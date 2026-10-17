"use client";

import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useT } from "@/lib/i18n/IdiomaProvider";

/**
 * A tela de ligar o recebimento por PIX.
 *
 * ## A ordem dos blocos é a ordem do trabalho
 *
 * Quem chega aqui tem uma tarefa com DOIS lados: um pedaço no nosso sistema (a
 * tag) e dois pedaços no painel do provedor (ligar o checkout, cadastrar a
 * chave PIX). A tela mostra os três na ordem em que precisam ser feitos, e o
 * endereço do webhook só aparece depois de haver conta — antes disso ele não
 * existe e mostrá-lo vazio só confundiria.
 *
 * ## Por que o carimbo da chave PIX é um botão, e não um campo automático
 *
 * Porque **a InfinitePay não responde isso por API**. Sem a chave, o link de
 * pagamento nasce com sucesso, o PIX aparece como opção e só falha na tela do
 * cliente que já decidiu comprar. Como nenhuma chamada sabe, quem sabe é a
 * pessoa que olhou — e o botão é essa assinatura. Enquanto ela não existir, o
 * assistente se recusa a cobrar, de propósito.
 */

export interface EstadoDaConta {
  configurada: boolean;
  handle?: string;
  pixConferidoEm?: string | null;
  webhookConferidoEm?: string | null;
  webhookUrl?: string;
}

type Carimbo = "chave_pix" | "webhook";

export function ContaDePagamento({ inicial }: { inicial: EstadoDaConta }) {
  const t = useT();
  const [conta, setConta] = useState<EstadoDaConta>(inicial);
  const [handle, setHandle] = useState(inicial.handle ?? "");
  const [salvando, setSalvando] = useState(false);
  const [conferindo, setConferindo] = useState<Carimbo | null>(null);

  /**
   * Relê o estado do servidor. Chamada depois de QUALQUER falha: quando a
   * escrita pode ter acontecido e a resposta não chegou, continuar mostrando o
   * que a tela achava é pior que mostrar nada — a tela diria "chave conferida"
   * sobre uma conta que o servidor acabou de trocar e descarimbar.
   */
  async function reconciliar() {
    try {
      const r = await fetch("/api/v1/pagamentos/conta");
      const corpo = (await r.json()) as {
        data?: {
          configurada: boolean;
          handle?: string;
          pix_conferido_em?: string | null;
          webhook_conferido_em?: string | null;
          webhook_url?: string;
        };
      };
      if (!r.ok || !corpo.data) return;
      const d = corpo.data;
      setConta({
        configurada: d.configurada,
        handle: d.handle,
        pixConferidoEm: d.pix_conferido_em ?? null,
        webhookConferidoEm: d.webhook_conferido_em ?? null,
        webhookUrl: d.webhook_url,
      });
      // NÃO apaga o rascunho: se a pessoa digitou uma tag nova e a gravação
      // falhou, sobrescrever o campo com o valor do servidor jogaria fora o que
      // ela escreveu. Só sincroniza o campo quando ele não foi editado.
      setHandle((digitado) =>
        digitado.trim() === (conta.handle ?? "") ? (d.handle ?? "") : digitado,
      );
    } catch {
      // Se nem a releitura responde, a tela fica como está e o aviso de erro
      // que o chamador já mostrou é o que a pessoa tem.
    }
  }

  async function salvar() {
    setSalvando(true);
    try {
      const r = await fetch("/api/v1/pagamentos/conta", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ handle }),
      });
      const corpo = (await r.json()) as {
        data?: { handle: string; webhook_url: string };
        error?: { message: string };
      };
      if (!r.ok || !corpo.data) {
        toast.error(corpo.error?.message ?? t("Não deu para salvar."));
        await reconciliar();
        return;
      }
      // Trocar a conta zera os DOIS carimbos no servidor; a tela segue a mesma
      // regra, senão mostraria "conferido" para uma conta que ninguém olhou e
      // para um aviso que ninguém ligou naquele painel.
      const trocou = conta.handle !== undefined && conta.handle !== corpo.data.handle;
      setConta({
        configurada: true,
        handle: corpo.data.handle,
        webhookUrl: corpo.data.webhook_url,
        pixConferidoEm: trocou ? null : conta.pixConferidoEm,
        webhookConferidoEm: trocou ? null : conta.webhookConferidoEm,
      });
      // O servidor guarda a tag SEM o `$`. Sem refletir isso no campo, quem
      // digitou `$minhaloja` ficaria com `temEdicaoNaoSalva` eternamente
      // verdadeiro — e os dois botões de conferência travados, sem explicação.
      setHandle(corpo.data.handle);
      toast.success(t("Conta salva."));
    } catch {
      toast.error(t("Não deu para falar com o servidor. Confira como ficou."));
      await reconciliar();
    } finally {
      setSalvando(false);
    }
  }

  async function carimbar(o_que: Carimbo) {
    setConferindo(o_que);
    try {
      const r = await fetch("/api/v1/pagamentos/conta", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        // A conta que ESTA tela está mostrando. Se o servidor já tiver outra, a
        // assinatura é recusada com 409 em vez de carimbar a conta errada.
        body: JSON.stringify({ handle: conta.handle, o_que }),
      });
      const corpo = (await r.json()) as {
        data?: { o_que: Carimbo; conferido_em: string };
        error?: { message: string };
      };
      if (!r.ok || !corpo.data) {
        toast.error(corpo.error?.message ?? t("Não deu para registrar."));
        await reconciliar();
        return;
      }
      const em = corpo.data.conferido_em;
      setConta((c) =>
        o_que === "chave_pix" ? { ...c, pixConferidoEm: em } : { ...c, webhookConferidoEm: em },
      );
      toast.success(t("Conferência registrada."));
    } catch {
      toast.error(t("Não deu para falar com o servidor. Confira como ficou."));
      await reconciliar();
    } finally {
      setConferindo(null);
    }
  }

  async function copiar(texto: string) {
    try {
      await navigator.clipboard.writeText(texto);
      toast.success(t("Endereço copiado."));
    } catch {
      toast.error(t("Não deu para copiar. Selecione e copie à mão."));
    }
  }

  // Assinar a chave de uma conta enquanto o campo mostra OUTRA tag seria assinar
  // sobre o que não está na tela. Salve primeiro.
  const temEdicaoNaoSalva = conta.configurada && handle.trim() !== (conta.handle ?? "");

  // Os TRÊS passos. O do webhook entra aqui porque ele é o único cuja falta faz
  // o cliente PAGAR e não receber: sem o aviso configurado no provedor, o
  // dinheiro entra na conta e o CRM nunca sabe. A tela já o apresentava como
  // obrigatório; agora ele também é.
  const pronto =
    conta.configurada && Boolean(conta.pixConferidoEm) && Boolean(conta.webhookConferidoEm);

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6 p-4 md:p-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold">{t("Receber pagamentos")}</h1>
        <p className="text-muted-foreground">
          {t(
            "Com isto ligado, o assistente cobra pelo PIX dentro da conversa e entrega o produto sozinho assim que o pagamento é confirmado.",
          )}
        </p>
      </header>

      {!pronto && (
        <div
          role="status"
          className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm"
        >
          <strong className="font-medium">{t("Ainda não dá para cobrar.")}</strong>{" "}
          {t(
            "Enquanto os três passos abaixo não estiverem feitos, o assistente não manda link de pagamento — e isso é de propósito: cobrança com conta incompleta falha na tela do cliente.",
          )}
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle>{t("1. Sua conta InfinitePay")}</CardTitle>
          <CardDescription>
            {t(
              "A InfiniteTag é o apelido da sua conta, o mesmo que seus clientes veem ao pagar. Está no app da InfinitePay.",
            )}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="flex flex-col gap-2">
            <Label htmlFor="handle">InfiniteTag</Label>
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground" aria-hidden>
                $
              </span>
              <Input
                id="handle"
                value={handle}
                onChange={(e) => setHandle(e.target.value)}
                placeholder="suaempresa"
                autoComplete="off"
                spellCheck={false}
              />
            </div>
          </div>
          <div>
            <Button
              onClick={salvar}
              disabled={salvando || conferindo !== null || handle.trim().length < 2}
            >
              {salvando
                ? t("Salvando…")
                : conta.configurada
                  ? t("Salvar")
                  : t("Ligar recebimento")}
            </Button>
          </div>
        </CardContent>
      </Card>

      {conta.configurada && conta.webhookUrl && (
        <Card>
          <CardHeader>
            <CardTitle>{t("2. Avisar a InfinitePay onde falar com você")}</CardTitle>
            <CardDescription>
              {t(
                "No painel da InfinitePay, ligue o Checkout Integrado e cole este endereço no campo de webhook. É por ele que o aviso de pagamento chega.",
              )}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <code className="block overflow-x-auto rounded-md bg-muted px-3 py-2 text-xs">
              {conta.webhookUrl}
            </code>
            <div>
              <Button variant="secondary" onClick={() => void copiar(conta.webhookUrl!)}>
                {t("Copiar endereço")}
              </Button>
            </div>
            <p className="text-sm text-muted-foreground">
              {t(
                "Guarde-o em lugar seguro: quem tiver este endereço consegue mandar avisos ao seu sistema. Ele muda se a chave interna da instalação for trocada.",
              )}
            </p>
            <p className="text-sm">
              {t(
                "Este passo é o mais importante dos três. Sem ele o link funciona, o cliente paga, o dinheiro entra na sua conta — e o sistema nunca é avisado: nada é confirmado e nada é entregue. Também não conseguimos checar isso sozinhos.",
              )}
            </p>
            {conta.webhookConferidoEm ? (
              <p className="text-sm font-medium text-emerald-600 dark:text-emerald-400">
                {t("Conferido em")} {new Date(conta.webhookConferidoEm).toLocaleDateString()}.
              </p>
            ) : (
              <div>
                <Button
                  onClick={() => void carimbar("webhook")}
                  disabled={conferindo !== null || salvando || temEdicaoNaoSalva}
                >
                  {conferindo === "webhook"
                    ? t("Registrando…")
                    : t("Conferi: colei o endereço no painel da InfinitePay")}
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {conta.configurada && (
        <Card>
          <CardHeader>
            <CardTitle>{t("3. Conferir a chave PIX")}</CardTitle>
            <CardDescription>
              {t(
                "Abra o painel da InfinitePay e confirme que a conta tem uma chave PIX cadastrada.",
              )}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <p className="text-sm">
              {t(
                "Não conseguimos checar isso sozinhos — a InfinitePay não informa. E sem a chave, o link é criado normalmente, o PIX aparece como opção e só falha na hora em que o cliente vai pagar. Por isso precisamos da sua palavra.",
              )}
            </p>
            {conta.pixConferidoEm ? (
              <p className="text-sm font-medium text-emerald-600 dark:text-emerald-400">
                {t("Conferida em")} {new Date(conta.pixConferidoEm).toLocaleDateString()}.
              </p>
            ) : (
              <div>
                <Button
                  onClick={() => void carimbar("chave_pix")}
                  disabled={conferindo !== null || salvando || temEdicaoNaoSalva}
                >
                  {conferindo === "chave_pix"
                    ? t("Registrando…")
                    : t("Conferi: a chave PIX está cadastrada")}
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {pronto && (
        <div
          role="status"
          className="rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-4 py-3 text-sm"
        >
          <strong className="font-medium">{t("Pronto para vender.")}</strong>{" "}
          {t(
            "O assistente já pode cobrar produtos do catálogo nesta conversa. Faça uma venda de R$ 1 para você mesmo antes de soltar para os clientes.",
          )}
        </div>
      )}
    </div>
  );
}
