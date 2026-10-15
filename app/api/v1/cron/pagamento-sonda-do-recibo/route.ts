/**
 * GET/POST /api/v1/cron/pagamento-sonda-do-recibo — a sonda da conferência.
 *
 * ─── Por que esta rota existe ───────────────────────────────────────────────
 *
 * A confirmação de pagamento da 0678 não vem de API. O `payment_check` do
 * provedor é rota morta (devolve a mesma resposta para parâmetros válidos,
 * inválidos e corpo vazio) e o webhook dele não é assinado. O que resta é ler o
 * recibo PÚBLICO em `recibo.infinitepay.io` — e leitura de HTML de terceiro
 * quebra no dia em que eles mudarem o layout, sem avisar ninguém.
 *
 * O modo de falha é o pior que existe para quem instalou numa VPS e foi dormir:
 * quebra para o lado SEGURO. Ninguém recebe produto sem pagar. O que acontece é
 * que **ninguém recebe**. As vendas entram, o dinheiro cai na conta do
 * provedor, e o CRM segue achando que nada foi pago. Mesma família de
 * `message_send_stuck` (0109) e `midia_nao_lida` (0129): o produto não dá erro,
 * só para de cumprir a promessa.
 *
 * ─── Como ela mede ──────────────────────────────────────────────────────────
 *
 * Reconferindo um pagamento que JÁ passou pela conferência antes. Se o que
 * passou ontem falha hoje, não foi o pagamento que mudou — foi a página. É
 * dado real, não amostra sintética: uma amostra que eu escrevo envelhece junto
 * com a minha suposição sobre o HTML deles.
 *
 * Uma cobrança por organização, e no máximo `TETO_DE_ORGS` por rodada: o
 * defeito é do parser, é o mesmo para todo mundo, e bater N vezes no provedor
 * para descobrir a mesma coisa é abuso sem ganho.
 *
 * ─── Por que qualquer falha abre aviso, inclusive a de rede ─────────────────
 *
 * Seria mais fino distinguir "a página mudou" de "a rede piscou". Não vale:
 * para distinguir seria preciso guardar estado de tentativas, e o custo de errar
 * para cada lado é brutalmente assimétrico. Alarme falso custa uma olhada na
 * Central e **se fecha sozinho na próxima rodada que passar**. Silêncio custa
 * todas as vendas até alguém desconfiar.
 *
 * Auth: mesmo contrato dos demais crons (Bearer INTERNAL_CRON_SECRET|
 * INTERNAL_SECRET, fail-closed).
 *
 * NOTA DE DEPLOY: o agendamento vive em `docker/scheduler/entrypoint.sh`.
 */
import { randomUUID } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { autorizaCron } from "@/lib/auth/cron-auth";
import { logger } from "@/lib/logger";
import { conferirPeloRecibo, ErroDaInfinitePay } from "@/lib/pagamentos/provedores/infinitepay";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

/** O kind da Central (migration 0680). */
export const KIND_DO_AVISO = "conferencia_do_recibo_quebrada" as const;

/** Quantas organizações a rodada sonda. O defeito é global; isto é amostra. */
export const TETO_DE_ORGS = 5;

/** De quantas cobranças recentes a amostra é tirada antes de deduplicar por org. */
const COBRANCAS_LIDAS = 50;

export interface ResultadoDaSonda {
  sondadas: number;
  falharam: number;
  avisosAbertos: number;
  avisosResolvidos: number;
}

interface CobrancaSondavel {
  id: string;
  organization_id: string;
  transaction_nsu: string | null;
  amount_cents: number;
}

export async function sondarRecibos(admin: SupabaseClient, requestId: string): Promise<ResultadoDaSonda> {
  const vazio: ResultadoDaSonda = { sondadas: 0, falharam: 0, avisosAbertos: 0, avisosResolvidos: 0 };

  const { data, error } = await admin
    .from("payment_charges")
    .select("id, organization_id, transaction_nsu, amount_cents")
    .eq("status", "paid")
    .not("conferido_pelo_recibo_em", "is", null)
    .not("transaction_nsu", "is", null)
    .order("paid_at", { ascending: false })
    .limit(COBRANCAS_LIDAS);

  if (error) {
    logger.error("[sonda-do-recibo] leitura falhou", { error: error.message, requestId });
    return vazio;
  }

  // Uma por organização, a mais recente — a lista já vem ordenada.
  const porOrg = new Map<string, CobrancaSondavel>();
  for (const c of (data ?? []) as CobrancaSondavel[]) {
    if (!porOrg.has(c.organization_id)) porOrg.set(c.organization_id, c);
    if (porOrg.size >= TETO_DE_ORGS) break;
  }

  // Instalação que ainda não vendeu não tem o que sondar — e não é defeito.
  if (porOrg.size === 0) return vazio;

  const r: ResultadoDaSonda = { ...vazio, sondadas: porOrg.size };

  for (const cobranca of porOrg.values()) {
    let motivo: string | null = null;
    try {
      await conferirPeloRecibo({
        transactionNsu: cobranca.transaction_nsu!,
        amountCentsEsperado: cobranca.amount_cents,
      });
    } catch (e) {
      motivo = e instanceof ErroDaInfinitePay ? e.codigo : "erro_inesperado";
    }

    if (motivo) {
      r.falharam += 1;
      if (await abrirAviso(admin, cobranca, motivo, requestId)) r.avisosAbertos += 1;
    } else if (await resolverAviso(admin, cobranca.organization_id, requestId)) {
      r.avisosResolvidos += 1;
    }
  }

  return r;
}

/** Devolve `true` quando ABRIU — o índice único faz o repetido não contar. */
async function abrirAviso(
  admin: SupabaseClient,
  cobranca: CobrancaSondavel,
  motivo: string,
  requestId: string,
): Promise<boolean> {
  const { error } = await admin.from("agent_inbox_items").insert({
    organization_id: cobranca.organization_id,
    kind: KIND_DO_AVISO,
    severity: "critical",
    title: "Pagamentos não estão sendo confirmados",
    body:
      "A conferência do recibo do provedor parou de reconhecer a página dele. " +
      "Enquanto isso durar, pagamento que entrar NÃO é confirmado e nenhum produto é entregue — " +
      "o dinheiro cai na conta do provedor normalmente, mas o sistema não fica sabendo. " +
      `Diagnóstico técnico: ${motivo}. ` +
      "Este aviso se fecha sozinho quando a conferência voltar a funcionar.",
    // O defeito é do parser, não desta cobrança — ela é só a amostra que o
    // suporte usa para reproduzir.
    ref_kind: "payment_charge",
    ref_id: cobranca.id,
  });

  if (!error) return true;
  // 23505 = já havia aviso aberto para esta organização. Não é falha, e não é
  // efeito: contar como aberto faria a auditoria registrar rodada sem novidade.
  if (error.code === "23505") return false;

  logger.error("[sonda-do-recibo] aviso na Central falhou", {
    error: error.message,
    organization_id: cobranca.organization_id,
    requestId,
  });
  return false;
}

/** Devolve `true` quando RESOLVEU algum aviso que estava aberto. */
async function resolverAviso(
  admin: SupabaseClient,
  organizationId: string,
  requestId: string,
): Promise<boolean> {
  const { data, error } = await admin
    .from("agent_inbox_items")
    .update({ status: "resolved", resolved_at: new Date().toISOString() })
    .eq("organization_id", organizationId)
    .eq("kind", KIND_DO_AVISO)
    .eq("status", "open")
    .select("id");

  if (error) {
    logger.error("[sonda-do-recibo] fechar aviso falhou", {
      error: error.message,
      organization_id: organizationId,
      requestId,
    });
    return false;
  }
  return (data ?? []).length > 0;
}

async function handle(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();

  if (!autorizaCron(req)) {
    return fail("forbidden", "Cron secret missing or invalid.", 403, { requestId });
  }

  let resultado: ResultadoDaSonda;
  try {
    resultado = await sondarRecibos(createAdminClient(), requestId);
  } catch (err) {
    const detalhe = err instanceof Error ? err.message : String(err);
    logger.error("[sonda-do-recibo] falhou", { error: detalhe, requestId });
    return fail("internal_error", "Falha ao sondar os recibos.", 500, { requestId });
  }

  // Rodada que não abriu nem fechou aviso não é mutação e não ocupa linha de
  // auditoria (CLAUDE.md: cron audita QUANDO HÁ EFEITO).
  if (resultado.avisosAbertos > 0 || resultado.avisosResolvidos > 0) {
    void audit({
      action: "pagamento.sonda_do_recibo_run",
      organizationId: null,
      bypassedRls: true,
      metadata: resultado as unknown as Record<string, unknown>,
      requestId,
    });
  }

  return ok(resultado, { requestId });
}

export async function GET(req: NextRequest): Promise<Response> {
  return handle(req);
}

export async function POST(req: NextRequest): Promise<Response> {
  return handle(req);
}
