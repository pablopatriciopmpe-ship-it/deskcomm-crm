// @vitest-environment node
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { bancoFalso, type BancoFalso, type Cadeia, type Resposta } from "@/tests/helpers/banco-falso-da-cobranca";

/**
 * APAGAR O PRODUTO NÃO PODE DEIXAR O ARQUIVO VENDIDO NO BUCKET.
 *
 * `catalog_product_files` tem `on delete cascade` para o produto: depois do
 * DELETE as linhas não existem mais, e com elas vão os únicos ponteiros para os
 * objetos. Quem apagasse um produto com entregáveis deixava o arquivo lá dentro
 * para sempre, comendo a cota de 1 GB que a instalação divide com a mídia do
 * WhatsApp.
 *
 * Dois casos aqui, e o segundo é sobre ORDEM — que é o defeito inteiro.
 */

const ORG = "aaaaaaaa-0000-4000-8000-000000000001";
const PRODUTO = "bbbbbbbb-0000-4000-8000-000000000002";
const UUID = "cccccccc-0000-4000-8000-000000000003";

const h = vi.hoisted(() => ({
  removidos: [] as string[][],
  banco: undefined as unknown as BancoFalso,
}));

vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    ...h.banco.cliente,
    storage: {
      from: () => ({
        remove: async (caminhos: string[]) => {
          h.removidos.push(caminhos);
          return { data: null, error: null };
        },
      }),
    },
  }),
}));

import { apagarEntregaveisDoBucket, caminhosDosEntregaveis } from "./arquivos-no-bucket";

let linhas: Array<{ storage_path: string }>;

function responder(c: Cadeia): Resposta {
  if (c.tabela === "catalog_product_files") return { data: linhas };
  return {};
}

beforeEach(() => {
  vi.clearAllMocks();
  h.removidos = [];
  linhas = [{ storage_path: `${ORG}/${PRODUTO}/${UUID}.pdf` }];
  h.banco = bancoFalso(responder);
});

describe("os caminhos saem da organização e do produto", () => {
  it("lê filtrando organização E produto", async () => {
    await caminhosDosEntregaveis(ORG, PRODUTO);
    const leitura = h.banco.cadeias.find((c) => c.tabela === "catalog_product_files")!;
    const filtros = leitura.passos.filter((p) => p.metodo === "eq").map((p) => p.args);
    expect(filtros).toEqual(
      expect.arrayContaining([
        ["organization_id", ORG],
        ["product_id", PRODUTO],
      ]),
    );
  });

  it("apaga só o caminho que é DESTE produto", async () => {
    const alheio = "99999999-0000-4000-8000-000000000099/" + PRODUTO + `/${UUID}.pdf`;
    const meu = `${ORG}/${PRODUTO}/${UUID}.pdf`;
    await apagarEntregaveisDoBucket(ORG, PRODUTO, [meu, alheio], "req-1");
    // A coluna é gravável pela REST e o `remove` é service role, sem RLS: sem o
    // filtro, um caminho plantado apagaria arquivo de outra organização.
    expect(h.removidos).toEqual([[meu]]);
  });

  it("lista vazia não chama o bucket", async () => {
    await apagarEntregaveisDoBucket(ORG, PRODUTO, [], "req-1");
    expect(h.removidos).toHaveLength(0);
  });
});

describe("a ORDEM na rota que apaga o produto", () => {
  it("lê os caminhos ANTES do delete — depois dele o cascade já levou as linhas", () => {
    const rota = readFileSync(
      join(process.cwd(), "app/api/v1/products/[id]/route.ts"),
      "utf8",
    );
    const leitura = rota.indexOf("caminhosDosEntregaveis(");
    const exclusao = rota.indexOf(".delete()");
    const faxina = rota.indexOf("apagarEntregaveisDoBucket(");

    expect(leitura).toBeGreaterThan(-1);
    expect(faxina).toBeGreaterThan(-1);
    // Esta é a asserção que importa: inverter as duas primeiras devolve o
    // defeito, e o teste fica vermelho.
    expect(leitura).toBeLessThan(exclusao);
    expect(exclusao).toBeLessThan(faxina);
  });
});
