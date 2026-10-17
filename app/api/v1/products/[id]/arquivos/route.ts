/**
 * POST   /api/v1/products/:id/arquivos — sobe UM entregável (multipart `file`).
 * DELETE /api/v1/products/:id/arquivos — `{ arquivo_id }`: tira a linha e o objeto.
 *
 * É a metade que faltava do caminho do dinheiro: a 0690 criou a tabela e o
 * bucket, a página `/entrega/[token]` sabe ler, e NADA escrevia. Sem esta rota o
 * dono só punha arquivo no produto por SQL na mão — e um produto vendido para
 * clínica não pode exigir acesso ao servidor.
 *
 * ── Mesmo desenho da rota de fotos (`../fotos/route.ts`) ─────────────────────
 *
 * O arquivo vai pelo service role (o bucket `produtos-digitais` não tem policy
 * nenhuma), e é o `requireRole("manager")` daqui que autoriza — a mesma régua do
 * resto do catálogo. O caminho é gerado AQUI, nunca aceito do cliente, e o tipo
 * sai da ASSINATURA dos bytes, nunca do `content-type` do navegador: este
 * arquivo vai ser servido ao navegador de quem COMPROU, a partir do domínio do
 * Storage.
 *
 * ── Por que tirar tira de quem já comprou, e por que isso está na tela ──────
 *
 * A página de entrega lê `catalog_product_files` AO VIVO — ela não guarda um
 * retrato dos arquivos no momento da venda. Então remover um arquivo o remove de
 * todas as páginas de entrega, inclusive as de quem já pagou. Duas saídas
 * existiam: guardar o retrato (tabela nova, entrega maior) ou DIZER na tela. A
 * segunda é a escolhida, e a tela diz com todas as letras — o que não se faz é
 * deixar a pessoa descobrir isso pelo cliente reclamando.
 *
 * E a remoção apaga o objeto no bucket junto: deixar `ativo = false` com o
 * arquivo lá dentro teria o MESMO efeito visível (a entrega filtra `ativo`) e
 * ainda consumiria a cota de 1 GB que a instalação divide com a mídia do
 * WhatsApp.
 */
import { randomUUID } from "node:crypto";

import { type NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import {
  arquivoPertenceAoProduto,
  BUCKET_DOS_ARQUIVOS,
  extensaoDoEntregavel,
  farejarEntregavel,
  MAXIMO_DE_ARQUIVOS,
  nomeSeguroDoArquivo,
  TAMANHO_MAXIMO_DO_ARQUIVO,
} from "@/lib/catalogo/arquivos-do-produto";
import { traduzir } from "@/lib/i18n/dicionario";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const remocaoSchema = z.object({ arquivo_id: z.string().uuid() });

/** O produto existe NESTA organização? Leitura pela sessão, com RLS. */
async function produtoExiste(orgId: string, id: string): Promise<boolean> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("catalog_products")
    .select("id")
    .eq("organization_id", orgId)
    .eq("id", id)
    .maybeSingle();
  return data !== null;
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "catalog_products" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const orgId = authz.org.orgId;
  const { id } = await params;

  if (!(await produtoExiste(orgId, id))) {
    return fail("not_found", t("Produto não encontrado."), 404, { requestId });
  }

  const admin = createAdminClient();
  const { count, error: erroDaContagem } = await admin
    .from("catalog_product_files")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", orgId)
    .eq("product_id", id)
    .eq("ativo", true);

  if (erroDaContagem) {
    logger.error("[produtos/arquivos] contagem falhou", {
      detalhe: erroDaContagem.message,
      requestId,
    });
    return fail("internal_error", "Erro ao ler os arquivos do produto.", 500, { requestId });
  }
  // ponytail: contar-e-inserir sem trava. Dois uploads no MESMO instante com
  // nove arquivos leem `9` e os dois entram, deixando onze e repetindo a
  // `position` — a mesma classe de corrida que a rota de fotos declara. O custo
  // é cosmético (a ordem é por `position` e depois `id`) e o teto existe para
  // segurar a página de entrega, não para ser exato. Fechar pediria RPC.
  if ((count ?? 0) >= MAXIMO_DE_ARQUIVOS) {
    return fail("validation_failed", t("Cada produto entrega no máximo 10 arquivos."), 422, {
      requestId,
    });
  }

  // Recusa pelo Content-Length declarado ANTES de bufferizar (igual à rota de
  // fotos); o `file.size` abaixo continua sendo o teto autoritativo.
  const declarado = Number(req.headers.get("content-length") ?? 0);
  if (declarado > TAMANHO_MAXIMO_DO_ARQUIVO + 1_048_576) {
    return fail("payload_too_large", t("O arquivo precisa ter até 500 MB."), 413, { requestId });
  }

  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) {
    return fail("validation_failed", t("Campo 'file' (multipart) obrigatório."), 422, { requestId });
  }
  if (file.size === 0) {
    return fail("validation_failed", t("O arquivo está vazio."), 422, { requestId });
  }
  if (file.size > TAMANHO_MAXIMO_DO_ARQUIVO) {
    return fail("payload_too_large", t("O arquivo precisa ter até 500 MB."), 413, { requestId });
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  const extensaoDeclarada = (file.name.split(".").pop() ?? "").toLowerCase();
  const tipo = farejarEntregavel(bytes, extensaoDeclarada);
  if (!tipo) {
    return fail(
      "unsupported_media_type",
      t("Dá para entregar PDF, EPUB, ZIP, MP4, MP3, PNG ou JPG."),
      415,
      { requestId, details: { content_type_declarado: file.type || null } },
    );
  }

  const caminho = `${orgId}/${id}/${randomUUID()}.${extensaoDoEntregavel(tipo)}`;
  const { error: erroUp } = await admin.storage
    .from(BUCKET_DOS_ARQUIVOS)
    .upload(caminho, bytes, { contentType: tipo, upsert: false });
  if (erroUp) {
    logger.error("[produtos/arquivos] upload falhou", { detalhe: erroUp.message, requestId });
    return fail("internal_error", "Erro ao subir o arquivo.", 500, { requestId });
  }

  const { data: linha, error: erroDaLinha } = await admin
    .from("catalog_product_files")
    .insert({
      organization_id: orgId,
      product_id: id,
      storage_path: caminho,
      nome_arquivo: nomeSeguroDoArquivo(file.name, tipo),
      mime: tipo,
      bytes: file.size,
      position: count ?? 0,
      created_by: authz.user.id,
    })
    .select("id, nome_arquivo, mime, bytes")
    .maybeSingle();

  if (erroDaLinha || !linha) {
    // O objeto já subiu: sem a linha ele é órfão e come cota para sempre.
    const { error: erroDaFaxina } = await admin.storage
      .from(BUCKET_DOS_ARQUIVOS)
      .remove([caminho]);
    if (erroDaFaxina) {
      // A faxina também falhou (Storage fora do ar no mesmo instante). Não há
      // linha para achar o objeto depois, então o CAMINHO vai para o log: é a
      // única pista que sobra para alguém apagá-lo à mão.
      logger.error("[produtos/arquivos] objeto orfao no bucket", {
        caminho,
        detalhe: erroDaFaxina.message,
        requestId,
      });
    }
    logger.error("[produtos/arquivos] linha falhou", {
      detalhe: erroDaLinha?.message ?? "sem linha",
      requestId,
    });
    return fail("internal_error", "Erro ao salvar o arquivo.", 500, { requestId });
  }

  const gravada = linha as { id: string; nome_arquivo: string; mime: string; bytes: number };

  await audit({
    organizationId: orgId,
    actorUserId: authz.user.id,
    action: "catalog_product.file_added",
    resourceType: "catalog_products",
    resourceId: id,
    requestId,
    // O NOME é do vendedor e aparece ao comprador; o caminho no bucket não entra.
    metadata: {
      arquivo_id: gravada.id,
      nome: gravada.nome_arquivo,
      mime: gravada.mime,
      bytes: gravada.bytes,
    },
  });

  return ok(gravada, { requestId });
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "catalog_products" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const orgId = authz.org.orgId;
  const { id } = await params;

  const parsed = remocaoSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("validation_failed", t("Diga qual arquivo tirar."), 422, { requestId });
  }

  const admin = createAdminClient();
  const { data: arquivo, error } = await admin
    .from("catalog_product_files")
    .select("id, storage_path, nome_arquivo")
    .eq("id", parsed.data.arquivo_id)
    .eq("organization_id", orgId)
    .eq("product_id", id)
    .maybeSingle();

  if (error) {
    logger.error("[produtos/arquivos] leitura falhou", { detalhe: error.message, requestId });
    return fail("internal_error", "Erro ao ler o arquivo.", 500, { requestId });
  }
  if (!arquivo) return fail("not_found", t("Arquivo não encontrado."), 404, { requestId });

  const linha = arquivo as { id: string; storage_path: string; nome_arquivo: string };

  // ⚠️ Confere o caminho ANTES de apagar. A coluna é gravável por qualquer
  // `manager` da organização pela REST, e o `remove` abaixo é service role, sem
  // RLS: um caminho de outra organização gravado na linha apagaria arquivo
  // alheio. É a mesma trava que `fotoPertenceAoProduto` fecha nas fotos.
  if (!arquivoPertenceAoProduto(linha.storage_path, orgId, id)) {
    logger.error("[produtos/arquivos] caminho fora do produto", {
      arquivo: linha.id,
      requestId,
    });
    return fail("not_found", t("Arquivo não encontrado."), 404, { requestId });
  }

  const { error: erroDoRemove } = await admin.storage
    .from(BUCKET_DOS_ARQUIVOS)
    .remove([linha.storage_path]);
  if (erroDoRemove) {
    logger.error("[produtos/arquivos] remove do bucket falhou", {
      detalhe: erroDoRemove.message,
      requestId,
    });
    return fail("internal_error", "Erro ao tirar o arquivo.", 500, { requestId });
  }

  const { error: erroDaExclusao } = await admin
    .from("catalog_product_files")
    .delete()
    .eq("id", linha.id)
    .eq("organization_id", orgId);

  if (erroDaExclusao) {
    // O objeto já saiu. A linha que ficou aponta para nada, e a página de
    // entrega mostraria um arquivo que não abre: é pior ficar calado.
    logger.error("[produtos/arquivos] exclusao da linha falhou", {
      detalhe: erroDaExclusao.message,
      arquivo: linha.id,
      requestId,
    });
    return fail("internal_error", "Erro ao tirar o arquivo.", 500, { requestId });
  }

  await audit({
    organizationId: orgId,
    actorUserId: authz.user.id,
    action: "catalog_product.file_removed",
    resourceType: "catalog_products",
    resourceId: id,
    requestId,
    metadata: { arquivo_id: linha.id, nome: linha.nome_arquivo },
  });

  return ok({ removido: true }, { requestId });
}
