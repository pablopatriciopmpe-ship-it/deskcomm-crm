/**
 * POST /api/v1/webhooks/pagamento/[token] — o aviso de pagamento da cobrança
 * que a ORGANIZAÇÃO faz ao cliente dela (migration 0717).
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
import { hashDoToken } from "@/lib/pagamentos/token-do-webhook";
import { EVENTO_AVISO_DE_PAGAMENTO, PROVEDOR_INFINITEPAY } from "@/lib/pagamentos/vocabulario";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

/**
 * Lê o corpo até o teto e desiste no byte que o estoura. Devolve `null` quando
 * estourou. Ver o chamador: o `content-length` não é promessa.
 */
async function lerCorpoComTeto(req: Request, teto: number): Promise<string | null> {
  if (!req.body) return "";
  const leitor = req.body.getReader();
  const pedacos: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await leitor.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > teto) {
      await leitor.cancel();
      return null;
    }
    pedacos.push(Buffer.from(value));
  }
  return Buffer.concat(pedacos).toString("utf8");
}

const LIMITE_DO_CORPO = 65_536;
const RECUSAS_POR_MINUTO = 120;
/**
 * Teto de avisos ACEITOS por IP. O balde de recusas sozinho não protegia nada
 * contra quem TEM um token válido vazado: cada aviso com `invoice_slug` novo
 * criava linha em `webhook_events_log` e em `event_log`, sem limite, até
 * entupir banco e fila. Folgado de propósito — o provedor legítimo reentrega,
 * mas não dispara milhares por minuto.
 */
const AVISOS_POR_MINUTO = 600;

type Rota = { params: Promise<{ token: string }> };

export async function POST(req: NextRequest, { params }: Rota) {
  const requestId = randomUUID();
  const naoExiste = () => fail("not_found", "Not found", 404, { requestId });
  const { token } = await params;

  // O token é HMAC-SHA256 em hex (64). Recusar o que nem parece token evita uma
  // ida ao banco por requisição de varredura.
  if (!/^[0-9a-f]{64}$/.test(token)) return naoExiste();

  if (Number(req.headers.get("content-length") ?? "0") > LIMITE_DO_CORPO) {
    return fail("payload_too_large", "Aviso grande demais.", 413, { requestId });
  }

  const balde = ipDoCliente(req.headers) ?? "sem-proxy";
  const teto = await checkRateLimit(`pagamento-webhook:${balde}`, AVISOS_POR_MINUTO, 60);
  if (!teto.allowed) {
    return fail("rate_limited", "Muitos avisos.", 429, {
      requestId,
      headers: { "Retry-After": "60" },
    });
  }

  const admin = createAdminClient();

  // O banco guarda o HASH, nunca o token: ele autentica sozinho (o provedor não
  // assina nada), e caminho de URL vai para log de proxy e de acesso. O valor
  // em si é DERIVADO do INTERNAL_SECRET quando se precisa montar a URL
  // (`lib/pagamentos/token-do-webhook.ts`), então não existe em lugar nenhum.
  const tokenSha256 = hashDoToken(token);

  const { data: conta, error: erroDaConta } = await admin
    .from("payment_provider_credentials")
    .select("id, organization_id, provider, is_active")
    .eq("webhook_path_token_sha256", tokenSha256)
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
    const taxa = await checkRateLimit(`pagamento-webhook-recusado:${balde}`, RECUSAS_POR_MINUTO, 60);
    if (!taxa.allowed) {
      return fail("rate_limited", "Muitos avisos recusados seguidos.", 429, {
        requestId,
        headers: { "Retry-After": "60" },
      });
    }
    return naoExiste();
  }

  // `req.text()` carregaria o corpo INTEIRO antes de qualquer medida, e o
  // `content-length` conferido lá em cima pode vir ausente ou mentiroso —
  // requisição `chunked` passa por ele. Então a leitura é com teto: ela
  // interrompe o fluxo no byte que estoura, e nada além disso é acumulado.
  const cru = await lerCorpoComTeto(req, LIMITE_DO_CORPO);
  if (cru === null) {
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

  // A COBRANÇA TEM DE SER DESTA ORGANIZAÇÃO. O `order_nsu` vem do corpo, que é
  // de fora, e ia direto para `event_log.entity_id` sem ninguém perguntar de
  // quem era. Com o token da organização A e o id de uma cobrança da B nascia
  // um evento incoerente — `organization_id` de A apontando para entidade de B.
  // É a regra da casa que este arquivo cita no cabeçalho: resolvido de fonte
  // confiável, NUNCA do body.
  //
  // Também resolve o `entity_id` ser `uuid`: id que não existe aqui não vira
  // INSERT, então um aviso torto não estoura 22P02 nem vira reentrega eterna.
  const { data: cobranca, error: erroDaCobranca } = await admin
    .from("payment_charges")
    .select("id")
    .eq("id", aviso.data.order_nsu)
    .eq("organization_id", conta.organization_id)
    .maybeSingle();

  if (erroDaCobranca) {
    // Pode ser `22P02` (o order_nsu nem é uuid) ou falha de leitura. O primeiro
    // é aviso que não é nosso; o segundo merece reentrega. Separar os dois evita
    // tanto a fila eterna quanto a venda perdida.
    if (erroDaCobranca.code === "22P02") {
      logger.warn("pagamento.aviso_com_referencia_estranha", { organizacao: conta.organization_id });
      return ok({ recebido: true, ignorado: true }, { requestId });
    }
    logger.error("pagamento.leitura_da_cobranca_falhou", { erro: erroDaCobranca.message });
    return fail("service_unavailable", "Indisponível.", 503, { requestId });
  }

  if (!cobranca) {
    logger.warn("pagamento.aviso_de_cobranca_desconhecida", { organizacao: conta.organization_id });
    return ok({ recebido: true, ignorado: true }, { requestId });
  }

  // GRAVA ANTES DE EMITIR. O 23505 deste insert é a idempotência: na ordem
  // inversa, a reentrega emitiria um segundo evento e o produto sairia duas
  // vezes. `raw_body` fica de fora de propósito — o aviso leva receipt_url, que
  // é endereço de documento do pagador.
  const { error: erroDoLog } = await admin.from("webhook_events_log").insert({
    organization_id: conta.organization_id,
    provider: PROVEDOR_INFINITEPAY,
    // A CHAVE DE REPETIÇÃO é fatura + transação, não a fatura sozinha. Uma
    // fatura pode receber mais de um aviso com transações DIFERENTES (tentativa
    // que falha e depois a que passa), e com a fatura sozinha o primeiro
    // ocupava a chave: o segundo aviso — o que de fato pagou — era respondido
    // como "repetido" e nunca processado. O cliente pagava e não recebia. Com o
    // token vazado isso virava ataque: mandar primeiro uma transação inventada
    // calava a verdadeira.
    external_id: `${aviso.data.invoice_slug}:${aviso.data.transaction_nsu}`,
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

  const repetido = erroDoLog?.code === "23505";
  if (erroDoLog && !repetido) {
    logger.error("pagamento.webhook_log_falhou", { erro: erroDoLog.message });
    return fail("service_unavailable", "Indisponível.", 503, { requestId });
  }

  // ⚠️ REPETIDO NÃO É "NADA A FAZER". São dois INSERTs sem transação: se o
  // primeiro passou e o segundo falhou, a resposta foi 503 pedindo reentrega —
  // e a reentrega caía no 23505 acima e respondia 200 SEM emitir o evento. O
  // retry do provedor neutralizava a si mesmo, e o pagamento ficava registrado
  // com o produto nunca entregue.
  //
  // Por isso a repetição também procura o evento, e só emite se ele faltar. A
  // corrida que sobra (dois avisos simultâneos lendo o vazio) é estreita e o
  // consumidor é idempotente pelo estado da cobrança, não pelo evento.
  //
  // A busca é pela MESMA TRANSAÇÃO, não só pela cobrança: perguntar "existe
  // algum evento desta cobrança?" fazia um aviso anterior, de outra transação,
  // responder pelo de agora — e o de agora nunca era emitido.
  if (repetido) {
    const { data: jaEmitido, error: erroDaBusca } = await admin
      .from("event_log")
      .select("id")
      .eq("organization_id", conta.organization_id)
      .eq("event_type", EVENTO_AVISO_DE_PAGAMENTO)
      .eq("entity_id", cobranca.id)
      .eq("payload->>transaction_nsu", aviso.data.transaction_nsu)
      .limit(1)
      .maybeSingle();

    if (erroDaBusca) {
      logger.error("pagamento.busca_do_evento_falhou", { erro: erroDaBusca.message });
      return fail("service_unavailable", "Indisponível.", 503, { requestId });
    }
    if (jaEmitido) return ok({ recebido: true, repetido: true }, { requestId });
  }

  const { error: erroDoEvento } = await admin.from("event_log").insert({
    organization_id: conta.organization_id,
    event_type: EVENTO_AVISO_DE_PAGAMENTO,
    entity_kind: "payment_charge",
    entity_id: cobranca.id,
    payload: {
      invoice_slug: aviso.data.invoice_slug,
      transaction_nsu: aviso.data.transaction_nsu,
      capture_method: aviso.data.capture_method,
    },
  });

  if (erroDoEvento) {
    // Agora a reentrega CURA: o ramo do repetido acima procura o evento e, não
    // achando, emite. Quem cura por último é a reconciliação, que relê cobrança
    // pendente sem depender de aviso nenhum.
    logger.error("pagamento.evento_nao_emitido", {
      erro: erroDoEvento.message,
      cobranca: cobranca.id,
    });
    return fail("service_unavailable", "Indisponível.", 503, { requestId });
  }

  return ok({ recebido: true }, { requestId });
}
