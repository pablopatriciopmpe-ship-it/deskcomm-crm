import type * as InfinitePay from "./provedores/infinitepay";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { bancoFalso, operacao, type BancoFalso, type Cadeia, type Resposta } from "@/tests/helpers/banco-falso-da-cobranca";

/**
 * O WORKER QUE DECIDE SE HOUVE VENDA.
 *
 * É o único lugar do sistema que transforma um aviso não assinado em dinheiro
 * reconhecido e produto entregue. Os casos aqui prendem a regra que sustenta o
 * caminho inteiro: **nada é entregue sem o recibo do provedor conferir.**
 */

const h = vi.hoisted(() => ({
  erroDaConferencia: null as string | null,
  conferencias: [] as unknown[],
  enviadas: [] as unknown[],
  erroDoEnvio: null as Error | null,
  banco: undefined as unknown as BancoFalso,
}));

vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => h.banco.cliente }));
vi.mock("./provedores/infinitepay", async (original) => {
  const real = await original<typeof InfinitePay>();
  return {
    ...real,
    conferirPeloRecibo: async (p: unknown) => {
      h.conferencias.push(p);
      if (h.erroDaConferencia) throw new real.ErroDaInfinitePay(200, h.erroDaConferencia);
    },
  };
});
vi.mock("@/app/api/v1/messages/_handler", () => ({
  sendMessageHandler: async (_a: unknown, _b: unknown, c: unknown) => {
    if (h.erroDoEnvio) throw h.erroDoEnvio;
    h.enviadas.push(c);
    return { id: "msg-1", status: "sent" };
  },
}));

import { confirmarPagamentoHandler } from "./confirmar.handler";

const ORG = "aaaaaaaa-0000-4000-8000-000000000001";
const COBRANCA = "cccccccc-0000-4000-8000-000000000003";

interface Mundo {
  cobranca: Record<string, unknown> | null;
  arquivos: Array<{ id: string }>;
  entregaExistente: { id: string; expira_em: string } | null;
  conversa: { id: string } | null;
}
let m: Mundo;

function responder(c: Cadeia): Resposta {
  if (c.tabela === "payment_charges") return { data: m.cobranca };
  if (c.tabela === "order_items") return { data: [{ product_id: "prod-1" }] };
  if (c.tabela === "catalog_product_files") return { data: m.arquivos };
  if (c.tabela === "order_deliveries") return { data: m.entregaExistente };
  if (c.tabela === "orders") return { data: { contact_id: "contato-1" } };
  if (c.tabela === "conversations") return { data: m.conversa };
  return {};
}

const evento = (payload: Record<string, unknown> = {}) => ({
  id: "ev-1",
  organization_id: ORG,
  event_type: "pagamento.aviso_recebido",
  entity_kind: "payment_charge",
  entity_id: COBRANCA,
  payload: {
    transaction_nsu: "nsu-1",
    invoice_slug: "slug-1",
    capture_method: "pix",
    ...payload,
  },
  metadata: {},
  consumed_by: [],
  attempts: 0,
  created_at: new Date().toISOString(),
});

const baixas = () =>
  h.banco.cadeias.filter((c) => c.tabela === "payment_charges" && operacao(c) === "update");

beforeEach(() => {
  vi.clearAllMocks();
  h.erroDaConferencia = null;
  h.conferencias = [];
  h.enviadas = [];
  h.erroDoEnvio = null;
  m = {
    cobranca: {
      id: COBRANCA,
      order_id: "pedido-1",
      status: "pending",
      amount_cents: 12990,
      handle_do_recebedor: "minhaloja",
      payment_provider_credentials: { handle: "minhaloja" },
    },
    arquivos: [{ id: "arq-1" }],
    entregaExistente: null,
    conversa: { id: "conversa-1" },
  };
  h.banco = bancoFalso(responder);
});

describe("nada é entregue sem o recibo conferir", () => {
  it("recibo de outro vendedor NÃO marca pago e NÃO entrega", async () => {
    h.erroDaConferencia = "recibo_de_outro_vendedor";
    const r = await confirmarPagamentoHandler.handle(evento());
    expect(r.status).toBe("skipped");
    expect(baixas()).toHaveLength(0);
    expect(h.enviadas).toHaveLength(0);
  });

  it("valor diferente NÃO marca pago", async () => {
    h.erroDaConferencia = "recibo_com_valor_diferente";
    await confirmarPagamentoHandler.handle(evento());
    expect(baixas()).toHaveLength(0);
  });

  it("falha de CONTEÚDO não vira retentativa eterna", async () => {
    // O recibo não vai mudar. Quem acusa se isto virar rotina é a sonda diária.
    h.erroDaConferencia = "recibo_de_outra_transacao";
    const r = await confirmarPagamentoHandler.handle(evento());
    expect(r.status).toBe("skipped");
  });

  it("falha de REDE vira retentativa", async () => {
    h.erroDaConferencia = "recibo_inacessivel";
    const r = await confirmarPagamentoHandler.handle(evento());
    expect(r.status).toBe("error");
  });
});

describe("o que é conferido", () => {
  it("o valor sai do NOSSO banco, nunca do aviso", async () => {
    // Um aviso forjado dizendo "R$ 1" não pode confirmar uma cobrança de R$ 500.
    await confirmarPagamentoHandler.handle(evento({ amount: 100, paid_amount: 100 }));
    expect(h.conferencias[0]).toMatchObject({ amountCentsEsperado: 12990, handle: "minhaloja" });
  });

  it("o handle conferido é o do RETRATO, não o da conta atual", async () => {
    // A organização trocou de InfiniteTag depois desta cobrança. O dinheiro
    // caiu na conta ANTIGA e é o handle dela que o recibo mostra: comparar com
    // a atual recusaria uma venda legítima, e o cliente que pagou não receberia.
    m.cobranca = {
      ...m.cobranca!,
      handle_do_recebedor: "lojaantiga",
      payment_provider_credentials: { handle: "lojanova" },
    };
    await confirmarPagamentoHandler.handle(evento());
    expect(h.conferencias[0]).toMatchObject({ handle: "lojaantiga" });
  });

  it("conta sem handle não confere nada", async () => {
    m.cobranca = {
      ...m.cobranca!,
      handle_do_recebedor: null,
      payment_provider_credentials: null,
    };
    const r = await confirmarPagamentoHandler.handle(evento());
    expect(r).toMatchObject({ status: "skipped", detail: "conta_sem_handle" });
    expect(h.conferencias).toHaveLength(0);
  });
});

describe("quando confere", () => {
  it("marca pago COM o carimbo da conferência", async () => {
    // Sem o carimbo o banco recusa o `paid` — o CHECK é a última porta.
    await confirmarPagamentoHandler.handle(evento());
    const args = baixas()[0]!.passos[0]!.args[0] as Record<string, unknown>;
    expect(args.status).toBe("paid");
    expect(args.paid_at).toBeTruthy();
    expect(args.conferido_pelo_recibo_em).toBeTruthy();
    expect(args.transaction_nsu).toBe("nsu-1");
  });

  it("entrega e manda o link na conversa", async () => {
    const r = await confirmarPagamentoHandler.handle(evento());
    expect(r).toMatchObject({ status: "ok", detail: "entregue" });
    expect(h.enviadas).toHaveLength(1);
    expect(String((h.enviadas[0] as { body: string }).body)).toContain("/entrega/");
  });

  it("guarda o HASH do token da entrega, nunca o token", async () => {
    await confirmarPagamentoHandler.handle(evento());
    const insert = h.banco.cadeias.find(
      (c) => c.tabela === "order_deliveries" && operacao(c) === "insert",
    )!;
    const args = insert.passos[0]!.args[0] as Record<string, unknown>;
    expect(String(args.token_sha256)).toMatch(/^[0-9a-f]{64}$/);
    const enviado = String((h.enviadas[0] as { body: string }).body);
    expect(enviado).not.toContain(String(args.token_sha256));
  });

  it("produto sem arquivo é venda boa, não defeito", async () => {
    m.arquivos = [];
    const r = await confirmarPagamentoHandler.handle(evento());
    expect(r).toMatchObject({ status: "ok", detail: "pago_sem_arquivo" });
  });

  it("aviso recusado NÃO desfaz a entrega", async () => {
    // O contato pediu para não receber, ou a janela fechou. A entrega existe e
    // o link vale; quem opera vê o pedido pago e pode reenviar.
    h.erroDoEnvio = new Error("forbidden");
    const r = await confirmarPagamentoHandler.handle(evento());
    expect(r).toMatchObject({ status: "ok", detail: "entregue_sem_aviso" });
  });
});

describe("repetição", () => {
  it("cobrança já paga não é reprocessada", async () => {
    m.cobranca = { ...m.cobranca!, status: "paid" };
    const r = await confirmarPagamentoHandler.handle(evento());
    expect(r).toMatchObject({ status: "skipped", detail: "ja_confirmada" });
    expect(h.conferencias).toHaveLength(0);
  });

  it("cobrança de outra organização não é encontrada", async () => {
    m.cobranca = null;
    const r = await confirmarPagamentoHandler.handle(evento());
    expect(r).toMatchObject({ status: "skipped", detail: "cobranca_desconhecida" });
  });
});
