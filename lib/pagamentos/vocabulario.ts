/**
 * O vocabulário da cobrança avulsa, em UM lugar.
 *
 * `event_log.event_type` é coluna de vocabulário ABERTO — não tem CHECK, de
 * propósito (CLAUDE.md, Modelagem): um clone pode ter linhas com valor legado, e
 * a constraint quebraria o `update.sh` dele. A regra que vale no lugar do CHECK
 * é esta: o emissor usa a CONSTANTE, nunca a string literal. Sem isso, quem
 * emite e quem consome divergem por um caractere e o evento morre sem consumidor
 * — o anti-pattern nº 3 da casa.
 */

/**
 * O aviso do gateway CHEGOU e foi gravado. Não quer dizer que foi pago: quem
 * decide é o worker, depois de conferir o recibo. A rota não entrega nada.
 */
export const EVENTO_AVISO_DE_PAGAMENTO = "pagamento.aviso_recebido" as const;

/** O provedor, como ele aparece em `payment_charges.provider` e no log. */
export const PROVEDOR_INFINITEPAY = "infinitepay" as const;
