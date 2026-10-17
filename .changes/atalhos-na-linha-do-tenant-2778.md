---
impacto: capacidade_nova
secao: adicionado
titulo: A listagem de instalações do admin ganha atalhos de acompanhar, editar e suspender em cada linha
---

Cada linha da listagem de tenants em `/admin/tenants` deixa de ter só o link "Ver" e passa a ter três atalhos com rótulo que diz o nome do tenant: Acompanhar (abre a página de saúde), Editar (abre a ficha) e Suspender. Suspender acontece na própria lista, com o mesmo diálogo de confirmação da ficha, agora com o nome do tenant no título, e sem perder a posição na lista. Um tenant suspenso por decisão administrativa mostra Reativar no lugar de Suspender. Um tenant suspenso por falta de pagamento não oferece Reativar, porque essa suspensão só se desfaz pelo card Cobrança da ficha (dar prazo ou tornar isenta), e o atalho leva para lá. Um tenant anonimizado não recebe atalho nenhum, só o link para a ficha. Nenhuma mudança de banco.

Contribuição de @webtecnica (#2779).
