---
impacto: exige_acao
secao: corrigido
titulo: O custo das chamadas do provedor personalizado passa a ser calculado pelo preço do catálogo
---

O provedor personalizado serve qualquer modelo — o endereço é de quem instalou —, e o motor de custo só olhava a tabela de preços embutida no código. Um modelo que não estivesse lá, como o `openai/gpt-oss-120b` apontado para o Groq, gravava `llm_calls.cost_cents` nulo em toda chamada: a tela de Uso e orçamento somava `coalesce(cost_cents, 0)`, então essas chamadas pagas apareciam como gasto zero e não consumiam teto nenhum. Medido numa instalação: 180 chamadas de `openai/gpt-oss-120b` e 256 de `openai/gpt-oss-20b`, todas nulas, enquanto o Haiku 5.5 do mesmo turno tinha custo.

Agora, quando a tabela embutida não conhece o id, o preço sai do catálogo da própria instalação — as tabelas `ai_models` e `ai_pricing`, as mesmas que a tela de Provedores mostra e que a tela de orçamento já usava nos outros caminhos de custo. É de lá que sai o preço do modelo que você cadastrou, sem nenhum número inventado no código: modelo que não está em nenhuma das duas continua sem custo, e agora isso deixa aviso no log uma vez por provedor e modelo, em vez de passar calado.

O que muda no número que você vê: essas chamadas passam a entrar na tela de Uso de IA e no teto mensal de gasto. Se a sua organização tem teto configurado e usa o provedor personalizado, o gasto que aparece sobe para o real. Se a leitura do catálogo falhar (banco indisponível naquele instante), a chamada segue normalmente, o custo daquela chamada fica sem valor e o log diz que foi a leitura que falhou.

Quem só usa os modelos de fábrica não vê mudança nenhuma: a tabela embutida continua sendo consultada primeiro, e para eles nada mais é lido do banco.

Refs #3013.

## Requer atenção

Se você usa o provedor personalizado e tem teto de gasto de IA em modo de bloqueio, confira o teto antes de atualizar: as chamadas desse provedor passam a ser contadas pelo preço real, e o gasto do mês pode cruzar o limite e pausar a IA nas conversas.
