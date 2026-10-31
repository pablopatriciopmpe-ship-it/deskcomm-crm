import { describe, expect, it } from "vitest";

import { splitForSend, splitIntoBubbles } from "@/lib/agent-engine/agent/split-message";

/**
 * O CÓDIGO PIX NÃO PODE SAIR PELO TEXTO DO MODELO.
 *
 * ## O defeito, medido
 *
 * O BR Code do PIX contém `br.gov.bcb.pix`. O separador de sentença de
 * `splitIntoBubbles` quebra em todo `.` que não esteja entre DÍGITOS
 * (`split-message.ts`, `splitSentences` — a guarda cobre "R$ 10.990", não
 * cobre letra.letra). Um parágrafo que estoure `split_max_chars` com o código
 * dentro sai partido, e o pedaço seguinte é colado com ESPAÇO.
 *
 * O cliente copia, cola no banco e não funciona. **Nenhum erro aparece** — nem
 * para ele, nem para quem vendeu. É a mesma família do defeito que o produto já
 * corrigiu para preços, quando "R$ 10.990" virava "R$ 10".
 *
 * ## Por que o teto padrão não salva
 *
 * Com o parágrafo como fronteira da bolha, um código SOZINHO no parágrafo
 * sobrevive em 600. Mas basta o modelo ser tagarela: 673 caracteres num
 * parágrafo só, com o código no meio, e ele parte — no teto PADRÃO, sem
 * ninguém ter configurado nada de errado.
 *
 * ## A regra que este arquivo defende
 *
 * O servidor manda o código, por `sendMessageHandler` (`app/api/v1/messages/_handler.ts`),
 * que não quebra em bolhas, respeita a janela de 24h e recusa contato que
 * pediu para não receber. O modelo nunca recebe o BR Code, então não tem como
 * recopiá-lo nem errar um dígito.
 *
 * Se um dia alguém fizer a ferramenta devolver o código para o modelo, ou
 * mandar o PIX pelo caminho do turno, é este arquivo que acusa.
 */

/** BR Code estático de PIX, no formato EMV. 147 caracteres. */
const BR_CODE =
  "00020126580014br.gov.bcb.pix0136a1b2c3d4-e5f6-7890-abcd-ef1234567890" +
  "520400005303986540510.005802BR5913PABLO HENRIQUE6008BRASILIA62070503***6304A1B2";

/** O padrão de `split_max_chars` em `lib/ai/agents/validation.ts`. */
const TETO_PADRAO = 600;

describe("o BR Code do PIX e a quebra em bolhas", () => {
  it("é destruído quando vai dentro de um parágrafo que estoura o teto PADRÃO", () => {
    const tagarela =
      "Perfeito, que bom que você decidiu! Deixa eu te explicar direitinho como " +
      "funciona daqui pra frente, porque é bem simples e eu quero que fique tudo " +
      "claro. O acesso é vitalício, você recebe tudo no mesmo minuto em que o " +
      "pagamento cair, e ainda tem a garantia de sete dias caso não goste. " +
      "Qualquer dúvida você me chama aqui mesmo, eu respondo rápido. Então é só " +
      "copiar o código abaixo e colar no app do seu banco na opção PIX copia e " +
      `cola: ${BR_CODE} Assim que cair eu te aviso na hora e já libero o seu ` +
      "acesso, combinado? Fico no aguardo!";

    expect(tagarela.length).toBeGreaterThan(TETO_PADRAO);

    const bolhas = splitIntoBubbles(tagarela, TETO_PADRAO);

    // A prova do dano: nenhuma bolha contém o código inteiro.
    expect(bolhas.some((b) => b.includes(BR_CODE))).toBe(false);
    expect(bolhas.length).toBeGreaterThan(1);
  });

  it("é destruído em parágrafo próprio quando o teto é o MÍNIMO permitido (80)", () => {
    // 80 é o piso que `split_max_chars` aceita, não um valor absurdo: é uma
    // configuração que um operador pode escolher pela tela.
    const bolhas = splitIntoBubbles(`Segue o PIX:\n\n${BR_CODE}`, 80);

    expect(bolhas.some((b) => b.includes(BR_CODE))).toBe(false);
    // O modo da corrupção: o ponto de `br.gov.bcb` vira fim de sentença, e o
    // pedaço seguinte volta colado com espaço.
    expect(bolhas.some((b) => /br\.\s|gov\.\s/.test(b))).toBe(true);
  });

  it("sobrevive inteiro quando o envio não fatia — que é como o servidor manda", () => {
    // `enabled = false` é o que todo caminho de envio do SERVIDOR faz na
    // prática: `sendMessageHandler` nem chama `splitForSend`.
    const partes = splitForSend(BR_CODE, false, TETO_PADRAO);

    expect(partes).toHaveLength(1);
    expect(partes[0]).toBe(BR_CODE);
  });

  it("sobrevive inteiro mesmo com o fatiamento LIGADO, se for a mensagem inteira", () => {
    // Este caso não é permissão para mandar pelo turno: é o controle que mostra
    // que o dano do primeiro caso vem do TEXTO EM VOLTA, não do código em si.
    const partes = splitForSend(BR_CODE, true, TETO_PADRAO);

    expect(partes).toHaveLength(1);
    expect(partes[0]).toBe(BR_CODE);
  });
});
