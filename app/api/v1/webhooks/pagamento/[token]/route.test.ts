import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { bancoFalso, operacao, type BancoFalso, type Cadeia, type Resposta } from "@/tests/helpers/banco-falso-da-cobranca";

/**
 * A rota do aviso de pagamento GRAVA e responde. Os casos aqui prendem as duas
 * promessas que sustentam o caminho do dinheiro:
 *
 *   - ela NUNCA marca pagamento nem entrega produto (quem decide é o worker,
 *     depois de conferir o recibo público);
 *   - o segundo aviso da mesma cobrança não emite um segundo evento, senão o
 *     produto sai duas vezes.
 */

const h = vi.hoisted(() => ({
  permitido: true,
  baldes: [] as string[],
  aviso: vi.fn(),
  erro: vi.fn(),
  banco: undefined as unknown as BancoFalso,
}));
vi.mock("@/lib/ai/dispatcher/rate-limit", () => ({
  checkRateLimit: async (balde: string) => {
    h.baldes.push(balde);
    return { allowed: h.permitido };
  },
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => h.banco.cliente }));
vi.mock("@/lib/logger", () => ({ logger: { warn: h.aviso, error: h.erro, info: vi.fn() } }));

import { POST } from "./route";

const ORG = "cccccccc-0000-4000-8000-000000000001";
const COBRANCA = "11111111-2222-4333-8444-555555555555";
const TOKEN = "a".repeat(48);

const AVISO = {
  amount: 100,
  paid_amount: 100,
  order_nsu: COBRANCA,
  invoice_slug: "uiQGUOC9io",
  capture_method: "pix",
  transaction_nsu: "d8846e38-8d8a-4c8f-a0ad-6922b3a5a346",
  receipt_url: "https://recibo.infinitepay.io/d8846e38-8d8a-4c8f-a0ad-6922b3a5a346",
};

interface Mundo {
  conta: { id: string; organization_id: string; provider: string; is_active: boolean } | null;
  erroDaConta: { code?: string; message: string } | null;
  logDuplicado: boolean;
}
let m: Mundo;

function responder(c: Cadeia): Resposta {
  if (c.tabela === "payment_provider_credentials") {
    return m.erroDaConta ? { error: m.erroDaConta } : { data: m.conta };
  }
  if (c.tabela === "webhook_events_log") {
    return m.logDuplicado ? { error: { code: "23505", message: "dup" } } : { data: { id: "linha-1" } };
  }
  if (c.tabela === "event_log") return { data: { id: "evento-1" } };
  return {};
}

const pedido = (token = TOKEN, corpo: unknown = AVISO) =>
  POST(
    new NextRequest(`http://localhost/api/v1/webhooks/pagamento/${token}`, {
      method: "POST",
      body: typeof corpo === "string" ? corpo : JSON.stringify(corpo),
      headers: { "x-forwarded-for": "10.0.0.1" },
    }),
    { params: Promise.resolve({ token }) },
  );

const escritas = (tabela: string) =>
  h.banco.cadeias.filter((c) => c.tabela === tabela && operacao(c) === "insert");

beforeEach(() => {
  vi.clearAllMocks();
  h.permitido = true;
  h.baldes = [];
  m = {
    conta: { id: "conta-1", organization_id: ORG, provider: "infinitepay", is_active: true },
    erroDaConta: null,
    logDuplicado: false,
  };
  h.banco = bancoFalso(responder);
});

describe("o caminho feliz", () => {
  it("grava o aviso, emite o evento e responde 200", async () => {
    const r = await pedido();
    expect(r.status).toBe(200);
    expect(escritas("webhook_events_log")).toHaveLength(1);
    expect(escritas("event_log")).toHaveLength(1);
  });

  it("grava no LOG antes de emitir o evento", async () => {
    await pedido();
    // Na ordem inversa a reentrega emitiria um segundo evento antes de o
    // registro existir — e o produto sairia duas vezes.
    const ordem = h.banco.cadeias.map((c) => c.tabela);
    expect(ordem.indexOf("webhook_events_log")).toBeLessThan(ordem.indexOf("event_log"));
  });

  it("NUNCA toca em payment_charges — não é ela quem decide pagamento", async () => {
    await pedido();
    expect(h.banco.cadeias.some((c) => c.tabela === "payment_charges")).toBe(false);
  });

  it("não grava o corpo cru, que leva o endereço do recibo do pagador", async () => {
    await pedido();
    const args = escritas("webhook_events_log")[0]!.passos[0]!.args[0] as Record<string, unknown>;
    expect(args.raw_body).toBeUndefined();
    expect(args.organization_id).toBe(ORG);
    expect(args.external_id).toBe(AVISO.invoice_slug);
  });

  it("não guarda o token do caminho na linha do log", async () => {
    await pedido();
    const args = escritas("webhook_events_log")[0]!.passos[0]!.args[0] as Record<string, unknown>;
    expect(args.webhook_path_token).toBeNull();
  });
});

describe("a reentrega do provedor", () => {
  it("responde 200 e NÃO emite segundo evento quando o aviso repete", async () => {
    m.logDuplicado = true;
    const r = await pedido();
    expect(r.status).toBe(200);
    await expect(r.json()).resolves.toMatchObject({ data: { repetido: true } });
    expect(escritas("event_log")).toHaveLength(0);
  });
});

describe("o token", () => {
  it("recusa formato errado sem nem ir ao banco", async () => {
    const r = await pedido("curto-demais");
    expect(r.status).toBe(404);
    expect(h.banco.cadeias).toHaveLength(0);
  });

  it("responde 404 (e não 401) para token desconhecido", async () => {
    m.conta = null;
    const r = await pedido();
    // 401 contaria a quem sondou que o endereço existe e falta credencial.
    expect(r.status).toBe(404);
  });

  it("responde 404 para conta desativada", async () => {
    m.conta = { ...m.conta!, is_active: false };
    expect((await pedido()).status).toBe(404);
  });

  it("responde 404 quando a conta é de outro provedor", async () => {
    m.conta = { ...m.conta!, provider: "outro" };
    expect((await pedido()).status).toBe(404);
  });

  it("limita a taxa de RECUSAS por IP", async () => {
    m.conta = null;
    h.permitido = false;
    const r = await pedido();
    expect(r.status).toBe(429);
    expect(h.baldes[0]).toContain("10.0.0.1");
  });
});

describe("avisos que não servem", () => {
  it("responde 400 para corpo que não é JSON", async () => {
    expect((await pedido(TOKEN, "nao e json")).status).toBe(400);
  });

  it("responde 400 para o payload que a documentação oficial descreve, com `slug`", async () => {
    const { invoice_slug, ...resto } = AVISO;
    const r = await pedido(TOKEN, { ...resto, slug: invoice_slug });
    expect(r.status).toBe(400);
    expect(escritas("event_log")).toHaveLength(0);
  });

  it("grava mas NÃO emite quando a referência não tem a nossa forma", async () => {
    // order_nsu vai para `event_log.entity_id`, que é uuid. Texto qualquer ali
    // estouraria 22P02, viraria 503 e o provedor reentregaria para sempre.
    const r = await pedido(TOKEN, { ...AVISO, order_nsu: "teste-webhook-pablo-004" });
    expect(r.status).toBe(200);
    expect(escritas("webhook_events_log")).toHaveLength(1);
    expect(escritas("event_log")).toHaveLength(0);
  });
});

describe("falha de infraestrutura", () => {
  it("responde 503 (não 404) quando a leitura da conta falha", async () => {
    // 404 ensinaria o provedor a desistir de um aviso que ainda vale.
    m.erroDaConta = { message: "conexão caiu" };
    expect((await pedido()).status).toBe(503);
  });
});
