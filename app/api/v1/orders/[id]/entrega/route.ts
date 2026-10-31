/**
 * POST /api/v1/orders/:id/entrega — reenvia a entrega de um pedido pago.
 *
 * ── Por que esta rota existe ─────────────────────────────────────────────────
 *
 * Porque havia um caminho em que o cliente PAGA e não recebe, e ninguém tinha
 * botão para resolver. O handler da confirmação cria a entrega e tenta avisar
 * pela conversa; quando o aviso não sai — contato que pediu para não receber,
 * janela de 24 h fechada, organização suspensa — o desfecho é
 * `entregue_sem_aviso`: a entrega existe, o link vale 30 dias, e o endereço não
 * chegou a ninguém. O token em claro não existe em lugar nenhum (é SHA-256 no
 * banco, de propósito), então nem consultando se recuperava.
 *
 * ── Por que ela DEVOLVE o endereço a quem opera ──────────────────────────────
 *
 * Reenviar só pelo WhatsApp não resolveria o caso principal: se a janela está
 * fechada, o reenvio falha igual. Quem está atendendo precisa do endereço na
 * mão para entregar por onde der — outro canal, e-mail, uma ligação. Então a
 * resposta traz a URL, e o envio pela conversa é ESFORÇO, não garantia: a
 * resposta diz se saiu.
 *
 * ── Por que `agent`, e por que isso é seguro de rastrear ─────────────────────
 *
 * Quem percebe que o cliente não recebeu é quem está na conversa. Exigir
 * `manager` deixaria o atendente parado na frente do problema que ele vê.
 *
 * O risco é o oposto: um atendente mal-intencionado reenviando entregas para
 * colher links. Duas coisas o denunciam, e nenhuma é vigilância — são
 * consequências do desenho: todo reenvio **revoga o endereço anterior**, então
 * colher link alheio ARREBENTA o acesso do comprador legítimo, que reclama na
 * hora; e cada reenvio vira linha de auditoria com quem fez.
 */
import { randomUUID } from "node:crypto";

import { type NextRequest } from "next/server";

import { sendMessageHandler } from "@/app/api/v1/messages/_handler";
import { ApiError } from "@/lib/api/types";
import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { traduzir } from "@/lib/i18n/dicionario";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { logger } from "@/lib/logger";
import { reenviarEntrega } from "@/lib/pagamentos/entrega";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "orders" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const orgId = authz.org.orgId;
  const { id } = await params;

  const admin = createAdminClient();

  // O pedido é DESTA organização, e está pago? Reenviar entrega de pedido não
  // pago seria entregar sem pagamento — o caminho que todo o resto deste módulo
  // existe para fechar.
  const { data: pedido, error } = await admin
    .from("orders")
    .select("id, status, contact_id")
    .eq("id", id)
    .eq("organization_id", orgId)
    .maybeSingle();

  if (error) {
    logger.error("[orders/entrega] leitura do pedido falhou", {
      detalhe: error.message,
      requestId,
    });
    return fail("internal_error", "Erro ao ler o pedido.", 500, { requestId });
  }
  if (!pedido) return fail("not_found", t("Pedido não encontrado."), 404, { requestId });

  const linha = pedido as { id: string; status: string | null; contact_id: string | null };
  if (linha.status !== "paid") {
    return fail("state_conflict", t("Este pedido ainda não está pago."), 409, { requestId });
  }

  const nova = await reenviarEntrega(admin, orgId, linha.id);
  if ("motivo" in nova) {
    if (nova.motivo === "sem_arquivo") {
      return fail("validation_failed", t("Este pedido não tem arquivo para entregar."), 422, {
        requestId,
      });
    }
    // O acesso deste pedido foi DESTRUÍDO de propósito: redação de LGPD ou
    // revogação por reembolso (as duas põem o hash do token em nulo). Reenvio
    // não desfaz apagamento — se desfizesse, seria uma porta para devolver
    // acesso a dado que alguém pediu para apagar.
    if (nova.motivo === "acesso_revogado") {
      return fail(
        "state_conflict",
        t("O acesso deste pedido foi revogado e o reenvio não o devolve."),
        409,
        { requestId },
      );
    }
    if (nova.motivo === "reenvio_concorrente") {
      return fail(
        "state_conflict",
        t("Outro reenvio acabou de acontecer neste pedido. Recarregue para ver o endereço atual."),
        409,
        { requestId },
      );
    }
    return fail("internal_error", "Erro ao gerar o endereço novo.", 500, { requestId });
  }

  // ESFORÇO, não garantia: se a janela está fechada o envio falha, e é
  // justamente esse o caso em que quem opera mais precisa do endereço.
  let avisado = false;
  if (linha.contact_id) {
    try {
      const { data: conversa } = await admin
        .from("conversations")
        .select("id")
        .eq("organization_id", orgId)
        .eq("contact_id", linha.contact_id)
        .order("updated_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      const conversaId = (conversa as { id: string } | null)?.id;
      if (conversaId) {
        await sendMessageHandler(
          admin,
          { organization_id: orgId, actor: { type: "user", id: authz.user.id }, requestId },
          {
            conversation_id: conversaId,
            type: "text",
            body: t("Aqui está o acesso ao seu produto:") + `\n${nova.url}`,
          },
        );
        avisado = true;
      }
    } catch (e) {
      if (!(e instanceof ApiError)) throw e;
      logger.warn("[orders/entrega] reenvio sem aviso", { pedido: linha.id, codigo: e.code, requestId });
    }
  }

  await audit({
    organizationId: orgId,
    actorUserId: authz.user.id,
    action: "pagamento.entrega_reenviada",
    resourceType: "orders",
    resourceId: linha.id,
    requestId,
    // O ENDEREÇO NÃO ENTRA: ele é credencial, e a auditoria é lida por mais
    // gente do que o pedido. Fica registrado que houve reenvio e quem fez.
    metadata: { avisado, expira_em: nova.expiraEm, arquivos: nova.arquivos },
  });

  return ok(
    { url: nova.url, expira_em: nova.expiraEm, arquivos: nova.arquivos, avisado },
    { requestId },
  );
}
