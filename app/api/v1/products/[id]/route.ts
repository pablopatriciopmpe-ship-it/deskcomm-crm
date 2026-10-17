import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * PATCH  /api/v1/products/:id — muda o que veio, não encosta no resto.
 * DELETE /api/v1/products/:id — remove do catálogo.
 *
 * O id vai no PATH, não no corpo, e o DELETE confere que a linha existia ANTES
 * de auditar: sem isso, um DELETE barrado pela RLS devolveria sucesso e gravaria
 * auditoria de uma mutação que não aconteceu.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { audit } from "@/lib/audit";
import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import {
  apagarEntregaveisDoBucket,
  caminhosDosEntregaveis,
} from "@/lib/catalogo/arquivos-no-bucket";
import { apagarDoBucket } from "@/lib/catalogo/fotos-no-bucket";
import { COLUNAS_DO_PRODUTO, produtoPatchSchema } from "@/lib/schemas/produtos";
import { createClient } from "@/lib/supabase/server";
import { traduzir } from "@/lib/i18n/dicionario";

export const dynamic = "force-dynamic";

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "catalog_products" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { id } = await params;

  const parsed = produtoPatchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("validation_failed", t("Dados inválidos."), 422, {
      requestId,
      details: parsed.error.flatten().fieldErrors as Record<string, unknown>,
    });
  }
  if (Object.keys(parsed.data).length === 0) {
    return fail("validation_failed", t("Nada para alterar."), 422, { requestId });
  }

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("catalog_products")
    .update(parsed.data)
    .eq("organization_id", authz.org.orgId)
    .eq("id", id)
    .select(COLUNAS_DO_PRODUTO)
    .maybeSingle();

  if (error) {
    if (error.code === "23505") {
      return fail("conflict", t("Já existe um produto com esse código."), 409, { requestId });
    }
    return fail("internal_error", "Erro ao salvar o produto.", 500, { requestId });
  }
  // `maybeSingle` devolve null quando a RLS barrou ou o id não é desta org — os
  // dois são "não existe para você", e 404 é a resposta honesta.
  if (!data) return fail("not_found", t("Produto não encontrado."), 404, { requestId });

  await audit({
    organizationId: authz.org.orgId,
    actorUserId: authz.user.id,
    action: "catalog_product.updated",
    resourceType: "catalog_products",
    resourceId: id,
    requestId,
  });

  return ok(data, { requestId });
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "catalog_products" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { id } = await params;

  // ⚠️ LER ANTES DE APAGAR. `catalog_product_files` tem `on delete cascade` para
  // o produto: depois do DELETE as linhas não existem, e com elas vão os únicos
  // ponteiros para os objetos no bucket. Sem esta leitura, apagar um produto
  // deixava o arquivo vendido no `produtos-digitais` para sempre, comendo a cota
  // de 1 GB que a instalação divide com a mídia do WhatsApp. As fotos não têm
  // esse problema porque moram numa COLUNA da própria linha, que o DELETE
  // devolve.
  const entregaveis = await caminhosDosEntregaveis(authz.org.orgId, id);

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("catalog_products")
    .delete()
    .eq("organization_id", authz.org.orgId)
    .eq("id", id)
    .select("id, fotos")
    .maybeSingle();

  if (error) return fail("internal_error", "Erro ao remover o produto.", 500, { requestId });
  if (!data) return fail("not_found", t("Produto não encontrado."), 404, { requestId });
  // As fotos saem junto: a linha era a única referência a elas.
  await apagarDoBucket(authz.org.orgId, id, (data as { fotos: string[] | null }).fotos ?? [], requestId);
  await apagarEntregaveisDoBucket(authz.org.orgId, id, entregaveis, requestId);

  await audit({
    organizationId: authz.org.orgId,
    actorUserId: authz.user.id,
    action: "catalog_product.deleted",
    resourceType: "catalog_products",
    resourceId: id,
    requestId,
  });

  return ok({ id }, { requestId });
}
