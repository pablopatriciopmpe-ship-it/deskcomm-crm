---
impacto: capacidade_nova
secao: adicionado
titulo: Um aviso quando os pagamentos param de ser confirmados
---

A confirmação de pagamento por PIX depende de ler o recibo do provedor, porque
ele não oferece uma forma de perguntar "esta cobrança foi paga?". Isso funciona,
e um dia vai parar de funcionar sozinho, quando o provedor mudar a página dele.

O problema não é a quebra: é o silêncio dela. Nada daria erro. O dinheiro
continuaria caindo na conta, e o sistema continuaria achando que ninguém pagou —
então nenhum produto sairia, e ninguém saberia por quê.

Agora uma verificação diária reconfere um pagamento que já tinha sido confirmado
antes. Se o que passava ontem falha hoje, não foi o pagamento que mudou, foi a
página — e aparece um aviso na Central dizendo exatamente isso, com o que fazer.
O aviso se fecha sozinho quando volta a funcionar.

Quem não vende por PIX não vê diferença nenhuma.
