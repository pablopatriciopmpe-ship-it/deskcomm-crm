/**
 * OS ARQUIVOS ENTREGÁVEIS DO PRODUTO — as regras que a rota, a tela e a página
 * de entrega compartilham.
 *
 * Não confundir com `lib/catalogo/fotos.ts`: foto é VITRINE, o que o cliente vê
 * antes de comprar. Isto é o que ele recebe DEPOIS de pagar, e por isso mora num
 * bucket privado, sem policy nenhuma, saindo só por URL assinada (migration
 * 0690).
 *
 * ── Por que os números estão duplicados aqui ─────────────────────────────────
 *
 * Eles espelham o `storage.buckets` da 0690 e o CHECK de `bytes` da mesma
 * migration. Um teto aqui diferente do de lá faria a rota aceitar o que o
 * Storage recusa, e a pessoa receberia "erro ao subir o arquivo" sem saber por
 * quê — é a mesma razão escrita em `fotos.ts`.
 */

/** O bucket PRIVADO da 0690. Sem policy: só o service role alcança. */
export const BUCKET_DOS_ARQUIVOS = "produtos-digitais";

/** 500 MB: o `file_size_limit` do bucket e o teto do CHECK `bytes` da 0690. */
export const TAMANHO_MAXIMO_DO_ARQUIVO = 524_288_000;

/**
 * Quantos arquivos um produto entrega.
 *
 * ⚠️ Este número NÃO vem do schema — não há CHECK de cardinalidade na 0690. É
 * decisão de produto, e mora aqui para a tela e a rota dizerem o mesmo: a página
 * de entrega lista todos e assina uma URL para cada um, então uma lista sem teto
 * é uma página que demora e um pedido que consome assinaturas sem fim. Dez cobre
 * com folga um curso em módulos.
 */
export const MAXIMO_DE_ARQUIVOS = 10;

/**
 * Os tipos que o bucket aceita (`allowed_mime_types` da 0690), nesta ordem.
 * Mudar esta lista sem mudar a migration faz a rota prometer o que o Storage
 * recusa.
 */
export const TIPOS_ACEITOS = [
  "application/pdf",
  "application/epub+zip",
  "application/zip",
  "video/mp4",
  "audio/mpeg",
  "image/png",
  "image/jpeg",
  "text/markdown",
  "text/plain",
] as const;
export type TipoAceito = (typeof TIPOS_ACEITOS)[number];

const EXTENSAO: Record<TipoAceito, string> = {
  "application/pdf": "pdf",
  "application/epub+zip": "epub",
  "application/zip": "zip",
  "video/mp4": "mp4",
  "audio/mpeg": "mp3",
  "image/png": "png",
  "image/jpeg": "jpg",
  "text/markdown": "md",
  "text/plain": "txt",
};

export function extensaoDoEntregavel(mime: TipoAceito): string {
  return EXTENSAO[mime];
}

function comecaCom(bytes: Uint8Array, assinatura: readonly number[], deslocamento = 0): boolean {
  if (bytes.length < deslocamento + assinatura.length) return false;
  return assinatura.every((b, i) => bytes[deslocamento + i] === b);
}

/** Bytes suficientes para a assinatura mais distante (`ftyp` do MP4, em 4). */
export const BYTES_PARA_FAREJAR = 1024;

/**
 * O que estes bytes SÃO — pela assinatura, nunca pelo `content-type` que o
 * navegador declarou.
 *
 * O arquivo vai ser servido ao navegador DE OUTRA PESSOA (quem comprou), a
 * partir do domínio do Storage. Aceitar o tipo declarado deixaria subir um HTML
 * e servi-lo como HTML naquele domínio.
 *
 * ── O caso do texto, que não tem assinatura ──────────────────────────────────
 *
 * `text/markdown` e `text/plain` não têm bytes mágicos: nenhum farejador os
 * distingue de qualquer outra coisa. Então a decisão é por EXCLUSÃO, e com duas
 * travas: o conteúdo tem de ser UTF-8 válido, e não pode parecer marcação que um
 * navegador executaria. O tipo gravado é `text/plain`/`text/markdown`, que são
 * inertes; a trava de marcação existe para o caso de um Storage (ou um proxy à
 * frente) algum dia farejar o conteúdo por conta própria.
 */
export function farejarEntregavel(bytes: Uint8Array, extensaoDeclarada: string): TipoAceito | null {
  if (comecaCom(bytes, [0x25, 0x50, 0x44, 0x46])) return "application/pdf"; // %PDF
  if (comecaCom(bytes, [0x89, 0x50, 0x4e, 0x47])) return "image/png";
  if (comecaCom(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (comecaCom(bytes, [0x66, 0x74, 0x79, 0x70], 4)) return "video/mp4"; // ....ftyp
  if (comecaCom(bytes, [0x49, 0x44, 0x33])) return "audio/mpeg"; // ID3
  if (comecaCom(bytes, [0xff, 0xfb]) || comecaCom(bytes, [0xff, 0xf3])) return "audio/mpeg";

  // ZIP e EPUB têm a MESMA assinatura (`PK\x03\x04`): o EPUB é um zip com um
  // `mimetype` dentro. Distinguir exigiria abrir o arquivo; os dois estão na
  // lista do bucket, então a extensão declarada só escolhe o rótulo — nenhum dos
  // dois é executável no navegador.
  if (comecaCom(bytes, [0x50, 0x4b, 0x03, 0x04])) {
    return extensaoDeclarada === "epub" ? "application/epub+zip" : "application/zip";
  }

  if (extensaoDeclarada === "md" || extensaoDeclarada === "txt") {
    if (!ehUtf8Valido(bytes)) return null;
    if (pareceMarcacaoExecutavel(bytes)) return null;
    return extensaoDeclarada === "md" ? "text/markdown" : "text/plain";
  }

  return null;
}

function ehUtf8Valido(bytes: Uint8Array): boolean {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

/**
 * Parece HTML, SVG ou XML? DELIBERADAMENTE FROUXO, como o `pareceSvg` do logo:
 * aqui o erro caro é o falso NEGATIVO, e um texto legítimo que caia nesta rede
 * perde no máximo a chance de ser entregue como `.txt` (pode ir como PDF).
 */
function pareceMarcacaoExecutavel(bytes: Uint8Array): boolean {
  let texto = "";
  for (const b of bytes.subarray(0, BYTES_PARA_FAREJAR)) texto += String.fromCharCode(b);
  return /<\s*(script|svg|html|iframe|object|embed)[\s>]/i.test(texto) || /<\?xml|<!doctype/i.test(texto);
}

const FORMA_DO_CAMINHO = new RegExp(
  // O `\\.` é o PONTO literal. Escrito `\.` dentro de template literal ele chega
  // à regex como `.`, que casa com qualquer caractere — e a conferência de
  // caminho passaria a aceitar nome que não é o que esta rota gera.
  `^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.(${Object.values(EXTENSAO).join("|")})$`,
);

/**
 * O caminho É desta organização e deste produto, na forma exata que a rota gera?
 *
 * ⚠️ Quem LÊ confere, não só quem escreve — a mesma razão escrita em
 * `fotos.ts`. A leitura do arquivo é por service role, que não tem RLS: um
 * caminho de outra organização gravado na linha viraria arquivo alheio assinado
 * para o comprador, ou arquivo alheio APAGADO na remoção.
 */
export function arquivoPertenceAoProduto(caminho: string, orgId: string, produtoId: string): boolean {
  const prefixo = `${orgId}/${produtoId}/`;
  return caminho.startsWith(prefixo) && FORMA_DO_CAMINHO.test(caminho.slice(prefixo.length));
}

/**
 * O nome que o COMPRADOR vai ver e salvar.
 *
 * Ele vem do computador de quem vende e sai na página de entrega, no atributo
 * `download` de um link. Então: sem separador de caminho (um `../` viraria nome
 * de arquivo salvo fora da pasta de downloads em clientes antigos), sem
 * caractere de controle nem aspas (eles quebram cabeçalho e atributo), e curto.
 * O nome NÃO decide o caminho no bucket — esse é um uuid gerado no servidor.
 */
export function nomeSeguroDoArquivo(bruto: string, mime: TipoAceito): string {
  const semCaminho = bruto.replace(/\\/g, "/").split("/").pop() ?? "";
  // eslint-disable-next-line no-control-regex -- é exatamente o que se quer tirar
  const limpo = semCaminho.replace(/[\u0000-\u001f\u007f"'`<>|*?:]/g, "").trim();
  const curto = limpo.slice(0, 120);
  return curto.length > 0 ? curto : `arquivo.${extensaoDoEntregavel(mime)}`;
}
