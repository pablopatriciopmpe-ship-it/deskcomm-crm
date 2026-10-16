"use client";

import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

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
  webhookUrl?: string;
}

export function ContaDePagamento({ inicial }: { inicial: EstadoDaConta }) {
  const [conta, setConta] = useState<EstadoDaConta>(inicial);
  const [handle, setHandle] = useState(inicial.handle ?? "");
  const [salvando, setSalvando] = useState(false);
  const [conferindo, setConferindo] = useState(false);

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
        toast.error(corpo.error?.message ?? "Não deu para salvar.");
        return;
      }
      // Trocar a conta zera o carimbo no servidor; a tela segue a mesma regra,
      // senão mostraria "conferida" para uma conta que ninguém olhou.
      const trocou = conta.handle !== undefined && conta.handle !== corpo.data.handle;
      setConta({
        configurada: true,
        handle: corpo.data.handle,
        webhookUrl: corpo.data.webhook_url,
        pixConferidoEm: trocou ? null : conta.pixConferidoEm,
      });
      toast.success("Conta salva.");
    } finally {
      setSalvando(false);
    }
  }

  async function conferirPix() {
    setConferindo(true);
    try {
      const r = await fetch("/api/v1/pagamentos/conta", { method: "PATCH" });
      const corpo = (await r.json()) as {
        data?: { pix_conferido_em: string };
        error?: { message: string };
      };
      if (!r.ok || !corpo.data) {
        toast.error(corpo.error?.message ?? "Não deu para registrar.");
        return;
      }
      setConta((c) => ({ ...c, pixConferidoEm: corpo.data!.pix_conferido_em }));
      toast.success("Conferência registrada.");
    } finally {
      setConferindo(false);
    }
  }

  async function copiar(texto: string) {
    try {
      await navigator.clipboard.writeText(texto);
      toast.success("Endereço copiado.");
    } catch {
      toast.error("Não deu para copiar. Selecione e copie à mão.");
    }
  }

  const pronto = conta.configurada && Boolean(conta.pixConferidoEm);

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6 p-4 md:p-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold">Receber pagamentos</h1>
        <p className="text-muted-foreground">
          Com isto ligado, o assistente cobra pelo PIX dentro da conversa e entrega o produto
          sozinho assim que o pagamento é confirmado.
        </p>
      </header>

      {!pronto && (
        <div
          role="status"
          className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm"
        >
          <strong className="font-medium">Ainda não dá para cobrar.</strong> Enquanto os três
          passos abaixo não estiverem feitos, o assistente não manda link de pagamento — e isso é
          de propósito: cobrança com conta incompleta falha na tela do cliente.
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle>1. Sua conta InfinitePay</CardTitle>
          <CardDescription>
            A InfiniteTag é o apelido da sua conta, o mesmo que seus clientes veem ao pagar. Está no
            app da InfinitePay.
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
            <Button onClick={salvar} disabled={salvando || handle.trim().length < 2}>
              {salvando ? "Salvando…" : conta.configurada ? "Salvar" : "Ligar recebimento"}
            </Button>
          </div>
        </CardContent>
      </Card>

      {conta.configurada && conta.webhookUrl && (
        <Card>
          <CardHeader>
            <CardTitle>2. Avisar a InfinitePay onde falar com você</CardTitle>
            <CardDescription>
              No painel da InfinitePay, ligue o <strong>Checkout Integrado</strong> e cole este
              endereço no campo de webhook. É por ele que o aviso de pagamento chega.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <code className="block overflow-x-auto rounded-md bg-muted px-3 py-2 text-xs">
              {conta.webhookUrl}
            </code>
            <div>
              <Button variant="secondary" onClick={() => void copiar(conta.webhookUrl!)}>
                Copiar endereço
              </Button>
            </div>
            <p className="text-sm text-muted-foreground">
              Guarde-o em lugar seguro: quem tiver este endereço consegue mandar avisos ao seu
              sistema. Ele muda se a chave interna da instalação for trocada.
            </p>
          </CardContent>
        </Card>
      )}

      {conta.configurada && (
        <Card>
          <CardHeader>
            <CardTitle>3. Conferir a chave PIX</CardTitle>
            <CardDescription>
              Abra o painel da InfinitePay e confirme que a conta tem uma chave PIX cadastrada.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <p className="text-sm">
              Não conseguimos checar isso sozinhos — a InfinitePay não informa. E sem a chave, o
              link é criado normalmente, o PIX aparece como opção e só falha na hora em que o
              cliente vai pagar. Por isso precisamos da sua palavra.
            </p>
            {conta.pixConferidoEm ? (
              <p className="text-sm font-medium text-emerald-600 dark:text-emerald-400">
                Conferida em {new Date(conta.pixConferidoEm).toLocaleDateString("pt-BR")}.
              </p>
            ) : (
              <div>
                <Button onClick={conferirPix} disabled={conferindo}>
                  {conferindo ? "Registrando…" : "Conferi: a chave PIX está cadastrada"}
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
          <strong className="font-medium">Pronto para vender.</strong> O assistente já pode cobrar
          produtos do catálogo nesta conversa. Faça uma venda de R$ 1 para você mesmo antes de
          soltar para os clientes.
        </div>
      )}
    </div>
  );
}
