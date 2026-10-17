/**
 * OS ARQUIVOS ENTREGÁVEIS DO PRODUTO — as regras que a rota, a tela e a página
 * de entrega compartilham.
 *
 * Não confundir com `lib/catalogo/fotos.ts`: foto é VITRINE, o que o cliente vê
 * antes de comprar. Isto é o que ele recebe DEPOIS de pagar, e por isso mora num
 * bucket privado, sem policy nenhuma, saindo só por URL assinada (migration
 * 0694).
 *
 * ── Por que os números estão duplicados aqui ─────────────────────────────────
 *
 * Eles espelham o `storage.buckets` da 0694 e o CHECK de `bytes` da mesma
 * migration. Um teto aqui diferente do de lá faria a rota aceitar o que o
 * Storage recusa, e a pessoa receberia "erro ao subir o arquivo" sem saber por
 * quê — é a mesma razão escrita em `fotos.ts`.
 */

/** O bucket PRIVADO da 0694. Sem policy: só o service role alcança. */
export const BUCKET_DOS_ARQUIVOS = "produtos-digitais";

/** 500 MB: o `file_size_limit` do bucket e o teto do CHECK `bytes` da 0694. */
export const TAMANHO_MAXIMO_DO_ARQUIVO = 524_288_000;

/**
 * Quantos arquivos um produto entrega.
 *
 * ⚠️ Este número NÃO vem do schema — não há CHECK de cardinalidade na 0694. É
 * decisão de produto, e mora aqui para a tela e a rota dizerem o mesmo: a página
 * de entrega lista todos e assina uma URL para cada um, então uma lista sem teto
 * é uma página que demora e um pedido que consome assinaturas sem fim. Dez cobre
 * com folga um curso em módulos.
 */
export const MAXIMO_DE_ARQUIVOS = 10;

/**
 * Os tipos que o UPLOAD aceita.
 *
 * ⚠️ É um SUBCONJUNTO do `allowed_mime_types` do bucket (0694), e isso é de
 * propósito: a lista de lá tem `text/markdown` e `text/plain`, que esta NÃO
 * tem. Mais estreito é seguro — a rota promete menos do que o Storage aceita,
 * e o modo de falha que `fotos.ts` adverte (a rota aceitar o que o Storage
 * recusa) não acontece nesse sentido. O contrário quebraria.
 *
 * ── Por que texto saiu ───────────────────────────────────────────────────────
 *
 * Texto NÃO TEM ASSINATURA: nenhum farejador distingue um `.txt` de qualquer
 * outra coisa. A primeira versão disto aceitava texto com duas travas (UTF-8
 * válido + heurística de marcação), e a heurística era furada de um jeito óbvio:
 * ela listava `script|svg|html|iframe|object|embed` e olhava 1.024 bytes, então
 * `<img src=x onerror=…>` passava, e 1.024 espaços antes de `<script>` também.
 *
 * Fechar isso de verdade pediria varrer o arquivo inteiro e recusar qualquer
 * `<tag`, o que reprovaria markdown legítimo (code sample, `<br>`). Entre uma
 * heurística que não protege e uma regra que atrapalha, a saída é não aceitar o
 * tipo: quem entrega checklist exporta PDF, que é o formato normal de
 * infoproduto. Se algum dia alguém precisar de texto, entra com o farejador
 * certo, não com esta lista alargada na pressa.
 */
export const TIPOS_ACEITOS = [
  "application/pdf",
  "application/epub+zip",
  "application/zip",
  "video/mp4",
  "audio/mpeg",
  "image/png",
  "image/jpeg",
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
 * TODO tipo aqui tem assinatura. Texto não tem, e por isso não está na lista —
 * ver o comentário de `TIPOS_ACEITOS`.
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

  return null;
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
/** O nome inteiro, extensão incluída, não passa disto. */
const TETO_DO_NOME = 120;

export function nomeSeguroDoArquivo(bruto: string, mime: TipoAceito): string {
  const semCaminho = bruto.replace(/\\/g, "/").split("/").pop() ?? "";
  // eslint-disable-next-line no-control-regex -- é exatamente o que se quer tirar
  let limpo = semCaminho.replace(/[\u0000-\u001f\u007f"'`<>|*?:]/g, "");
  // Os controles de DIREÇÃO DE TEXTO também saem. Eles não são de controle no
  // sentido ASCII e passavam pela limpeza acima, mas servem a um truque antigo:
  // `U+202E` (RLO) inverte o que vem depois, então `lista<RLO>fdp.exe` aparece
  // na tela do comprador como `listaexe.pdf`. Este nome é mostrado e salvo por
  // ele.
  limpo = limpo.replace(/[‎‏‪-‮⁦-⁩]/g, "").trim();

  const certa = extensaoDoEntregavel(mime);
  if (limpo.length === 0) return `arquivo.${certa}`;

  // A extensão acompanha o que o arquivo É, não o que o nome dizia. Um PDF
  // chamado `foto.jpg` chegaria ao comprador como `.jpg` e não abriria com dois
  // cliques — o tipo gravado está certo, o nome é que mentia.
  if (limpo.toLowerCase().endsWith(`.${certa}`)) return limpo.slice(0, TETO_DO_NOME);

  // O corte reserva espaço para a extensão: cortar em 120 e DEPOIS acrescentar
  // devolvia 124 caracteres, e o teto existe para o nome caber em cabeçalho e
  // em nome de arquivo no sistema de quem baixa.
  const espaco = TETO_DO_NOME - certa.length - 1;
  return `${limpo.slice(0, espaco)}.${certa}`;
}
