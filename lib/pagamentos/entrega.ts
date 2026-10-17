/**
 * A ENTREGA — o que acontece depois que o pagamento é confirmado.
 *
 * ## Por que uma PÁGINA com token, e não o arquivo no WhatsApp
 *
 * Três razões, e a terceira é a que decide:
 *
 *  1. arquivo no WhatsApp some na conversa; link continua achável;
 *  2. arquivo enviado não volta — reembolso e disputa não revogam nada;
 *  3. **o arquivo é a mercadoria.** Com uma página, o acesso é um ponteiro que
 *     a gente controla: vence, pode ser revogado, e deixa registro de quem
 *     baixou e quando. É o que `order_deliveries` existe para guardar.
 *
 * O token da página é guardado como SHA-256, nunca em claro (anti-pattern 13):
 * o endereço vai ao cliente, e o banco guarda só a impressão digital dele.
 */
import { createHash, randomBytes } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";

import { env } from "@/lib/env";

/** Quanto tempo o link de entrega vale. Longo o bastante para não irritar. */
export const VALIDADE_DA_ENTREGA_DIAS = 30;

export const CAMINHO_DA_ENTREGA = "/entrega";

export function tokenDaEntrega(): string {
  return randomBytes(32).toString("hex");
}

export function hashDaEntrega(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function urlDaEntrega(token: string, base: string = env.NEXT_PUBLIC_APP_URL): string {
  return `${base.replace(/\/+$/, "")}${CAMINHO_DA_ENTREGA}/${token}`;
}

export interface EntregaCriada {
  token: string;
  url: string;
  expiraEm: string;
  arquivos: number;
}

/**
 * Cria (ou reaproveita) a entrega de um pedido e devolve o endereço.
 *
 * Reaproveitar importa: o worker pode rodar duas vezes para o mesmo pedido — o
 * aviso do provedor reentrega, e a reconciliação relê. Gerar um token novo a
 * cada passagem invalidaria o link que o cliente já recebeu.
 */
export async function prepararEntrega(
  admin: SupabaseClient,
  organizationId: string,
  orderId: string,
): Promise<EntregaCriada | { motivo: "sem_arquivo" | "ja_entregue" | "falhou" }> {
  // Os arquivos vêm dos produtos DESTE pedido, pelo item — e não do catálogo
  // inteiro. Produto sem arquivo não é defeito: é venda de coisa que não se
  // entrega por download (consulta, serviço), e quem chama decide o que dizer.
  const { data: itens } = await admin
    .from("order_items")
    .select("product_id")
    .eq("organization_id", organizationId)
    .eq("order_id", orderId);

  const produtos = (itens ?? [])
    .map((i) => (i as { product_id: string | null }).product_id)
    .filter((p): p is string => Boolean(p));

  if (produtos.length === 0) return { motivo: "sem_arquivo" };

  const { data: arquivos } = await admin
    .from("catalog_product_files")
    .select("id")
    .eq("organization_id", organizationId)
    .in("product_id", produtos)
    .eq("ativo", true);

  if (!arquivos || arquivos.length === 0) return { motivo: "sem_arquivo" };

  // Já existe entrega viva? Então ela é a resposta — o cliente já tem este link.
  const { data: existente } = await admin
    .from("order_deliveries")
    .select("id, expira_em")
    .eq("organization_id", organizationId)
    .eq("order_id", orderId)
    .is("revogada_em", null)
    .maybeSingle();

  if (existente) {
    // O token em claro não existe mais em lugar nenhum — é o ponto de guardar o
    // hash. Quem precisa do endereço de novo pede um link novo pela tela, o que
    // revoga o anterior. Aqui a entrega já foi feita e não se repete.
    //
    // `ja_entregue`, e NÃO `falhou`: quem chama transforma `falhou` em `error`,
    // e a fila repetiria para sempre um serviço que já está concluído.
    return { motivo: "ja_entregue" };
  }

  const token = tokenDaEntrega();
  const expiraEm = new Date(Date.now() + VALIDADE_DA_ENTREGA_DIAS * 86_400_000).toISOString();

  const { error } = await admin.from("order_deliveries").insert({
    organization_id: organizationId,
    order_id: orderId,
    token_sha256: hashDaEntrega(token),
    canal: "pagina",
    entregue_em: new Date().toISOString(),
    expira_em: expiraEm,
  });

  // A corrida que a consulta acima não fecha: dois avisos simultâneos leem o
  // vazio e os dois tentam inserir. Quem perde leva 23505 do índice
  // `order_deliveries_uma_viva_por_pedido` — e isso é "já entregue", não falha.
  // Sem a distinção, o perdedor mandaria um SEGUNDO link, igualmente válido.
  if (error) return { motivo: error.code === "23505" ? "ja_entregue" : "falhou" };

  return { token, url: urlDaEntrega(token), expiraEm, arquivos: arquivos.length };
}

/**
 * REENVIAR: revoga o endereço atual e devolve um NOVO.
 *
 * ## Por que gerar outro em vez de mostrar o mesmo
 *
 * Porque o token em claro não existe em lugar nenhum — o banco guarda só o
 * SHA-256 dele, e hash não volta. Não há "mostrar o mesmo link": ou se gera
 * outro, ou não há reenvio.
 *
 * E isso é melhor do que a alternativa. Quando alguém pede o link de novo, a
 * razão mais comum é que o primeiro se perdeu — e um endereço perdido pode ter
 * sido perdido NUM GRUPO. Revogar fecha essa porta: o link antigo para de abrir
 * no mesmo instante em que o novo nasce.
 *
 * ## O que isto NÃO conserta
 *
 * A entrega revogada some da página antiga, e quem estiver com ela recebe a
 * mesma recusa de link vencido. Se o comprador legítimo tinha o link antigo
 * guardado, ele precisa do novo — que é exatamente o que esta função devolve a
 * quem opera.
 */
export async function reenviarEntrega(
  admin: SupabaseClient,
  organizationId: string,
  orderId: string,
): Promise<EntregaCriada | { motivo: "sem_arquivo" | "falhou" }> {
  // Revoga a viva ANTES de criar a nova: o índice único parcial
  // `order_deliveries_uma_viva_por_pedido` recusaria a segunda enquanto a
  // primeira estivesse de pé — e é essa trava que garante que nunca existam
  // dois endereços válidos para o mesmo pedido.
  const { error: erroDaRevogacao } = await admin
    .from("order_deliveries")
    .update({ revogada_em: new Date().toISOString(), motivo_revogacao: "reenviada" })
    .eq("organization_id", organizationId)
    .eq("order_id", orderId)
    .is("revogada_em", null);

  if (erroDaRevogacao) return { motivo: "falhou" };

  const nova = await prepararEntrega(admin, organizationId, orderId);
  // `ja_entregue` aqui seria defeito: acabamos de revogar a viva, então
  // `prepararEntrega` não pode ter encontrado nenhuma. Se encontrou, alguém
  // criou uma no meio — tratar como falha é a saída honesta.
  if ("motivo" in nova) {
    return { motivo: nova.motivo === "sem_arquivo" ? "sem_arquivo" : "falhou" };
  }
  return nova;
}
