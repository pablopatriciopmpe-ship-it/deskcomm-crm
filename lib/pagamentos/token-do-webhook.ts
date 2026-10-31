/**
 * O TOKEN DO WEBHOOK DE PAGAMENTO — derivado, nunca guardado.
 *
 * ## O problema que esta derivação resolve
 *
 * O aviso de pagamento da InfinitePay não é assinado, então quem autentica a
 * chamada é o token no CAMINHO da rota. Isso o torna um segredo portador — e
 * guardar segredo portador em claro é o anti-pattern 13 da casa.
 *
 * Só que guardar o HASH também não resolve sozinho: a URL do webhook vai em
 * CADA cobrança criada (`webhook_url` do `POST /links`), então o servidor
 * precisa do valor de volta, e hash não volta.
 *
 * As duas saídas óbvias são piores:
 *
 *   - guardar cifrado exige a chave de cifra do banco (`fn_encrypt_oauth`), que
 *     depende de um GUC que instalação fresca pode não ter. Uma venda que falha
 *     porque faltou configurar chave de OAuth da Nuvemshop é o tipo de defeito
 *     que ninguém relaciona com a causa;
 *   - não ter token nenhum devolve o problema: qualquer um na internet passa a
 *     bater no nosso webhook.
 *
 * ## A saída: derivar do segredo que TODA instalação já tem
 *
 * `INTERNAL_SECRET` é obrigatória no `lib/env.ts` — sem ela o app nem sobe. O
 * token é um HMAC dela com o id da conta de pagamento: reconstruível quando se
 * precisa montar a URL, e inexistente no banco, onde fica só o SHA-256 para a
 * busca indexada.
 *
 * **Consequência declarada:** trocar `INTERNAL_SECRET` invalida os webhooks já
 * configurados no provedor. É o mesmo custo de rotacionar qualquer credencial,
 * e a tela de configuração mostra a URL vigente para recolar.
 */
import { createHash, createHmac } from "node:crypto";

import { env } from "@/lib/env";

/** O caminho da rota, sem o token. Um lugar só, para a tela e o adaptador. */
export const CAMINHO_DO_WEBHOOK = "/api/v1/webhooks/pagamento";

/**
 * O token daquela conta de pagamento. HMAC-SHA256 em hex: 64 caracteres, o
 * mesmo alfabeto que a rota exige.
 */
export function tokenDoWebhook(credentialId: string): string {
  return createHmac("sha256", env.INTERNAL_SECRET)
    .update(`pagamento:${credentialId}`)
    .digest("hex");
}

/** O que o banco guarda. A rota faz o mesmo com o que chegou e compara por índice. */
export function hashDoToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** O endereço que vai no `webhook_url` de cada cobrança e na tela de configuração. */
export function urlDoWebhook(credentialId: string, base: string = env.NEXT_PUBLIC_APP_URL): string {
  const raiz = base.replace(/\/+$/, "");
  return `${raiz}${CAMINHO_DO_WEBHOOK}/${tokenDoWebhook(credentialId)}`;
}
