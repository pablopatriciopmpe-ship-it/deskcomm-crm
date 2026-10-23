import "server-only";

import { arquivoPertenceAoProduto, BUCKET_DOS_ARQUIVOS } from "@/lib/catalogo/arquivos-do-produto";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Os caminhos dos entregáveis de um produto, LIDOS ANTES de apagar o produto.
 *
 * A ordem importa e é a razão desta função existir: `catalog_product_files` tem
 * `on delete cascade` para o produto, então depois do DELETE as linhas não
 * existem mais — e com elas vão os únicos ponteiros para os objetos no bucket.
 * Apagar o produto sem ler isto primeiro deixava o arquivo vendido lá dentro
 * **para sempre**, consumindo a cota de 1 GB que a instalação divide com a
 * mídia do WhatsApp.
 */
export async function caminhosDosEntregaveis(orgId: string, produtoId: string): Promise<string[]> {
  const { data, error } = await createAdminClient()
    .from("catalog_product_files")
    .select("storage_path")
    .eq("organization_id", orgId)
    .eq("product_id", produtoId);

  if (error) {
    logger.warn("[produtos/arquivos] leitura dos caminhos falhou", { detalhe: error.message });
    return [];
  }
  return ((data ?? []) as Array<{ storage_path: string }>).map((l) => l.storage_path);
}

/**
 * Apaga do bucket — só o que é DESTE produto.
 *
 * O filtro não é zelo: a coluna é gravável pelo PostgREST por qualquer
 * `manager` da organização, e o `remove` roda como service role, sem RLS. Sem
 * ele, um caminho de outra organização gravado na linha seria apagado por esta
 * função. Mesma trava de `fotos-no-bucket.ts`, pelo mesmo motivo.
 *
 * Falha aqui não desfaz nada: o produto já saiu, e o que sobra é um objeto que
 * ninguém referencia — por isso o caminho vai para o log, que é a única pista
 * que resta para apagá-lo à mão.
 */
export async function apagarEntregaveisDoBucket(
  orgId: string,
  produtoId: string,
  caminhos: readonly string[],
  requestId: string,
): Promise<void> {
  const deste = caminhos.filter((c) => arquivoPertenceAoProduto(c, orgId, produtoId));
  if (deste.length === 0) return;

  const { error } = await createAdminClient().storage.from(BUCKET_DOS_ARQUIVOS).remove(deste);
  if (error) {
    logger.error("[produtos/arquivos] objetos orfaos no bucket", {
      caminhos: deste,
      detalhe: error.message,
      requestId,
    });
  }
}
