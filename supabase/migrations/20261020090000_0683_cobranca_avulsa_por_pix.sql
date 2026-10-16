-- manifest: **Cobrança avulsa dentro do CRM: a organização cobra o cliente dela e o pedido nasce da conversa.** O módulo `cobranca` (0583/0601) é o dono da INSTALAÇÃO cobrando as organizações — assinatura, chave única, `platform_config`. Aqui é o oposto: cada ORGANIZAÇÃO cobra os clientes dela. Três peças: (A) `payment_provider_credentials`, a conta de gateway POR organização — e no provedor escolhido (InfinitePay) **não há chave de API**, então o que se guarda é o `handle` (público) e o `webhook_path_token` (segredo NOSSO), sem trio de cifra; (B) `payment_charges`, uma linha por TENTATIVA, que é onde mora o ciclo de vida fino (`expired`, `disputed`) que `orders.status` não tem e cujo CHECK não se alarga (lição da 0623), mais o carimbo da conferência pelo recibo, SEM o qual nenhuma linha pode ficar `paid`; (C) `order_items`, item com SNAPSHOT de nome e código, no formato de `crm_proposal_items`. Consistência entre organizações por GATILHO comparando com o pai (idioma da 0464), não por chave composta. Mais o índice único PARCIAL de idempotência do webhook, que o geral (`idx_webhook_events_external_id`) não é. Sem backfill: nenhuma linha existe.
-- 0683: cobrança avulsa por organização — conta do gateway, tentativa de cobrança e item do pedido
--
-- ─── O defeito ───────────────────────────────────────────────────────────────
--
-- O CRM conversa, qualifica e registra o pedido, mas não cobra. Quem vende
-- infoproduto por WhatsApp — ou a clínica que quer sinal antes de segurar o
-- horário — fecha a conversa aqui e manda o cliente para fora. O pagamento
-- volta (ou não) sem ninguém ligar as duas pontas, e o pedido fica `pending`
-- para sempre.
--
-- ─── Por que NÃO reaproveitar o que já existe ───────────────────────────────
--
-- `cobranca_*` (0583/0601) é a assinatura DA INSTALAÇÃO: uma conta de gateway
-- para o produto inteiro, em `platform_config`, estado por organização-cliente.
-- Usar a mesma conta aqui faria todas as organizações receberem no mesmo banco.
--
-- `tenant_integrations` é por organização e até tem `webhook_secret_encrypted`,
-- mas o CHECK de `provider` aceita só nuvemshop/vtex/shopify. Alargá-lo à mão é
-- exatamente o que a 0623 documenta como armadilha: a migration seguinte que
-- recriar a lista derruba a atualização de quem alargou.
--
-- ─── O provedor, e por que ele encolheu esta migration ──────────────────────
--
-- O provedor é a **InfinitePay (Checkout Integrado)**, escolhida em 15/10/2026
-- depois de teste real de R$ 1 contra Asaas e AbacatePay. O que decidiu:
--
--   * ela **não exige CPF** do comprador (o Asaas exige para criar o cliente, o
--     que obrigaria o agente a pedir CPF no meio da conversa);
--   * o preço vai em **centavos**, como as colunas desta casa (o Asaas usa
--     reais decimais, que é arredondamento em cima de dinheiro);
--   * e **não há chave de API**: `POST /links` identifica a conta só pelo
--     `handle` (a InfiniteTag sem `$`), que não é segredo — é como os clientes
--     daquela organização pagam.
--
-- Por isso NÃO existe aqui o trio `*_encrypted`/`*_iv`/`*_tag` de
-- `ai_provider_credentials`. Cifra que não protege nada continua sendo
-- superfície à toa. O único segredo é o `webhook_path_token`, que é NOSSO, e
-- ele é gerado aqui.
--
-- ─── A trava que substitui a assinatura do webhook ──────────────────────────
--
-- O webhook da InfinitePay **não tem assinatura, segredo nem cabeçalho de
-- autenticação** — medido, não suposto. E o endpoint `payment_check` que a
-- documentação deles oferece para conferir pagamento é **rota morta**: devolve a
-- mesma resposta para parâmetros válidos, inválidos e corpo vazio. Então não há
-- como validar o aviso pela API do provedor.
--
-- O que sobra são duas camadas independentes, e as duas são obrigatórias:
--
--   1. o `webhook_path_token` no CAMINHO da rota, que é servidor-a-servidor e
--      nunca aparece no navegador do comprador (mesmo idioma das fontes de
--      captação do núcleo);
--   2. a conferência cruzada buscando o `receipt_url` que vem no aviso — página
--      pública, sem login, que mostra valor e `transaction_nsu`.
--
-- A segunda é o que esta migration transforma em REGRA DE BANCO:
-- `payment_charges_conferida_antes_de_paga` recusa `status = 'paid'` sem
-- `conferido_pelo_recibo_em`. Uma rota com defeito, ou um aviso forjado por
-- quem descobrisse o caminho, não consegue marcar venda paga — o banco recusa
-- antes de qualquer entrega acontecer.
--
-- ─── As três peças ──────────────────────────────────────────────────────────
--
-- (A) A CONTA é por organização. O `handle` é público; o `webhook_path_token`
--     não, e é por isso que a tabela-base continua fechada a `authenticated`
--     (disciplina da 0583) e a tela lê pela view `_safe`.
--
--     `pix_conferido_em` existe por um defeito medido do provedor: a chave PIX
--     cadastrada na conta **não é verificável pela API**. Sem ela o link nasce
--     com HTTP 200, o PIX aparece como opção, e só quebra na cara do cliente
--     ("Fale para o vendedor cadastrar uma Chave Pix"). Como nenhuma chamada
--     responde isso, o que resta é alguém conferir e carimbar — e a tela cobra o
--     carimbo antes de deixar a organização vender.
--
-- (B) A TENTATIVA é separada do pedido porque um pedido tem várias: o cliente
--     some e volta, aceita o adicional depois do primeiro link. E é aqui que
--     mora o estado fino. `orders.status` aceita
--     pending/paid/cancelled/fulfilled/shipped/delivered/refunded — não tem
--     `expired` nem `disputed`, e alargar aquele CHECK é a armadilha da 0623.
--     Então o pedido recebe o vocabulário grosso que já existe e quem precisa do
--     detalhe lê aqui.
--
--     `metodo` nasce NULO de propósito: quem escolhe entre PIX e cartão é o
--     comprador, na página do checkout, depois de a cobrança já existir.
--
-- (C) O ITEM guarda SNAPSHOT de nome e código. `product_id` é
--     `on delete set null` e o produto é mutável: sem o snapshot, renomear o
--     produto reescreve o que foi vendido no ano passado.
--
-- ─── Consistência entre organizações: gatilho, não chave composta ───────────
--
-- As ferramentas do agente rodam com service_role, que ignora RLS. Sem guarda,
-- um item da organização A aponta para pedido da B. O idioma da casa para isto
-- é o gatilho BEFORE INSERT OR UPDATE que lê o `organization_id` do pai e
-- levanta 23514 (`fn_verificar_org_do_item_da_proposta`, 0464). Chave composta
-- `(organization_id, id)` exigiria índice único novo em `orders` e em
-- `catalog_products` — mudança nas tabelas DELES para resolver problema nosso.
--
-- Sem backfill: as três tabelas nascem vazias em toda instalação.

-- ─── (A) conta do gateway, por organização ──────────────────────────────────

create table if not exists public.payment_provider_credentials (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  provider text not null,
  label text not null,

  -- A InfiniteTag sem `$`. NÃO é segredo: é o identificador público de quem
  -- recebe. Fica na tabela fechada por morar ao lado do token, não por si.
  handle text not null,

  -- O ÚNICO segredo desta tabela, e ele é nosso: é o que autentica o aviso do
  -- gateway, já que o provedor não assina nada.
  webhook_path_token text not null default encode(extensions.gen_random_bytes(24), 'hex'),

  -- O carimbo humano do que a API não responde (ver cabeçalho).
  pix_conferido_em timestamptz,
  pix_conferido_por uuid references auth.users(id) on delete set null,

  is_active boolean not null default true,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.payment_provider_credentials is
  'Conta de gateway de pagamento de CADA organização (migration 0683). Não confundir com cobranca_* (0583), que é a assinatura DA INSTALAÇÃO. O provedor não usa chave de API: o handle é público e o único segredo é o webhook_path_token, que é nosso. Tabela-base fechada a authenticated — a tela lê por payment_provider_credentials_safe.';

comment on column public.payment_provider_credentials.pix_conferido_em is
  'Quando alguém confirmou À MÃO que a chave PIX está cadastrada na conta do provedor. Existe porque isso não é verificável pela API: sem a chave, o link nasce 200, o PIX aparece, e só falha na tela do cliente.';

alter table public.payment_provider_credentials
  drop constraint if exists payment_provider_credentials_provider_check;
alter table public.payment_provider_credentials
  add constraint payment_provider_credentials_provider_check
  check (provider in ('infinitepay'));

-- O carimbo e quem carimbou andam juntos: um sem o outro é registro que não
-- responde "quem disse que estava conferido?".
alter table public.payment_provider_credentials
  drop constraint if exists payment_provider_credentials_conferencia_coerente;
alter table public.payment_provider_credentials
  add constraint payment_provider_credentials_conferencia_coerente
  check ((pix_conferido_em is null) = (pix_conferido_por is null));

-- Uma conta ATIVA por organização e provedor. Parcial: a desativada fica como
-- histórico (foi com ela que as cobranças antigas nasceram).
create unique index if not exists payment_provider_credentials_ativa
  on public.payment_provider_credentials (organization_id, provider)
  where is_active;

-- O token do caminho é a chave de roteamento do webhook: tem de ser único na
-- instalação inteira, não só dentro da organização.
create unique index if not exists payment_provider_credentials_path_token
  on public.payment_provider_credentials (webhook_path_token);

drop trigger if exists trg_payment_provider_credentials_touch
  on public.payment_provider_credentials;
create trigger trg_payment_provider_credentials_touch
  before update on public.payment_provider_credentials
  for each row execute function public.fn_touch_updated_at();

-- A view que a tela lê: tudo menos o token. `security_invoker` para a RLS de
-- quem consulta continuar valendo (mesmo desenho de ai_provider_credentials_safe).
create or replace view public.payment_provider_credentials_safe
  with (security_invoker = 'true') as
  select id,
         organization_id,
         provider,
         label,
         handle,
         pix_conferido_em,
         pix_conferido_por,
         is_active,
         created_by,
         created_at,
         updated_at
    from public.payment_provider_credentials;

comment on view public.payment_provider_credentials_safe is
  'payment_provider_credentials sem o webhook_path_token (migration 0683). É por aqui que a tela lê. O handle aparece: ele é público.';

alter table public.payment_provider_credentials enable row level security;
revoke all on public.payment_provider_credentials from anon, authenticated;
grant select, insert, update, delete
  on public.payment_provider_credentials to service_role;

-- A view herda o fechamento da base, mas o grant dela é explícito: sem isto a
-- tela não lê nem o handle.
revoke all on public.payment_provider_credentials_safe from anon;
grant select on public.payment_provider_credentials_safe to authenticated, service_role;

drop policy if exists payment_provider_credentials_leitura on public.payment_provider_credentials;
create policy payment_provider_credentials_leitura
  on public.payment_provider_credentials for select to authenticated
  using (
    (organization_id in (select public.fn_user_org_ids())
     and public.fn_role_at_least(organization_id, 'manager'))
    or public.fn_is_platform_admin()
  );

-- ─── (B) tentativa de cobrança ──────────────────────────────────────────────

create table if not exists public.payment_charges (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  order_id uuid not null references public.orders(id) on delete cascade,
  credential_id uuid references public.payment_provider_credentials(id) on delete set null,

  provider text not null,

  -- O identificador da cobrança NO provedor. Na InfinitePay é o `invoice_slug`
  -- do aviso — e não o `slug`, que é como a documentação deles o chama por
  -- engano (medido na prática, 15/10/2026).
  external_charge_id text,

  -- Chega só com o pagamento, e é o que monta o endereço do recibo
  -- (`recibo.infinitepay.io/<transaction_nsu>`), que é a nossa conferência.
  transaction_nsu text,
  receipt_url text,

  -- PIX ou cartão: quem decide é o comprador na página, depois desta linha
  -- existir. Por isso nasce NULO.
  metodo text,

  amount_cents bigint not null,
  currency text not null default 'BRL',

  status text not null default 'pending',

  -- A InfinitePay devolve uma PÁGINA de checkout, não um "copia e cola". Some
  -- daqui, portanto, o br_code: não existe BR Code para guardar.
  checkout_url text,

  expires_at timestamptz,
  paid_at timestamptz,
  refunded_at timestamptz,
  disputed_at timestamptz,

  -- O carimbo da segunda camada: quando o recibo público foi buscado e bateu.
  -- Sem ele nenhuma linha pode ficar `paid` (ver o CHECK abaixo).
  conferido_pelo_recibo_em timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.payment_charges is
  'Uma linha por TENTATIVA de cobrança de um pedido (migration 0683). É aqui que mora o ciclo de vida fino do pagamento: orders.status não tem expired nem disputed, e alargar aquele CHECK é a armadilha da 0623. O id DESTA linha é o order_nsu enviado ao provedor — é assim que o aviso volta a encontrar a cobrança.';

comment on column public.payment_charges.conferido_pelo_recibo_em is
  'Quando o recibo público do provedor foi buscado e o valor bateu. O webhook da InfinitePay não é assinado e o payment_check deles é rota morta, então esta conferência é a única prova de pagamento — e o CHECK payment_charges_conferida_antes_de_paga a torna obrigatória.';

alter table public.payment_charges
  drop constraint if exists payment_charges_provider_check;
alter table public.payment_charges
  add constraint payment_charges_provider_check
  check (provider in ('infinitepay'));

-- O vocabulário é NOSSO, e por isso pode crescer sem tocar em tabela deles.
alter table public.payment_charges
  drop constraint if exists payment_charges_status_check;
alter table public.payment_charges
  add constraint payment_charges_status_check
  check (status in ('pending', 'paid', 'expired', 'cancelled', 'refunded', 'disputed', 'failed'));

alter table public.payment_charges
  drop constraint if exists payment_charges_metodo_check;
alter table public.payment_charges
  add constraint payment_charges_metodo_check
  check (metodo is null or metodo in ('pix', 'credit_card'));

-- Dinheiro é inteiro positivo e a moeda é ISO-4217 em maiúscula. BRL é o único
-- valor que os gateways brasileiros operam; a recusa acontece ANTES de cobrar,
-- na aplicação, mas o banco não aceita o que a aplicação deixar passar.
alter table public.payment_charges
  drop constraint if exists payment_charges_amount_check;
alter table public.payment_charges
  add constraint payment_charges_amount_check
  check (amount_cents > 0);

alter table public.payment_charges
  drop constraint if exists payment_charges_currency_check;
alter table public.payment_charges
  add constraint payment_charges_currency_check
  check (currency = 'BRL');

-- Coerência de uma via só: estado terminal exige a data, e a data exige o
-- estado. Sem isto um `paid` sem `paid_at` passa, e o relatório financeiro
-- conta uma venda que não sabe quando aconteceu.
alter table public.payment_charges
  drop constraint if exists payment_charges_datas_coerentes;
alter table public.payment_charges
  add constraint payment_charges_datas_coerentes
  check (
    (status = 'paid')     = (paid_at     is not null) and
    (status = 'refunded') = (refunded_at is not null) and
    (status = 'disputed') = (disputed_at is not null)
  );

-- A TRAVA. Marcar pago sem ter conferido o recibo é o caminho pelo qual um
-- aviso forjado viraria entrega de produto. O banco recusa, e recusa antes de
-- qualquer efeito: é BEFORE por ser CHECK, e vale para a rota, para o worker e
-- para quem escrever à mão com a service key.
alter table public.payment_charges
  drop constraint if exists payment_charges_conferida_antes_de_paga;
alter table public.payment_charges
  add constraint payment_charges_conferida_antes_de_paga
  check (status <> 'paid' or conferido_pelo_recibo_em is not null);

-- A IDEMPOTÊNCIA da cobrança: o gateway reentrega, e duas linhas para a mesma
-- cobrança remota virariam duas vendas. Parcial porque `external_charge_id` é
-- nulo entre o insert e a resposta do gateway (a chamada está em voo).
create unique index if not exists payment_charges_externa_unica
  on public.payment_charges (organization_id, provider, external_charge_id)
  where external_charge_id is not null;

create index if not exists payment_charges_pedido_idx
  on public.payment_charges (organization_id, order_id, created_at desc);

-- Quem a reconciliação relê: cobrança que ainda pode mudar de estado sozinha.
create index if not exists payment_charges_a_reconciliar_idx
  on public.payment_charges (organization_id, expires_at)
  where status = 'pending';

drop trigger if exists trg_payment_charges_touch on public.payment_charges;
create trigger trg_payment_charges_touch
  before update on public.payment_charges
  for each row execute function public.fn_touch_updated_at();

-- ─── (C) item do pedido ─────────────────────────────────────────────────────

create table if not exists public.order_items (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  order_id uuid not null references public.orders(id) on delete cascade,
  product_id uuid references public.catalog_products(id) on delete set null,

  -- O snapshot: é isto que preserva o que foi vendido quando o produto muda.
  nome text not null,
  codigo text,

  quantidade integer not null default 1,
  preco_unitario_cents bigint not null,
  desconto_cents bigint not null default 0,
  position integer not null default 0,

  -- De onde veio o item: o adicional aceito na conversa não é o item principal,
  -- e o relatório de order bump precisa dos dois distinguíveis.
  origem text not null default 'principal',

  created_at timestamptz not null default now()
);

comment on table public.order_items is
  'Item de um pedido, com SNAPSHOT de nome e código (migration 0683). Formato de crm_proposal_items. product_id é on delete set null e o produto é mutável: sem o snapshot, renomear o produto reescreve o que foi vendido no ano passado.';

alter table public.order_items
  drop constraint if exists order_items_quantidade_check;
alter table public.order_items
  add constraint order_items_quantidade_check
  check (quantidade > 0);

alter table public.order_items
  drop constraint if exists order_items_valores_check;
alter table public.order_items
  add constraint order_items_valores_check
  check (preco_unitario_cents >= 0 and desconto_cents >= 0
         and desconto_cents <= preco_unitario_cents * quantidade);

alter table public.order_items
  drop constraint if exists order_items_origem_check;
alter table public.order_items
  add constraint order_items_origem_check
  check (origem in ('principal', 'adicional'));

create index if not exists order_items_pedido_idx
  on public.order_items (organization_id, order_id, position);

-- ─── Consistência entre organizações (idioma da 0464) ───────────────────────
--
-- Uma função por tabela filha, cada uma lendo o pai que lhe cabe. Não dá para
-- fazer uma genérica: o nome da tabela-pai teria de entrar como texto e viraria
-- SQL dinâmico dentro de um gatilho que roda em todo INSERT.

create or replace function public.fn_verificar_org_da_cobranca()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_org uuid;
begin
  select organization_id into v_org from public.orders where id = new.order_id;
  if v_org is distinct from new.organization_id then
    raise exception 'payment_charge_org_mismatch' using errcode = '23514';
  end if;

  -- A conta é opcional (on delete set null), mas se houver tem de ser da MESMA
  -- organização: senão a cobrança de A nasce apontando para o recebedor de B.
  if new.credential_id is not null then
    select organization_id into v_org
      from public.payment_provider_credentials where id = new.credential_id;
    if v_org is distinct from new.organization_id then
      raise exception 'payment_charge_credential_org_mismatch' using errcode = '23514';
    end if;
  end if;

  return new;
end;
$$;

-- Função de gatilho: não é RPC, mas nasce com EXECUTE para public e anon como
-- qualquer função em public (CLAUDE.md, Migrations item 9).
revoke execute on function public.fn_verificar_org_da_cobranca() from public, anon;

drop trigger if exists trg_payment_charges_org_consistente on public.payment_charges;
create trigger trg_payment_charges_org_consistente
  before insert or update on public.payment_charges
  for each row execute function public.fn_verificar_org_da_cobranca();

create or replace function public.fn_verificar_org_do_item_do_pedido()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_org uuid;
begin
  select organization_id into v_org from public.orders where id = new.order_id;
  if v_org is distinct from new.organization_id then
    raise exception 'order_item_org_mismatch' using errcode = '23514';
  end if;

  if new.product_id is not null then
    select organization_id into v_org
      from public.catalog_products where id = new.product_id;
    if v_org is distinct from new.organization_id then
      raise exception 'order_item_product_org_mismatch' using errcode = '23514';
    end if;
  end if;

  return new;
end;
$$;

revoke execute on function public.fn_verificar_org_do_item_do_pedido() from public, anon;

drop trigger if exists trg_order_items_org_consistente on public.order_items;
create trigger trg_order_items_org_consistente
  before insert or update on public.order_items
  for each row execute function public.fn_verificar_org_do_item_do_pedido();

-- ─── RLS das duas tabelas de conversa (idioma da 0464) ──────────────────────
--
-- Leitura: qualquer papel da organização — o agente precisa saber o que o
-- cliente comprou e se a cobrança ainda está de pé.
-- Escrita: NINGUÉM pela sessão. Criar cobrança é efeito externo com dinheiro, e
-- a rota chama depois do requireRole('manager') com o service_role. Um
-- Atendente que escrevesse `paid` direto pela REST liberaria o produto sem
-- pagamento — e a policy de UPDATE não tem como saber se o dinheiro entrou.

alter table public.payment_charges enable row level security;
alter table public.order_items enable row level security;

revoke all on public.payment_charges from anon;
revoke all on public.order_items from anon;
grant select on public.payment_charges to authenticated;
grant select on public.order_items to authenticated;
grant select, insert, update, delete on public.payment_charges to service_role;
grant select, insert, update, delete on public.order_items to service_role;

drop policy if exists payment_charges_select on public.payment_charges;
create policy payment_charges_select on public.payment_charges
  for select to authenticated
  using (
    (organization_id in (select public.fn_user_org_ids()))
    or public.fn_is_platform_admin()
  );

drop policy if exists order_items_select on public.order_items;
create policy order_items_select on public.order_items
  for select to authenticated
  using (
    (organization_id in (select public.fn_user_org_ids()))
    or public.fn_is_platform_admin()
  );

-- ─── O provedor precisa caber em webhook_events_log ─────────────────────────
--
-- `webhook_events_log_provider_check` aceita uma lista fechada, e sem
-- `infinitepay` nela NENHUMA linha de aviso entra: o INSERT da rota é recusado
-- pelo CHECK, e o índice parcial logo abaixo nunca encontraria linha alguma.
--
-- A lista é reescrita INTEIRA, nunca alargada por um segundo bloco — é a mesma
-- postura que o bloco da 0601 e da 0623 já declara no baseline, e o motivo é a
-- armadilha que esta migration cita no cabeçalho: duas listas divergem, e a
-- migration seguinte que recriar a sua derruba a atualização de quem alargou.
-- Toda linha que já passava pelo CHECK antigo passa por este, então não há
-- backfill a fazer antes.
alter table public.webhook_events_log
  drop constraint if exists webhook_events_log_provider_check;
alter table public.webhook_events_log
  add constraint webhook_events_log_provider_check check (provider in (
    'waha', 'nuvemshop', 'generic', 'meta_cloud', 'zernio', 'datafy',
    -- (migration 0601) os provedores de cobrança do revendedor.
    'stripe', 'asaas',
    -- (migration 0683) a cobrança que cada organização faz ao cliente dela.
    'infinitepay'
  ));

-- ─── Idempotência do aviso do gateway ───────────────────────────────────────
--
-- `idx_webhook_events_external_id` existe e NÃO é único: dois POSTs simultâneos
-- do gateway passariam os dois, e o segundo confirmaria de novo um pagamento já
-- confirmado. O 23505 deste índice é a idempotência — a rota grava a linha
-- ANTES de agir e trata o conflito.
--
-- Parcial e COM organization_id, ao contrário do `uniq_webhook_events_log_cobranca`
-- da 0601: a cobrança daquela é da instalação, a desta é de cada organização.
-- Nenhuma linha deste provedor existia antes do CHECK acima, então não há o que
-- deduplicar antes de criar o índice.

create unique index if not exists uniq_webhook_events_log_pagamento
  on public.webhook_events_log (organization_id, provider, external_id)
  where provider = 'infinitepay' and external_id is not null;
