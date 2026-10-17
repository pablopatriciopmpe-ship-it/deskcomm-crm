import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type * as InfinitePay from "@/lib/pagamentos/provedores/infinitepay";
import { bancoFalso, operacao, type BancoFalso, type Cadeia, type Resposta } from "@/tests/helpers/banco-falso-da-cobranca";

/**
 * A sonda existe para que uma quebra SILENCIOSA vire aviso. Os casos aqui
 * prendem as três coisas que fazem isso ser verdade: ela acusa quando a
 * conferência falha, ela se cala quando volta a funcionar, e ela não gasta
 * linha de auditoria em rodada sem novidade.
 */

const h = vi.hoisted(() => ({
  autorizado: true,
  falhas: [] as Array<string | null>,
  duplicado: false,
  avisosAbertos: [] as unknown[],
  auditorias: [] as Array<Record<string, unknown>>,
  erro: vi.fn(),
  banco: undefined as unknown as BancoFalso,
}));

vi.mock("@/lib/auth/cron-auth", () => ({ autorizaCron: () => h.autorizado }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => h.banco.cliente }));
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), error: h.erro, info: vi.fn() } }));
vi.mock("@/lib/audit", () => ({
  audit: async (a: Record<string, unknown>) => {
    h.auditorias.push(a);
  },
}));
vi.mock("@/lib/pagamentos/provedores/infinitepay", async (original) => {
  const real = await original<typeof InfinitePay>();
  return {
    ...real,
    conferirPeloRecibo: async () => {
      const motivo = h.falhas.shift() ?? null;
      if (motivo) throw new real.ErroDaInfinitePay(200, motivo);
    },
  };
});

import { KIND_DO_AVISO, POST, TETO_DE_ORGS } from "./route";

const ORG_A = "aaaaaaaa-0000-4000-8000-000000000001";
const ORG_B = "bbbbbbbb-0000-4000-8000-000000000002";

interface Mundo {
  /** Uma linha por organização com conta ligada — é daqui que sai a amostra. */
  contas: Array<{ organization_id: string; status: string }>;
  cobrancas: Array<{
    id: string;
    organization_id: string;
    transaction_nsu: string;
    amount_cents: number;
    payment_provider_credentials: { handle: string } | null;
  }>;
  resolvidos: Array<{ id: string }>;
  /** Avisos já gravados em `webhook_events_log`, para a reconciliação achar. */
  avisos: Array<{ organization_id: string; payload_parsed: Record<string, unknown> }>;
  /** Cobranças que a reconciliação encontra ainda `pending`. */
  pendentes: Array<{ id: string; organization_id: string }>;
}
let m: Mundo;

function responder(c: Cadeia): Resposta {
  if (c.tabela === "payment_provider_credentials") {
    // O dublê HONRA o filtro de status embutido: é ele que prova que a
    // organização parada sai ANTES de qualquer limite.
    const filtro = c.passos.find((p) => p.metodo === "eq" && p.args[0] === "organizations.status");
    const linhas = m.contas.filter((k) => !filtro || k.status === filtro.args[1]);
    return {
      data: linhas.map((k) => ({
        organization_id: k.organization_id,
        organizations: { status: k.status },
      })),
    };
  }

  if (c.tabela === "webhook_events_log") return { data: m.avisos };

  if (c.tabela === "payment_charges") {
    // A reconciliação pergunta por `in (ids)`; a sonda pergunta por organização.
    if (c.passos.some((p) => p.metodo === "in")) return { data: m.pendentes };
    const porOrg = c.passos.find((p) => p.metodo === "eq" && p.args[0] === "organization_id");
    const dela = m.cobrancas.filter((x) => !porOrg || x.organization_id === porOrg.args[1]);
    return { data: dela[0] ?? null };
  }

  if (c.tabela === "event_log") return { data: { id: "ev-1" } };
  if (c.tabela === "agent_inbox_items") {
    const op = operacao(c);
    if (op === "insert") {
      if (h.duplicado) return { error: { code: "23505", message: "ja aberto" } };
      h.avisosAbertos.push(c.passos[0]!.args[0]);
      return { data: { id: "aviso-1" } };
    }
    if (op === "update") return { data: m.resolvidos };
  }
  return {};
}

const rodar = () =>
  POST(new NextRequest("http://localhost/api/v1/cron/pagamento-sonda-do-recibo", { method: "POST" }));

const cobranca = (org: string, i = 1) => ({
  id: `cobranca-${org}-${i}`,
  organization_id: org,
  transaction_nsu: `nsu-${org}-${i}`,
  amount_cents: 12990,
  payment_provider_credentials: { handle: `loja-${org}` },
});

beforeEach(() => {
  vi.clearAllMocks();
  h.autorizado = true;
  h.falhas = [];
  h.duplicado = false;
  h.avisosAbertos = [];
  h.auditorias = [];
  m = {
    contas: [{ organization_id: ORG_A, status: "active" }],
    cobrancas: [cobranca(ORG_A)],
    resolvidos: [],
    avisos: [],
    pendentes: [],
  };
  h.banco = bancoFalso(responder);
});

describe("quem pode chamar", () => {
  it("recusa sem o segredo do cron", async () => {
    h.autorizado = false;
    const r = await rodar();
    expect(r.status).toBe(403);
    expect(h.banco.cadeias).toHaveLength(0);
  });
});

describe("quando a conferência quebra", () => {
  it("abre aviso crítico apontando a cobrança que serve de amostra", async () => {
    h.falhas = ["recibo_com_valor_diferente"];
    const r = await rodar();

    await expect(r.json()).resolves.toMatchObject({ data: { falharam: 1, avisosAbertos: 1 } });
    const aviso = h.avisosAbertos[0] as Record<string, unknown>;
    expect(aviso.kind).toBe(KIND_DO_AVISO);
    expect(aviso.severity).toBe("critical");
    expect(aviso.organization_id).toBe(ORG_A);
    expect(aviso.ref_id).toBe("cobranca-" + ORG_A + "-1");
  });

  it("diz no corpo que o dinheiro entra e o produto não sai", async () => {
    h.falhas = ["recibo_inacessivel"];
    await rodar();
    const corpo = String((h.avisosAbertos[0] as Record<string, unknown>).body);
    // Quem lê a Central precisa entender a consequência, não o erro técnico.
    expect(corpo).toContain("NÃO é confirmado");
    expect(corpo).toContain("recibo_inacessivel");
  });

  it("não conta como aberto o aviso que já estava aberto", async () => {
    h.falhas = ["recibo_com_valor_diferente"];
    h.duplicado = true;
    const r = await rodar();
    // Sem isto, a auditoria registraria rodada sem novidade todo dia.
    await expect(r.json()).resolves.toMatchObject({ data: { falharam: 1, avisosAbertos: 0 } });
    expect(h.auditorias).toHaveLength(0);
  });
});

describe("quando a conferência volta a funcionar", () => {
  it("fecha sozinho o aviso que estava aberto", async () => {
    m.resolvidos = [{ id: "aviso-1" }];
    const r = await rodar();
    await expect(r.json()).resolves.toMatchObject({
      data: { falharam: 0, avisosResolvidos: 1 },
    });
  });

  it("não audita quando não havia aviso para fechar", async () => {
    m.resolvidos = [];
    await rodar();
    expect(h.auditorias).toHaveLength(0);
  });
});

describe("o tamanho da amostra", () => {
  it("sonda UMA cobrança por organização", async () => {
    m.contas = [
      { organization_id: ORG_A, status: "active" },
      { organization_id: ORG_B, status: "active" },
    ];
    m.cobrancas = [cobranca(ORG_A, 1), cobranca(ORG_A, 2), cobranca(ORG_B, 1)];
    const r = await rodar();
    await expect(r.json()).resolves.toMatchObject({ data: { sondadas: 2 } });
  });

  it("não passa do teto de organizações por rodada", async () => {
    m.contas = Array.from({ length: TETO_DE_ORGS + 3 }, (_, i) => ({
      organization_id: `org-${i}`,
      status: "active",
    }));
    m.cobrancas = m.contas.map((k) => cobranca(k.organization_id, 1));
    const r = await rodar();
    await expect(r.json()).resolves.toMatchObject({ data: { sondadas: TETO_DE_ORGS } });
  });

  it("instalação que ainda não vendeu não sonda nada e não audita", async () => {
    m.cobrancas = [];
    const r = await rodar();
    await expect(r.json()).resolves.toMatchObject({ data: { sondadas: 0 } });
    expect(h.auditorias).toHaveLength(0);
  });

  it("organização com conta ligada e sem venda não ocupa vaga", async () => {
    // Ela entra na lista de candidatas (tem conta), mas não tem cobrança
    // sondável. Isso não é defeito, e não pode calar quem tem.
    m.contas = [
      { organization_id: ORG_A, status: "active" },
      { organization_id: ORG_B, status: "active" },
    ];
    m.cobrancas = [cobranca(ORG_B, 1)];
    const r = await rodar();
    await expect(r.json()).resolves.toMatchObject({ data: { sondadas: 1 } });
  });
});

describe("a auditoria", () => {
  it("registra a rodada que ABRIU aviso", async () => {
    h.falhas = ["recibo_com_valor_diferente"];
    await rodar();
    expect(h.auditorias).toHaveLength(1);
    expect(h.auditorias[0]!.action).toBe("pagamento.sonda_do_recibo_run");
  });
});

describe("organização parada", () => {
  it("não é sondada — a sonda sai para fora e org suspensa não gasta nem fala", async () => {
    m.contas = [
      { organization_id: ORG_A, status: "suspended" },
      { organization_id: ORG_B, status: "active" },
    ];
    m.cobrancas = [cobranca(ORG_A), cobranca(ORG_B)];
    const r = await rodar();
    await expect(r.json()).resolves.toMatchObject({ data: { sondadas: 1 } });
  });

  it("a parada não ocupa vaga do teto, senão calaria quem opera", async () => {
    // O corte sai na PRÓPRIA consulta, por `!inner` — antes de qualquer limite.
    // Se viesse depois, a parada entraria na conta e uma organização que opera
    // ficaria de fora sem ninguém perceber.
    m.contas = [
      { organization_id: ORG_A, status: "suspended" },
      ...Array.from({ length: TETO_DE_ORGS }, (_, i) => ({
        organization_id: `org-${i}`,
        status: "active",
      })),
    ];
    m.cobrancas = m.contas.map((k) => cobranca(k.organization_id, 1));
    const r = await rodar();
    await expect(r.json()).resolves.toMatchObject({ data: { sondadas: TETO_DE_ORGS } });
  });
});

describe("a amostra não pode famintar organização", () => {
  it("escolhe a amostra pelas CONTAS, nunca por uma leitura global de cobranças", async () => {
    // ⚠️ ESTE CASO EXISTIA E PASSAVA COM O DEFEITO DE PÉ. Ele dava 40 linhas à
    // ORG_A quando o teto da leitura global era 500 — provou a deduplicação e
    // nunca a fome. O que faminta é o `limit` cortar ANTES de deduplicar: aí
    // `porOrg` nasce com uma entrada só e o rodízio gira sobre um elemento.
    //
    // Agora a pergunta é outra e o defeito não cabe: a primeira consulta é a de
    // CONTAS, uma linha por organização. É isso que este caso prende.
    m.contas = [
      { organization_id: ORG_A, status: "active" },
      { organization_id: ORG_B, status: "active" },
    ];
    m.cobrancas = [
      ...Array.from({ length: 2000 }, (_, i) => cobranca(ORG_A, i + 1)),
      cobranca(ORG_B, 1),
    ];
    const r = await rodar();
    await expect(r.json()).resolves.toMatchObject({ data: { sondadas: 2 } });

    const primeira = h.banco.cadeias[0]!;
    expect(primeira.tabela).toBe("payment_provider_credentials");
  });
});

describe("a reconciliação", () => {
  const aviso = (cobrancaId: string, org = ORG_A) => ({
    organization_id: org,
    payload_parsed: {
      order_nsu: cobrancaId,
      transaction_nsu: `nsu-${cobrancaId}`,
      invoice_slug: `slug-${cobrancaId}`,
    },
  });

  it("devolve à fila a cobrança que recebeu aviso e continuou pendente", async () => {
    // O caminho que não existia: a InfinitePay muda o HTML, as vendas do dia
    // viram `skipped`, e depois de alguém consertar o parser elas seguiam
    // perdidas. O dinheiro entrou e o produto nunca saiu.
    m.avisos = [aviso("cobranca-perdida")];
    m.pendentes = [{ id: "cobranca-perdida", organization_id: ORG_A }];
    const r = await rodar();
    await expect(r.json()).resolves.toMatchObject({ data: { reemitidas: 1 } });

    const emissao = h.banco.cadeias.find(
      (c) => c.tabela === "event_log" && operacao(c) === "insert",
    )!;
    const args = emissao.passos[0]!.args[0] as Record<string, unknown>;
    expect(args.entity_id).toBe("cobranca-perdida");
    expect(args.organization_id).toBe(ORG_A);
  });

  it("NÃO reemite aviso cuja organização não é a da cobrança", async () => {
    // A busca das pendentes é por `in (ids)`, e id não carrega organização: sem
    // a conferência, um aviso gravado numa organização emitiria evento
    // apontando para cobrança de outra.
    m.avisos = [aviso("cobranca-x", ORG_B)];
    m.pendentes = [{ id: "cobranca-x", organization_id: ORG_A }];
    const r = await rodar();
    await expect(r.json()).resolves.toMatchObject({ data: { reemitidas: 0 } });
    expect(h.banco.cadeias.some((c) => c.tabela === "event_log")).toBe(false);
  });

  it("não reemite cobrança que já saiu de pendente", async () => {
    m.avisos = [aviso("cobranca-ja-paga")];
    m.pendentes = [];
    const r = await rodar();
    await expect(r.json()).resolves.toMatchObject({ data: { reemitidas: 0 } });
  });

  it("aviso sem transação não serve para reemitir", async () => {
    m.avisos = [{ organization_id: ORG_A, payload_parsed: { order_nsu: "c1" } }];
    m.pendentes = [{ id: "c1", organization_id: ORG_A }];
    const r = await rodar();
    await expect(r.json()).resolves.toMatchObject({ data: { reemitidas: 0 } });
  });

  it("rodada que SÓ reemitiu também audita — houve efeito", async () => {
    m.avisos = [aviso("cobranca-perdida")];
    m.pendentes = [{ id: "cobranca-perdida", organization_id: ORG_A }];
    await rodar();
    expect(h.auditorias).toHaveLength(1);
    expect(h.auditorias[0]!.metadata).toMatchObject({ reemitidas: 1 });
  });
});

describe("a conta sem handle", () => {
  it("abre aviso em vez de conferir sem amarra ao vendedor", async () => {
    // Sem o handle não dá para provar que o recibo é da nossa loja. Conferir
    // assim mesmo era o furo apontado na revisão; recusar é a saída segura.
    m.cobrancas = [{ ...cobranca(ORG_A), payment_provider_credentials: null }];
    const r = await rodar();
    await expect(r.json()).resolves.toMatchObject({ data: { falharam: 1, avisosAbertos: 1 } });
    expect(String((h.avisosAbertos[0] as Record<string, unknown>).body)).toContain("conta_sem_handle");
  });
});
