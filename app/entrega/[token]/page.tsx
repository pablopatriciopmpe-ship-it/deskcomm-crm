/**
 * /entrega/[token] — a página onde quem pagou pega o produto.
 *
 * ## Quem entra aqui
 *
 * O comprador, com o navegador dele, sem conta e sem cookie nosso. Por isso a
 * rota é declarada em `lib/auth/public-paths.ts` — "público" ali quer dizer que
 * o proxy não decide, nunca que não há autenticação.
 *
 * Quem autentica é o TOKEN do caminho. O banco guarda só o SHA-256 dele
 * (anti-pattern 13: token portador em claro é senha em claro), então a página
 * faz o hash do que recebeu e procura por ele.
 *
 * ## O arquivo nunca é servido por aqui
 *
 * O que sai é uma URL ASSINADA e curta do Storage, emitida pelo servidor na
 * hora. O bucket `produtos-digitais` é privado e **não tem policy nenhuma**
 * para `authenticated` — sob RLS, ausência de policy é negação. Então não há
 * caminho que alcance o arquivo sem passar por aqui.
 *
 * ## As três recusas, e por que todas dizem a mesma coisa
 *
 * Token errado, entrega vencida e entrega revogada devolvem a MESMA tela. A
 * diferença interessa a nós, não a quem está do outro lado — e distinguir
 * contaria a quem sonda quais tokens existem.
 */
import { createHash } from "node:crypto";

import type { Metadata } from "next";
import { headers } from "next/headers";

import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";
import { traduzir } from "@/lib/i18n/dicionario";
import { idiomaDoVisitante } from "@/lib/i18n/idiomaAnonimo";
import { ipDoCliente } from "@/lib/http/ip-do-cliente";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Seu acesso",
  robots: { index: false, follow: false },
};

/** Vida da URL assinada: o bastante para o navegador baixar, não para circular. */
const VALIDADE_DO_LINK_SEGUNDOS = 15 * 60;

/**
 * O freio desta página. Ela é PÚBLICA e cada abertura válida custa: duas
 * leituras, uma URL assinada por arquivo e uma escrita no contador. Sem teto,
 * quem tenha um link legítimo nas mãos (ou um robô com ele) gera milhares de
 * assinaturas e escritas por minuto. A doutrina da casa exige teto em rota
 * pública, e o número é generoso de propósito: quem comprou recarrega a página
 * para renovar os links de 15 minutos, e isso tem de continuar funcionando.
 */
const ABERTURAS_POR_MINUTO = 60;

interface Arquivo {
  nome: string;
  url: string;
  bytes: number;
}

function tamanhoLegivel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function carregar(token: string): Promise<Arquivo[] | null> {
  if (!/^[0-9a-f]{64}$/.test(token)) return null;
  const admin = createAdminClient();
  const hash = createHash("sha256").update(token).digest("hex");

  const { data: entrega } = await admin
    .from("order_deliveries")
    .select("id, organization_id, order_id, expira_em, revogada_em, downloads")
    .eq("token_sha256", hash)
    .maybeSingle();

  if (!entrega) return null;
  if (entrega.revogada_em) return null;
  if (entrega.expira_em && Date.parse(entrega.expira_em) < Date.now()) return null;

  const { data: itens } = await admin
    .from("order_items")
    .select("product_id")
    .eq("organization_id", entrega.organization_id)
    .eq("order_id", entrega.order_id);

  const produtos = (itens ?? [])
    .map((i) => (i as { product_id: string | null }).product_id)
    .filter((p): p is string => Boolean(p));
  if (produtos.length === 0) return [];

  const { data: arquivos } = await admin
    .from("catalog_product_files")
    .select("storage_path, nome_arquivo, bytes, position")
    .eq("organization_id", entrega.organization_id)
    .in("product_id", produtos)
    .eq("ativo", true)
    .order("position", { ascending: true });

  const saida: Arquivo[] = [];
  for (const a of arquivos ?? []) {
    const linha = a as { storage_path: string; nome_arquivo: string; bytes: number };
    const { data: assinada } = await admin.storage
      .from("produtos-digitais")
      .createSignedUrl(linha.storage_path, VALIDADE_DO_LINK_SEGUNDOS);
    if (assinada?.signedUrl) {
      saida.push({ nome: linha.nome_arquivo, url: assinada.signedUrl, bytes: linha.bytes });
    }
  }

  // O contador é de ABERTURA da página, não de download do arquivo — o
  // navegador baixa direto do Storage e não passa por aqui. Dito assim na tela
  // de quem vende, para o número não ser lido como "quantos baixaram".
  await admin
    .from("order_deliveries")
    .update({ downloads: entrega.downloads + 1, ultimo_download_em: new Date().toISOString() })
    .eq("id", entrega.id)
    // A organização SAI DA LINHA que acabou de ser lida — ela é conhecida aqui.
    // Cadeia de serviço que filtra só por id deixa um id adivinhado alcançar
    // linha de outra organização; a cerca `admin-client-exige-filtro-de-tenant`
    // cobra isto em toda escrita por chave.
    .eq("organization_id", entrega.organization_id);

  return saida;
}

export default async function PaginaDaEntrega({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;

  // Quem abre esta página é o COMPRADOR, sem sessão e sem perfil nosso — então
  // o idioma vem do navegador dele (mesma cadeia das telas de login).
  const idioma = await idiomaDoVisitante(null);
  const t = (texto: string) => traduzir(texto, idioma);

  // O balde é por IP, nunca por token: por token, quem tem um link válido
  // continuaria podendo bater à vontade, que é justamente o abuso. Sem IP
  // resolvido (proxy mal configurado), o balde é único — teto global em vez de
  // nenhum teto.
  const cabecalhos = await headers();
  const balde = ipDoCliente(cabecalhos) ?? "sem-ip";
  const teto = await checkRateLimit(`entrega-pagina:${balde}`, ABERTURAS_POR_MINUTO, 60);
  if (!teto.allowed) {
    return (
      <main className="mx-auto flex min-h-dvh max-w-lg flex-col justify-center gap-3 px-6 py-16">
        <h1 className="text-2xl font-semibold">{t("Muitas tentativas")}</h1>
        <p className="text-muted-foreground">{t("Espere um minuto e recarregue a página.")}</p>
      </main>
    );
  }

  const arquivos = await carregar(token);

  if (arquivos === null) {
    return (
      <main className="mx-auto flex min-h-dvh max-w-lg flex-col justify-center gap-3 px-6 py-16">
        <h1 className="text-2xl font-semibold">{t("Este link não vale mais")}</h1>
        <p className="text-muted-foreground">
          {t(
            "Ele pode ter expirado ou sido substituído por outro. Fale com quem te vendeu para receber um link novo.",
          )}
        </p>
      </main>
    );
  }

  return (
    <main className="mx-auto flex min-h-dvh max-w-lg flex-col justify-center gap-6 px-6 py-16">
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold">{t("Seu acesso está pronto")}</h1>
        <p className="text-muted-foreground">
          {arquivos.length === 0
            ? t("Seu pagamento foi confirmado. Este pedido não tem arquivo para baixar.")
            : t(
                "Pagamento confirmado. Baixe abaixo — cada link vale por alguns minutos; recarregue a página se precisar de novo.",
              )}
        </p>
      </header>

      <ul className="flex flex-col gap-2">
        {arquivos.map((a) => (
          <li key={a.url}>
            <a
              href={a.url}
              className="flex items-center justify-between gap-4 rounded-lg border px-4 py-3 hover:bg-muted"
              download={a.nome}
            >
              <span className="truncate font-medium">{a.nome}</span>
              <span className="shrink-0 text-sm text-muted-foreground">
                {tamanhoLegivel(a.bytes)}
              </span>
            </a>
          </li>
        ))}
      </ul>
    </main>
  );
}
