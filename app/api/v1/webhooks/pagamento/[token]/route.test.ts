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
const TOKEN = "a".repeat(64);

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
  /** A cobrança que a rota acha ao perguntar por (id, organização). */
  cobranca: { id: string } | null;
  erroDaCobranca: { code?: string; message: string } | null;
  /** O evento já emitido que a busca do ramo "repetido" encontra. */
  eventoJaEmitido: { id: string } | null;
}
let m: Mundo;

function responder(c: Cadeia): Resposta {
  if (c.tabela === "payment_provider_credentials") {
    return m.erroDaConta ? { error: m.erroDaConta } : { data: m.conta };
  }
  if (c.tabela === "payment_charges") {
    return m.erroDaCobranca ? { error: m.erroDaCobranca } : { data: m.cobranca };
  }
  if (c.tabela === "webhook_events_log") {
    return m.logDuplicado ? { error: { code: "23505", message: "dup" } } : { data: { id: "linha-1" } };
  }
  if (c.tabela === "event_log") {
    if (operacao(c) === "select") return { data: m.eventoJaEmitido };
    return { data: { id: "evento-1" } };
  }
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
    cobranca: { id: COBRANCA },
    erroDaCobranca: null,
    eventoJaEmitido: null,
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

  it("NUNCA ESCREVE em payment_charges — não é ela quem decide pagamento", async () => {
    // Ela LÊ, para saber de quem é a cobrança. Escrever seria marcar pagamento
    // sem conferir o recibo, que é o que o CHECK do banco recusa de qualquer
    // forma — mas o lugar de recusar isso é aqui, antes de tentar.
    await pedido();
    expect(escritas("payment_charges")).toHaveLength(0);
    expect(h.banco.cadeias.some((c) => c.tabela === "payment_charges")).toBe(true);
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
    m.eventoJaEmitido = { id: "evento-1" };
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

  it("não emite quando a referência não tem a nossa forma (22P02)", async () => {
    // order_nsu é comparado com `payment_charges.id`, que é uuid. Texto
    // qualquer faz o Postgres recusar com 22P02 — e isso não é falha nossa, é
    // aviso que não é nosso. 200 para o provedor parar de reentregar.
    m.erroDaCobranca = { code: "22P02", message: "invalid input syntax for type uuid" };
    const r = await pedido(TOKEN, { ...AVISO, order_nsu: "teste-webhook-pablo-004" });
    expect(r.status).toBe(200);
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

describe("a cobrança referida", () => {
  it("IGNORA aviso que aponta para cobrança de OUTRA organização", async () => {
    // O token resolve a organização; o order_nsu vem do corpo. Sem perguntar
    // "esta cobrança é desta organização?", nascia evento com organization_id
    // de A apontando para entidade de B.
    m.cobranca = null;
    const r = await pedido();
    expect(r.status).toBe(200);
    await expect(r.json()).resolves.toMatchObject({ data: { ignorado: true } });
    expect(escritas("event_log")).toHaveLength(0);
    expect(escritas("webhook_events_log")).toHaveLength(0);
  });

  it("pergunta pela cobrança filtrando organização, não só por id", async () => {
    await pedido();
    const c = h.banco.cadeias.find((x) => x.tabela === "payment_charges")!;
    const colunas = c.passos.filter((p) => p.metodo === "eq").map((p) => p.args[0]);
    expect(colunas).toContain("id");
    expect(colunas).toContain("organization_id");
  });

  it("responde 503 quando a leitura da cobrança falha de verdade", async () => {
    m.erroDaCobranca = { message: "conexão caiu" };
    expect((await pedido()).status).toBe(503);
  });
});

describe("a reentrega depois de uma falha no meio", () => {
  it("EMITE o evento quando o log ja existe mas o evento nao", async () => {
    // Era o defeito: o 1o insert passou, o 2o falhou, a rota pediu reentrega —
    // e a reentrega batia no 23505 e respondia 200 sem emitir. O retry do
    // provedor neutralizava a si mesmo e o produto nunca saia.
    m.logDuplicado = true;
    m.eventoJaEmitido = null;
    const r = await pedido();
    expect(r.status).toBe(200);
    expect(escritas("event_log")).toHaveLength(1);
  });

  it("NAO emite de novo quando o evento ja existe", async () => {
    m.logDuplicado = true;
    m.eventoJaEmitido = { id: "evento-1" };
    const r = await pedido();
    await expect(r.json()).resolves.toMatchObject({ data: { repetido: true } });
    expect(escritas("event_log")).toHaveLength(0);
  });
});

describe("o token do caminho", () => {
  it("e procurado pelo HASH, nunca em claro", async () => {
    await pedido();
    const c = h.banco.cadeias.find((x) => x.tabela === "payment_provider_credentials")!;
    const eq = c.passos.find((p) => p.metodo === "eq")!;
    expect(eq.args[0]).toBe("webhook_path_token_sha256");
    // sha256 do token de teste, em hex: 64 caracteres, e != do token enviado
    expect(String(eq.args[1])).toMatch(/^[0-9a-f]{64}$/);
    expect(eq.args[1]).not.toBe(TOKEN);
  });
});
