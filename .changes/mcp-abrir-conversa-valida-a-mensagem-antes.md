---
impacto: nada_mudou
secao: corrigido
titulo: A ferramenta de integração que abre conversa e envia confere a mensagem antes de abrir
---

A ferramenta `crm_start_conversation_and_send` (MCP) abria a conversa e só depois conferia a mensagem. Uma chamada com a mensagem incompleta, como texto sem corpo, era recusada, mas deixava para trás uma conversa aberta e vazia no CRM. Agora a mensagem é conferida primeiro: a chamada inválida é recusada sem abrir conversa e sem passar pelo freio de envio do número. Chamadas válidas seguem iguais.

Refs #2812 (achado na triagem do #2851, de @webtecnica).
