---
impacto: capacidade_nova
secao: corrigido
titulo: O limite de passos do follow-up conta só o que o cliente sente, e a publicação recusa a cadência linear que o motor não conseguiria terminar
---

O limite de 30 passos de um fluxo de follow-up contava toda caixa do desenho. Por isso uma cadência de 7 toques com uma tag em cada toque era recusada na publicação, embora o cliente recebesse só 7 mensagens. Agora o limite conta o que chega ao cliente: mensagem, pergunta, skill, espera e as esperas por resposta (classificar e casar resposta). Gatilho, condição, repetir, tag, mover, tarefa interna e fim deixam de contar. A cadência de 7 toques com tag por toque passa a publicar.

O motor tem um limite próprio: ele desiste da inscrição depois de 80 passos. Para o limite novo não deixar publicar um fluxo que morreria no meio, a publicação passa a somar quanto custa no motor a cadência linear a partir do gatilho. Se passa de 80, ela recusa e diz o motivo, em vez de publicar e parar no meio da cadência. O trecho que fica dentro de um ciclo, ou depois dele, ainda não entra nessa soma. Fluxos já publicados não mudam.

Se a sua integração lê `details.errors[].code` no 422 de `POST /api/v1/ai/followup-flows/{id}/publish`, ela vai passar a ver também `max_engine_steps_exceeded`.

Contribuição de @webtecnica (closes #2896).
