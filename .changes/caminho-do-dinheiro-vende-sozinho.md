---
impacto: capacidade_nova
secao: adicionado
titulo: O assistente fecha a venda e entrega o produto sozinho
---

O assistente ganhou a capacidade de cobrar. Quando o cliente decide comprar,
ele cria a cobrança do produto escolhido no catálogo e manda o link de
pagamento na conversa. O endereço é enviado pelo servidor, não escrito pelo
assistente, para o link não sair quebrado no meio.

Quando o pagamento entra, o sistema confere com o provedor antes de acreditar.
Só depois disso o pedido vira pago e o cliente recebe uma página com o arquivo
que comprou. A página tem endereço secreto, vence, e registra cada abertura —
o arquivo nunca é mandado solto.

**Nada é entregue sem a conferência.** O próprio banco recusa marcar uma venda
como paga sem ela, então nem uma falha nossa libera produto sem pagamento.

**Uma vez por dia o sistema volta atrás e procura o que ficou no caminho.** Se
um pagamento chegou e a conferência não reconheceu a página do provedor naquele
momento, a cobrança não é esquecida: ela volta para a fila na rodada seguinte, e
se cura sozinha assim que a conferência voltar a funcionar.

**Pagamento que entra enquanto a empresa está suspensa também é registrado.**
Quem pagou foi o cliente dela, que não tem nada a ver com a mensalidade — e
recusar o registro não desfaz o pagamento, só esconde que aconteceu. Empresa
apagada por LGPD ou encerrada é exceção: nessas, nada é confirmado.

Para ligar, a empresa precisa de uma conta InfinitePay com o Checkout Integrado
ativo e a chave PIX cadastrada. Quem não vender por PIX não vê diferença.
