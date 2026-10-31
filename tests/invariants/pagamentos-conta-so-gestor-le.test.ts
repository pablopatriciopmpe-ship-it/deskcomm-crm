import { execFileSync } from "node:child_process";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * A CONTA QUE RECEBE O DINHEIRO NÃO SE LÊ COM PAPEL DE ATENDIMENTO.
 *
 * ═══ Por que um arquivo próprio, e não uma linha em rls-isolation.test.ts ═══
 *
 * Aquele molde mede um eixo só, e mede com um usuário `agent`: zero linhas do
 * vizinho, mais de zero linhas próprias. `payment_provider_credentials` NÃO
 * cabe lá — a policy dela exige `manager`, então o `agent` semeado naquele
 * arquivo leria ZERO da própria organização e o controle positivo reprovaria
 * com a policy CERTA. Um teste que só pode falhar não prova nada.
 *
 * (Foi uma revisão adversarial que apontou isso, antes de o CI rodar: a tabela
 * tinha entrado na lista do molde genérico por engano.)
 *
 * ═══ O que esta tabela guarda, e por que o papel importa ═══════════════════
 *
 * PARA ONDE VAI O DINHEIRO das vendas: o `handle` da conta do provedor e os
 * carimbos que destravam a cobrança. Quem muda isto muda o destino da receita —
 * é a mesma régua de Conversões e Billing, e é por isso que a leitura pede
 * `manager`, não `agent`. O atendente fecha a venda; ele não decide em qual
 * conta o dinheiro cai.
 *
 * ═══ Os três eixos ═════════════════════════════════════════════════════════
 *
 *  1. TENANT: o manager da org B lê ZERO linhas da org A;
 *  2. PAPEL:  o agent da org A lê ZERO linhas da PRÓPRIA org A;
 *  3. CONTROLE POSITIVO: o manager da org A lê a própria — sem ele, uma policy
 *     sabotada para `using (false)` passaria verde nos dois primeiros.
 *
 * Conectar como `postgres` mediria NADA (rolbypassrls = t). Aqui é `set role
 * authenticated` + `request.jwt.claims`, o mesmo caminho da produção.
 */

const container = process.env.TEST_DB_CONTAINER;
if (!container) {
  throw new Error(
    "TEST_DB_CONTAINER not set — rode esta suíte via `pnpm test:db` (scripts/test-db.sh)",
  );
}
const containerName: string = container;

function sql(script: string): string {
  return execFileSync(
    "docker",
    [
      "exec", "-i", containerName, "psql", "-U", "postgres", "-d", "postgres",
      "-v", "ON_ERROR_STOP=1", "-tA", "-f", "-",
    ],
    { input: script, encoding: "utf8" },
  ).trim();
}

/** Roda como a sessão de um usuário e devolve a última linha (a contagem). */
function comoUsuario(userId: string, script: string): string {
  const out = sql(`
    set role authenticated;
    select set_config('request.jwt.claims', '{"sub":"${userId}"}', false);
    ${script}
  `);
  return out.split("\n").pop() ?? "";
}

// UUIDs próprios: os arquivos de invariante compartilham a mesma base.
const ORG_A = "eeeeeeee-0000-4000-8000-00000000000a";
const ORG_B = "eeeeeeee-0000-4000-8000-00000000000b";
const MANAGER_A = "eeeeeeee-1111-4000-8000-00000000000a";
const AGENT_A = "eeeeeeee-1111-4000-8000-00000000000c";
const MANAGER_B = "eeeeeeee-1111-4000-8000-00000000000b";

const CONTA_DE_A = "loja-da-org-a";

beforeAll(() => {
  sql(`
    insert into auth.users (id, email) values
      ('${MANAGER_A}', 'pagamentos-mgr-a@invariant.test'),
      ('${AGENT_A}',   'pagamentos-agent-a@invariant.test'),
      ('${MANAGER_B}', 'pagamentos-mgr-b@invariant.test')
      on conflict (id) do nothing;

    insert into public.organizations (id, slug, legal_name, display_name) values
      ('${ORG_A}', 'pagamentos-inv-a', 'Pagamentos Invariant A', 'Pagamentos A'),
      ('${ORG_B}', 'pagamentos-inv-b', 'Pagamentos Invariant B', 'Pagamentos B')
      on conflict (id) do nothing;

    insert into public.user_organizations (user_id, organization_id, role, accepted_at) values
      ('${MANAGER_A}', '${ORG_A}', 'manager', now()),
      ('${AGENT_A}',   '${ORG_A}', 'agent',   now()),
      ('${MANAGER_B}', '${ORG_B}', 'manager', now())
      on conflict do nothing;

    -- Uma conta por organização. O hash do token do webhook tem CHECK de 64 hex;
    -- md5 duas vezes dá exatamente 64 e é núcleo do Postgres (digest() viria do
    -- pgcrypto, que no Supabase mora noutro schema).
    insert into public.payment_provider_credentials
      (organization_id, provider, label, handle, webhook_path_token_sha256)
    select v.org, 'infinitepay', 'InfinitePay', v.handle,
           md5(v.org::text) || md5(v.org::text || 'w')
      from (values ('${ORG_A}'::uuid, '${CONTA_DE_A}'), ('${ORG_B}'::uuid, 'loja-da-org-b'))
             as v(org, handle)
     where not exists (
       select 1 from public.payment_provider_credentials c
        where c.organization_id = v.org and c.provider = 'infinitepay'
     );
  `);
});

describe("payment_provider_credentials — quem pode ver para onde vai o dinheiro", () => {
  it("CONTROLE POSITIVO: o manager da org A lê a conta da própria organização", () => {
    // Sem este caso, uma policy sabotada para `using (false)` passaria verde
    // nos dois casos de baixo — que é o modo de falha de todo teste de
    // isolamento escrito só pela metade.
    const lidas = comoUsuario(
      MANAGER_A,
      `select count(*) from public.payment_provider_credentials
        where organization_id = '${ORG_A}';`,
    );
    expect(Number(lidas)).toBeGreaterThan(0);
  });

  it("TENANT: o manager da org B lê ZERO contas da org A", () => {
    const vizinha = comoUsuario(
      MANAGER_B,
      `select count(*) from public.payment_provider_credentials
        where organization_id = '${ORG_A}';`,
    );
    expect(vizinha).toBe("0");
  });

  it("PAPEL: o agent da org A lê ZERO contas da PRÓPRIA org", () => {
    // O atendente fecha a venda; ele não decide em qual conta o dinheiro cai.
    // Se alguém "simplificar" a policy para o padrão org-flat do resto do repo,
    // este caso reprova — e é o único que reprova.
    const propria = comoUsuario(
      AGENT_A,
      `select count(*) from public.payment_provider_credentials
        where organization_id = '${ORG_A}';`,
    );
    expect(propria).toBe("0");
  });

  it("o hash do token do webhook é RECUSADO até para quem pode ler a conta", () => {
    // A coluna é segredo: o `grant` de `authenticated` é por COLUNA e ela fica
    // de fora. A prova é que a consulta FALHA — `psql` roda com ON_ERROR_STOP=1,
    // então `permission denied for column` derruba o comando e o execFileSync
    // joga. Engolir o erro num bloco `exception` e afirmar outra coisa seria um
    // teste decorativo.
    expect(() =>
      comoUsuario(
        MANAGER_A,
        `select webhook_path_token_sha256 from public.payment_provider_credentials
          where organization_id = '${ORG_A}';`,
      ),
    ).toThrow();

    // E o controle: as colunas que NÃO são segredo seguem legíveis para ele.
    const handle = comoUsuario(
      MANAGER_A,
      `select handle from public.payment_provider_credentials
        where organization_id = '${ORG_A}';`,
    );
    expect(handle).toBe(CONTA_DE_A);
  });
});
