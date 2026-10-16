---
impacto: nada_mudou
secao: corrigido
titulo: A aba Atividade mostra o motivo da falha de uma ação de automação em vez de "[object Object]"
---
Quando uma ação de automação falhava com um erro do banco, a aba Atividade mostrava "[object Object]" em vez do motivo: o erro do banco não chega como `Error`, e a ação gravava a conversão literal do objeto. Agora a ação grava a mensagem e o código do erro, nas ações de enviar WhatsApp, enviar mensagem por IA, decidir por IA, criar ou mover lead e chamar webhook. A mensagem sai inteira; a ação não corta mais as instruções dos erros de configuração da IA. Um erro sem mensagem mostra só os nomes dos seus campos, nunca os valores.

Contribuição de @webtecnica (closes #2980).
