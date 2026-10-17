/**
 * Capacidade de COBRAR — o agente fecha a venda dentro da conversa.
 *
 * Domínio próprio, e não um item em `comercio.ts`, porque aqui há DINHEIRO: o
 * risco, o papel e o pacote são outros, e quem lê a tela de capacidades precisa
 * ver "cobrar" separado de "consultar o catálogo".
 */
import { declararTools } from "./tipos";

export const TOOLS_PAGAMENTOS = declararTools([
  {
    name: "crm_cobrar_produto",
    category: "write",
    rotulo: "Cobrar um produto e mandar o link",
    explicacao:
      "Cria uma cobrança de verdade do produto escolhido e envia o link de pagamento na conversa. O assistente não recebe o endereço — quem manda é o sistema, para o link não sair quebrado. O produto só é entregue depois que o pagamento for confirmado com o provedor.",
    oQueToca: "Cobranças e pagamentos",
    risco: "atencao",
    pacotes: ["vender"],
  },
]);
