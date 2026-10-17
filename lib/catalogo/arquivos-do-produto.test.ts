import { describe, expect, it } from "vitest";

import {
  arquivoPertenceAoProduto,
  BUCKET_DOS_ARQUIVOS,
  extensaoDoEntregavel,
  farejarEntregavel,
  nomeSeguroDoArquivo,
  TAMANHO_MAXIMO_DO_ARQUIVO,
  TIPOS_ACEITOS,
} from "./arquivos-do-produto";

/**
 * AS REGRAS DO ENTREGÁVEL. Três coisas se prendem aqui, e cada uma já foi
 * defeito em alguma parte desta casa:
 *
 *  1. o tipo sai da ASSINATURA dos bytes — o arquivo vai para o navegador de
 *     quem comprou, servido do domínio do Storage;
 *  2. o caminho conferido é o que ESTA rota gera — a coluna é gravável pela
 *     REST e a leitura é por service role, sem RLS;
 *  3. o nome que o comprador vê não pode carregar caminho nem caractere que
 *     quebre cabeçalho ou atributo HTML.
 */

const ORG = "aaaaaaaa-0000-4000-8000-000000000001";
const PRODUTO = "bbbbbbbb-0000-4000-8000-000000000002";
const UUID = "cccccccc-0000-4000-8000-000000000003";

const bytesCom = (...prefixo: number[]) =>
  new Uint8Array([...prefixo, ...Array.from({ length: 64 }, () => 0x20)]);

const texto = (s: string) => new TextEncoder().encode(s);

describe("o tipo sai dos bytes, não do que o navegador declarou", () => {
  it.each([
    ["application/pdf", bytesCom(0x25, 0x50, 0x44, 0x46), "pdf"],
    ["image/png", bytesCom(0x89, 0x50, 0x4e, 0x47), "png"],
    ["image/jpeg", bytesCom(0xff, 0xd8, 0xff), "jpg"],
    ["audio/mpeg", bytesCom(0x49, 0x44, 0x33), "mp3"],
  ] as const)("reconhece %s", (esperado, bytes, extensao) => {
    expect(farejarEntregavel(bytes, extensao)).toBe(esperado);
  });

  it("reconhece MP4 pela assinatura DESLOCADA (ftyp vem no byte 4)", () => {
    const mp4 = bytesCom(0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70);
    expect(farejarEntregavel(mp4, "mp4")).toBe("video/mp4");
  });

  it("ZIP e EPUB têm a MESMA assinatura; a extensão só escolhe o rótulo", () => {
    const pk = bytesCom(0x50, 0x4b, 0x03, 0x04);
    expect(farejarEntregavel(pk, "epub")).toBe("application/epub+zip");
    expect(farejarEntregavel(pk, "zip")).toBe("application/zip");
  });

  it("RECUSA executável renomeado para .pdf", () => {
    // O caso que a cerca existe para impedir: o `content-type` do navegador
    // diria application/pdf e os bytes são de um binário do Windows.
    const exe = bytesCom(0x4d, 0x5a, 0x90, 0x00);
    expect(farejarEntregavel(exe, "pdf")).toBeNull();
  });

  it("TEXTO não entra, qualquer que seja o conteúdo", () => {
    // A primeira versão aceitava `.md`/`.txt` com uma heurística de marcação, e
    // a heurística era furada de um jeito óbvio: `<img src=x onerror=…>` passava
    // (não estava na lista de tags) e 1.024 espaços antes de `<script>` também
    // (a janela olhava só o começo). Texto não tem assinatura, então o tipo saiu
    // da lista em vez de ganhar outra heurística.
    const lista = texto("# Checklist\n\n- primeiro passo\n");
    expect(farejarEntregavel(lista, "md")).toBeNull();
    expect(farejarEntregavel(lista, "txt")).toBeNull();
    expect(farejarEntregavel(texto("<img src=x onerror=alert(1)>"), "txt")).toBeNull();
    expect(
      farejarEntregavel(texto(" ".repeat(1024) + "<script>alert(1)</script>"), "txt"),
    ).toBeNull();
  });

  it("todo tipo aceito tem extensão, e o bucket é o privado da 0690", () => {
    for (const tipo of TIPOS_ACEITOS) {
      expect(extensaoDoEntregavel(tipo)).toMatch(/^[a-z0-9]+$/);
    }
    expect(BUCKET_DOS_ARQUIVOS).toBe("produtos-digitais");
    // Espelha o `file_size_limit` do bucket e o CHECK de `bytes` da migration.
    expect(TAMANHO_MAXIMO_DO_ARQUIVO).toBe(524_288_000);
  });
});

describe("o caminho conferido é o que a rota gera", () => {
  it("aceita o caminho desta organização e deste produto", () => {
    expect(arquivoPertenceAoProduto(`${ORG}/${PRODUTO}/${UUID}.pdf`, ORG, PRODUTO)).toBe(true);
  });

  it("recusa caminho de OUTRA organização — era arquivo alheio apagado", () => {
    const outra = "dddddddd-0000-4000-8000-000000000009";
    expect(arquivoPertenceAoProduto(`${outra}/${PRODUTO}/${UUID}.pdf`, ORG, PRODUTO)).toBe(false);
  });

  it("recusa caminho de outro produto da mesma organização", () => {
    const outro = "eeeeeeee-0000-4000-8000-000000000009";
    expect(arquivoPertenceAoProduto(`${ORG}/${outro}/${UUID}.pdf`, ORG, PRODUTO)).toBe(false);
  });

  it("recusa travessia de diretório e sufixo que não é extensão conhecida", () => {
    expect(arquivoPertenceAoProduto(`${ORG}/${PRODUTO}/../${UUID}.pdf`, ORG, PRODUTO)).toBe(false);
    expect(arquivoPertenceAoProduto(`${ORG}/${PRODUTO}/${UUID}.exe`, ORG, PRODUTO)).toBe(false);
  });

  it("o PONTO da extensão é literal, não um curinga", () => {
    // Escrito `\\.` de propósito: dentro de template literal, `\.` chega à regex
    // como `.` e casaria QUALQUER caractere — o nome abaixo passaria.
    expect(arquivoPertenceAoProduto(`${ORG}/${PRODUTO}/${UUID}Xpdf`, ORG, PRODUTO)).toBe(false);
  });
});

describe("o nome que o comprador vê", () => {
  it("tira o caminho e mantém só o nome", () => {
    expect(nomeSeguroDoArquivo("C:\\Users\\eu\\Documentos\\curso.pdf", "application/pdf")).toBe(
      "curso.pdf",
    );
    expect(nomeSeguroDoArquivo("../../etc/passwd.zip", "application/zip")).toBe("passwd.zip");
  });

  it("tira os controles de DIREÇÃO, que invertem o nome na tela do comprador", () => {
    // `U+202E` (RLO) faz `lista‮fdp.exe` aparecer como `listaexe.pdf`.
    const seguro = nomeSeguroDoArquivo("lista‮fdp.exe", "application/pdf");
    expect(seguro).not.toContain("‮");
    expect(seguro).toBe("listafdp.exe.pdf");
  });

  it("a extensão acompanha o que o arquivo É, não o que o nome dizia", () => {
    // PDF chamado `foto.jpg` chegaria ao comprador como `.jpg` e não abriria
    // com dois cliques. O tipo gravado está certo; o nome é que mentia.
    expect(nomeSeguroDoArquivo("foto.jpg", "application/pdf")).toBe("foto.jpg.pdf");
    // E não duplica quando já está certa, nem se incomoda com caixa alta.
    expect(nomeSeguroDoArquivo("curso.pdf", "application/pdf")).toBe("curso.pdf");
    expect(nomeSeguroDoArquivo("CURSO.PDF", "application/pdf")).toBe("CURSO.PDF");
  });

  it("tira aspas e caractere de controle, que quebram cabeçalho e atributo", () => {
    expect(nomeSeguroDoArquivo('cur"so\n.pdf', "application/pdf")).toBe("curso.pdf");
  });

  it("nome que sobra vazio recebe um nome com a extensão do tipo", () => {
    expect(nomeSeguroDoArquivo('"""', "application/pdf")).toBe("arquivo.pdf");
    expect(nomeSeguroDoArquivo("", "video/mp4")).toBe("arquivo.mp4");
  });

  it("encurta nome absurdo em vez de recusar o arquivo", () => {
    const longo = `${"a".repeat(400)}.pdf`;
    expect(nomeSeguroDoArquivo(longo, "application/pdf").length).toBeLessThanOrEqual(120);
  });
});
