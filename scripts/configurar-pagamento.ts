/**
 * Liga a cobrança por PIX de uma organização — e imprime a URL do webhook.
 *
 * Existe porque a TELA de configuração ainda não existe, e sem um jeito de
 * cadastrar a conta o caminho do dinheiro inteiro fica inalcançável. É o mesmo
 * papel do `bootstrap-owner.ts`: o passo que o produto ainda não tem botão para
 * fazer.
 *
 * Uso:
 *
 *   pnpm tsx scripts/configurar-pagamento.ts --org <uuid> --handle <infinitetag>
 *   pnpm tsx scripts/configurar-pagamento.ts --org <uuid> --conferir-pix
 *   pnpm tsx scripts/configurar-pagamento.ts --org <uuid> --conferir-webhook
 *
 * O segundo comando é o carimbo humano de que a chave PIX está cadastrada na
 * conta do provedor. Ele existe porque **a InfinitePay não deixa checar isso
 * pela API**: sem a chave, o link nasce com HTTP 200, o PIX aparece como opção
 * e só falha na tela do cliente. Enquanto ninguém carimbar, a cobrança é
 * recusada aqui — de propósito.
 */
import { createClient } from "@supabase/supabase-js";

import { hashDoToken, tokenDoWebhook, urlDoWebhook } from "@/lib/pagamentos/token-do-webhook";
import { PROVEDOR_INFINITEPAY } from "@/lib/pagamentos/vocabulario";

function arg(nome: string): string | undefined {
  const i = process.argv.indexOf(`--${nome}`);
  return i > -1 ? process.argv[i + 1] : undefined;
}

function exigir(valor: string | undefined, nome: string): string {
  if (!valor) {
    console.error(`Falta --${nome}`);
    process.exit(1);
  }
  return valor;
}

async function main(): Promise<void> {
  const url = exigir(process.env.NEXT_PUBLIC_SUPABASE_URL, "NEXT_PUBLIC_SUPABASE_URL (env)");
  const key = exigir(process.env.SUPABASE_SERVICE_ROLE_KEY, "SUPABASE_SERVICE_ROLE_KEY (env)");
  const admin = createClient(url, key, { auth: { persistSession: false } });

  const org = exigir(arg("org"), "org");

  // Os dois carimbos humanos, pela mesma porta: as colunas mudam, o resto é
  // idêntico (dono obrigatório, conta ativa, uma organização).
  const carimbo = process.argv.includes("--conferir-pix")
    ? { em: "pix_conferido_em", por: "pix_conferido_por", nome: "Chave PIX" }
    : process.argv.includes("--conferir-webhook")
      ? { em: "webhook_conferido_em", por: "webhook_conferido_por", nome: "Aviso de pagamento" }
      : null;

  if (carimbo) {
    // O carimbo TEM dono: `payment_provider_credentials_conferencia_coerente`
    // recusa data sem responsável, porque a pergunta que a auditoria faz depois
    // é "quem disse que estava conferido?". Sem `--por`, usa um admin da
    // organização.
    let quem = arg("por");
    if (!quem) {
      const { data } = await admin
        .from("user_organizations")
        .select("user_id")
        .eq("organization_id", org)
        .eq("role", "admin")
        .limit(1)
        .maybeSingle();
      quem = (data as { user_id: string } | null)?.user_id;
    }
    if (!quem) {
      console.error("Não achei um admin desta organização. Informe --por <uuid do usuário>.");
      process.exit(1);
    }

    const { error } = await admin
      .from("payment_provider_credentials")
      .update({ [carimbo.em]: new Date().toISOString(), [carimbo.por]: quem })
      .eq("organization_id", org)
      .eq("provider", PROVEDOR_INFINITEPAY)
      .eq("is_active", true);
    if (error) {
      console.error("Não deu para carimbar:", error.message);
      process.exit(1);
    }
    console.info(`${carimbo.nome} marcado como conferido por`, quem);
    return;
  }

  const handle = exigir(arg("handle"), "handle").replace(/^\$/, "");

  const { data: existente } = await admin
    .from("payment_provider_credentials")
    .select("id")
    .eq("organization_id", org)
    .eq("provider", PROVEDOR_INFINITEPAY)
    .eq("is_active", true)
    .maybeSingle();

  // O id vem ANTES do token: o token é derivado dele (HMAC do INTERNAL_SECRET),
  // e é por isso que ele não precisa ser guardado em lugar nenhum.
  const id = existente?.id ?? crypto.randomUUID();
  const token = tokenDoWebhook(id);

  const { error } = await admin.from("payment_provider_credentials").upsert(
    {
      id,
      organization_id: org,
      provider: PROVEDOR_INFINITEPAY,
      label: "InfinitePay",
      handle,
      webhook_path_token_sha256: hashDoToken(token),
      is_active: true,
    },
    { onConflict: "id" },
  );

  if (error) {
    console.error("Não deu para gravar:", error.message);
    process.exit(1);
  }

  console.info("");
  console.info("Conta de pagamento ligada.");
  console.info("");
  console.info("  InfiniteTag : $" + handle);
  console.info("  Webhook URL : " + urlDoWebhook(id));
  console.info("");
  console.info("Falta fazer, NA MÃO, no painel da InfinitePay:");
  console.info("  1. ligar o Checkout Integrado (Configurações)");
  console.info("  2. cadastrar a Chave PIX da conta");
  console.info("");
  console.info("Depois de conferir a chave, carimbe aqui:");
  console.info(`  pnpm tsx scripts/configurar-pagamento.ts --org ${org} --conferir-pix`);
  console.info(`  pnpm tsx scripts/configurar-pagamento.ts --org ${org} --conferir-webhook`);
  console.info("");
  console.info("Sem esse carimbo a cobrança é recusada — e é melhor assim: sem a chave,");
  console.info("o PIX falha na tela do cliente depois de ele ter decidido comprar.");
}

void main();
