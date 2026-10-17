// @vitest-environment node
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { bancoFalso, operacao, type BancoFalso, type Cadeia, type Resposta } from "@/tests/helpers/banco-falso-da-cobranca";

/**
 * O REENVIO — a peça que faltava num caminho em que o cliente PAGAVA E NÃO
 * RECEBIA.
 *
 * Quando o aviso da entrega não sai (janela de 24 h fechada, contato que pediu
 * para não receber, organização suspensa), a entrega existe e o endereço não
 * chegou a ninguém — e o token em claro não existe em lugar nenhum, porque o
 * banco guarda só o hash.
 *
 * Os casos prendem as quatro decisões: só pedido PAGO, endereço NOVO com o
 * anterior revogado, a URL volta a quem opera (senão a janela fechada continua
 * sem saída), e o endereço nunca entra na auditoria.
 */

const ORG = "aaaaaaaa-0000-4000-8000-000000000001";
const PEDIDO = "bbbbbbbb-0000-4000-8000-000000000002";
const CONTATO = "cccccccc-0000-4000-8000-000000000003";
const USUARIO = "dddddddd-0000-4000-8000-000000000004";

const h = vi.hoisted(() => ({
  papelOk: true,
  suporteBloqueia: false,
  auditorias: [] as Array<Record<string, unknown>>,
  enviadas: [] as Array<Record<string, unknown>>,
  erroDoEnvio: null as Error | null,
  banco: undefined as unknown as BancoFalso,
}));

vi.mock("@/lib/auth/require-role", () => ({
  requireRole: async (papel: string) =>
    h.papelOk
      ? { ok: true, org: { orgId: ORG }, user: { id: USUARIO, idioma: "pt-BR" }, role: papel }
      : { ok: false, response: new Response("forbidden", { status: 403 }) },
}));
vi.mock("@/lib/impersonate/support", () => ({
  requireSupportWrite: async () =>
    h.suporteBloqueia ? new Response("suporte", { status: 403 }) : null,
}));
vi.mock("@/lib/audit", () => ({
  audit: async (a: Record<string, unknown>) => {
    h.auditorias.push(a);
  },
}));
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => h.banco.cliente }));
vi.mock("@/lib/env", () => ({
  env: { NEXT_PUBLIC_APP_URL: "https://crm.exemplo.com", INTERNAL_SECRET: "x" },
}));
vi.mock("@/app/api/v1/messages/_handler", () => ({
  sendMessageHandler: async (_a: unknown, _b: unknown, c: Record<string, unknown>) => {
    if (h.erroDoEnvio) throw h.erroDoEnvio;
    h.enviadas.push(c);
    return { id: "msg-1", status: "sent" };
  },
}));

import { ApiError } from "@/lib/api/types";
import { POST } from "./route";

interface Mundo {
  pedido: { id: string; status: string | null; contact_id: string | null } | null;
  arquivos: Array<{ id: string }>;
  conversa: { id: string } | null;
  /** A entrega VIVA do pedido, do jeito que o banco a devolve. */
  viva: { id: string; token_sha256: string | null } | null;
  /** O insert da entrega nova falha (disco, rede, corrida). */
  erroDoInsert: { code?: string; message: string } | null;
}
let m: Mundo;

function responder(c: Cadeia): Resposta {
  if (c.tabela === "orders") return { data: m.pedido };
  if (c.tabela === "order_items") return { data: [{ product_id: "prod-1" }] };
  if (c.tabela === "catalog_product_files") return { data: m.arquivos };
  if (c.tabela === "conversations") return { data: m.conversa };
  if (c.tabela === "order_deliveries") {
    if (operacao(c) === "insert") return m.erroDoInsert ? { error: m.erroDoInsert } : { data: null };
    if (operacao(c) === "update") return { data: null };
    // A PRIMEIRA leitura é a do `reenviarEntrega`, que procura a viva para
    // decidir se o acesso foi revogado de propósito. A segunda vem de
    // `prepararEntrega`, DEPOIS da revogação — e aí não pode achar nada, senão
    // ele devolveria `ja_entregue`.
    const jaLeu = h.banco.cadeias.filter(
      (x) => x.tabela === "order_deliveries" && operacao(x) === "select",
    ).length;
    return { data: jaLeu > 1 ? null : m.viva };
  }
  return {};
}

const reenviar = () =>
  POST(new NextRequest("http://localhost/api/v1/orders/x/entrega", { method: "POST" }), {
    params: Promise.resolve({ id: PEDIDO }),
  });

const cadeiasDe = (tabela: string, op: string) =>
  h.banco.cadeias.filter((c) => c.tabela === tabela && operacao(c) === op);

beforeEach(() => {
  vi.clearAllMocks();
  h.papelOk = true;
  h.suporteBloqueia = false;
  h.auditorias = [];
  h.enviadas = [];
  h.erroDoEnvio = null;
  m = {
    pedido: { id: PEDIDO, status: "paid", contact_id: CONTATO },
    arquivos: [{ id: "arq-1" }],
    conversa: { id: "conversa-1" },
    viva: { id: "entrega-1", token_sha256: "a".repeat(64) },
    erroDoInsert: null,
  };
  h.banco = bancoFalso(responder);
});

describe("quem pode reenviar", () => {
  it("recusa quem não alcança o papel", async () => {
    h.papelOk = false;
    expect((await reenviar()).status).toBe(403);
  });

  it("recusa sessão de suporte", async () => {
    h.suporteBloqueia = true;
    expect((await reenviar()).status).toBe(403);
  });
});

describe("só pedido pago", () => {
  it("recusa pedido que não está pago — seria entregar sem pagamento", async () => {
    m.pedido = { id: PEDIDO, status: "pending", contact_id: CONTATO };
    const r = await reenviar();
    expect(r.status).toBe(409);
    expect(cadeiasDe("order_deliveries", "update")).toHaveLength(0);
  });

  it("recusa pedido de outra organização", async () => {
    m.pedido = null;
    expect((await reenviar()).status).toBe(404);
  });

  it("recusa pedido sem arquivo para entregar", async () => {
    m.arquivos = [];
    expect((await reenviar()).status).toBe(422);
  });
});

describe("o endereço novo", () => {
  it("revoga o anterior ANTES de criar, e devolve a URL a quem opera", async () => {
    const r = await reenviar();
    expect(r.status).toBe(200);

    const revogacao = cadeiasDe("order_deliveries", "update")[0]!;
    const args = revogacao.passos[0]!.args[0] as Record<string, unknown>;
    expect(args.revogada_em).toBeTruthy();
    expect(args.motivo_revogacao).toBe("reenviada");
    // Só a VIVA é revogada: as antigas são histórico.
    expect(revogacao.passos.some((p) => p.metodo === "is" && p.args[0] === "revogada_em")).toBe(true);

    // A URL na resposta é o que resolve o caso da janela fechada.
    const corpo = (await r.json()) as { data: { url: string } };
    expect(corpo.data.url).toContain("/entrega/");
  });

  it("guarda o HASH do token novo, nunca o token", async () => {
    const r = await reenviar();
    const corpo = (await r.json()) as { data: { url: string } };
    const token = corpo.data.url.split("/entrega/")[1]!;

    const insercao = cadeiasDe("order_deliveries", "insert")[0]!;
    const args = insercao.passos[0]!.args[0] as Record<string, unknown>;
    expect(String(args.token_sha256)).toMatch(/^[0-9a-f]{64}$/);
    expect(args.token_sha256).not.toBe(token);
  });

  it("manda na conversa quando dá, e diz que mandou", async () => {
    const r = await reenviar();
    const corpo = (await r.json()) as { data: { avisado: boolean } };
    expect(corpo.data.avisado).toBe(true);
    expect(h.enviadas).toHaveLength(1);
  });

  it("aviso que NÃO sai ainda devolve o endereço — é o caso que motivou a rota", async () => {
    // Janela de 24 h fechada, ou contato que pediu para não receber. Reenviar
    // só pela conversa não resolveria nada aqui.
    h.erroDoEnvio = new ApiError(403, "forbidden", undefined, "req-1", "fora da janela");
    const r = await reenviar();
    expect(r.status).toBe(200);
    const corpo = (await r.json()) as { data: { avisado: boolean; url: string } };
    expect(corpo.data.avisado).toBe(false);
    expect(corpo.data.url).toContain("/entrega/");
  });
});

describe("o que o reenvio NÃO desfaz", () => {
  it("RECUSA quando o acesso foi revogado de propósito (LGPD ou reembolso)", async () => {
    // A redação de LGPD e a revogação por reembolso derrubam o acesso pondo
    // `token_sha256` em NULO, e NÃO mexem em `revogada_em` — a linha segue
    // "viva" para o índice parcial. Um reenvio ingênuo a revogaria e criaria um
    // token novo, DEVOLVENDO o acesso que o apagamento tinha destruído.
    m.viva = { id: "entrega-1", token_sha256: null };
    const r = await reenviar();
    expect(r.status).toBe(409);
    // E não chega a mexer em nada.
    expect(cadeiasDe("order_deliveries", "update")).toHaveLength(0);
    expect(cadeiasDe("order_deliveries", "insert")).toHaveLength(0);
    expect(h.auditorias).toHaveLength(0);
  });

  it("falha ao criar a nova DEVOLVE a revogação — senão o comprador fica sem nada", async () => {
    // Era o pior estado possível: o endereço que ele tinha deixava de abrir e
    // nenhum novo nascia. O hash nunca foi tocado, então desfazer a revogação
    // faz o endereço antigo voltar a funcionar.
    m.erroDoInsert = { message: "disco cheio" };
    const r = await reenviar();
    expect(r.status).toBe(500);

    const updates = cadeiasDe("order_deliveries", "update");
    expect(updates).toHaveLength(2);
    const volta = updates[1]!.passos[0]!.args[0] as Record<string, unknown>;
    expect(volta.revogada_em).toBeNull();
    expect(volta.motivo_revogacao).toBeNull();
  });

  it("pedido que nunca teve entrega não tenta revogar nada", async () => {
    m.viva = null;
    const r = await reenviar();
    expect(r.status).toBe(200);
    expect(cadeiasDe("order_deliveries", "update")).toHaveLength(0);
  });
});

describe("a auditoria", () => {
  it("registra quem reenviou e NÃO guarda o endereço", async () => {
    const r = await reenviar();
    const corpo = (await r.json()) as { data: { url: string } };
    const token = corpo.data.url.split("/entrega/")[1]!;

    const a = h.auditorias[0]!;
    expect(a.action).toBe("pagamento.entrega_reenviada");
    expect(a.actorUserId).toBe(USUARIO);
    // O endereço é credencial: a auditoria é lida por mais gente que o pedido.
    expect(JSON.stringify(a)).not.toContain(token);
    expect(JSON.stringify(a)).not.toContain("/entrega/");
  });
});
