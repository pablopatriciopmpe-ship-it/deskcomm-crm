-- manifest: **O aviso de que a conferência do recibo parou de funcionar.** A confirmação de pagamento da 0693 não vem de API — o `payment_check` do provedor é rota morta e o webhook não é assinado —, então ela é leitura do recibo PÚBLICO do provedor. Isso quebra sozinho no dia em que eles mudarem o layout da página, e quebra para o lado seguro: nenhuma venda é confirmada, nenhum produto sai, e **nada reclama**. Este kind é o que faz esse silêncio virar aviso na Central. Entra na lista CANÔNICA de `agent_inbox_items_kind_check`, no fim e antes de `other`, pelas duas razões que o próprio bloco declara (bloco único por constraint, lição do #159; e a janela de 2000 caracteres que `tests/unit/midia-nao-lida.test.ts` varre). Sem backfill: nenhuma linha usa o kind novo.
-- 0695: o aviso de que a conferência do recibo parou de funcionar
--
-- ─── O defeito que este kind existe para tornar visível ─────────────────────
--
-- A 0693 decidiu que nenhuma cobrança fica `paid` sem `conferido_pelo_recibo_em`
-- (CHECK `payment_charges_conferida_antes_de_paga`). Essa conferência é leitura
-- do HTML de `recibo.infinitepay.io`, e não API: não existe API para perguntar —
-- o `payment_check` do provedor devolve a mesma resposta para parâmetros
-- válidos, inválidos e corpo vazio.
--
-- Leitura de HTML de terceiro quebra sem avisar. E o modo de falha é o pior
-- possível para quem instalou numa VPS e foi dormir: quebra para o lado SEGURO.
-- Ninguém recebe produto sem pagar; o que acontece é que **ninguém recebe**. As
-- vendas entram, o dinheiro cai na conta do provedor, e o CRM segue achando que
-- nada foi pago. É a mesma família de `message_send_stuck` (0109) e de
-- `midia_nao_lida` (0129): o produto não dá erro, só para de cumprir a promessa,
-- e quem instalou conclui que é assim mesmo.
--
-- Quem abre este aviso é o cron `pagamento-sonda-do-recibo`, que reconfere um
-- pagamento JÁ confirmado antes. Se a conferência que passou ontem falha hoje,
-- não foi o pagamento que mudou — foi a página. E o aviso se fecha sozinho
-- quando volta a passar, no mesmo laço de `canal_pausado` (0589).

alter table public.agent_inbox_items
  drop constraint if exists agent_inbox_items_kind_check;
alter table public.agent_inbox_items
  add constraint agent_inbox_items_kind_check check (kind in (
    'appointment_outcome_required',
    'appointment_recovery_review',
    'qr_rescan',
    'routing_unassigned',
    'job_dead',
    'event_dead',
    'budget_exceeded',
    'handoff',
    'promotion_review',
    'judge_unaligned',
    'followup_dead',
    'snooze_expired',
    'next_action_ambiguous',
    'risk_backlog_seeded',
    'reactivation_expired',
    'capabilities_missing',
    'message_send_stuck',
    'midia_nao_lida',
    'channel_template_review',
    'channel_number_alert',
    'promise_unfulfilled',
    'contact_proposal_expired',
    'budget_warning',
    'conhecimento_nao_indexado',
    'voice_call_missed',
    'case_stale',
    'aviso_de_caso_nao_entregue',
    'followup_sem_agente',
    'canal_mudo_sem_numero',
    'proposal_expired_notice', 'proposal_acceptance_rate_drop', 'proposal_promised_not_created',
    'proposta_travada',
    'proposta_pronta_para_revisao',
    'org_reativada',
    'jev_pedido_de_humano',
    'jev_parar_de_receber',
    'canal_pausado',
    'cobranca',
    'email_de_login_trocado',
    -- (migration 0655, #2529) os dois kinds do lembrete de tarefa. Eles NÃO são
    -- desta entrega: entraram na main enquanto esta branch vivia, e estão aqui
    -- porque este bloco RECONSTRÓI a lista inteira. Sem copiá-los, o clone que
    -- aplica a cadeia perderia os dois em silêncio — quem grava captura o 23514
    -- e segue, então o aviso de tarefa simplesmente nunca abriria. É o defeito
    -- que `check-do-baseline-nao-diverge-da-cadeia` e
    -- `kind-check-migration-x-baseline` existem para pegar, e pegaram.
    'task_due',
    'task_overdue',
    -- (migration 0695) a conferência do recibo do provedor parou de reconhecer
    -- a página. Enquanto durar, nenhuma venda é confirmada e nenhum produto sai.
    'conferencia_do_recibo_quebrada',
    'other'
  ));

-- Um aviso aberto por organização, não um por rodada do cron: a página quebrada
-- é a MESMA todo dia, e uma linha por dia encheria a Central de cópias do mesmo
-- fato. Mesmo idioma de `agent_inbox_canal_pausado_aberto_unico` (0589).
--
-- `ref_id` fica de fora da chave: o defeito não é de uma cobrança, é do parser.
create unique index if not exists agent_inbox_recibo_quebrado_aberto_unico
  on public.agent_inbox_items (organization_id, kind)
  where status = 'open' and kind = 'conferencia_do_recibo_quebrada';
