import { beforeEach, describe, expect, it, vi } from "vitest";

import { bancoFalso, operacao, type BancoFalso, type Cadeia, type Resposta } from "@/tests/helpers/banco-falso-da-cobranca";

/**
 * A rota da conta que RECEBE o dinheiro. Os casos prendem três coisas: só
 * `admin` mexe, o segredo nunca sai, e trocar de conta derruba o carimbo da
 * chave PIX — senão o sistema cobraria numa conta cuja chave ninguém olhou.
 */

const ORG = "aaaaaaaa-0000-4000-8000-000000000001";
const USUARIO = "dddddddd-0000-4000-8000-000000000004";

const h = vi.hoisted(() => ({
  papelOk: true,
  suporteBloqueia: false,
  auditorias: [] as Array<Record<string, unknown>>,
  banco: undefined as unknown as BancoFalso,
}));

vi.mock("@/lib/auth/require-role", () => ({
  requireRole: async (papel: string) =>
    h.papelOk
      ? { ok: true, org: { orgId: ORG }, user: { id: USUARIO }, role: papel }
      : { ok: false, response: new Response("forbidden", { status: 403 }) },
}));
vi.mock("@/lib/impersonate/support", () => ({
  requireSupportWrite: async () =>
    h.suporteBloqueia ? new Response("suporte", { status: 403 }) : null,
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => h.banco.cliente }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => h.banco.cliente }));
vi.mock("@/lib/audit", () => ({
  audit: async (a: Record<string, unknown>) => {
    h.auditorias.push(a);
  },
}));
vi.mock("@/lib/env", () => ({
  env: { INTERNAL_SECRET: "segredo-de-teste", NEXT_PUBLIC_APP_URL: "https://crm.exemplo.com" },
}));

import { GET, PATCH, PUT } from "./route";

interface Mundo {
  conta: { id: string; handle: string; pix_conferido_em: string | null } | null;
}
let m: Mundo;

function responder(c: Cadeia): Resposta {
  if (c.tabela === "payment_provider_credentials_safe") {
    return { data: m.conta ? { ...m.conta, is_active: true } : null };
  }
  if (c.tabela === "payment_provider_credentials") {
    if (operacao(c) === "update") return { data: m.conta ? { id: m.conta.id } : null };
    return { data: m.conta };
  }
  return {};
}

const put = (handle: string) =>
  PUT(
    new Request("http://localhost/api/v1/pagamentos/conta", {
      method: "PUT",
      body: JSON.stringify({ handle }),
      headers: { "Content-Type": "application/json" },
    }),
  );

beforeEach(() => {
  vi.clearAllMocks();
  h.papelOk = true;
  h.suporteBloqueia = false;
  h.auditorias = [];
  m = { conta: null };
  h.banco = bancoFalso(responder);
});

describe("quem pode mexer", () => {
  it("recusa quem não é admin", async () => {
    h.papelOk = false;
    expect((await put("loja")).status).toBe(403);
  });

  it("recusa sessão de suporte", async () => {
    // Para onde vai o dinheiro das vendas não é coisa que sessão emprestada muda.
    h.suporteBloqueia = true;
    expect((await put("loja")).status).toBe(403);
  });
});

describe("o segredo nunca sai", () => {
  it("a leitura devolve a URL do webhook, mas o token não está no banco", async () => {
    m.conta = { id: "conta-1", handle: "minhaloja", pix_conferido_em: null };
    const corpo = (await (await GET()).json()) as { data: { webhook_url: string } };
    expect(corpo.data.webhook_url).toContain("/api/v1/webhooks/pagamento/");
    // Ela é DERIVADA do segredo da instalação — por isso a tela mostra um
    // endereço que não existe em coluna nenhuma.
    const lidas = h.banco.cadeias.find((c) => c.tabela === "payment_provider_credentials_safe");
    expect(JSON.stringify(lidas?.passos)).not.toContain("token");
  });

  it("a gravação guarda o HASH do token, nunca o token", async () => {
    const r = await put("minhaloja");
    expect(r.status).toBe(200);
    const insert = h.banco.cadeias.find(
      (c) => c.tabela === "payment_provider_credentials" && operacao(c) === "upsert",
    )!;
    const args = insert.passos[0]!.args[0] as Record<string, unknown>;
    expect(String(args.webhook_path_token_sha256)).toMatch(/^[0-9a-f]{64}$/);
    expect(args).not.toHaveProperty("webhook_path_token");
  });

  it("a auditoria registra o handle (que é público) e nada de segredo", async () => {
    await put("minhaloja");
    const a = h.auditorias[0]!;
    expect(a.action).toBe("pagamento.conta_configurada");
    expect(JSON.stringify(a)).not.toMatch(/[0-9a-f]{64}/);
  });
});

describe("a InfiniteTag", () => {
  it("aceita com cifrão e guarda sem", async () => {
    await put("$minhaloja");
    const insert = h.banco.cadeias.find(
      (c) => c.tabela === "payment_provider_credentials" && operacao(c) === "upsert",
    )!;
    expect((insert.passos[0]!.args[0] as Record<string, unknown>).handle).toBe("minhaloja");
  });

  it("recusa tag com espaço", async () => {
    expect((await put("minha loja")).status).toBe(422);
  });
});

describe("trocar de conta", () => {
  it("DERRUBA o carimbo da chave PIX", async () => {
    // A chave conferida era da conta ANTERIOR. Deixar o carimbo de pé faria o
    // sistema cobrar numa conta cuja chave ninguém olhou — e o PIX falharia na
    // tela do cliente.
    m.conta = { id: "conta-1", handle: "antiga", pix_conferido_em: "2026-10-01T00:00:00Z" };
    await put("nova");
    const insert = h.banco.cadeias.find(
      (c) => c.tabela === "payment_provider_credentials" && operacao(c) === "upsert",
    )!;
    const args = insert.passos[0]!.args[0] as Record<string, unknown>;
    expect(args.pix_conferido_em).toBeNull();
    expect(args.pix_conferido_por).toBeNull();
  });

  it("salvar a MESMA tag não derruba o carimbo", async () => {
    m.conta = { id: "conta-1", handle: "minhaloja", pix_conferido_em: "2026-10-01T00:00:00Z" };
    await put("minhaloja");
    const insert = h.banco.cadeias.find(
      (c) => c.tabela === "payment_provider_credentials" && operacao(c) === "upsert",
    )!;
    expect(insert.passos[0]!.args[0]).not.toHaveProperty("pix_conferido_em");
  });
});

describe("o carimbo da chave PIX", () => {
  it("registra QUEM assinou", async () => {
    m.conta = { id: "conta-1", handle: "minhaloja", pix_conferido_em: null };
    const r = await PATCH();
    expect(r.status).toBe(200);
    const update = h.banco.cadeias.find(
      (c) => c.tabela === "payment_provider_credentials" && operacao(c) === "update",
    )!;
    expect((update.passos[0]!.args[0] as Record<string, unknown>).pix_conferido_por).toBe(USUARIO);
    expect(h.auditorias[0]!.action).toBe("pagamento.chave_pix_conferida");
  });

  it("recusa carimbar antes de existir conta", async () => {
    m.conta = null;
    expect((await PATCH()).status).toBe(404);
  });
});
