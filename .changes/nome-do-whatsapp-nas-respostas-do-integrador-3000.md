---
impacto: nada_mudou
secao: corrigido
titulo: As respostas prontas do integrador preenchem {{nome}} com o nome do perfil do WhatsApp
---

Quem chega pelo WhatsApp entra no CRM sem nome cadastrado, só com o nome do perfil. As respostas prontas usadas pelo integrador liam o contato sem esse nome do perfil. Por isso `{{nome}}` saía vazio e o pedido era recusado por falta do nome, mesmo com o nome aparecendo na tela. Agora o nome do perfil é lido, com a mesma régua do resto do produto: o nome cadastrado vem primeiro e o do perfil entra quando não há cadastro.

Contribuição de @webtecnica (refs #3000).
