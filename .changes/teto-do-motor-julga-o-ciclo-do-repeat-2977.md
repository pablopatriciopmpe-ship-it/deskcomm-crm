---
impacto: nada_mudou
secao: corrigido
titulo: O fluxo com "Repetir" que o motor não conseguiria terminar não é mais publicado
---

Um fluxo de follow-up com a caixa "Repetir" podia ser publicado e morrer no meio da cadência: a inscrição fechava com o motivo `max_steps` sem gravar as últimas caixas nem chegar ao fim. A publicação contava cada ciclo uma vez só — o "Repetir" dá até 20 voltas — e não somava nada do que só se alcança depois do ciclo, então uma cadência longa pendurada na saída do repetir passava batido.

Agora a publicação multiplica as voltas que o "Repetir" permite pelo custo do trecho repetido (mais a passada em que ele decide seguir em frente) e continua somando a cadência que vem depois do ciclo. Se o total passa do teto de 80 passos do motor, ela recusa e diz o motivo e, quando são as voltas do repetir que pesam, nomeia a caixa, quantos passos custa cada volta e até quantas voltas ela permite — em vez de publicar e parar no meio.

Poucas voltas continuam publicando: 15 voltas de uma mensagem mais uma espera cabem no orçamento; 16 não. Fluxos já publicados não mudam. Ao publicar de novo um fluxo assim, a publicação passa a recusar e dizer o porquê.

Contribuição de @webtecnica (refs #2977).
