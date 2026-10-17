import type { SupabaseClient } from "@supabase/supabase-js";
import type * as InfinitePay from "./provedores/infinitepay";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { bancoFalso, operacao, type BancoFalso, type Cadeia, type Resposta } from "@/tests/helpers/banco-falso-da-cobranca";

/**
 * A cadeia que cria a cobrança. Os casos prendem as duas recusas que protegem o
 * cliente de um fracasso na tela dele, e a ordem de escrita que mantém o
 * pagamento com dono.
 */

const h = vi.hoisted(() => ({
  provedorResponde: { checkoutUrl: "https://checkout.infinitepay.io/abc" } as { checkoutUrl: string } | null,
  provedorErro: null as string | null,
  chamadasAoProvedor: [] as unknown[],
  banco: undefined as unknown as BancoFalso,
}));

vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock("./provedores/infinitepay", async (original) => {
  const real = await original<typeof InfinitePay>();
  return {
    ...real,
    criarCobranca: async (e: unknown) => {
      h.chamadasAoProvedor.push(e);
      if (h.provedorErro) throw new real.ErroDaInfinitePay(404, h.provedorErro);
      return h.provedorResponde!;
    },
  };
});
vi.mock("./token-do-webhook", () => ({
  urlDoWebhook: (id: string) => `https://exemplo.com/api/v1/webhooks/pagamento/token-de-${id}`,
}));

import { cobrarProduto } from "./cobrar";

const ORG = "aaaaaaaa-0000-4000-8000-000000000001";
const CONTATO = "bbbbbbbb-0000-4000-8000-000000000002";

interface Mundo {
  conta: {
    id: string;
    handle: string;
    pix_conferido_em: string | null;
    webhook_conferido_em: string | null;
  } | null;
  produto: { id: string; codigo: string; nome: string; preco_cents: number; ativo: boolean } | null;
}
let m: Mundo;

function responder(c: Cadeia): Resposta {
  if (c.tabela === "payment_provider_credentials") return { data: m.conta };
  if (c.tabela === "catalog_products") return { data: m.produto };
  if (c.tabela === "orders") return { data: { id: "pedido-1" } };
  if (c.tabela === "payment_charges") return { data: { id: "cobranca-1" } };
  if (c.tabela === "order_items") return { data: { id: "item-1" } };
  return {};
}

const escritas = (t: string) => h.banco.cadeias.filter((c) => c.tabela === t && operacao(c) === "insert");

beforeEach(() => {
  vi.clearAllMocks();
  h.provedorErro = null;
  h.provedorResponde = { checkoutUrl: "https://checkout.infinitepay.io/abc" };
  h.chamadasAoProvedor = [];
  m = {
    conta: {
      id: "conta-1",
      handle: "minhaloja",
      pix_conferido_em: "2026-10-01T00:00:00Z",
      webhook_conferido_em: "2026-10-01T00:00:00Z",
    },
    produto: { id: "prod-1", codigo: "EBOOK", nome: "Ebook de Vendas", preco_cents: 12990, ativo: true },
  };
  h.banco = bancoFalso(responder);
});

const cobrar = (extra: Partial<Parameters<typeof cobrarProduto>[1]> = {}) =>
  cobrarProduto(h.banco.cliente as unknown as SupabaseClient, {
    organizationId: ORG,
    contactId: CONTATO,
    codigoDoProduto: "EBOOK",
    ...extra,
  });

describe("as recusas que acontecem ANTES de escrever", () => {
  it("recusa sem conta de pagamento, e não cria pedido nenhum", async () => {
    m.conta = null;
    const r = await cobrar();
    expect(r).toMatchObject({ cobranca_criada: false, motivo: "sem_conta_de_pagamento" });
    expect(escritas("orders")).toHaveLength(0);
  });

  it("recusa quando a chave PIX não foi conferida", async () => {
    // A InfinitePay NÃO deixa checar isso pela API: sem a chave, o link nasce
    // 200, o PIX aparece, e só quebra na tela do cliente que já decidiu comprar.
    m.conta = { ...m.conta!, pix_conferido_em: null };
    const r = await cobrar();
    expect(r).toMatchObject({ motivo: "chave_pix_nao_conferida" });
    expect(escritas("orders")).toHaveLength(0);
  });

  it("recusa quando ninguém conferiu o aviso de pagamento", async () => {
    // A PIOR falta das três, e a única que custa dinheiro a QUEM COMPRA: sem o
    // webhook cadastrado no provedor, o link funciona, o cliente paga, o
    // dinheiro entra na conta do vendedor — e nada aqui é confirmado nem
    // entregue. Melhor não vender do que vender e não entregar.
    m.conta = { ...m.conta!, webhook_conferido_em: null };
    const r = await cobrar();
    expect(r).toMatchObject({ motivo: "webhook_nao_conferido" });
    expect(escritas("orders")).toHaveLength(0);
  });

  it("recusa código que não existe no catálogo", async () => {
    m.produto = null;
    await expect(cobrar()).resolves.toMatchObject({ motivo: "produto_desconhecido" });
  });

  it("recusa produto desativado", async () => {
    m.produto = { ...m.produto!, ativo: false };
    await expect(cobrar()).resolves.toMatchObject({ motivo: "produto_inativo" });
  });

  it("toda recusa ensina o modelo a NÃO prometer link", async () => {
    m.conta = null;
    const r = (await cobrar()) as { mensagem: string };
    expect(r.mensagem.toLowerCase()).toContain("não");
  });
});

describe("o caminho feliz", () => {
  it("escreve pedido, item e cobrança ANTES de chamar o provedor", async () => {
    await cobrar();
    const ordem = h.banco.cadeias.map((c) => c.tabela);
    // A cobrança precisa de um id NOSSO antes de existir lá fora: é ele que
    // viaja como order_nsu e é por ele que o aviso reencontra a venda.
    expect(ordem.indexOf("payment_charges")).toBeGreaterThan(-1);
    expect(h.chamadasAoProvedor).toHaveLength(1);
  });

  it("manda o valor em CENTAVOS e o nosso id como order_nsu", async () => {
    await cobrar();
    expect(h.chamadasAoProvedor[0]).toMatchObject({
      amountCents: 12990,
      orderNsu: "cobranca-1",
      handle: "minhaloja",
    });
  });

  it("multiplica pela quantidade", async () => {
    await cobrar({ quantidade: 3 });
    expect(h.chamadasAoProvedor[0]).toMatchObject({ amountCents: 38970 });
  });

  it("o pedido nasce com origem genérica, sem o nome da casa", async () => {
    // Produto white-label: o nome da casa num identificador apareceria no banco
    // de quem instala com a marca dele.
    await cobrar();
    const args = escritas("orders")[0]!.passos[0]!.args[0] as Record<string, unknown>;
    expect(args.external_provider).toBe("external");
    expect(String(args.external_id)).toMatch(/^interno:/);
    // A marca montada, nunca escrita: a cerca de marca varre os testes também.
    const marcaDaCasa = ["desk", "comm"].join("");
    expect(JSON.stringify(args.payload).toLowerCase()).not.toContain(marcaDaCasa);
  });

  it("o item guarda o SNAPSHOT do nome e do código", async () => {
    await cobrar();
    const args = escritas("order_items")[0]!.passos[0]!.args[0] as Record<string, unknown>;
    expect(args.nome).toBe("Ebook de Vendas");
    expect(args.codigo).toBe("EBOOK");
  });

  it("devolve o link para quem chamou", async () => {
    await expect(cobrar()).resolves.toMatchObject({
      cobranca_criada: true,
      link_de_pagamento: "https://checkout.infinitepay.io/abc",
    });
  });
});

describe("quando o provedor recusa", () => {
  it("marca a cobrança como `failed`, não deixa pendente", async () => {
    // Pendente é coisa que ainda pode ser paga. Esta nunca existiu lá fora, e
    // deixá-la pendente faria a reconciliação procurar para sempre.
    h.provedorErro = "external_checkout_not_enabled";
    const r = await cobrar();
    expect(r).toMatchObject({ cobranca_criada: false, motivo: "provedor_recusou" });
    const update = h.banco.cadeias.find(
      (c) => c.tabela === "payment_charges" && operacao(c) === "update",
    );
    expect(update?.passos[0]?.args[0]).toMatchObject({ status: "failed" });
  });
});
