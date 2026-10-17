/**
 * O WORKER DA CONFIRMAÇÃO — a peça que liga as duas metades do caminho do
 * dinheiro.
 *
 * A rota do webhook grava e responde em menos de 1 s, porque é o que o provedor
 * exige. Quem decide é este handler, fora do ciclo da resposta:
 *
 *   1. relê a cobrança pelo id que NÓS mandamos (`order_nsu`);
 *   2. confere o recibo PÚBLICO do provedor — valor, transação e vendedor;
 *   3. só então marca pago, e aí entrega.
 *
 * ## Por que ele não confia em nada do aviso
 *
 * O aviso da InfinitePay não é assinado. Tudo que vem nele é pedido de
 * releitura, nunca fato: o valor conferido sai do NOSSO banco, o vendedor sai
 * da NOSSA conta, e o endereço do recibo é derivado, não copiado. O banco
 * fecha a porta por último — `payment_charges_conferida_antes_de_paga` recusa
 * `paid` sem o carimbo da conferência.
 *
 * ## Organização parada: a SUSPENSA segue, a encerrada não
 *
 * Ele sai para fora (busca o recibo) e manda mensagem, então seria candidato
 * natural a `pula`. Não é, e o motivo é de quem paga:
 *
 *   **o cliente final já pagou, e ele não tem nada a ver com a mensalidade que
 *   a empresa deve à instalação.** Recusar o registro não desfaz o pagamento —
 *   só esconde que ele aconteceu. Pior: `skipped` conta como CONSUMIDO, então o
 *   aviso morria ali, a cobrança ficava `pending` para sempre e ninguém nunca
 *   soube. (Esta seção dizia que "a reconciliação a encontra quando a
 *   organização voltar". Não existia reconciliação nenhuma no código, e a sonda
 *   diária só lê cobranças JÁ pagas. Era promessa falsa.)
 *
 * Suspensa segue; **redigida e arquivada não**. `parada` na régua da casa é
 * `status != 'active'`, e isso inclui organização apagada por LGPD e
 * organização encerrada: confirmar venda e entregar arquivo nessas duas estaria
 * errado. A separação é feita aqui dentro, porque o dispatcher só oferece
 * `roda` ou `pula`.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { sendMessageHandler } from "@/app/api/v1/messages/_handler";
import type { EventHandler, EventRow, HandlerResult } from "@/lib/event-log/dispatcher";
import { logger } from "@/lib/logger";
import { ehOperante, estaSuspensa } from "@/lib/organizacao/operante";
import { createAdminClient } from "@/lib/supabase/admin";
import { prepararEntrega } from "./entrega";
import { conferirPeloRecibo, ErroDaInfinitePay } from "./provedores/infinitepay";
import { EVENTO_AVISO_DE_PAGAMENTO } from "./vocabulario";

const CONSUMER_KEY = "pagamentos.confirmar";

const resultado = (status: HandlerResult["status"], detail?: string): HandlerResult => ({
  consumer_key: CONSUMER_KEY,
  status,
  ...(detail ? { detail } : {}),
});

/**
 * Falha que o tempo cura (rede, 5xx do provedor) pede nova tentativa. Falha de
 * CONTEÚDO não: o recibo não vai mudar, e repetir para sempre só enche a fila.
 * Nesse caso quem avisa é a sonda diária, que mede a mesma conferência.
 */
const CURA_COM_O_TEMPO = new Set(["recibo_inacessivel", "erro_inesperado"]);

async function handle(row: EventRow): Promise<HandlerResult> {
  if (!row.entity_id) return resultado("skipped", "sem_cobranca");
  const admin = createAdminClient();

  // Ver o cabeçalho: suspensa SEGUE, redigida e arquivada não. Uma leitura por
  // chave primária, antes de qualquer trabalho.
  const { data: org, error: erroDaOrg } = await admin
    .from("organizations")
    .select("status")
    .eq("id", row.organization_id)
    .maybeSingle();
  if (erroDaOrg) return resultado("error", `leitura da organizacao falhou: ${erroDaOrg.code ?? "sem_codigo"}`);
  const statusDaOrg = (org as { status?: string | null } | null)?.status;
  if (!ehOperante(statusDaOrg) && !estaSuspensa(statusDaOrg)) {
    return resultado("skipped", "organizacao_encerrada");
  }

  const { data: cobranca, error } = await admin
    .from("payment_charges")
    .select(
      "id, order_id, status, amount_cents, handle_do_recebedor, payment_provider_credentials(handle)",
    )
    .eq("id", row.entity_id)
    .eq("organization_id", row.organization_id)
    .maybeSingle();

  if (error) return resultado("error", `leitura da cobranca falhou: ${error.code ?? "sem_codigo"}`);
  if (!cobranca) return resultado("skipped", "cobranca_desconhecida");
  // A baixa acontece ANTES da entrega, de propósito (o dinheiro entrou, e isso
  // é fato). Mas encerrar aqui matava a retentativa: entrega que falhasse por
  // motivo passageiro devolvia `error` para a fila, a fila repetia, e a
  // repetição parava NESTA linha — o comprador pagava e nunca recebia. Agora
  // `paid` manda terminar o serviço; `prepararEntrega` é quem diz se já foi
  // feito, e nesse caso nada é reenviado.
  if (cobranca.status === "paid") return entregar(admin, row.organization_id, cobranca.order_id);

  const nsu = typeof row.payload.transaction_nsu === "string" ? row.payload.transaction_nsu : "";
  if (!nsu) return resultado("skipped", "aviso_sem_transacao");

  // O RETRATO primeiro, a linha depois. A conta é mutável: se a organização
  // trocou a InfiniteTag entre a criação desta cobrança e o aviso, o dinheiro
  // caiu na conta ANTIGA e é o handle dela que o recibo mostra. Comparar com o
  // handle ATUAL recusaria uma venda legítima — o cliente teria pagado e não
  // receberia. O ponteiro só responde quando não há retrato.
  const bruto = (cobranca as { payment_provider_credentials?: unknown })
    .payment_provider_credentials;
  const handleDaLinha = Array.isArray(bruto)
    ? (bruto[0] as { handle?: string } | undefined)?.handle
    : (bruto as { handle?: string } | null)?.handle;
  const handle_ =
    (cobranca as { handle_do_recebedor?: string | null }).handle_do_recebedor ?? handleDaLinha;
  if (!handle_) return resultado("skipped", "conta_sem_handle");

  try {
    await conferirPeloRecibo({
      transactionNsu: nsu,
      amountCentsEsperado: cobranca.amount_cents,
      handle: handle_,
    });
  } catch (e) {
    const codigo = e instanceof ErroDaInfinitePay ? e.codigo : "erro_inesperado";
    if (CURA_COM_O_TEMPO.has(codigo)) return resultado("error", codigo);
    // Aviso que não confere NÃO vira venda, e também não vira retentativa
    // eterna. Fica registrado com o motivo, e a sonda do recibo é quem acusa se
    // isto virar rotina — que é o sintoma de a página do provedor ter mudado.
    logger.warn("[pagamentos.confirmar] recibo não confere", {
      cobranca: cobranca.id,
      motivo: codigo,
    });
    return resultado("skipped", codigo);
  }

  const agora = new Date().toISOString();
  const { error: erroDaBaixa } = await admin
    .from("payment_charges")
    .update({
      status: "paid",
      paid_at: agora,
      conferido_pelo_recibo_em: agora,
      transaction_nsu: nsu,
      ...(typeof row.payload.invoice_slug === "string"
        ? { external_charge_id: row.payload.invoice_slug }
        : {}),
      ...(row.payload.capture_method === "pix" || row.payload.capture_method === "credit_card"
        ? { metodo: row.payload.capture_method }
        : {}),
    })
    .eq("id", cobranca.id)
    .eq("organization_id", row.organization_id)
    .neq("status", "paid");

  if (erroDaBaixa) return resultado("error", `baixa falhou: ${erroDaBaixa.code ?? "sem_codigo"}`);

  await admin
    .from("orders")
    .update({ status: "paid" })
    .eq("id", cobranca.order_id)
    .eq("organization_id", row.organization_id);

  return entregar(admin, row.organization_id, cobranca.order_id);
}

/**
 * A entrega é o ÚLTIMO passo e a falha dela não desfaz o pagamento: o dinheiro
 * entrou, e isso é fato registrado. Entrega que não sai vira `error` para a
 * fila tentar de novo — e, se insistir, o aviso da Central é quem chama gente.
 */
async function entregar(
  admin: SupabaseClient,
  organizationId: string,
  orderId: string,
): Promise<HandlerResult> {
  const entrega = await prepararEntrega(admin, organizationId, orderId);

  if ("motivo" in entrega) {
    // Produto sem arquivo não é defeito: é venda de coisa que não se baixa.
    if (entrega.motivo === "sem_arquivo") return resultado("ok", "pago_sem_arquivo");
    // Serviço já concluído (aviso repetido, ou a outra ponta da corrida). Não é
    // erro: virar `error` faria a fila repetir para sempre, e um segundo link
    // nunca é mandado.
    if (entrega.motivo === "ja_entregue") return resultado("ok", "ja_entregue");
    return resultado("error", "entrega_nao_nasceu");
  }

  const { data: pedido } = await admin
    .from("orders")
    .select("contact_id")
    .eq("id", orderId)
    .eq("organization_id", organizationId)
    .maybeSingle();

  const contactId = (pedido as { contact_id: string | null } | null)?.contact_id;
  if (!contactId) return resultado("ok", "entregue_sem_contato");

  const { data: conversa } = await admin
    .from("conversations")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("contact_id", contactId)
    .order("last_message_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const conversationId = (conversa as { id: string } | null)?.id;
  if (!conversationId) return resultado("ok", "entregue_sem_conversa");

  try {
    await sendMessageHandler(
      admin,
      {
        organization_id: organizationId,
        actor: { type: "webhook_source", id: "pagamento:confirmado" },
        requestId: `pagamento-entrega:${orderId}`,
      } as Parameters<typeof sendMessageHandler>[1],
      {
        conversation_id: conversationId,
        type: "text",
        body:
          `Pagamento confirmado! Seu acesso está aqui:\n${entrega.url}\n\n` +
          `O link vale por ${Math.round((Date.parse(entrega.expiraEm) - Date.now()) / 86_400_000)} dias.`,
      },
    );
  } catch (e) {
    // Mensagem recusada (contato pediu para não receber, janela fechada) NÃO
    // desfaz a entrega: ela existe, o link continua válido por 30 dias, e o
    // pedido pago aparece no painel do contato, dentro da conversa.
    //
    // ⚠️ MAS NÃO HÁ COMO REENVIAR O LINK. Este comentário dizia "quem opera vê
    // o pedido pago e pode reenviar", e a segunda metade era falsa: nenhuma
    // tela lê `order_deliveries`, e o token em claro não existe mais em lugar
    // nenhum (é hash no banco, de propósito). Então hoje, quando o aviso não
    // sai, quem comprou fica sem o endereço até alguém construir o reenvio —
    // que gera um link novo e revoga este. É o buraco conhecido deste módulo.
    logger.warn("[pagamentos.confirmar] entrega criada mas o aviso não saiu", {
      pedido: orderId,
      erro: e instanceof Error ? e.message : "desconhecido",
    });
    return resultado("ok", "entregue_sem_aviso");
  }

  return resultado("ok", "entregue");
}

export const confirmarPagamentoHandler: EventHandler = {
  key: CONSUMER_KEY,
  // `roda`, e o cabeçalho explica: quem pagou foi o cliente final.
  naOrgParada: "roda",
  events: [EVENTO_AVISO_DE_PAGAMENTO],
  handle,
};
