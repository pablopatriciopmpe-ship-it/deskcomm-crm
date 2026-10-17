-- manifest: **O segundo carimbo: alguém conferiu que o webhook está configurado no provedor.** A 0689 trouxe `pix_conferido_em` porque a chave PIX não é verificável por API, e a cobrança se recusa a existir sem ele. Faltava a OUTRA metade do mesmo problema, e ela é pior: sem o webhook apontando para cá, o link nasce, o cliente **paga**, o dinheiro entra na conta do vendedor e o CRM nunca sabe — nenhuma confirmação, nenhuma entrega, e o cliente que pagou fica sem o produto. A tela já apresentava o passo como obrigatório e nada o cobrava. Este par (`webhook_conferido_em`/`webhook_conferido_por`), com o mesmo CHECK de coerência do par da chave PIX, é o que `cobrarProduto` passa a exigir como terceira porta. Idempotente: `add column if not exists`, CHECK sob `drop constraint if exists`, view por `create or replace` com as colunas novas no FIM (acrescentar é permitido; reordenar não). Sem backfill — e DE PROPÓSITO: quem já ligou a conta antes desta migration não recebe carimbo automático, porque ninguém conferiu nada. Fica sem cobrar até assinar, que é o lado seguro.
-- 0692: o carimbo de que o webhook está configurado no provedor
--
-- ─── Por que um segundo carimbo, e não um só ────────────────────────────────
--
-- São dois fatos independentes, conferidos em dois lugares diferentes do painel
-- do provedor, e que falham de maneiras OPOSTAS:
--
--   • chave PIX ausente  → o link nasce, e falha NA TELA do cliente. Ninguém
--     paga. Venda perdida, dinheiro intacto.
--   • webhook ausente    → o link nasce, o cliente PAGA, o dinheiro entra na
--     conta do vendedor — e o CRM nunca é avisado. Nenhuma confirmação,
--     nenhuma entrega. O cliente pagou e não recebeu.
--
-- O segundo é o único caminho deste módulo em que o CLIENTE FINAL perde
-- dinheiro. Juntar os dois num carimbo só faria uma assinatura responder por
-- duas conferências, e quem assinasse por uma estaria assinando pela outra sem
-- saber.
--
-- ─── Por que é assinatura humana, de novo ───────────────────────────────────
--
-- Pelo mesmo motivo medido na 0689: a InfinitePay não responde por API se o
-- Checkout Integrado está ligado nem qual URL está cadastrada. Não há chamada a
-- fazer. O que existe é uma pessoa que abre o painel, olha, e assina.
--
-- A PROVA de verdade chega depois e sozinha: no primeiro aviso de pagamento que
-- entra, o webhook está provado por obra. A assinatura é o que destrava a
-- primeira venda; o primeiro aviso é o que a confirma.
--
-- ─── Sem backfill, de propósito ─────────────────────────────────────────────
--
-- Carimbar as contas que já existem seria assinar no lugar de quem não olhou —
-- exatamente o defeito que o carimbo existe para impedir. Quem já tinha a conta
-- ligada volta a não poder cobrar até assinar este passo. Erra para o lado em
-- que ninguém paga sem receber.

alter table public.payment_provider_credentials
  add column if not exists webhook_conferido_em timestamptz;
alter table public.payment_provider_credentials
  add column if not exists webhook_conferido_por uuid references auth.users(id) on delete set null;

comment on column public.payment_provider_credentials.webhook_conferido_em is
  'Quando alguém confirmou À MÃO que o webhook deste CRM está cadastrado no painel do provedor (migration 0692). Existe porque isso não é verificável pela API, e porque a falha é a pior do módulo: sem webhook o cliente paga e o CRM nunca sabe. A prova real chega no primeiro aviso de pagamento que entra.';

-- O carimbo e quem carimbou andam juntos, igual ao par da chave PIX: um sem o
-- outro é registro que não responde "quem disse que estava conferido?".
alter table public.payment_provider_credentials
  drop constraint if exists payment_provider_credentials_webhook_conferencia_coerente;
alter table public.payment_provider_credentials
  add constraint payment_provider_credentials_webhook_conferencia_coerente
  check ((webhook_conferido_em is null) = (webhook_conferido_por is null));

-- As colunas novas entram no FIM da view: `create or replace view` aceita
-- ACRESCENTAR coluna, e recusa remover ou reordenar.
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
         updated_at,
         webhook_conferido_em,
         webhook_conferido_por
    from public.payment_provider_credentials;

-- O grant por COLUNA da 0689 é uma LISTA: coluna nova não entra sozinha, e sem
-- isto a tela leria `permission denied` na própria view "segura" (o
-- `security_invoker` usa o privilégio de quem consulta).
grant select (webhook_conferido_em, webhook_conferido_por)
  on public.payment_provider_credentials to authenticated;
