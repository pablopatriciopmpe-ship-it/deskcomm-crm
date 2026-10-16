---
impacto: capacidade_nova
secao: adicionado
titulo: A tela de Contatos aceita seleção múltipla e executa ações em lote por uma rota só
---

Adicionar ou remover etiqueta, mudar o responsável (carteira) e preencher um campo personalizado eram gestos de um contato por vez. Agora a tabela de contatos tem caixa de seleção em cada linha e uma barra de ações que só aparece quando há algo marcado. As três ações saem por UMA rota, `POST /api/v1/contacts/bulk`, que recebe `ids[]` e a ação escolhida. O lote não tem permissão própria, organização própria nem auditoria própria: cada id é encaminhado ao MESMO caminho do contato individual — etiqueta e campo pelo PATCH da ficha, responsável pela porta única da carteira (`fn_definir_carteira_do_cliente`) —, mesma organização lida da sessão (nunca do corpo da requisição) e uma entrada de auditoria por contato. Aceita até 100 contatos por chamada (`bulk_too_large`, 422, com o teto na mensagem); acima disso a chamada recusa inteira antes de qualquer escrita. A resposta traz o resultado de cada item — feito, recusado e o porquê —, e uma recusa não derruba as demais: contato de outra organização ou inexistente é recusado NO ITEM, com o `not_found` do próprio caminho individual, e as outras seguem. Quem só lê não vê a barra. "Mover cards de etapa" e "marcar sempre humano" ficaram fora desta fatia por medição: a primeira é endereçada por negócio (`/leads/[id]/move`), não por contato, e a segunda só é gravada pelo motor de atendimento — não existe porta individual. Nenhuma mudança de banco.

Contribuição de @webtecnica (refs #2484).
