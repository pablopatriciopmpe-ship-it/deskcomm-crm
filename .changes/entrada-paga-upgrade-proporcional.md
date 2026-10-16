---
impacto: exige_acao
secao: alterado
titulo: Com a cobrança ligada e planos oferecidos, defina um plano padrão — sem ele o cadastro pelo Google some e o cadastro sem plano é recusado
---

Com a cobrança dos seus clientes ligada, toda empresa nova passa a nascer com plano. Na tela de cadastro, quem cria a conta escolhe um dos planos oferecidos (a lista já vem marcada no plano padrão); quem entra sem escolher — pelo Google ou pela integração — fica no plano padrão. Um plano com 0 dias de teste grátis cobra a entrada: a empresa nasce suspensa e o acesso abre quando o provedor confirma o primeiro pagamento (minutos no Pix e no cartão, até um dia útil no boleto). O prazo de tolerância da renovação não abre esse primeiro acesso.

Se você não tem plano nenhum oferecido aos clientes nem marcado como plano do cadastro, nada muda: a empresa nova nasce isenta e o "Entrar com Google" continua no cadastro.

Mudou também a troca de plano. A empresa que sobe de plano no meio do período pago recebe a cobrança da diferença proporcional aos dias que faltam. O plano novo e os limites dele só valem depois desse pagamento, e a data da renovação continua a mesma. Essa cobrança vale até o fim do período: não paga até lá, ela é cancelada; diferença abaixo de R$ 5,00 não é cobrada, e a troca fica para a renovação. Escolher outro plano enquanto a diferença espera pagamento cancela a cobrança; assinar de novo depois de cancelar a assinatura também a cancela, antes de abrir o pagamento do plano. Quem desce de plano continua no plano atual até a renovação, e a próxima fatura já sai com o preço novo, sem crédito proporcional. A troca que você faz pelo painel da empresa continua agendada para a renovação, sem cobrar diferença. A tela de cobrança compara preço, pessoas, números conectados e uso de IA antes da troca.

O e-mail que fica gravado no provedor de pagamento quando a empresa clica em Assinar passa a ser o do administrador dela, como já era no link que você gera pelo painel — nunca o seu, mesmo quando você entra como administrador provisório da empresa que criou.

## Requer atenção

Vale para quem tem a cobrança ligada, oferece planos aos clientes e não tem nenhum marcado como **Plano do cadastro** (o padrão). Depois da atualização, nessa situação:

- o "Entrar com Google" some da tela de cadastro;
- o cadastro sem plano escolhido é recusado. Quem entra pela primeira vez com o Google pela tela de login, ou se cadastrou antes da atualização, escolhe o plano na tela seguinte ("Configure sua organização");
- a integração que cria empresas por `POST /api/v1/tenants/provision` recebe `409 plano_obrigatorio`.

Com um padrão de 0 dias de teste grátis, a empresa criada pela integração também nasce suspensa até o primeiro pagamento.

Para evitar, escolha o plano padrão em Painel › Cobrança › Planos, no botão **Usar no cadastro** (o plano marcado passa a mostrar "Plano do cadastro"); a aba Planos avisa enquanto falta. Com o padrão definido, o Google volta, a integração volta a criar empresas e a empresa que entra sem escolher nasce no padrão.

Contribuição de @omayklourenco (#2846).
