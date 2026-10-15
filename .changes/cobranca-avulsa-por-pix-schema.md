---
impacto: capacidade_nova
secao: adicionado
titulo: O banco passa a guardar cobrança por PIX de cada empresa
---

Três tabelas novas, vazias em toda instalação: a conta do gateway de pagamento
de cada empresa, a tentativa de cobrança — que é onde ficam os estados que o
pedido não tem, como cobrança expirada e pagamento contestado — e o item do
pedido, que guarda o nome e o código do produto no momento da venda, para
renomear um produto não reescrever o que foi vendido no ano passado.

O gateway escolhido não usa chave de API: o que identifica quem recebe é a tag
pública da conta. O único segredo guardado é o endereço secreto por onde o aviso
de pagamento entra, e ele é gerado aqui, não copiado de lugar nenhum.

A regra que mais importa é do próprio banco: **nenhuma cobrança pode ser marcada
como paga sem a conferência do recibo do provedor**. O aviso de pagamento desse
gateway não é assinado, então um aviso inventado não basta — sem o recibo
conferido, o banco recusa, e o produto não sai.

Nada muda na tela ainda: é o schema que as próximas entregas usam. Quem não
vender por PIX não vê diferença nenhuma, e nenhuma tabela existente foi
alterada.
