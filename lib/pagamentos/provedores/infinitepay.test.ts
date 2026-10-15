import { afterEach, describe, expect, it, vi } from "vitest";

import {
  avisoDaInfinitePay,
  conferirPeloRecibo,
  criarCobranca,
  enderecoDoRecibo,
  ErroDaInfinitePay,
  INFINITEPAY_RECIBO_HOST,
  reciboMostraValor,
} from "./infinitepay";

/**
 * Cada caso aqui prende uma MEDIÇÃO contra a API real (15/10/2026), não uma
 * leitura da documentação deles — que erra pelo menos um nome de campo.
 */

function respondeCom(status: number, corpo: unknown, { texto }: { texto?: string } = {}) {
  // Os parâmetros são declarados de propósito: sem eles o tipo de `mock.calls`
  // é `[]`, e os casos que conferem o CORPO enviado não compilam.
  return vi.fn(async (_url: string | URL, _init?: RequestInit) =>
    new Response(texto ?? JSON.stringify(corpo), {
      status,
      headers: { "Content-Type": texto ? "text/html" : "application/json" },
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("criar a cobrança", () => {
  it("trata 404 com corpo como ERRO DE NEGÓCIO, não como rota inexistente", async () => {
    // Medido: conta sem Checkout Integrado responde exatamente isto, com 404.
    // Quem decidir pelo status trata uma regra de negócio como "não encontrado"
    // e engole o erro calado.
    vi.stubGlobal(
      "fetch",
      respondeCom(404, {
        success: false,
        error: "external_checkout_not_enabled",
        message: "External checkout is not enabled for this merchant.",
      }),
    );

    const erro = await criarCobranca({
      handle: "qualquer",
      orderNsu: "abc",
      amountCents: 100,
      descricao: "Teste",
      webhookUrl: "https://exemplo.com/w",
    }).catch((e: unknown) => e);

    expect(erro).toBeInstanceOf(ErroDaInfinitePay);
    expect((erro as ErroDaInfinitePay).codigo).toBe("external_checkout_not_enabled");
    expect((erro as ErroDaInfinitePay).status).toBe(404);
  });

  it("manda o preço em CENTAVOS e devolve a URL do checkout", async () => {
    const espiao = respondeCom(200, { url: "https://checkout.infinitepay.io/abc123" });
    vi.stubGlobal("fetch", espiao);

    const { checkoutUrl } = await criarCobranca({
      handle: "loja",
      orderNsu: "pedido-1",
      amountCents: 12990,
      descricao: "Curso",
      webhookUrl: "https://exemplo.com/w",
    });

    expect(checkoutUrl).toBe("https://checkout.infinitepay.io/abc123");

    const corpo = JSON.parse(String((espiao.mock.calls[0]![1] as RequestInit).body)) as {
      items: Array<{ price: number }>;
    };
    // R$ 129,90 vai como 12990, não como 129.9 — a conversão que o Asaas exigiria.
    expect(corpo.items[0]!.price).toBe(12990);
  });

  it("recusa valor que não seja inteiro positivo antes de chamar a rede", async () => {
    const espiao = respondeCom(200, { url: "https://x" });
    vi.stubGlobal("fetch", espiao);

    await expect(
      criarCobranca({
        handle: "loja",
        orderNsu: "p",
        amountCents: 0,
        descricao: "x",
        webhookUrl: "https://exemplo.com/w",
      }),
    ).rejects.toThrow("infinitepay:valor_invalido");

    expect(espiao).not.toHaveBeenCalled();
  });
});

describe("o aviso do webhook", () => {
  const avisoReal = {
    amount: 100,
    paid_amount: 100,
    order_nsu: "teste-webhook-pablo-004",
    invoice_slug: "uiQGUOC9io",
    capture_method: "pix",
    transaction_nsu: "d8846e38-8d8a-4c8f-a0ad-6922b3a5a346",
    receipt_url: "https://recibo.infinitepay.io/d8846e38-8d8a-4c8f-a0ad-6922b3a5a346",
  };

  it("aceita o payload REAL, com invoice_slug", () => {
    expect(avisoDaInfinitePay.safeParse(avisoReal).success).toBe(true);
  });

  it("RECUSA o payload que a documentação oficial descreve, com `slug`", () => {
    // A documentação deles diz `slug`; o webhook manda `invoice_slug`. Quem
    // seguir a documentação nunca acha a cobrança — e este caso é o que avisa,
    // caso alguém "conserte" o schema pelo que está escrito lá.
    const { invoice_slug, ...resto } = avisoReal;
    expect(avisoDaInfinitePay.safeParse({ ...resto, slug: invoice_slug }).success).toBe(false);
  });
});

describe("o endereço do recibo", () => {
  it("é DERIVADO do nsu e nunca o que o aviso mandou", () => {
    // O aviso não é assinado: usar o receipt_url dele deixaria quem forja
    // escolher o endereço que o nosso servidor visita.
    const url = new URL(enderecoDoRecibo("nsu-1"));
    expect(url.host).toBe(INFINITEPAY_RECIBO_HOST);
    expect(url.protocol).toBe("https:");
    expect(url.pathname).toBe("/nsu-1");
  });

  it("escapa o nsu, para ele não virar caminho", () => {
    expect(enderecoDoRecibo("../../etc/passwd")).toBe(
      `https://${INFINITEPAY_RECIBO_HOST}/..%2F..%2Fetc%2Fpasswd`,
    );
  });
});

describe("o valor dentro do HTML do recibo", () => {
  it.each([
    ["R$ 1,00", 100],
    ["R$&nbsp;1,00", 100],
    ["<span>1,00</span>", 100],
    ["R$ 129,90", 12990],
    ["R$ 1.234,56", 123456],
  ])("reconhece %s", (html, centavos) => {
    expect(reciboMostraValor(html, centavos)).toBe(true);
  });

  it("não aceita valor diferente", () => {
    expect(reciboMostraValor("R$ 10,00", 100)).toBe(false);
  });

  it("não casa com centavos soltos, que bateriam com qualquer id", () => {
    // "100" aparece em id, timestamp e contador. Se valesse, qualquer página
    // confirmaria qualquer cobrança.
    expect(reciboMostraValor("<div id='100'>pedido</div>", 100)).toBe(false);
  });
});

describe("a conferência pelo recibo", () => {
  const nsu = "d8846e38-8d8a-4c8f-a0ad-6922b3a5a346";

  it("passa quando o recibo traz a MESMA transação e o MESMO valor", async () => {
    vi.stubGlobal(
      "fetch",
      respondeCom(200, null, { texto: `<html>Transação ${nsu} — R$ 1,00 pago</html>` }),
    );
    await expect(
      conferirPeloRecibo({ transactionNsu: nsu, amountCentsEsperado: 100 }),
    ).resolves.toBeUndefined();
  });

  it("recusa recibo de OUTRA transação", async () => {
    vi.stubGlobal(
      "fetch",
      respondeCom(200, null, { texto: "<html>Transação outra-coisa — R$ 1,00</html>" }),
    );
    await expect(
      conferirPeloRecibo({ transactionNsu: nsu, amountCentsEsperado: 100 }),
    ).rejects.toThrow("infinitepay:recibo_de_outra_transacao");
  });

  it("recusa quando o valor do recibo não é o que cobramos", async () => {
    // O valor esperado vem do NOSSO banco, nunca do aviso: é o que impede
    // confirmar R$ 1 para uma cobrança de R$ 500.
    vi.stubGlobal(
      "fetch",
      respondeCom(200, null, { texto: `<html>Transação ${nsu} — R$ 1,00</html>` }),
    );
    await expect(
      conferirPeloRecibo({ transactionNsu: nsu, amountCentsEsperado: 50000 }),
    ).rejects.toThrow("infinitepay:recibo_com_valor_diferente");
  });

  it("recusa quando o recibo não abre", async () => {
    vi.stubGlobal("fetch", respondeCom(404, null, { texto: "sumiu" }));
    await expect(
      conferirPeloRecibo({ transactionNsu: nsu, amountCentsEsperado: 100 }),
    ).rejects.toThrow("infinitepay:recibo_inacessivel");
  });

  it("não segue redirecionamento — senão o pino do host não vale nada", async () => {
    const espiao = respondeCom(200, null, { texto: `<html>${nsu} R$ 1,00</html>` });
    vi.stubGlobal("fetch", espiao);
    await conferirPeloRecibo({ transactionNsu: nsu, amountCentsEsperado: 100 });

    expect((espiao.mock.calls[0]![1] as RequestInit).redirect).toBe("error");
  });
});
