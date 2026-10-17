/**
 * O ADAPTADOR DA INFINITEPAY (Checkout Integrado) — cobrança avulsa que uma
 * ORGANIZAÇÃO faz ao cliente dela. Não confundir com `lib/cobranca/`, que é a
 * assinatura DA INSTALAÇÃO e tem contrato próprio (`AdaptadorDeCobranca`).
 *
 * Tudo aqui foi MEDIDO contra a API real em 15/10/2026, com cobrança de R$ 1
 * paga de verdade. A documentação deles tem pelo menos um erro confirmado, e
 * onde este arquivo diverge dela é de propósito — o comentário diz qual é a
 * medição.
 *
 * ─── As quatro regras que custaram caro ──────────────────────────────────────
 *
 * 1. **404 é erro de REGRA DE NEGÓCIO, não rota inexistente.** `POST /links` com
 *    a conta sem Checkout Integrado devolve 404 com
 *    `{"error":"external_checkout_not_enabled"}` no corpo. Decidir pelo código
 *    HTTP engole erro de negócio calado — que é como uma venda some sem
 *    ninguém ver. Por isso `lerCorpo` lê o corpo SEMPRE, em qualquer status.
 *
 * 2. **O campo do aviso é `invoice_slug`, não `slug`.** A documentação oficial
 *    diz `slug` (e o redirect usa `slug` mesmo); o webhook manda `invoice_slug`.
 *    Medido. Quem seguir a documentação não acha a cobrança e nenhuma venda é
 *    confirmada.
 *
 * 3. **`POST /payment_check` é ROTA MORTA e este arquivo não a chama.** Ela
 *    devolve a mesma resposta para parâmetros válidos, parâmetros inválidos e
 *    CORPO VAZIO — medido nos dois lados. Um endpoint que responde igual a um
 *    corpo vazio não está lendo parâmetro nenhum. Se alguém voltar a adicioná-la
 *    como "fonte de verdade do pagamento", está reintroduzindo o buraco que a
 *    conferência pelo recibo existe para tapar.
 *
 * 4. **A chave PIX da conta não é verificável pela API.** Sem ela, o link nasce
 *    com HTTP 200, o PIX aparece como opção e só quebra na tela do comprador.
 *    Não há o que checar aqui — quem cobra o carimbo é `pix_conferido_em`
 *    (migration 0689) e a tela que o lê.
 *
 * ─── Por que a conferência pelo recibo é obrigatória ─────────────────────────
 *
 * O webhook da InfinitePay **não tem assinatura, segredo nem cabeçalho de
 * autenticação**. Quem descobrir o endereço pode mandar um JSON dizendo "pago".
 * Como a regra 3 fecha a validação pela API, sobram duas camadas, e as duas são
 * obrigatórias:
 *
 *   (a) o `webhook_path_token` no CAMINHO da rota — servidor-a-servidor, nunca
 *       aparece no navegador do comprador;
 *   (b) esta conferência: buscar o `receipt_url` e exigir que o recibo PÚBLICO
 *       do provedor confirme o mesmo `transaction_nsu` e o mesmo valor.
 *
 * O banco cobra (b) por CHECK (`payment_charges_conferida_antes_de_paga`): sem
 * `conferido_pelo_recibo_em`, a linha não pode ficar `paid`.
 *
 * ─── O que esta conferência NÃO é ────────────────────────────────────────────
 *
 * É leitura de HTML público, não API versionada. Se a InfinitePay mudar o
 * layout do recibo, ela quebra — e quebra para o lado SEGURO (recusa, não
 * libera). Mas recusar toda venda também é defeito, e silencioso: por isso ela
 * tem de ter sonda periódica contra um recibo real, não só verde no build.
 */
import { z } from "zod";

/** A base da API. Único host de escrita, e ele não pede chave nenhuma. */
export const INFINITEPAY_API_BASE = "https://api.checkout.infinitepay.io";

/**
 * O host do recibo, FIXO. O `receipt_url` chega dentro de um aviso NÃO
 * ASSINADO: buscá-lo como veio é SSRF de manual — quem forja o aviso escolhe o
 * endereço que o nosso servidor vai visitar. Só este host é aceito, e o
 * redirecionamento é recusado (`redirect: "error"`), senão o pino vale nada.
 */
export const INFINITEPAY_RECIBO_HOST = "recibo.infinitepay.io";

const TEMPO_LIMITE_MS = 10_000;

/** Erro do provedor. Nunca carrega corpo cru: a mensagem deles ecoa dado do pagador. */
export class ErroDaInfinitePay extends Error {
  constructor(
    readonly status: number,
    readonly codigo: string,
  ) {
    super(`infinitepay:${codigo}`);
    this.name = "ErroDaInfinitePay";
  }
}

// ─── Criar a cobrança ────────────────────────────────────────────────────────

export interface CobrancaParaCriar {
  /** A InfiniteTag da organização, SEM o `$`. Não é segredo. */
  handle: string;
  /**
   * A nossa referência, que volta no aviso. É o `payment_charges.id`: é assim
   * que o webhook reencontra a cobrança sem confiar em nada que ele mande.
   */
  orderNsu: string;
  /** Em CENTAVOS, como as colunas desta casa. A API também fala centavos. */
  amountCents: number;
  descricao: string;
  webhookUrl: string;
  redirectUrl?: string;
}

const respostaDoLink = z.object({ url: z.string().url() });

const erroDeNegocio = z.object({
  success: z.literal(false),
  error: z.string().optional(),
  message: z.string().optional(),
});

/**
 * Lê o corpo SEMPRE, em qualquer status (regra 1). Devolve o JSON cru para quem
 * chamou decidir — ou levanta `resposta_ilegivel` quando nem JSON é.
 */
async function lerCorpo(r: Response): Promise<unknown> {
  const texto = await r.text();
  try {
    return JSON.parse(texto) as unknown;
  } catch {
    throw new ErroDaInfinitePay(r.status, "resposta_ilegivel");
  }
}

export async function criarCobranca(entrada: CobrancaParaCriar): Promise<{ checkoutUrl: string }> {
  if (!Number.isInteger(entrada.amountCents) || entrada.amountCents <= 0) {
    throw new ErroDaInfinitePay(0, "valor_invalido");
  }

  const r = await fetch(`${INFINITEPAY_API_BASE}/links`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.timeout(TEMPO_LIMITE_MS),
    body: JSON.stringify({
      handle: entrada.handle,
      order_nsu: entrada.orderNsu,
      webhook_url: entrada.webhookUrl,
      ...(entrada.redirectUrl ? { redirect_url: entrada.redirectUrl } : {}),
      items: [{ quantity: 1, price: entrada.amountCents, description: entrada.descricao }],
    }),
  });

  const corpo = await lerCorpo(r);

  // A ORDEM IMPORTA: o erro de negócio vem com 404, então perguntar "r.ok?"
  // primeiro trataria `external_checkout_not_enabled` como rota perdida.
  const negocio = erroDeNegocio.safeParse(corpo);
  if (negocio.success) {
    throw new ErroDaInfinitePay(r.status, negocio.data.error ?? "erro_sem_codigo");
  }

  const ok = respostaDoLink.safeParse(corpo);
  if (!ok.success) throw new ErroDaInfinitePay(r.status, "resposta_invalida");

  return { checkoutUrl: ok.data.url };
}

// ─── Ler o aviso ─────────────────────────────────────────────────────────────

/**
 * O aviso, como ele CHEGA — `invoice_slug` e não `slug` (regra 2).
 *
 * Nada aqui é confiável por si: o aviso não é assinado. Este schema só garante
 * a FORMA; quem garante o fato é a conferência pelo recibo.
 */
export const avisoDaInfinitePay = z.object({
  order_nsu: z.string().min(1),
  invoice_slug: z.string().min(1),
  transaction_nsu: z.string().min(1),
  amount: z.number().int(),
  paid_amount: z.number().int(),
  capture_method: z.enum(["pix", "credit_card"]),
  receipt_url: z.string().url(),
});

export type AvisoDaInfinitePay = z.infer<typeof avisoDaInfinitePay>;

// ─── A conferência pelo recibo ───────────────────────────────────────────────

export interface ConferenciaPedida {
  /** O que o aviso disse. É exatamente por isso que vai ser conferido. */
  transactionNsu: string;
  /** O valor que NÓS cobramos — lido do nosso banco, nunca do aviso. */
  amountCentsEsperado: number;
  /**
   * A InfiniteTag da organização, lida do NOSSO banco. É o que amarra o recibo
   * ao vendedor certo.
   *
   * Sem ela a conferência provava apenas "existe um pagamento com este nsu, de
   * valor igual" — e isso é verdade para QUALQUER recibo legítimo da
   * InfinitePay, de qualquer vendedor, no mesmo valor. Quem tivesse o token do
   * caminho mandaria o nsu de uma compra alheia e levaria o produto.
   */
  handle: string;
}

/** O endereço do recibo é DERIVADO, nunca o que o aviso mandou (anti-SSRF). */
export function enderecoDoRecibo(transactionNsu: string): string {
  return `https://${INFINITEPAY_RECIBO_HOST}/${encodeURIComponent(transactionNsu)}`;
}

/**
 * Procura o valor no HTML do recibo, nas formas que o real pode ter.
 *
 * ⚠️ ESTA É A PARTE FRÁGIL, e ela é frágil por desenho do provedor, não por
 * preguiça: não existe API para perguntar. Aceita as grafias brasileiras usuais
 * do mesmo número (`R$ 1,00`, `R$&nbsp;1,00`, `1,00`) porque qualquer uma pode
 * aparecer, e NÃO aceita o valor em centavos solto (`100`) — um `100` casaria
 * com qualquer número da página, inclusive um id.
 */
export function reciboMostraValor(html: string, amountCents: number): boolean {
  const reais = Math.floor(amountCents / 100);
  const centavos = String(amountCents % 100).padStart(2, "0");
  const comMilhar = reais.toLocaleString("pt-BR");
  const semMilhar = String(reais);

  // `\s` cobre o espaço comum; ` ` é o não-separável que o HTML costuma usar.
  const corpo = html.replace(/ |&nbsp;/g, " ");
  return [comMilhar, semMilhar].some((parteInteira) => {
    const alvo = `${parteInteira.replace(/[.]/g, "\\.")},${centavos}`;
    return new RegExp(`(^|[^\\d])(R\\$\\s*)?${alvo}([^\\d]|$)`).test(corpo);
  });
}

/**
 * O recibo nomeia o vendedor? Compara sem diferenciar maiúscula e acentuação de
 * `$`, porque o handle aparece ora como `$loja`, ora como `loja`.
 *
 * ⚠️ ASSIM COMO `reciboMostraValor`, esta leitura NÃO FOI CONFERIDA contra um
 * recibo real — e esta é a mais arriscada das duas, porque ela é a que pode
 * recusar venda legítima. Se a página não trouxer o handle em lugar nenhum,
 * TODA conferência falha e NENHUMA venda é confirmada.
 *
 * Isso é ruim, e é o lado certo para errar: o produto não sai sem pagamento, e
 * o defeito aparece em menos de 24 h pelo aviso do cron da sonda, em vez de
 * sair produto de graça em silêncio. Mesmo assim, conferir contra um recibo de
 * verdade é pré-requisito de colocar isto para vender.
 */
export function reciboMencionaOHandle(html: string, handle: string): boolean {
  const limpo = handle.trim().replace(/^\$/, "");
  if (!limpo) return false;
  return html.toLowerCase().includes(limpo.toLowerCase());
}

/**
 * Busca o recibo público e exige que ele confirme o pagamento. Levanta quando
 * NÃO der para confirmar — e levantar é o caminho seguro: sem esta função
 * devolver sem erro, o banco recusa marcar `paid`.
 */
export async function conferirPeloRecibo(pedido: ConferenciaPedida): Promise<void> {
  const r = await fetch(enderecoDoRecibo(pedido.transactionNsu), {
    method: "GET",
    // Sem seguir redirecionamento: um 302 para outro host desfaria o pino.
    redirect: "error",
    signal: AbortSignal.timeout(TEMPO_LIMITE_MS),
  });

  if (!r.ok) throw new ErroDaInfinitePay(r.status, "recibo_inacessivel");

  const html = await r.text();

  // O recibo tem de ser DAQUELA transação. Sem isto, qualquer recibo válido do
  // vendedor serviria para confirmar qualquer cobrança.
  if (!html.includes(pedido.transactionNsu)) {
    throw new ErroDaInfinitePay(200, "recibo_de_outra_transacao");
  }

  // ...e de NOSSO vendedor. Esta é a amarra que faltava: sem ela, o recibo de
  // uma compra feita em outra loja da InfinitePay, no mesmo valor, confirmava
  // uma cobrança nossa.
  if (!reciboMencionaOHandle(html, pedido.handle)) {
    throw new ErroDaInfinitePay(200, "recibo_de_outro_vendedor");
  }

  if (!reciboMostraValor(html, pedido.amountCentsEsperado)) {
    throw new ErroDaInfinitePay(200, "recibo_com_valor_diferente");
  }
}
