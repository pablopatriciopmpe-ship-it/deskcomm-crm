/**
 * GET/POST /api/v1/cron/pagamento-sonda-do-recibo — a sonda da conferência.
 *
 * ─── Por que esta rota existe ───────────────────────────────────────────────
 *
 * A confirmação de pagamento da 0717 não vem de API. O `payment_check` do
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
import { ehOperante, statusDaOrgEmbutida, STATUS_OPERANTE } from "@/lib/organizacao/operante";
import { conferirPeloRecibo, ErroDaInfinitePay } from "@/lib/pagamentos/provedores/infinitepay";
import { EVENTO_AVISO_DE_PAGAMENTO, PROVEDOR_INFINITEPAY } from "@/lib/pagamentos/vocabulario";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

/** O kind da Central (migration 0719). */
export const KIND_DO_AVISO = "conferencia_do_recibo_quebrada" as const;

/** Quantas organizações a rodada sonda. O defeito é global; isto é amostra. */
export const TETO_DE_ORGS = 5;

/**
 * ⚠️ AQUI MOROU DUAS VEZES O MESMO DEFEITO, e a segunda tinha este comentário
 * dizendo que estava resolvido.
 *
 * A amostra era tirada de uma leitura GLOBAL de cobranças ordenada por data
 * (`limit(50)`, depois `limit(500)`) e só DEPOIS deduplicada por organização.
 * Mas o `limit` corta antes da deduplicação: uma organização de alto volume
 * ocupa as N linhas mais recentes todo dia, `porOrg` nasce com uma única
 * entrada, e o rodízio roda sobre uma lista de um elemento. As demais nunca são
 * sondadas — e quando o parser quebrar para uma delas, a venda fica sem entrega
 * e nenhum aviso abre. É exatamente o silêncio que esta rota existe para
 * romper. Alargar a janela não conserta, só torna mais raro.
 *
 * O conserto é perguntar por ORGANIZAÇÃO, não por cobrança: a lista de
 * candidatas sai de `payment_provider_credentials` (uma linha por organização,
 * então ninguém ocupa a vaga de ninguém), o status entra por `!inner` para o
 * corte sair ANTES de qualquer limite — o idioma que `lib/organizacao/
 * operante.ts` documenta — e só depois do rodízio cada escolhida tem a SUA
 * cobrança lida, uma consulta de uma linha por organização.
 */
const COBRANCAS_POR_ORG = 1;

export interface ResultadoDaSonda {
  sondadas: number;
  falharam: number;
  avisosAbertos: number;
  avisosResolvidos: number;
  /** Cobranças pendentes que receberam aviso e voltaram para a fila. */
  reemitidas: number;
}

/** Quantas pendentes a reconciliação devolve à fila por rodada. */
const RECONCILIADAS_POR_RODADA = 50;

/** Avisos mais velhos que isto não são mais reconciliados. */
const JANELA_DA_RECONCILIACAO_DIAS = 30;

interface CobrancaSondavel {
  id: string;
  organization_id: string;
  transaction_nsu: string | null;
  amount_cents: number;
  /** O handle da conta que recebeu — é o que amarra o recibo ao nosso vendedor. */
  handle_do_recebedor: string | null;
  payment_provider_credentials: { handle: string } | { handle: string }[] | null;
}

/** O PostgREST devolve objeto ou array conforme a cardinalidade que ele infere. */
function handleDaCobranca(c: CobrancaSondavel): string | null {
  // O retrato de quem recebeu vem primeiro: se a organização trocou de conta
  // depois desta cobrança, o recibo mostra o handle ANTIGO, e comparar com o
  // atual faria a sonda acusar quebra onde não houve.
  if (c.handle_do_recebedor) return c.handle_do_recebedor;
  const v = c.payment_provider_credentials;
  if (!v) return null;
  return (Array.isArray(v) ? v[0]?.handle : v.handle) ?? null;
}

export async function sondarRecibos(admin: SupabaseClient, requestId: string): Promise<ResultadoDaSonda> {
  const vazio: ResultadoDaSonda = {
    sondadas: 0,
    falharam: 0,
    avisosAbertos: 0,
    avisosResolvidos: 0,
    reemitidas: 0,
  };

  // ─── 1. As ORGANIZAÇÕES candidatas, uma linha cada ──────────────────────
  //
  // Uma conta ativa por organização, com o status embutido por `!inner` para o
  // corte das paradas sair ANTES de qualquer limite (idioma de
  // `lib/organizacao/operante.ts`). Organização parada não é sondada porque a
  // sonda SAI PARA FORA, batendo no provedor.
  const { data: contas, error: erroDasContas } = await admin
    .from("payment_provider_credentials")
    .select("organization_id, organizations:organization_id!inner(status)")
    .eq("provider", PROVEDOR_INFINITEPAY)
    .eq("is_active", true)
    .eq("organizations.status", STATUS_OPERANTE);

  // ⚠️ Erro de leitura NÃO é rodada vazia. Devolver zeros aqui fazia a rota
  // responder 200: o agendador via sucesso todos os dias, nenhuma auditoria
  // nascia e nenhum aviso abria, enquanto a sonda não media nada. Quem joga
  // sabe virar 500 na rota (`handle` abaixo).
  if (erroDasContas) {
    throw new Error(`leitura das contas falhou: ${erroDasContas.message}`);
  }

  // O `!inner` acima já cortou as paradas na consulta. O `ehOperante` linha a
  // linha é o CINTO que `lib/organizacao/operante.ts` recomenda junto: se o
  // embed vier com forma inesperada, a sonda não sai para fora por engano.
  const orgs = [
    ...new Set(
      ((contas ?? []) as Array<{
        organization_id: string;
        organizations?: { status?: string | null } | Array<{ status?: string | null }> | null;
      }>)
        .filter((c) => ehOperante(statusDaOrgEmbutida(c.organizations)))
        .map((c) => c.organization_id),
    ),
  ].sort();

  // ─── 2. O rodízio, agora sobre a lista INTEIRA de organizações ──────────
  //
  // A ordem é estável (id) e o começo anda com o dia, então toda organização
  // entra na amostra dentro de poucos dias, sem coluna nova para lembrar quem
  // foi sondado.
  const escolhidas: string[] = [];
  if (orgs.length > 0) {
    const diaDoAno = Math.floor(Date.now() / 86_400_000);
    const inicio = (diaDoAno * TETO_DE_ORGS) % orgs.length;
    for (let i = 0; i < Math.min(TETO_DE_ORGS, orgs.length); i += 1) {
      escolhidas.push(orgs[(inicio + i) % orgs.length]!);
    }
  }

  const r: ResultadoDaSonda = { ...vazio };

  // ─── 3. Uma cobrança por organização escolhida ──────────────────────────
  for (const orgId of escolhidas) {
    const { data: linha, error: erroDaCobranca } = await admin
      .from("payment_charges")
      .select(
        "id, organization_id, transaction_nsu, amount_cents, handle_do_recebedor, payment_provider_credentials(handle)",
      )
      .eq("organization_id", orgId)
      .eq("status", "paid")
      .not("conferido_pelo_recibo_em", "is", null)
      .not("transaction_nsu", "is", null)
      .order("paid_at", { ascending: false })
      .limit(COBRANCAS_POR_ORG)
      .maybeSingle();

    if (erroDaCobranca) {
      throw new Error(`leitura da cobranca falhou: ${erroDaCobranca.message}`);
    }
    // Organização com conta ligada que ainda não vendeu não tem o que sondar —
    // e isso não é defeito nem consome vaga de ninguém mais.
    if (!linha) continue;

    const cobranca = linha as unknown as CobrancaSondavel;
    r.sondadas += 1;

    const handle = handleDaCobranca(cobranca);
    let motivo: string | null = null;
    try {
      if (!handle) {
        // Sem o handle não dá para amarrar o recibo ao nosso vendedor, e
        // conferir sem essa amarra é o furo que a revisão apontou. Recusar é a
        // saída segura, e o aviso diz o que falta.
        motivo = "conta_sem_handle";
      } else {
        await conferirPeloRecibo({
          transactionNsu: cobranca.transaction_nsu!,
          amountCentsEsperado: cobranca.amount_cents,
          handle,
        });
      }
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

  // ─── 4. A RECONCILIAÇÃO, que até agora era só promessa de comentário ────
  r.reemitidas = await reconciliarPendentes(admin, requestId);

  return r;
}

/**
 * A RECONCILIAÇÃO — cobrança que recebeu aviso e continuou pendente volta para
 * a fila.
 *
 * ─── Por que ela precisa existir ────────────────────────────────────────────
 *
 * Duas peças deste módulo tinham, em comentário, a promessa de que "a
 * reconciliação encontra depois": o handler da confirmação e a rota do webhook.
 * **Ela não existia.** E a sonda acima não serve: ela relê cobranças JÁ pagas,
 * para medir a saúde do parser. Cobrança que o parser recusou nunca chega a ser
 * paga, então ninguém olhava para ela nunca mais.
 *
 * O resultado era o pior modo de falha possível: a InfinitePay muda o HTML do
 * recibo, as vendas do dia viram `skipped`, a sonda abre o aviso na Central —
 * e depois de alguém consertar o parser, **aquelas vendas seguem perdidas**. O
 * dinheiro entrou e o produto nunca saiu.
 *
 * ─── Como ela acha ──────────────────────────────────────────────────────────
 *
 * Pelo aviso que chegou, não pelo estado da cobrança: `webhook_events_log`
 * guarda o `order_nsu`, que é o id da cobrança. Alguém disse que esta cobrança
 * foi paga, e ela não está paga — é exatamente a lista que precisa de nova
 * tentativa. Reemitir é seguro porque nada aqui CONFIRMA nada: quem confirma é
 * o handler, que confere o recibo de novo e depende do mesmo CHECK do banco.
 *
 * ─── Por que ela pode repetir para sempre sem virar problema ────────────────
 *
 * Se o parser continuar quebrado, a mesma cobrança volta à fila amanhã. É
 * barato (uma leitura de página pública por cobrança, com teto por rodada) e é
 * o comportamento desejado: no dia em que o parser for consertado, a venda se
 * cura sozinha sem ninguém lembrar dela. Aviso forjado por quem tenha o token
 * cai no mesmo caminho e continua sendo recusado pelo recibo — ele só custa uma
 * leitura, e a janela de 30 dias impede que ele custe para sempre.
 */
async function reconciliarPendentes(admin: SupabaseClient, requestId: string): Promise<number> {
  const desde = new Date(
    Date.now() - JANELA_DA_RECONCILIACAO_DIAS * 86_400_000,
  ).toISOString();

  const { data: avisos, error: erroDosAvisos } = await admin
    .from("webhook_events_log")
    .select("organization_id, payload_parsed")
    .eq("provider", PROVEDOR_INFINITEPAY)
    .gte("created_at", desde)
    .order("created_at", { ascending: false })
    .limit(RECONCILIADAS_POR_RODADA * 4);

  if (erroDosAvisos) throw new Error(`leitura dos avisos falhou: ${erroDosAvisos.message}`);

  // O `order_nsu` do aviso é o id da cobrança — foi NÓS que o mandamos.
  const porCobranca = new Map<string, { organizationId: string; nsu: string; slug: string }>();
  for (const linha of (avisos ?? []) as Array<{
    organization_id: string;
    payload_parsed: Record<string, unknown> | null;
  }>) {
    const p = linha.payload_parsed ?? {};
    const id = typeof p.order_nsu === "string" ? p.order_nsu : null;
    const nsu = typeof p.transaction_nsu === "string" ? p.transaction_nsu : null;
    const slug = typeof p.invoice_slug === "string" ? p.invoice_slug : null;
    if (!id || !nsu || !slug || porCobranca.has(id)) continue;
    porCobranca.set(id, { organizationId: linha.organization_id, nsu, slug });
  }
  if (porCobranca.size === 0) return 0;

  const { data: pendentes, error: erroDasPendentes } = await admin
    .from("payment_charges")
    .select("id, organization_id")
    .in("id", [...porCobranca.keys()])
    .eq("status", "pending")
    .limit(RECONCILIADAS_POR_RODADA);

  if (erroDasPendentes) throw new Error(`leitura das pendentes falhou: ${erroDasPendentes.message}`);
  if (!pendentes || pendentes.length === 0) return 0;

  let reemitidas = 0;
  for (const linha of pendentes as Array<{ id: string; organization_id: string }>) {
    const aviso = porCobranca.get(linha.id);
    // A organização do aviso TEM de ser a da cobrança. O `in (...)` acima é por
    // id, e id não carrega organização: sem esta conferência um aviso gravado
    // numa organização reemitiria evento apontando para cobrança de outra.
    if (!aviso || aviso.organizationId !== linha.organization_id) continue;

    const { error } = await admin.from("event_log").insert({
      organization_id: linha.organization_id,
      event_type: EVENTO_AVISO_DE_PAGAMENTO,
      entity_kind: "payment_charge",
      entity_id: linha.id,
      payload: {
        invoice_slug: aviso.slug,
        transaction_nsu: aviso.nsu,
        reconciliado_em: new Date().toISOString(),
      },
    });
    if (error) {
      logger.error("[sonda-do-recibo] reemissao falhou", {
        cobranca: linha.id,
        erro: error.message,
        requestId,
      });
      continue;
    }
    reemitidas += 1;
  }

  return reemitidas;
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
      `Diagnóstico técnico: ${motivo} (amostra: cobrança ${cobranca.id}). ` +
      "Este aviso se fecha sozinho quando a conferência voltar a funcionar.",
    // ⚠️ SEM `ref_kind`/`ref_id`, e isso é o que faz o botão de reparo existir.
    //
    // O aviso nascia apontando para a cobrança que serviu de amostra. Mas o
    // resolvedor de destino (`lib/ai/inbox-destino.ts`) manda para "contexto
    // indisponível" quando o `ref_kind` não está na lista `refs` da política — e
    // o destino GERAL só é alcançado quando não há referência nenhuma. Com a
    // referência posta, até quem administra abria o aviso crítico e não recebia
    // o caminho para consertar.
    //
    // O defeito nunca foi daquela cobrança: ela é só a amostra que reproduz. Por
    // isso o id dela foi para o CORPO (onde serve ao suporte) e a referência
    // saiu, liberando o destino geral: a tela de receber pagamentos.
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
  if (resultado.avisosAbertos > 0 || resultado.avisosResolvidos > 0 || resultado.reemitidas > 0) {
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
