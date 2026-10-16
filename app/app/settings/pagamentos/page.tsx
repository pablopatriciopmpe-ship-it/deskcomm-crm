import { redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { urlDoWebhook } from "@/lib/pagamentos/token-do-webhook";
import { PROVEDOR_INFINITEPAY } from "@/lib/pagamentos/vocabulario";
import { createClient } from "@/lib/supabase/server";

import { ContaDePagamento } from "./_client";

export const dynamic = "force-dynamic";
export const metadata = { title: "Receber pagamentos" };

/**
 * A tela onde a empresa liga o recebimento por PIX.
 *
 * ── Quem entra ──────────────────────────────────────────────────────────────
 *
 * `admin`. Quem mexe aqui decide PARA ONDE VAI O DINHEIRO das vendas — mesma
 * régua de Conversões e Billing, e a rota da API cobra a mesma coisa. A tela
 * não inventa uma segunda régua: quem não é admin recebe `/403`, que é o que a
 * rota devolveria.
 *
 * ── O que ela lê, e o que ela NÃO lê ────────────────────────────────────────
 *
 * Lê pela view `_safe`, que não tem o segredo. O token do webhook não é lido de
 * lugar nenhum: ele é DERIVADO do segredo da instalação na hora de montar a
 * URL. Por isso a tela pode mostrar o endereço sem que ele exista no banco.
 */
export default async function PagamentosPage() {
  const user = await requireAuth();
  const org = await resolveActiveOrg(user);
  if (!org || ROLE_RANK[org.role] < ROLE_RANK.admin) redirect("/403");

  const { data } = await (await createClient())
    .from("payment_provider_credentials_safe")
    .select("id, handle, pix_conferido_em")
    .eq("organization_id", org.orgId)
    .eq("provider", PROVEDOR_INFINITEPAY)
    .eq("is_active", true)
    .maybeSingle();

  const conta = data as { id: string; handle: string; pix_conferido_em: string | null } | null;

  return (
    <ContaDePagamento
      inicial={
        conta
          ? {
              configurada: true,
              handle: conta.handle,
              pixConferidoEm: conta.pix_conferido_em,
              webhookUrl: urlDoWebhook(conta.id),
            }
          : { configurada: false }
      }
    />
  );
}
