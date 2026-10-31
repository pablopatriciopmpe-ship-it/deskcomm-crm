/**
 * A FERRAMENTA DE COBRAR — o agente fecha a venda dentro da conversa.
 *
 * ## Por que ela ENVIA o link, em vez de devolvê-lo ao modelo
 *
 * Porque o caminho do modelo corrompe texto longo. `splitIntoBubbles` quebra em
 * todo `.` que não esteja entre dígitos e recola os pedaços com ESPAÇO — é o
 * defeito que `tests/unit/pix-nao-passa-pela-quebra-em-bolhas.test.ts` mede com
 * o BR Code do PIX, e um endereço de checkout tem pontos pelo mesmo motivo.
 *
 * Então o link sai pelo SERVIDOR, por `sendMessageHandler`, que não fatia nada,
 * respeita a janela de 24 h e recusa contato que pediu para não receber. O
 * modelo recebe de volta a confirmação e o VALOR — nunca a URL. Ele não tem
 * como recopiá-la errado porque não a tem.
 *
 * ## Por que o contato e a conversa são CONFERIDOS, não aceitos
 *
 * Os dois chegam pelo modelo, e são usados para coisas diferentes: o contato
 * vira dono do pedido (e da ENTREGA), a conversa recebe o link. Aceitar os dois
 * soltos permitia o pior erro possível — **cobrar uma pessoa e entregar a
 * outra**: o modelo passa o contato B durante a conversa A, a A paga pelo link
 * que recebeu, e o pedido com o arquivo fica no B.
 *
 * Duas conferências fecham isso:
 *
 *  1. quando existe CONTATO DO TURNO (`ctx.contatoDoTurno`, que só a ponte do
 *     atendimento injeta), ele vence: contato diferente é recusa, não correção
 *     silenciosa — corrigir calado esconderia um modelo que está confundindo
 *     pessoas;
 *  2. a conversa tem de ser DAQUELE contato, na nossa organização. Isto vale
 *     também fora do atendimento (token de terceiro), onde não há contato do
 *     turno para comparar.
 *
 * ## O que ela NÃO faz
 *
 * Não confirma pagamento e não entrega produto. Quem confirma é o worker, e só
 * depois de conferir o recibo do provedor — o banco recusa `paid` sem isso.
 */
import { z } from "zod";

import { sendMessageHandler } from "@/app/api/v1/messages/_handler";
import { ApiError } from "@/lib/api/types";
import { cobrarProduto } from "@/lib/pagamentos/cobrar";
import type { McpToolDefinition } from "@/lib/mcp/types";

const cobrarShape = {
  conversation_id: z
    .string()
    .uuid()
    .describe("a conversa em que o link vai ser enviado — a conversa DESTE atendimento."),
  contact_id: z.string().uuid().describe("o contato que está comprando."),
  codigo_do_produto: z
    .string()
    .min(1)
    .max(120)
    .describe(
      "o `codigo` do produto no catálogo, exatamente como veio de `crm_search_products`. " +
        "NÃO invente código nem use o nome do produto.",
    ),
  quantidade: z.coerce.number().int().min(1).max(999).optional().describe("padrão 1."),
};

export const crmCobrarProduto: McpToolDefinition<typeof cobrarShape> = {
  name: "crm_cobrar_produto",
  description:
    "Cobra um produto do catálogo e MANDA o link de pagamento na conversa. Use quando o cliente " +
    "JÁ decidiu comprar e você confirmou com ele o que é e quanto custa — isto cria uma cobrança " +
    "de verdade, com dinheiro. " +
    "O link é enviado por mim, não por você: você recebe de volta o valor e a confirmação de que " +
    "saiu, e NÃO recebe o endereço. Depois de chamar, diga ao cliente que o link do pagamento foi " +
    "enviado e qual é o valor. " +
    "⚠️ NÃO prometa o produto agora. O arquivo só é entregue depois que o pagamento for " +
    "confirmado, e quem confirma não é você — é o sistema, conferindo com o provedor. Diga que, " +
    "assim que o pagamento cair, você manda o material. " +
    "Se a resposta vier com `cobranca_criada: false`, NÃO tente de novo e NÃO mande link nenhum: " +
    "leia a `mensagem` e faça o que ela diz.",
  inputSchema: cobrarShape,
  category: "write",
  requiresRole: "ai_operator",
  requiresScope: "mcp:write",
  handler: async (input, ctx) => {
    // ── As duas conferências do cabeçalho, antes de qualquer escrita ──────
    if (ctx.contatoDoTurno && ctx.contatoDoTurno !== input.contact_id) {
      return {
        cobranca_criada: false,
        motivo: "contato_de_outra_conversa",
        mensagem:
          "o `contact_id` que você passou não é o do cliente deste atendimento. NÃO tente de " +
          "novo com outro id: cobre o contato desta conversa.",
      };
    }

    const { data: conversa } = await ctx.supabase
      .from("conversations")
      .select("contact_id")
      .eq("id", input.conversation_id)
      .eq("organization_id", ctx.organizationId)
      .maybeSingle();

    const donoDaConversa = (conversa as { contact_id: string | null } | null)?.contact_id ?? null;
    if (donoDaConversa !== input.contact_id) {
      return {
        cobranca_criada: false,
        motivo: "conversa_de_outro_contato",
        mensagem:
          "esta conversa não é do contato que você quer cobrar. NÃO mande link nenhum: cobre o " +
          "contato desta conversa, ou chame alguém da equipe.",
      };
    }

    const r = await cobrarProduto(ctx.supabase, {
      organizationId: ctx.organizationId,
      contactId: input.contact_id,
      codigoDoProduto: input.codigo_do_produto,
      ...(input.quantidade !== undefined ? { quantidade: input.quantidade } : {}),
    });

    if (!r.cobranca_criada) return r;

    const reais = (r.valor_cents / 100).toLocaleString("pt-BR", {
      style: "currency",
      currency: "BRL",
    });

    try {
      await sendMessageHandler(
        ctx.supabase,
        {
          organization_id: ctx.organizationId,
          actor: ctx.actor,
          requestId: ctx.requestId,
        },
        {
          conversation_id: input.conversation_id,
          type: "text",
          body: `Para concluir a compra de ${r.produto} (${reais}), é só pagar por aqui:\n${r.link_de_pagamento}`,
        },
      );
    } catch (e) {
      // A cobrança EXISTE e o link não saiu. Não dá para fingir que deu certo:
      // o cliente ficaria esperando um link que nunca chega, e o modelo diria
      // que mandou. Devolver a falha faz ele chamar alguém da equipe.
      if (!(e instanceof ApiError)) throw e;
      return {
        cobranca_criada: false,
        motivo: e.code === "forbidden" ? "contato_nao_recebe" : "envio_falhou",
        mensagem:
          e.code === "forbidden"
            ? "este contato pediu para não receber mensagens, então o link não foi enviado. NÃO insista."
            : "a cobrança foi criada mas o link não saiu. Diga que alguém da equipe vai concluir a compra.",
      };
    }

    return {
      cobranca_criada: true,
      valor: reais,
      produto: r.produto,
      // A URL fica de fora de propósito (ver o cabeçalho deste arquivo).
      mensagem:
        `o link de pagamento de ${reais} foi enviado nesta conversa. Diga isso ao cliente e avise ` +
        `que, assim que o pagamento for confirmado, você manda o material. NÃO mande o produto agora.`,
    };
  },
};
