/**
 * COBRAR UM PRODUTO DO CATÁLOGO — a cadeia que vai do "quero comprar" ao link.
 *
 * É o meio que faltava entre as duas pontas que já existiam: o adaptador da
 * InfinitePay (`provedores/infinitepay.ts`) e o schema da 0689.
 *
 * ## A ordem importa, e ela é esta
 *
 * Pedido → item (com snapshot) → tentativa de cobrança → chamada ao provedor.
 *
 * O provedor é o ÚLTIMO, e de propósito: a cobrança precisa de um `id` nosso
 * ANTES de existir lá fora, porque é esse id que viaja como `order_nsu` e é por
 * ele que o aviso volta a encontrar a venda. Criar primeiro no provedor exigiria
 * um segundo UPDATE para casar as pontas, e uma falha no meio deixaria cobrança
 * órfã lá — dinheiro que entra e não tem dono aqui.
 *
 * ## As duas recusas ANTES de qualquer escrita
 *
 * Nenhuma linha nasce se a organização não tem conta de pagamento, ou se a
 * chave PIX não foi conferida. A segunda é a mais importante e a menos óbvia:
 * **a InfinitePay não deixa checar isso pela API**. Sem a chave cadastrada, o
 * link nasce com HTTP 200, o PIX aparece como opção, e só quebra na tela do
 * cliente, depois de ele ter decidido comprar. Recusar aqui transforma um
 * fracasso na frente do cliente num aviso para quem opera.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { logger } from "@/lib/logger";
import { criarCobranca as criarNoProvedor, ErroDaInfinitePay } from "./provedores/infinitepay";
import { urlDoWebhook } from "./token-do-webhook";
import { PROVEDOR_INFINITEPAY } from "./vocabulario";

export interface PedidoDeCobranca {
  organizationId: string;
  contactId: string;
  /** O `codigo` do produto no catálogo — é o que o agente conhece. */
  codigoDoProduto: string;
  quantidade?: number;
}

export type ResultadoDaCobranca =
  | {
      cobranca_criada: true;
      charge_id: string;
      order_id: string;
      link_de_pagamento: string;
      valor_cents: number;
      produto: string;
    }
  | { cobranca_criada: false; motivo: string; mensagem: string };

/** O que o modelo deve DIZER em cada recusa — nunca o erro cru. */
const ENSINO: Record<string, string> = {
  sem_conta_de_pagamento:
    "esta empresa ainda não ligou a conta de pagamento. NÃO prometa link nenhum: diga que vai " +
    "chamar alguém da equipe para concluir a compra.",
  chave_pix_nao_conferida:
    "a conta de pagamento está ligada mas ninguém conferiu a chave PIX dela, e sem isso o PIX " +
    "falha na mão do cliente. NÃO mande link: avise que a equipe conclui a compra.",
  webhook_nao_conferido:
    "ninguém confirmou que o aviso de pagamento está configurado no provedor, e sem ele o " +
    "cliente paga e a compra nunca é confirmada nem entregue. NÃO mande link: avise que a " +
    "equipe conclui a compra.",
  produto_desconhecido:
    "não existe produto com esse código no catálogo. Use `crm_search_products` e cobre um código " +
    "que voltou de lá.",
  produto_inativo: "este produto está desativado e não pode ser vendido agora.",
  provedor_recusou:
    "o provedor de pagamento recusou criar a cobrança. NÃO tente de novo na conversa: diga que " +
    "alguém da equipe vai concluir.",
};

export async function cobrarProduto(
  admin: SupabaseClient,
  pedido: PedidoDeCobranca,
): Promise<ResultadoDaCobranca> {
  const recusa = (motivo: string): ResultadoDaCobranca => ({
    cobranca_criada: false,
    motivo,
    mensagem: ENSINO[motivo] ?? "não consegui gerar a cobrança agora.",
  });

  const quantidade = Math.max(1, Math.trunc(pedido.quantidade ?? 1));

  // ─── As duas portas, antes de escrever qualquer linha ───────────────────
  const { data: conta } = await admin
    .from("payment_provider_credentials")
    .select("id, handle, pix_conferido_em, webhook_conferido_em")
    .eq("organization_id", pedido.organizationId)
    .eq("provider", PROVEDOR_INFINITEPAY)
    .eq("is_active", true)
    .maybeSingle();

  if (!conta) return recusa("sem_conta_de_pagamento");
  if (!conta.pix_conferido_em) return recusa("chave_pix_nao_conferida");
  // A terceira porta, e a que protege o CLIENTE FINAL: sem o aviso configurado
  // no provedor, o link nasce, o cliente paga, o dinheiro entra na conta do
  // vendedor — e nada aqui é confirmado nem entregue. É o único caminho deste
  // módulo em que quem paga perde dinheiro.
  if (!conta.webhook_conferido_em) return recusa("webhook_nao_conferido");

  const { data: produto } = await admin
    .from("catalog_products")
    .select("id, codigo, nome, preco_cents, ativo")
    .eq("organization_id", pedido.organizationId)
    .eq("codigo", pedido.codigoDoProduto)
    .maybeSingle();

  if (!produto) return recusa("produto_desconhecido");
  if (!produto.ativo) return recusa("produto_inativo");

  const total = produto.preco_cents * quantidade;
  if (total <= 0) return recusa("produto_desconhecido");

  // ─── Pedido ─────────────────────────────────────────────────────────────
  //
  // `external_provider = 'external'` com a plataforma no payload é o caminho
  // que a 0623 abriu para pedido que não vem de conector — alargar aquele CHECK
  // à mão é a armadilha que ela documenta.
  const agora = new Date().toISOString();
  const { data: order, error: erroDoPedido } = await admin
    .from("orders")
    .insert({
      organization_id: pedido.organizationId,
      contact_id: pedido.contactId,
      external_provider: "external",
      // Namespace NEUTRO de propósito: o produto é white-label, e o nome da
      // casa num identificador apareceria no banco de quem instala com a marca
      // dele. "interno" diz o que importa — este pedido não veio de conector.
      external_id: `interno:${crypto.randomUUID()}`,
      status: "pending",
      total_cents: total,
      currency: "BRL",
      ordered_at: agora,
      payload: { platform: "interno", origem: "cobranca_avulsa" },
    })
    .select("id")
    .single();

  if (erroDoPedido || !order) {
    logger.error("[cobrar] pedido não nasceu", { erro: erroDoPedido?.message });
    return recusa("provedor_recusou");
  }

  // ─── Item, com SNAPSHOT ─────────────────────────────────────────────────
  const { error: erroDoItem } = await admin.from("order_items").insert({
    organization_id: pedido.organizationId,
    order_id: order.id,
    product_id: produto.id,
    nome: produto.nome,
    codigo: produto.codigo,
    quantidade,
    preco_unitario_cents: produto.preco_cents,
    origem: "principal",
  });
  if (erroDoItem) logger.error("[cobrar] item não nasceu", { erro: erroDoItem.message });

  // ─── Tentativa de cobrança (ainda sem o provedor) ───────────────────────
  const { data: charge, error: erroDaCobranca } = await admin
    .from("payment_charges")
    .insert({
      organization_id: pedido.organizationId,
      order_id: order.id,
      credential_id: conta.id,
      // O RETRATO de quem recebe, não só o ponteiro para a linha. A conta é
      // mutável: trocar a InfiniteTag agora, com esta venda em voo, faria a
      // conferência comparar o recibo da conta ANTIGA (onde o dinheiro caiu)
      // com o handle da conta NOVA — a venda nunca confirmaria e o cliente que
      // pagou não receberia.
      handle_do_recebedor: conta.handle,
      provider: PROVEDOR_INFINITEPAY,
      amount_cents: total,
      currency: "BRL",
      status: "pending",
    })
    .select("id")
    .single();

  if (erroDaCobranca || !charge) {
    logger.error("[cobrar] cobrança não nasceu", { erro: erroDaCobranca?.message });
    return recusa("provedor_recusou");
  }

  // ─── Agora sim, o provedor ──────────────────────────────────────────────
  try {
    const { checkoutUrl } = await criarNoProvedor({
      handle: conta.handle,
      orderNsu: charge.id,
      amountCents: total,
      descricao: quantidade > 1 ? `${quantidade}x ${produto.nome}` : produto.nome,
      webhookUrl: urlDoWebhook(conta.id),
    });

    await admin
      .from("payment_charges")
      .update({ checkout_url: checkoutUrl })
      .eq("id", charge.id)
      .eq("organization_id", pedido.organizationId);

    return {
      cobranca_criada: true,
      charge_id: charge.id,
      order_id: order.id,
      link_de_pagamento: checkoutUrl,
      valor_cents: total,
      produto: produto.nome,
    };
  } catch (e) {
    // A cobrança fica `failed` em vez de `pending`: pendente é coisa que ainda
    // pode ser paga, e esta nunca chegou a existir no provedor. Deixá-la
    // pendente faria a reconciliação procurar para sempre um pagamento que não
    // tem como acontecer.
    await admin
      .from("payment_charges")
      .update({ status: "failed" })
      .eq("id", charge.id)
      .eq("organization_id", pedido.organizationId);

    logger.error("[cobrar] provedor recusou", {
      cobranca: charge.id,
      codigo: e instanceof ErroDaInfinitePay ? e.codigo : "erro_inesperado",
    });
    return recusa("provedor_recusou");
  }
}
