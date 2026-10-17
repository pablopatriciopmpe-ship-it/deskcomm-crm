// @vitest-environment node
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { bancoFalso, operacao, type BancoFalso, type Cadeia, type Resposta } from "@/tests/helpers/banco-falso-da-cobranca";

/**
 * A ROTA QUE FALTAVA: sem ela a 0690 era tabela e bucket sem ninguém escrevendo,
 * e o dono só punha o entregável no produto por SQL na mão.
 *
 * Os casos prendem o que custa caro aqui: o tipo sai dos BYTES (o arquivo vai
 * para o navegador de quem comprou, servido do domínio do Storage), o objeto não
 * fica órfão quando a linha falha, e a remoção confere o caminho ANTES de apagar
 * — porque a coluna é gravável pela REST e o `remove` é service role, sem RLS.
 */

const ORG = "aaaaaaaa-0000-4000-8000-000000000001";
const PRODUTO = "bbbbbbbb-0000-4000-8000-000000000002";
const USUARIO = "dddddddd-0000-4000-8000-000000000004";
const ARQUIVO = "eeeeeeee-0000-4000-8000-000000000005";

const h = vi.hoisted(() => ({
  papelOk: true,
  suporteBloqueia: false,
  auditorias: [] as Array<Record<string, unknown>>,
  subidos: [] as Array<{ caminho: string; contentType: string | undefined }>,
  removidos: [] as string[][],
  erroDoUpload: null as { message: string } | null,
  banco: undefined as unknown as BancoFalso,
}));

vi.mock("@/lib/auth/require-role", () => ({
  requireRole: async (papel: string) =>
    h.papelOk
      ? { ok: true, org: { orgId: ORG }, user: { id: USUARIO, idioma: "pt-BR" }, role: papel }
      : { ok: false, response: new Response("forbidden", { status: 403 }) },
}));
vi.mock("@/lib/impersonate/support", () => ({
  requireSupportWrite: async () =>
    h.suporteBloqueia ? new Response("suporte", { status: 403 }) : null,
}));
vi.mock("@/lib/audit", () => ({
  audit: async (a: Record<string, unknown>) => {
    h.auditorias.push(a);
  },
}));
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => clienteFalso() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => clienteFalso() }));

import { DELETE, POST } from "./route";

interface Mundo {
  produtoExiste: boolean;
  quantos: number;
  erroDaLinha: { message: string } | null;
  /** A linha que a remoção encontra; `storage_path` é o que será conferido. */
  arquivo: { id: string; storage_path: string; nome_arquivo: string } | null;
}
let m: Mundo;

/** O cliente do Supabase com um dublê de Storage em volta do banco falso. */
function clienteFalso() {
  return {
    ...h.banco.cliente,
    storage: {
      from: () => ({
        upload: async (caminho: string, _bytes: unknown, opts?: { contentType?: string }) => {
          if (h.erroDoUpload) return { data: null, error: h.erroDoUpload };
          h.subidos.push({ caminho, contentType: opts?.contentType });
          return { data: { path: caminho }, error: null };
        },
        remove: async (caminhos: string[]) => {
          h.removidos.push(caminhos);
          return { data: null, error: null };
        },
      }),
    },
  } as never;
}

function responder(c: Cadeia): Resposta {
  if (c.tabela === "catalog_products") {
    return { data: m.produtoExiste ? { id: PRODUTO } : null };
  }
  if (c.tabela === "catalog_product_files") {
    const op = operacao(c);
    if (op === "insert") {
      if (m.erroDaLinha) return { error: m.erroDaLinha };
      return { data: { id: ARQUIVO, nome_arquivo: "curso.pdf", mime: "application/pdf", bytes: 9 } };
    }
    if (op === "delete") return { data: null };
    // A contagem (head: true) e a leitura da remoção passam por aqui.
    return { data: m.arquivo, count: m.quantos };
  }
  return {};
}

const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x0a]);

function pedidoDeUpload(bytes: Uint8Array, nome = "curso.pdf"): NextRequest {
  const form = new FormData();
  form.append("file", new File([bytes as BlobPart], nome));
  return new NextRequest("http://localhost/api/v1/products/x/arquivos", {
    method: "POST",
    body: form,
  });
}

const subir = (bytes = PDF, nome = "curso.pdf") =>
  POST(pedidoDeUpload(bytes, nome), { params: Promise.resolve({ id: PRODUTO }) });

const tirar = (corpo: unknown) =>
  DELETE(
    new NextRequest("http://localhost/api/v1/products/x/arquivos", {
      method: "DELETE",
      body: JSON.stringify(corpo),
      headers: { "Content-Type": "application/json" },
    }),
    { params: Promise.resolve({ id: PRODUTO }) },
  );

beforeEach(() => {
  vi.clearAllMocks();
  h.papelOk = true;
  h.suporteBloqueia = false;
  h.auditorias = [];
  h.subidos = [];
  h.removidos = [];
  h.erroDoUpload = null;
  m = {
    produtoExiste: true,
    quantos: 0,
    erroDaLinha: null,
    arquivo: { id: ARQUIVO, storage_path: `${ORG}/${PRODUTO}/${ARQUIVO}.pdf`, nome_arquivo: "curso.pdf" },
  };
  h.banco = bancoFalso(responder);
});

describe("quem pode mexer", () => {
  it("recusa quem não é manager", async () => {
    h.papelOk = false;
    expect((await subir()).status).toBe(403);
  });

  it("recusa sessão de suporte — isto é o produto que o cliente compra", async () => {
    h.suporteBloqueia = true;
    expect((await subir()).status).toBe(403);
    expect(h.subidos).toHaveLength(0);
  });

  it("recusa produto que não é desta organização", async () => {
    m.produtoExiste = false;
    expect((await subir()).status).toBe(404);
    expect(h.subidos).toHaveLength(0);
  });
});

describe("o que entra", () => {
  it("sobe o PDF com o tipo FAREJADO e caminho gerado aqui", async () => {
    const r = await subir();
    expect(r.status).toBe(200);
    expect(h.subidos).toHaveLength(1);
    expect(h.subidos[0]!.contentType).toBe("application/pdf");
    // Organização e produto no prefixo, uuid + extensão no fim: é o que
    // `arquivoPertenceAoProduto` confere depois, na remoção e na entrega.
    expect(h.subidos[0]!.caminho).toMatch(
      new RegExp(`^${ORG}/${PRODUTO}/[0-9a-f-]{36}\\.pdf$`),
    );
  });

  it("RECUSA executável renomeado para .pdf, e não sobe nada", async () => {
    const exe = new Uint8Array([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00]);
    const r = await subir(exe, "curso.pdf");
    expect(r.status).toBe(415);
    expect(h.subidos).toHaveLength(0);
  });

  it("recusa arquivo vazio", async () => {
    expect((await subir(new Uint8Array([]))).status).toBe(422);
  });

  it("recusa quando o produto já tem o teto de arquivos", async () => {
    m.quantos = 10;
    expect((await subir()).status).toBe(422);
    expect(h.subidos).toHaveLength(0);
  });

  it("o nome gravado é o SANEADO, não o que veio do computador de quem vende", async () => {
    await subir(PDF, "C:\\Users\\eu\\cur\"so.pdf");
    const insercao = h.banco.cadeias.find(
      (c) => c.tabela === "catalog_product_files" && operacao(c) === "insert",
    )!;
    expect((insercao.passos[0]!.args[0] as Record<string, unknown>).nome_arquivo).toBe("curso.pdf");
  });

  it("linha que falha APAGA o objeto — senão ele come cota para sempre", async () => {
    m.erroDaLinha = { message: "boom" };
    const r = await subir();
    expect(r.status).toBe(500);
    expect(h.subidos).toHaveLength(1);
    expect(h.removidos).toEqual([[h.subidos[0]!.caminho]]);
  });

  it("audita com o nome e o tamanho, e sem o caminho no bucket", async () => {
    await subir();
    const a = h.auditorias[0]!;
    expect(a.action).toBe("catalog_product.file_added");
    expect(JSON.stringify(a)).not.toContain(ORG + "/" + PRODUTO + "/");
  });
});

describe("o que sai", () => {
  it("tira a linha e o objeto, e audita", async () => {
    const r = await tirar({ arquivo_id: ARQUIVO });
    expect(r.status).toBe(200);
    expect(h.removidos).toEqual([[`${ORG}/${PRODUTO}/${ARQUIVO}.pdf`]]);
    const exclusao = h.banco.cadeias.find(
      (c) => c.tabela === "catalog_product_files" && operacao(c) === "delete",
    );
    expect(exclusao).toBeDefined();
    expect(h.auditorias[0]!.action).toBe("catalog_product.file_removed");
  });

  it("NÃO apaga objeto cujo caminho não é deste produto", async () => {
    // A coluna é gravável por qualquer `manager` pela REST, e o `remove` é
    // service role: sem esta conferência, um caminho plantado apagaria arquivo
    // de OUTRA organização.
    m.arquivo = {
      id: ARQUIVO,
      storage_path: `99999999-0000-4000-8000-000000000099/${PRODUTO}/${ARQUIVO}.pdf`,
      nome_arquivo: "curso.pdf",
    };
    const r = await tirar({ arquivo_id: ARQUIVO });
    expect(r.status).toBe(404);
    expect(h.removidos).toHaveLength(0);
    expect(h.auditorias).toHaveLength(0);
  });

  it("recusa remoção sem dizer qual arquivo", async () => {
    expect((await tirar({})).status).toBe(422);
  });

  it("recusa arquivo que não existe nesta organização", async () => {
    m.arquivo = null;
    expect((await tirar({ arquivo_id: ARQUIVO })).status).toBe(404);
    expect(h.removidos).toHaveLength(0);
  });
});
