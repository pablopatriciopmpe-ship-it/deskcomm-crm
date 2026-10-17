/**
 * A conta de pagamento da organização — ler, ligar e carimbar a chave PIX.
 *
 * ## Por que `admin` e não `manager`
 *
 * Quem troca o `handle` troca PARA ONDE VAI O DINHEIRO das vendas. É a mesma
 * régua de Conversões e de Billing, pelo mesmo motivo: um `manager` decidindo
 * destino de receita ficaria acima de quem paga a conta.
 *
 * ## Por que a escrita usa o cliente de serviço
 *
 * A tabela-base é fechada: `authenticated` só tem SELECT nas colunas que não
 * são segredo (grant por coluna, migration 0689). Então a leitura vai pela
 * sessão — e a RLS vale — e a escrita vai pelo serviço, com o
 * `organization_id` resolvido do cookie, nunca do corpo.
 *
 * ## O carimbo da chave PIX
 *
 * Não é frescura de formulário: **a InfinitePay não deixa checar isso pela
 * API**. Sem a chave cadastrada lá, o link de pagamento nasce com HTTP 200, o
 * PIX aparece como opção e só falha na tela do cliente que já decidiu comprar.
 * Como nenhuma chamada responde, o que resta é uma pessoa conferir e assinar —
 * e é isso que a cobrança exige antes de existir.
 */
import { randomUUID } from "node:crypto";

import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { hashDoToken, tokenDoWebhook, urlDoWebhook } from "@/lib/pagamentos/token-do-webhook";
import { PROVEDOR_INFINITEPAY } from "@/lib/pagamentos/vocabulario";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/** A InfiniteTag. Aceita com e sem `$`, guarda sem. */
const contaSchema = z.object({
  handle: z
    .string()
    .trim()
    .min(2)
    .max(120)
    .transform((h) => h.replace(/^\$/, ""))
    .refine((h) => /^[a-zA-Z0-9._-]+$/.test(h), {
      message: "A InfiniteTag não tem espaço nem acento.",
    }),
});

export async function GET() {
  const requestId = randomUUID();
  const auth = await requireRole("admin", { requestId, resource: "pagamentos" });
  if (!auth.ok) return auth.response;

  const { data, error } = await (await createClient())
    .from("payment_provider_credentials_safe")
    .select("id, handle, pix_conferido_em, is_active")
    .eq("organization_id", auth.org.orgId)
    .eq("provider", PROVEDOR_INFINITEPAY)
    .eq("is_active", true)
    .maybeSingle();

  if (error) {
    return fail("internal_error", "Não foi possível ler a conta de pagamento.", 500, { requestId });
  }

  if (!data) return ok({ configurada: false }, { requestId });

  return ok(
    {
      configurada: true,
      handle: data.handle,
      pix_conferido_em: data.pix_conferido_em,
      // A URL é DERIVADA aqui, não guardada: o token sai do segredo da
      // instalação (ver `lib/pagamentos/token-do-webhook.ts`).
      webhook_url: urlDoWebhook(data.id),
    },
    { requestId },
  );
}

export async function PUT(req: Request) {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const auth = await requireRole("admin", { requestId, resource: "pagamentos" });
  if (!auth.ok) return auth.response;

  const parsed = contaSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("validation_failed", "Confira a InfiniteTag.", 422, { requestId });
  }

  const admin = createAdminClient();
  const { data: existente } = await admin
    .from("payment_provider_credentials")
    .select("id, handle")
    .eq("organization_id", auth.org.orgId)
    .eq("provider", PROVEDOR_INFINITEPAY)
    .eq("is_active", true)
    .maybeSingle();

  const id = (existente as { id: string } | null)?.id ?? randomUUID();
  const trocouDeConta = Boolean(existente) && existente!.handle !== parsed.data.handle;

  const { error } = await admin.from("payment_provider_credentials").upsert(
    {
      id,
      organization_id: auth.org.orgId,
      provider: PROVEDOR_INFINITEPAY,
      label: "InfinitePay",
      handle: parsed.data.handle,
      webhook_path_token_sha256: hashDoToken(tokenDoWebhook(id)),
      is_active: true,
      // Trocar a conta zera o carimbo: a chave PIX conferida era da conta
      // ANTERIOR, e deixá-lo de pé faria o sistema cobrar numa conta cuja
      // chave ninguém olhou.
      ...(trocouDeConta ? { pix_conferido_em: null, pix_conferido_por: null } : {}),
    },
    { onConflict: "id" },
  );

  if (error) {
    return fail("internal_error", "Não foi possível salvar a conta de pagamento.", 500, {
      requestId,
    });
  }

  void audit({
    action: "pagamento.conta_configurada",
    organizationId: auth.org.orgId,
    actorUserId: auth.user.id,
    requestId,
    resourceType: "payment_provider_credential",
    resourceId: id,
    // O handle é público (é como os clientes pagam). O token NÃO entra aqui.
    metadata: { handle: parsed.data.handle, trocou_de_conta: trocouDeConta },
  });

  return ok(
    { configurada: true, handle: parsed.data.handle, webhook_url: urlDoWebhook(id) },
    { requestId },
  );
}

/** O carimbo humano da chave PIX (ver o cabeçalho). */
export async function PATCH() {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const auth = await requireRole("admin", { requestId, resource: "pagamentos" });
  if (!auth.ok) return auth.response;

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("payment_provider_credentials")
    .update({ pix_conferido_em: new Date().toISOString(), pix_conferido_por: auth.user.id })
    .eq("organization_id", auth.org.orgId)
    .eq("provider", PROVEDOR_INFINITEPAY)
    .eq("is_active", true)
    .select("id")
    .maybeSingle();

  if (error) {
    return fail("internal_error", "Não foi possível registrar a conferência.", 500, { requestId });
  }
  if (!data) {
    return fail("not_found", "Ligue a conta de pagamento antes de conferir a chave.", 404, {
      requestId,
    });
  }

  void audit({
    action: "pagamento.chave_pix_conferida",
    organizationId: auth.org.orgId,
    actorUserId: auth.user.id,
    requestId,
    resourceType: "payment_provider_credential",
    resourceId: data.id,
  });

  return ok({ pix_conferido_em: new Date().toISOString() }, { requestId });
}
