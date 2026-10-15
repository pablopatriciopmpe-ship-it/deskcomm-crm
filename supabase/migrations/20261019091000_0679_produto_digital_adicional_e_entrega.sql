-- manifest: **O produto digital, o adicional e a entrega — a outra metade do caminho do dinheiro (par da 0678).** Três tabelas e um bucket: (A) `catalog_product_files`, os arquivos entregáveis de um produto do catálogo (`catalog_products` tem `fotos`, que é vitrine, não entrega), guardando `storage_path` e NUNCA URL — URL assinada vence e URL pública não existe aqui; (B) `product_bumps`, o adicional como RELAÇÃO entre dois produtos do catálogo, não como campo copiado no produto (DIRC: referenciar, não duplicar), com guarda contra apontar para si mesmo e contra ciclo de um nível; (C) `order_deliveries`, o que foi entregue e quando, com o token da página pública guardado como **SHA-256** — token em claro no banco é senha em claro. Mais o bucket privado `produtos-digitais`, com caminho prefixado pela organização e **sem policy nenhuma para `authenticated`**: sob RLS, ausência de policy é negação, e é isso que faz o arquivo vendido sair só por URL assinada emitida pelo servidor. Fecha também a LGPD das duas metades: `payment_charges` (0678) e `order_deliveries` entram em `modulo_secoes_lgpd` — a cascata lê dali desde a 0620 em vez de nomear tabela, então nenhuma função de 919 linhas é redefinida. Sem backfill: tudo nasce vazio.
-- 0679: arquivos do produto digital, order bump, entrega e a LGPD das duas
--
-- ─── O que a 0678 deixou faltando ───────────────────────────────────────────
--
-- A 0678 sabe cobrar: conta do gateway, tentativa de cobrança e item do pedido. Ela
-- não sabe o que entregar nem registrar que entregou. Sem isto o pagamento
-- confirma e não acontece nada — que é pior do que não cobrar.
--
-- ─── (A) por que arquivo não é `fotos` ──────────────────────────────────────
--
-- `catalog_products.fotos` é vitrine: o que o cliente vê antes de comprar.
-- O entregável é o oposto — só existe depois do pagamento e nunca pode ser
-- público. São colunas com ciclos de vida e permissões opostas; morar juntas
-- faria a vitrine e o cofre compartilharem policy.
--
-- Guardamos `storage_path`, nunca URL: URL assinada vence (e uma vencida no
-- banco é um registro que mente), e URL pública não existe neste bucket.
--
-- ─── (B) por que o adicional é relação, e não campo ─────────────────────────
--
-- A tentação é `catalog_products.produto_adicional_id`. DIRC diz referenciar:
-- o mesmo produto pode ser adicional de vários, com preço promocional
-- diferente em cada oferta, e um campo no produto só comporta um. A relação
-- também é onde o preço da oferta mora — o preço do adicional NAQUELA oferta
-- não é o preço de catálogo dele.
--
-- Duas guardas: não apontar para si mesmo (CHECK) e não formar par recíproco
-- A→B e B→A (gatilho), que é o ciclo que faria a tela oferecer para sempre.
--
-- ─── (C) por que o token é guardado como hash ───────────────────────────────
--
-- O token da página de entrega é credencial portadora: quem o tem, baixa. Em
-- claro no banco ele é senha em claro — a mesma regra que o produto já aplica
-- a bearer token de API (anti-pattern 13). Guardamos SHA-256; a página faz o
-- hash do que recebeu e compara. A coluna é NULÁVEL de propósito: é assim que
-- a redação de LGPD o revoga, pondo nulo (ver a seção da LGPD abaixo).
--
-- ─── O bucket: ausência de policy é a trava ─────────────────────────────────
--
-- `ai-policy` (0014/0017) concede leitura a membro da organização. Aqui NÃO:
-- o arquivo é a mercadoria, e `viewer` não compra nem baixa. Sob RLS, tabela
-- sem policy nega para `anon` e `authenticated`; o `service_role` passa porque
-- ignora RLS. O servidor emite URL assinada curta depois de conferir que
-- existe entrega válida — a autorização é do pedido pago, nunca do papel.
--
-- ─── A LGPD das duas metades, sem redefinir a função ────────────────────────
--
-- Desde a 0620 a cascata não nomeia tabela: ela lê `modulo_secoes_lgpd` e pula
-- a seção cuja tabela não existe. Registrar ali evita um `create or replace`
-- de `fn_lgpd_cascade_redact_contact`, que tem 919 linhas e já quebrou uma
-- instalação inteira quando nomeou tabela de módulo (0497 → forward-fix 0620).
--
-- O mecanismo foi criado para MÓDULO opcional (ADR-0002, D8) e aqui é usado
-- por tabela de núcleo. É reuso deliberado: a alternativa é reescrever a
-- função de 919 linhas, e o `to_regclass` que pula tabela ausente é inócuo
-- para tabela que sempre existe. **Se a revisão preferir a função, o conserto
-- é mecânico** — as colunas a redigir estão declaradas aqui.
--
-- `order_items` NÃO entra: as colunas dele são nome e código de PRODUTO, que
-- não são dado pessoal. Registrar seção sem coluna a redigir seria cascata
-- fantasma ao contrário — a aparência de cobertura sem efeito nenhum.
--
-- Sem backfill: as três tabelas nascem vazias em toda instalação.

-- ─── (A) arquivos entregáveis do produto ────────────────────────────────────

create table if not exists public.catalog_product_files (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  product_id uuid not null references public.catalog_products(id) on delete cascade,

  storage_path text not null,
  nome_arquivo text not null,
  mime text not null,
  bytes bigint not null,
  checksum_sha256 text,

  position integer not null default 0,
  ativo boolean not null default true,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.catalog_product_files is
  'Arquivos ENTREGÁVEIS de um produto do catálogo (migration 0679). Não confundir com catalog_products.fotos, que é vitrine. Guarda storage_path no bucket privado produtos-digitais, nunca URL: URL assinada vence e pública não existe aqui.';

alter table public.catalog_product_files
  drop constraint if exists catalog_product_files_bytes_check;
alter table public.catalog_product_files
  add constraint catalog_product_files_bytes_check
  check (bytes > 0 and bytes <= 524288000);

-- O caminho é único na instalação: dois produtos apontando para o mesmo objeto
-- fariam a exclusão de um apagar o arquivo do outro.
create unique index if not exists catalog_product_files_caminho
  on public.catalog_product_files (storage_path);

create index if not exists catalog_product_files_produto_idx
  on public.catalog_product_files (organization_id, product_id, position);

drop trigger if exists trg_catalog_product_files_touch on public.catalog_product_files;
create trigger trg_catalog_product_files_touch
  before update on public.catalog_product_files
  for each row execute function public.fn_touch_updated_at();

-- ─── (B) o adicional (order bump) ───────────────────────────────────────────

create table if not exists public.product_bumps (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  produto_base_id uuid not null references public.catalog_products(id) on delete cascade,
  produto_adicional_id uuid not null references public.catalog_products(id) on delete cascade,

  -- O preço DAQUELA oferta, que não é o preço de catálogo do adicional.
  preco_promocional_cents bigint not null,
  currency text not null default 'BRL',

  chamada text,
  ativo boolean not null default true,
  position integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.product_bumps is
  'O adicional (order bump) como RELAÇÃO entre dois produtos do catálogo (migration 0679). DIRC: referenciar, não duplicar — o mesmo produto é adicional de vários, com preço de oferta diferente em cada um, e um campo no produto só comportaria um.';

alter table public.product_bumps
  drop constraint if exists product_bumps_nao_e_ele_mesmo;
alter table public.product_bumps
  add constraint product_bumps_nao_e_ele_mesmo
  check (produto_base_id <> produto_adicional_id);

alter table public.product_bumps
  drop constraint if exists product_bumps_preco_check;
alter table public.product_bumps
  add constraint product_bumps_preco_check
  check (preco_promocional_cents > 0);

alter table public.product_bumps
  drop constraint if exists product_bumps_currency_check;
alter table public.product_bumps
  add constraint product_bumps_currency_check
  check (currency = 'BRL');

create unique index if not exists product_bumps_par_unico
  on public.product_bumps (organization_id, produto_base_id, produto_adicional_id);

create index if not exists product_bumps_base_idx
  on public.product_bumps (organization_id, produto_base_id, position)
  where ativo;

drop trigger if exists trg_product_bumps_touch on public.product_bumps;
create trigger trg_product_bumps_touch
  before update on public.product_bumps
  for each row execute function public.fn_touch_updated_at();

-- ─── (C) a entrega ──────────────────────────────────────────────────────────

create table if not exists public.order_deliveries (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  order_id uuid not null references public.orders(id) on delete cascade,

  -- SHA-256 do token da página pública, nunca o token. Nulável porque é assim
  -- que a redação de LGPD e a revogação por reembolso o derrubam.
  token_sha256 text,

  canal text not null default 'pagina',
  entregue_em timestamptz,
  expira_em timestamptz,
  revogada_em timestamptz,
  motivo_revogacao text,
  downloads integer not null default 0,
  ultimo_download_em timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.order_deliveries is
  'O que foi entregue de um pedido, quando, e o SHA-256 do token da página pública (migration 0679). Token em claro no banco é senha em claro (anti-pattern 13): a página faz o hash do que recebeu e compara. token_sha256 é nulável de propósito — pôr nulo é como a redação de LGPD e a revogação por reembolso derrubam o acesso.';

alter table public.order_deliveries
  drop constraint if exists order_deliveries_canal_check;
alter table public.order_deliveries
  add constraint order_deliveries_canal_check
  check (canal in ('pagina', 'whatsapp', 'email'));

-- Hash é hexadecimal de 64 caracteres. O CHECK é o que denuncia, no primeiro
-- INSERT, o dia em que alguém gravar o token em claro aqui.
alter table public.order_deliveries
  drop constraint if exists order_deliveries_token_e_hash;
alter table public.order_deliveries
  add constraint order_deliveries_token_e_hash
  check (token_sha256 is null or token_sha256 ~ '^[0-9a-f]{64}$');

alter table public.order_deliveries
  drop constraint if exists order_deliveries_revogacao_coerente;
alter table public.order_deliveries
  add constraint order_deliveries_revogacao_coerente
  check ((revogada_em is null) = (motivo_revogacao is null));

create unique index if not exists order_deliveries_token
  on public.order_deliveries (token_sha256)
  where token_sha256 is not null;

create index if not exists order_deliveries_pedido_idx
  on public.order_deliveries (organization_id, order_id);

drop trigger if exists trg_order_deliveries_touch on public.order_deliveries;
create trigger trg_order_deliveries_touch
  before update on public.order_deliveries
  for each row execute function public.fn_touch_updated_at();

-- ─── Consistência entre organizações (idioma da 0464, igual à 0678) ─────────

create or replace function public.fn_verificar_org_do_arquivo_do_produto()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_org uuid;
begin
  select organization_id into v_org from public.catalog_products where id = new.product_id;
  if v_org is distinct from new.organization_id then
    raise exception 'catalog_product_file_org_mismatch' using errcode = '23514';
  end if;
  return new;
end;
$$;

revoke execute on function public.fn_verificar_org_do_arquivo_do_produto() from public, anon;

drop trigger if exists trg_catalog_product_files_org_consistente on public.catalog_product_files;
create trigger trg_catalog_product_files_org_consistente
  before insert or update on public.catalog_product_files
  for each row execute function public.fn_verificar_org_do_arquivo_do_produto();

create or replace function public.fn_verificar_org_do_adicional()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_base uuid;
  v_adic uuid;
begin
  select organization_id into v_base from public.catalog_products where id = new.produto_base_id;
  select organization_id into v_adic from public.catalog_products where id = new.produto_adicional_id;
  if v_base is distinct from new.organization_id or v_adic is distinct from new.organization_id then
    raise exception 'product_bump_org_mismatch' using errcode = '23514';
  end if;

  -- Ciclo de um nível: A oferece B e B oferece A faria a tela oferecer o
  -- adicional para sempre, um atrás do outro. O CHECK já barra A→A; o par
  -- recíproco precisa de consulta, então mora aqui.
  if exists (
    select 1 from public.product_bumps b
     where b.organization_id = new.organization_id
       and b.produto_base_id = new.produto_adicional_id
       and b.produto_adicional_id = new.produto_base_id
       and b.id is distinct from new.id
  ) then
    raise exception 'product_bump_reciproco' using errcode = '23514';
  end if;

  return new;
end;
$$;

revoke execute on function public.fn_verificar_org_do_adicional() from public, anon;

drop trigger if exists trg_product_bumps_org_consistente on public.product_bumps;
create trigger trg_product_bumps_org_consistente
  before insert or update on public.product_bumps
  for each row execute function public.fn_verificar_org_do_adicional();

create or replace function public.fn_verificar_org_da_entrega()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_org uuid;
begin
  select organization_id into v_org from public.orders where id = new.order_id;
  if v_org is distinct from new.organization_id then
    raise exception 'order_delivery_org_mismatch' using errcode = '23514';
  end if;
  return new;
end;
$$;

revoke execute on function public.fn_verificar_org_da_entrega() from public, anon;

drop trigger if exists trg_order_deliveries_org_consistente on public.order_deliveries;
create trigger trg_order_deliveries_org_consistente
  before insert or update on public.order_deliveries
  for each row execute function public.fn_verificar_org_da_entrega();

-- ─── RLS ────────────────────────────────────────────────────────────────────
--
-- Catálogo e adicional: leitura por qualquer papel (o agente precisa saber o
-- que existe à venda e qual é o adicional da oferta). Escrita pelo servidor.
-- Entrega: leitura por qualquer papel — menos a coluna que é credencial, e por
-- isso a tela nunca seleciona `token_sha256` (ele também não serve para nada
-- em claro: é hash).

alter table public.catalog_product_files enable row level security;
alter table public.product_bumps enable row level security;
alter table public.order_deliveries enable row level security;

revoke all on public.catalog_product_files from anon;
revoke all on public.product_bumps from anon;
revoke all on public.order_deliveries from anon;
grant select on public.catalog_product_files to authenticated;
grant select on public.product_bumps to authenticated;
grant select on public.order_deliveries to authenticated;
grant select, insert, update, delete on public.catalog_product_files to service_role;
grant select, insert, update, delete on public.product_bumps to service_role;
grant select, insert, update, delete on public.order_deliveries to service_role;

drop policy if exists catalog_product_files_select on public.catalog_product_files;
create policy catalog_product_files_select on public.catalog_product_files
  for select to authenticated
  using ((organization_id in (select public.fn_user_org_ids()))
         or public.fn_is_platform_admin());

drop policy if exists product_bumps_select on public.product_bumps;
create policy product_bumps_select on public.product_bumps
  for select to authenticated
  using ((organization_id in (select public.fn_user_org_ids()))
         or public.fn_is_platform_admin());

drop policy if exists order_deliveries_select on public.order_deliveries;
create policy order_deliveries_select on public.order_deliveries
  for select to authenticated
  using ((organization_id in (select public.fn_user_org_ids()))
         or public.fn_is_platform_admin());

-- ─── O bucket privado ───────────────────────────────────────────────────────
--
-- Caminho: <organization_id>/<product_id>/<arquivo>. O prefixo de organização é
-- o que as policies de OUTROS buckets usam para isolar, e aqui serve para o
-- servidor montar e conferir o caminho — não há policy de tenant porque não há
-- policy nenhuma para a sessão.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'produtos-digitais',
  'produtos-digitais',
  false,
  524288000,
  array[
    'application/pdf',
    'application/epub+zip',
    'application/zip',
    'video/mp4',
    'audio/mpeg',
    'image/png',
    'image/jpeg',
    'text/markdown',
    'text/plain'
  ]
)
on conflict (id) do nothing;

-- NENHUMA policy para `authenticated` neste bucket, e isto é a trava, não um
-- esquecimento: sob RLS, ausência de policy é negação. Quem lê é o servidor,
-- pelo `service_role`, depois de conferir que existe entrega válida — e ele
-- devolve URL assinada curta, nunca o objeto nem o caminho.
-- Se um dia alguém acrescentar policy de leitura por membro aqui, terá
-- transformado a mercadoria em arquivo de equipe.

-- ─── LGPD: as duas metades entram na cascata, sem redefinir a função ────────
--
-- `ligacao` recebe $1 = organization_id e $2 = contact_id, e vai para `execute`
-- via `using`: nenhum valor de contato entra no texto do SQL.
-- `colunas` é o que vira NULO.

insert into public.modulo_secoes_lgpd
    (modulo, tabela, ligacao, colunas, colunas_rotulo, colunas_redigidas, colunas_agora)
  values
    (
      'pagamentos',
      'payment_charges',
      'organization_id = $1 and order_id in (select id from public.orders where organization_id = $1 and contact_id = $2)',
      -- A página de checkout e a do recibo levam a quem pagou: a primeira é
      -- instrumento de pagamento vivo, a segunda nomeia o pagador na página do
      -- provedor. O valor e as datas FICAM: são registro financeiro, e
      -- anonimizar contato não apaga a contabilidade.
      array['checkout_url', 'receipt_url'],
      '{}'::text[],
      '{}'::text[],
      array['updated_at']
    ),
    (
      'pagamentos',
      'order_deliveries',
      'organization_id = $1 and order_id in (select id from public.orders where organization_id = $1 and contact_id = $2)',
      -- Pôr o hash em nulo É a revogação: sem ele nenhum token confere, e a
      -- página de entrega daquele pedido para de abrir.
      array['token_sha256'],
      '{}'::text[],
      '{}'::text[],
      array['updated_at']
    )
  on conflict (modulo, tabela) do update
    set ligacao = excluded.ligacao,
        colunas = excluded.colunas,
        colunas_rotulo = excluded.colunas_rotulo,
        colunas_redigidas = excluded.colunas_redigidas,
        colunas_agora = excluded.colunas_agora;
