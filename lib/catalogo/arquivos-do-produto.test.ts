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

  it("RECUSA HTML renomeado para .txt — ele seria servido do domínio do Storage", () => {
    expect(farejarEntregavel(texto("<html><script>alert(1)</script>"), "txt")).toBeNull();
    expect(farejarEntregavel(texto("<svg onload=alert(1)>"), "txt")).toBeNull();
    expect(farejarEntregavel(texto("<?xml version='1.0'?><x/>"), "md")).toBeNull();
  });

  it("aceita texto de verdade, e só nas extensões de texto", () => {
    const lista = texto("# Checklist\n\n- primeiro passo\n- segundo passo\n");
    expect(farejarEntregavel(lista, "md")).toBe("text/markdown");
    expect(farejarEntregavel(lista, "txt")).toBe("text/plain");
    // Sem extensão de texto não há como decidir: texto não tem assinatura.
    expect(farejarEntregavel(lista, "pdf")).toBeNull();
  });

  it("RECUSA texto que não é UTF-8 válido", () => {
    // Bytes de uma sequência UTF-8 truncada: não é texto, e aceitar como
    // `text/plain` gravaria lixo que o comprador baixa e não abre.
    expect(farejarEntregavel(new Uint8Array([0xc3, 0x28, 0x41]), "txt")).toBeNull();
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
    expect(nomeSeguroDoArquivo("../../etc/passwd.txt", "text/plain")).toBe("passwd.txt");
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
