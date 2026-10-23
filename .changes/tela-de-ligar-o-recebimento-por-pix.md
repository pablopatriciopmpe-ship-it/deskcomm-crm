---
impacto: capacidade_nova
secao: adicionado
titulo: A tela de ligar o recebimento por PIX, com os três passos assinados
---

Em **Configurações › Receber pagamentos**, quem administra a empresa liga o
recebimento sem tocar em script nem em banco. A tela mostra os três passos na
ordem em que precisam ser feitos: a tag da conta InfinitePay, o endereço do
aviso de pagamento para colar no painel do provedor, e a conferência da chave
PIX.

Dois desses passos acontecem **no painel do provedor**, não aqui, e a
InfinitePay não responde por API se eles foram feitos. Então cada um termina
com um botão em que a pessoa assina que olhou. Enquanto os três não estiverem
assinados, o assistente se recusa a cobrar — e isso é de propósito:

- sem a chave PIX, o link nasce e falha na tela do cliente. Ninguém paga;
- **sem o aviso de pagamento o cliente paga e o sistema nunca sabe.** O
  dinheiro entra na conta da empresa, nada é confirmado e nada é entregue. É a
  única falha do módulo em que quem compra perde dinheiro, e é por isso que ela
  também virou assinatura obrigatória.

Trocar a tag da conta **derruba as duas assinaturas**, no servidor e na tela: a
chave conferida era da conta anterior, e o aviso foi cadastrado no painel
daquela conta. Quem assinou fica registrado na auditoria.

Quem não vende por PIX não vê diferença: a tela só aparece para quem
administra, e nada passa a cobrar sozinho.
