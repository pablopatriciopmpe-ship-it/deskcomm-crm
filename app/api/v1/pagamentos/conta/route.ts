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
 * são segredo (grant por coluna, migration 0693). Então a leitura vai pela
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
 *
 * ## Por que o carimbo vem com o `handle` no corpo
 *
 * Porque a assinatura é sobre UMA conta, e quem assina estava olhando a tela.
 * Sem isso: a admin A abre a tela com a conta `antiga`, a admin B troca para
 * `nova`, a A clica em "conferi" na aba velha — e `nova` nasce carimbada sem
 * ninguém ter olhado a chave dela. O PUT já derruba o carimbo quando a conta
 * troca; aceitar um carimbo cego aqui desfaria exatamente essa trava. Então o
 * `handle` do corpo é a VERSÃO que a pessoa viu: se não for mais a conta ativa,
 * a resposta é 409 e a tela recarrega.
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

/**
 * O corpo do carimbo. O `handle` é a VERSÃO que a pessoa viu (ver o cabeçalho);
 * o `o_que` escolhe qual das duas conferências está sendo assinada — elas são
 * fatos diferentes, conferidos em lugares diferentes do painel do provedor, e
 * uma assinatura não responde pela outra.
 */
const carimboSchema = contaSchema.extend({
  o_que: z.enum(["chave_pix", "webhook"]),
});

const COLUNA_DO_CARIMBO = {
  chave_pix: { em: "pix_conferido_em", por: "pix_conferido_por" },
  webhook: { em: "webhook_conferido_em", por: "webhook_conferido_por" },
} as const;

const AUDITORIA_DO_CARIMBO = {
  chave_pix: "pagamento.chave_pix_conferida",
  webhook: "pagamento.webhook_conferido",
} as const;

export async function GET() {
  const requestId = randomUUID();
  const auth = await requireRole("admin", { requestId, resource: "pagamentos" });
  if (!auth.ok) return auth.response;

  const { data, error } = await (await createClient())
    .from("payment_provider_credentials_safe")
    .select("id, handle, pix_conferido_em, webhook_conferido_em, is_active")
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
      webhook_conferido_em: data.webhook_conferido_em,
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

  const orgId = auth.org.orgId;
  const novoHandle = parsed.data.handle;

  const admin = createAdminClient();
  const { data: existente } = await admin
    .from("payment_provider_credentials")
    .select("id, handle")
    .eq("organization_id", orgId)
    .eq("provider", PROVEDOR_INFINITEPAY)
    .eq("is_active", true)
    .maybeSingle();

  async function gravar(id: string, trocouDeConta: boolean) {
    return admin.from("payment_provider_credentials").upsert(
      {
        id,
        organization_id: orgId,
        provider: PROVEDOR_INFINITEPAY,
        label: "InfinitePay",
        handle: novoHandle,
        webhook_path_token_sha256: hashDoToken(tokenDoWebhook(id)),
        is_active: true,
        // Trocar a conta zera OS DOIS carimbos: a chave PIX conferida era da
        // conta ANTERIOR, e o webhook foi cadastrado no painel DAQUELA conta —
        // a nova não tem nada configurado. Deixá-los de pé faria o sistema
        // cobrar numa conta que ninguém olhou, pelo aviso que ninguém ligou.
        ...(trocouDeConta
          ? {
              pix_conferido_em: null,
              pix_conferido_por: null,
              webhook_conferido_em: null,
              webhook_conferido_por: null,
            }
          : {}),
      },
      { onConflict: "id" },
    );
  }

  let id = (existente as { id: string } | null)?.id ?? randomUUID();
  let trocouDeConta = Boolean(existente) && existente!.handle !== novoHandle;
  let { error } = await gravar(id, trocouDeConta);

  // Duas pessoas ligando a conta ao MESMO tempo: as duas leram "não existe" e
  // sortearam ids diferentes. O `onConflict: "id"` não vê conflito, mas o
  // índice único PARCIAL (organization_id, provider) where is_active recusa a
  // segunda com 23505. Em vez de devolver 500 para quem perdeu a corrida,
  // releia a linha que venceu e grave sobre ela.
  if (error?.code === "23505" && !existente) {
    const { data: vencedora } = await admin
      .from("payment_provider_credentials")
      .select("id, handle")
      .eq("organization_id", auth.org.orgId)
      .eq("provider", PROVEDOR_INFINITEPAY)
      .eq("is_active", true)
      .maybeSingle();
    const linha = vencedora as { id: string; handle: string } | null;
    if (linha) {
      id = linha.id;
      trocouDeConta = linha.handle !== novoHandle;
      ({ error } = await gravar(id, trocouDeConta));
    }
  }

  if (error) {
    return fail("internal_error", "Não foi possível salvar a conta de pagamento.", 500, {
      requestId,
    });
  }

  void audit({
    action: "pagamento.conta_configurada",
    organizationId: orgId,
    actorUserId: auth.user.id,
    requestId,
    resourceType: "payment_provider_credential",
    resourceId: id,
    // O handle é público (é como os clientes pagam). O token NÃO entra aqui.
    metadata: { handle: novoHandle, trocou_de_conta: trocouDeConta },
  });

  return ok(
    { configurada: true, handle: parsed.data.handle, webhook_url: urlDoWebhook(id) },
    { requestId },
  );
}

/** O carimbo humano da chave PIX (ver o cabeçalho). */
export async function PATCH(req: Request) {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const auth = await requireRole("admin", { requestId, resource: "pagamentos" });
  if (!auth.ok) return auth.response;

  const parsed = carimboSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("validation_failed", "Recarregue a tela e confira de novo.", 422, { requestId });
  }
  const coluna = COLUNA_DO_CARIMBO[parsed.data.o_que];
  const agora = new Date().toISOString();

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("payment_provider_credentials")
    .update({ [coluna.em]: agora, [coluna.por]: auth.user.id })
    .eq("organization_id", auth.org.orgId)
    .eq("provider", PROVEDOR_INFINITEPAY)
    .eq("is_active", true)
    .eq("handle", parsed.data.handle)
    .select("id")
    .maybeSingle();

  if (error) {
    return fail("internal_error", "Não foi possível registrar a conferência.", 500, { requestId });
  }
  if (!data) {
    // Duas causas diferentes, e a pessoa precisa de instruções diferentes: não
    // há conta nenhuma, ou a conta ativa já é OUTRA. A leitura extra só acontece
    // aqui, no caminho que já falhou.
    const { data: ativa } = await admin
      .from("payment_provider_credentials")
      .select("id")
      .eq("organization_id", auth.org.orgId)
      .eq("provider", PROVEDOR_INFINITEPAY)
      .eq("is_active", true)
      .maybeSingle();

    if (!ativa) {
      return fail("not_found", "Ligue a conta de pagamento antes de conferir a chave.", 404, {
        requestId,
      });
    }
    return fail(
      "state_conflict",
      "A conta mudou desde que esta tela abriu. Recarregue e confira a chave da conta atual.",
      409,
      { requestId },
    );
  }

  void audit({
    action: AUDITORIA_DO_CARIMBO[parsed.data.o_que],
    organizationId: auth.org.orgId,
    actorUserId: auth.user.id,
    requestId,
    resourceType: "payment_provider_credential",
    resourceId: data.id,
  });

  return ok({ o_que: parsed.data.o_que, conferido_em: agora }, { requestId });
}
