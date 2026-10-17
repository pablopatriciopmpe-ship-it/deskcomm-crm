---
impacto: capacidade_nova
secao: alterado
titulo: A condição "contém" das automações ignora acento e trata pontuação como espaço
---

A condição `contém` das automações comparava sem diferenciar maiúsculas, mas não ignorava acento nem pontuação: uma regra escrita com "anúncio" não disparava para um lead que escreveu "anuncio", e a regra feita com o trecho da mensagem pronta do anúncio deixava de disparar quando o lead apagava uma vírgula ou um ponto de exclamação. A regra simplesmente não rodava, sem erro e sem aviso. Agora os dois lados da comparação passam pela mesma forma: minúsculas, sem acento, e a pontuação conta como espaço. "Olá", "Ola" e "olá!" são a mesma frase para a regra, e "pré-venda" casa "pre venda"; números e endereços não se juntam ("10,00" não casa "1.000"), e uma regra feita só de pontuação, como "?", continua comparando como antes. A comparação exata (`é igual a`) continua exata, e a pertinência em lista de tags continua exigindo a tag inteira.

Atenção ao atualizar: regras com 'contém' passam a disparar também quando a mensagem ou a etiqueta difere só por acento ou pontuação ('anúncio' casa 'anuncio'; 'Olá! Vi o anúncio' casa 'ola vi o anuncio'); se você tem regra que manda WhatsApp com 'contém', confira o texto dela.

Contribuição de @webtecnica (Refs #2973).
