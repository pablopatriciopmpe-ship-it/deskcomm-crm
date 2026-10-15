/**
 * POST /api/v1/webhooks/pagamento/[token] — o aviso de pagamento da cobrança
 * que a ORGANIZAÇÃO faz ao cliente dela (migration 0678).
 *
 * Não confundir com `/webhooks/cobranca/[provedor]`, que é a assinatura DA
 * INSTALAÇÃO e tem provedor no caminho porque a conta é uma só. Aqui a conta é
 * de cada organização, então quem resolve o tenant é o TOKEN do caminho —
 * fonte confiável, nunca o corpo (CLAUDE.md, Multi-tenancy).
 *
 * ─── O que esta rota faz, e o que ela deliberadamente NÃO faz ───────────────
 *
 * Ela GRAVA e responde. Não confere pagamento, não marca `paid`, não entrega
 * produto nenhum. Duas razões, e as duas são medidas:
 *
 *  1. **A InfinitePay exige resposta em menos de 1 segundo** (e trata 400 como
 *     motivo de reentrega). Buscar o recibo do provedor dentro do ciclo da
 *     resposta é apostar a venda na latência dele.
 *  2. **O aviso não é assinado.** Nada que chegue aqui é fato — é pedido de
 *     releitura. Quem decide é o worker, que confere o recibo público
 *     (`conferirPeloRecibo`) e só então escreve. E o banco cobra isso por CHECK:
 *     `payment_charges_conferida_antes_de_paga` recusa `paid` sem o carimbo da
 *     conferência, então nem uma rota com defeito consegue liberar produto.
 *
 * ─── O token é o que autentica, então ele se comporta como senha ────────────
 *
 * Token desconhecido responde **404**, igual a rota inexistente: um 401 contaria
 * a quem sondou que o endereço existe e que falta credencial. E a comparação é
 * do Postgres, por índice único — o token tem 24 bytes aleatórios, e adivinhá-lo
 * não é o vetor; vazá-lo é, e para isso existe a segunda camada (o recibo).
 *
 * ─── Idempotência ───────────────────────────────────────────────────────────
 *
 * O gateway reentrega. `uniq_webhook_events_log_pagamento` é único por
 * (organização, provedor, external_id), e o `23505` É a idempotência: segundo
 * aviso da mesma cobrança responde 200 sem reemitir evento. Gravar ANTES de
 * emitir é o que torna isso verdade — na ordem inversa, duas entregas.
 */
import { randomUUID } from "node:crypto";

import type { NextRequest } from "next/server";

import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";
import { fail, ok } from "@/lib/api/wrappers";
import { ipDoCliente } from "@/lib/http/ip-do-cliente";
import { logger } from "@/lib/logger";
import { avisoDaInfinitePay } from "@/lib/pagamentos/provedores/infinitepay";
import { EVENTO_AVISO_DE_PAGAMENTO, PROVEDOR_INFINITEPAY } from "@/lib/pagamentos/vocabulario";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const LIMITE_DO_CORPO = 65_536;
const RECUSAS_POR_MINUTO = 120;

type Rota = { params: Promise<{ token: string }> };

export async function POST(req: NextRequest, { params }: Rota) {
  const requestId = randomUUID();
  const naoExiste = () => fail("not_found", "Not found", 404, { requestId });
  const { token } = await params;

  // O token tem formato conhecido (24 bytes em hex). Recusar o que nem parece
  // token evita uma ida ao banco por requisição de varredura.
  if (!/^[0-9a-f]{48}$/.test(token)) return naoExiste();

  if (Number(req.headers.get("content-length") ?? "0") > LIMITE_DO_CORPO) {
    return fail("payload_too_large", "Aviso grande demais.", 413, { requestId });
  }

  const admin = createAdminClient();

  const { data: conta, error: erroDaConta } = await admin
    .from("payment_provider_credentials")
    .select("id, organization_id, provider, is_active")
    .eq("webhook_path_token", token)
    .maybeSingle();

  if (erroDaConta) {
    // Falha de leitura NÃO é token inválido. Responder 404 aqui ensinaria o
    // provedor a desistir de um aviso que ainda vale; 503 faz ele reentregar.
    logger.error("pagamento.webhook_leitura_falhou", { erro: erroDaConta.message });
    return fail("service_unavailable", "Indisponível.", 503, { requestId });
  }

  // Esta rota fala UM provedor. Se um dia a conta aceitar outro, o aviso dele
  // não tem a mesma forma nem a mesma conferência — tratá-lo aqui gravaria um
  // evento com o nome errado e mandaria o worker conferir no recibo errado.
  if (conta && conta.provider !== PROVEDOR_INFINITEPAY) return naoExiste();

  if (!conta || !conta.is_active) {
    const balde = ipDoCliente(req.headers) ?? "sem-proxy";
    const taxa = await checkRateLimit(`pagamento-webhook-recusado:${balde}`, RECUSAS_POR_MINUTO, 60);
    if (!taxa.allowed) {
      return fail("rate_limited", "Muitos avisos recusados seguidos.", 429, {
        requestId,
        headers: { "Retry-After": "60" },
      });
    }
    return naoExiste();
  }

  const cru = await req.text();
  if (Buffer.byteLength(cru, "utf8") > LIMITE_DO_CORPO) {
    return fail("payload_too_large", "Aviso grande demais.", 413, { requestId });
  }

  let bruto: unknown;
  try {
    bruto = JSON.parse(cru) as unknown;
  } catch {
    return fail("invalid_payload", "Corpo inválido.", 400, { requestId });
  }

  const aviso = avisoDaInfinitePay.safeParse(bruto);
  if (!aviso.success) {
    // 400 faz a InfinitePay reentregar. Está certo: a forma pode ter mudado do
    // lado deles, e perder o aviso é perder a venda. O aviso malformado fica
    // registrado no log do servidor para alguém olhar.
    logger.warn("pagamento.aviso_com_forma_inesperada", {
      organizacao: conta.organization_id,
      provedor: conta.provider,
    });
    return fail("invalid_payload", "Forma inesperada.", 400, { requestId });
  }

  // GRAVA ANTES DE EMITIR. O 23505 deste insert é a idempotência: na ordem
  // inversa, a reentrega emitiria um segundo evento e o produto sairia duas
  // vezes. `raw_body` fica de fora de propósito — o aviso leva receipt_url, que
  // é endereço de documento do pagador.
  const { error: erroDoLog } = await admin.from("webhook_events_log").insert({
    organization_id: conta.organization_id,
    provider: PROVEDOR_INFINITEPAY,
    external_id: aviso.data.invoice_slug,
    event_type: EVENTO_AVISO_DE_PAGAMENTO,
    http_method: "POST",
    status: "received",
    webhook_path_token: null,
    payload_parsed: {
      order_nsu: aviso.data.order_nsu,
      invoice_slug: aviso.data.invoice_slug,
      transaction_nsu: aviso.data.transaction_nsu,
      capture_method: aviso.data.capture_method,
    },
  });

  if (erroDoLog) {
    if (erroDoLog.code === "23505") {
      // Já recebido. Responder 200 é o que faz o provedor parar de reentregar.
      return ok({ recebido: true, repetido: true }, { requestId });
    }
    logger.error("pagamento.webhook_log_falhou", { erro: erroDoLog.message });
    return fail("service_unavailable", "Indisponível.", 503, { requestId });
  }

  // `event_log.entity_id` é `uuid`, e o `order_nsu` é texto vindo de fora. Um
  // valor que não seja UUID faria o INSERT estourar com 22P02, a rota devolver
  // 503 e o provedor reentregar para sempre — um aviso torto viraria fila
  // infinita. O que não tem a nossa forma não é cobrança nossa: fica gravado no
  // log (serve de evidência) e não emite evento.
  const EH_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!EH_UUID.test(aviso.data.order_nsu)) {
    logger.warn("pagamento.aviso_com_referencia_estranha", {
      organizacao: conta.organization_id,
    });
    return ok({ recebido: true, ignorado: true }, { requestId });
  }

  const { error: erroDoEvento } = await admin.from("event_log").insert({
    organization_id: conta.organization_id,
    event_type: EVENTO_AVISO_DE_PAGAMENTO,
    entity_kind: "payment_charge",
    // O id da cobrança é o que NÓS mandamos como order_nsu. Resolver por aqui, e
    // não por nada que o aviso diga sobre valor ou situação, é o que mantém o
    // aviso no papel de cutucão.
    entity_id: aviso.data.order_nsu,
    payload: {
      invoice_slug: aviso.data.invoice_slug,
      transaction_nsu: aviso.data.transaction_nsu,
      capture_method: aviso.data.capture_method,
    },
  });

  if (erroDoEvento) {
    // O log já tem a linha, então a reentrega cairia no 23505 e não reemitiria.
    // Devolver 503 faz o provedor tentar de novo, mas quem cura de verdade é a
    // reconciliação, que relê cobrança pendente sem depender de aviso nenhum.
    logger.error("pagamento.evento_nao_emitido", {
      erro: erroDoEvento.message,
      cobranca: aviso.data.order_nsu,
    });
    return fail("service_unavailable", "Indisponível.", 503, { requestId });
  }

  return ok({ recebido: true }, { requestId });
}
