import { beforeEach, describe, expect, it, vi } from "vitest";

import { bancoFalso, type BancoFalso, type Cadeia, type Resposta } from "@/tests/helpers/banco-falso-da-cobranca";

/**
 * A FERRAMENTA DE COBRAR não tinha teste nenhum — e ela é a única peça do
 * caminho do dinheiro que o MODELO aciona.
 *
 * Os casos aqui prendem as duas coisas que o modelo pode errar e que custam
 * caro: **cobrar uma pessoa e entregar a outra** (contato e conversa chegam
 * soltos, e são usados para fins diferentes), e **ver o endereço do link** —
 * que ele não pode ter, porque o caminho dele corrompe texto com ponto.
 */

const ORG = "aaaaaaaa-0000-4000-8000-000000000001";
const CONTATO = "cccccccc-0000-4000-8000-000000000001";
const OUTRO_CONTATO = "cccccccc-0000-4000-8000-000000000002";
const CONVERSA = "dddddddd-0000-4000-8000-000000000001";

const h = vi.hoisted(() => ({
  cobrou: 0,
  enviadas: [] as Array<Record<string, unknown>>,
  banco: undefined as unknown as BancoFalso,
}));

vi.mock("@/lib/pagamentos/cobrar", () => ({
  cobrarProduto: async () => {
    h.cobrou += 1;
    return {
      cobranca_criada: true,
      charge_id: "cob-1",
      order_id: "ped-1",
      link_de_pagamento: "https://checkout.exemplo.com/abc.def",
      valor_cents: 12990,
      produto: "Curso",
    };
  },
}));
vi.mock("@/app/api/v1/messages/_handler", () => ({
  sendMessageHandler: async (_a: unknown, _b: unknown, c: Record<string, unknown>) => {
    h.enviadas.push(c);
    return { id: "msg-1", status: "sent" };
  },
}));

import { crmCobrarProduto } from "./pagamentos";

interface Mundo {
  donoDaConversa: string | null;
  contatoDoTurno: string | undefined;
}
let m: Mundo;

function responder(c: Cadeia): Resposta {
  if (c.tabela === "conversations") {
    return { data: m.donoDaConversa ? { contact_id: m.donoDaConversa } : null };
  }
  return {};
}

const ENTRADA = {
  conversation_id: CONVERSA,
  contact_id: CONTATO,
  codigo_do_produto: "CURSO-1",
};

const cobrar = (entrada: Record<string, unknown> = {}) =>
  crmCobrarProduto.handler({ ...ENTRADA, ...entrada } as never, {
    supabase: h.banco.cliente,
    organizationId: ORG,
    actor: { type: "ai_agent", id: "a" },
    requestId: "r",
    ...(m.contatoDoTurno ? { contatoDoTurno: m.contatoDoTurno } : {}),
  } as never);

beforeEach(() => {
  vi.clearAllMocks();
  h.cobrou = 0;
  h.enviadas = [];
  m = { donoDaConversa: CONTATO, contatoDoTurno: CONTATO };
  h.banco = bancoFalso(responder);
});

describe("cobrar um e entregar a outro", () => {
  it("recusa contato diferente do contato DO TURNO", async () => {
    // O pedido (e a entrega) ficam no contato; o link vai para a conversa. Se o
    // modelo passar o contato B durante a conversa A, a A paga e o produto fica
    // com o B. Recusa, não correção silenciosa: corrigir calado esconderia um
    // modelo que está confundindo pessoas.
    const r = (await cobrar({ contact_id: OUTRO_CONTATO })) as Record<string, unknown>;
    expect(r).toMatchObject({ cobranca_criada: false, motivo: "contato_de_outra_conversa" });
    expect(h.cobrou).toBe(0);
    expect(h.enviadas).toHaveLength(0);
  });

  it("recusa conversa que não é do contato cobrado", async () => {
    // Vale também fora do atendimento (token de terceiro), onde não existe
    // contato do turno para comparar.
    m.contatoDoTurno = undefined;
    m.donoDaConversa = OUTRO_CONTATO;
    const r = (await cobrar()) as Record<string, unknown>;
    expect(r).toMatchObject({ cobranca_criada: false, motivo: "conversa_de_outro_contato" });
    expect(h.cobrou).toBe(0);
  });

  it("recusa conversa que não existe nesta organização", async () => {
    m.contatoDoTurno = undefined;
    m.donoDaConversa = null;
    const r = (await cobrar()) as Record<string, unknown>;
    expect(r).toMatchObject({ cobranca_criada: false, motivo: "conversa_de_outro_contato" });
  });

  it("a conversa é lida DENTRO da organização do contexto", async () => {
    await cobrar();
    const leitura = h.banco.cadeias.find((c) => c.tabela === "conversations")!;
    const filtros = leitura.passos.filter((p) => p.metodo === "eq").map((p) => p.args);
    expect(filtros).toEqual(
      expect.arrayContaining([
        ["id", CONVERSA],
        ["organization_id", ORG],
      ]),
    );
  });
});

describe("o que o modelo recebe de volta", () => {
  it("cobra, manda o link na conversa e NÃO devolve o endereço", async () => {
    // O caminho do modelo quebra texto em todo ponto e recola com espaço — um
    // endereço de checkout sai destruído. Por isso quem manda é o servidor, e o
    // modelo não tem como recopiar errado o que ele não tem.
    const r = (await cobrar()) as Record<string, unknown>;
    expect(r.cobranca_criada).toBe(true);
    // O valor volta FORMATADO, para o modelo só repetir: centavos obrigariam
    // ele a dividir por 100 e escrever o resultado.
    expect(String(r.valor)).toContain("129,90");
    expect(JSON.stringify(r)).not.toContain("checkout.exemplo.com");
    expect(String(h.enviadas[0]!.body)).toContain("https://checkout.exemplo.com/abc.def");
    expect(h.enviadas[0]!.conversation_id).toBe(CONVERSA);
  });
});
