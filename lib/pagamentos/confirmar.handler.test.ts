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
  /** `status` de `organizations`: a régua de "parada" da casa. */
  statusDaOrg: string;
  cobranca: Record<string, unknown> | null;
  arquivos: Array<{ id: string }>;
  entregaExistente: { id: string; expira_em: string } | null;
  /** O 23505 do índice `order_deliveries_uma_viva_por_pedido`. */
  erroDoInsertDaEntrega: { code: string; message: string } | null;
  conversa: { id: string } | null;
}
let m: Mundo;

function responder(c: Cadeia): Resposta {
  if (c.tabela === "organizations") return { data: { status: m.statusDaOrg } };
  if (c.tabela === "payment_charges") return { data: m.cobranca };
  if (c.tabela === "order_items") return { data: [{ product_id: "prod-1" }] };
  if (c.tabela === "catalog_product_files") return { data: m.arquivos };
  if (c.tabela === "order_deliveries") {
    if (operacao(c) === "insert" && m.erroDoInsertDaEntrega) {
      return { error: m.erroDoInsertDaEntrega };
    }
    return { data: m.entregaExistente };
  }
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
    statusDaOrg: "active",
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
    erroDoInsertDaEntrega: null,
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
    // o link vale 30 dias — mas NÃO há como reenviá-lo hoje (ver o cabeçalho do
    // handler). O que este caso prende é que a falha do aviso não desfaz a
    // entrega: desfazer deixaria o pedido pago sem entrega nenhuma.
    h.erroDoEnvio = new Error("forbidden");
    const r = await confirmarPagamentoHandler.handle(evento());
    expect(r).toMatchObject({ status: "ok", detail: "entregue_sem_aviso" });
  });
});

describe("organização parada", () => {
  it("SUSPENSA segue: quem pagou foi o cliente final", async () => {
    // A empresa deve a mensalidade à instalação. O comprador não tem nada a ver
    // com isso, e recusar o registro não desfaz o pagamento — só esconde que
    // aconteceu. E `skipped` conta como consumido: o aviso morria ali.
    m.statusDaOrg = "suspended";
    const r = await confirmarPagamentoHandler.handle(evento());
    expect(r).toMatchObject({ status: "ok", detail: "entregue" });
  });

  it.each(["redacted", "archived"])("%s NÃO confirma nem entrega", async (status) => {
    // "Parada" na régua da casa é `status != 'active'`, e isso inclui apagada
    // por LGPD e encerrada. Confirmar venda e entregar arquivo nessas duas
    // estaria errado — e é por isso que a separação é feita no handler, já que
    // o dispatcher só oferece `roda` ou `pula`.
    m.statusDaOrg = status;
    const r = await confirmarPagamentoHandler.handle(evento());
    expect(r).toMatchObject({ status: "skipped", detail: "organizacao_encerrada" });
    expect(h.conferencias).toHaveLength(0);
    expect(h.enviadas).toHaveLength(0);
  });
});

describe("repetição", () => {
  it("cobrança já paga com entrega feita não reenvia nada", async () => {
    m.cobranca = { ...m.cobranca!, status: "paid" };
    m.entregaExistente = { id: "entrega-1", expira_em: "2026-12-01T00:00:00Z" };
    const r = await confirmarPagamentoHandler.handle(evento());
    expect(r).toMatchObject({ status: "ok", detail: "ja_entregue" });
    expect(h.conferencias).toHaveLength(0);
    expect(h.enviadas).toHaveLength(0);
  });

  it("cobrança paga SEM entrega termina o serviço — era aqui que o comprador se perdia", async () => {
    // A baixa acontece antes da entrega. Se a entrega falhar por motivo
    // passageiro, a fila repete — e a repetição PARAVA em "ja_confirmada": o
    // cliente pagava e nunca recebia. Agora ela entrega.
    m.cobranca = { ...m.cobranca!, status: "paid" };
    m.entregaExistente = null;
    const r = await confirmarPagamentoHandler.handle(evento());
    expect(r).toMatchObject({ status: "ok", detail: "entregue" });
    expect(h.enviadas).toHaveLength(1);
  });

  it("entrega que perde a corrida do índice único NÃO manda um segundo link", async () => {
    // Dois avisos simultâneos leem "não há entrega" e os dois inserem; quem
    // perde leva 23505. Sem a distinção, o perdedor mandaria outro link válido.
    m.erroDoInsertDaEntrega = { code: "23505", message: "duplicate key" };
    const r = await confirmarPagamentoHandler.handle(evento());
    expect(r).toMatchObject({ status: "ok", detail: "ja_entregue" });
    expect(h.enviadas).toHaveLength(0);
  });

  it("cobrança de outra organização não é encontrada", async () => {
    m.cobranca = null;
    const r = await confirmarPagamentoHandler.handle(evento());
    expect(r).toMatchObject({ status: "skipped", detail: "cobranca_desconhecida" });
  });
});
