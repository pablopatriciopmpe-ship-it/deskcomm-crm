"use client";
import { useState, Fragment } from "react";
import { useT } from "@/hooks/i18n/useT";
import { ChipDeEtiqueta } from "@/components/tags/ChipDeEtiqueta";
import { PontoDaEtiqueta } from "@/components/tags/PontoDaEtiqueta";
import { SeletorDeCorDaEtiqueta } from "@/components/tags/SeletorDeCorDaEtiqueta";
import { DialogoDeNovaEtiqueta } from "@/components/tags/DialogoDeNovaEtiqueta";
import { useCoresDasEtiquetas } from "@/components/tags/CoresDasEtiquetas";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { X, Plus } from "@/lib/ui/icons";
import { useUpdateContact } from "@/hooks/contacts/useUpdateContact";
import { useContactTagVocabulary } from "@/hooks/contacts/useContactTagVocabulary";
import { useDefinirCorDaEtiqueta } from "@/hooks/tags/useDefinirCorDaEtiqueta";
import { chaveDaEtiqueta } from "@/lib/tags/cor-da-etiqueta";
import { useAuth } from "@/hooks/auth/AuthProvider";
import { ROLE_RANK } from "@/lib/auth/types";
import { normalizarTag, TAMANHO_MAXIMO_DA_TAG } from "@/lib/contacts/tag-normalizada";

interface Props {
  contactId: string;
  orgId: string;
  tags: string[];
}

/** Edita as tags do CONTATO (distinto de ConversationTagsEditor, que edita as
 * tags da conversa) — aberto pelo botão "Tag" do painel do Inbox. */
export function ContactTagsEditor({ contactId, orgId, tags }: Props) {
  const t = useT();
  const [draft, setDraft] = useState("");
  // Issue #2718 — tom escolhido ANTES do "+": a etiqueta nasce colorida.
  const [cor, setCor] = useState<string | null>(null);
  const mutation = useUpdateContact(contactId);
  const { definirCor } = useDefinirCorDaEtiqueta();
  const { data: vocabulary } = useContactTagVocabulary(orgId);
  // A cor de quem JÁ está no contato vem do MESMO mapa que o chip usa (#2771):
  // uma leitura só, sem pergunta por tag, e o gatilho abre já com o tom atual
  // marcado — abrir a paleta de uma etiqueta colorida como se ela não tivesse
  // cor faria "Confirmar" apagar o que estava lá.
  const cores = useCoresDasEtiquetas();
  // #2789 — a sugestão escolhida, enquanto o diálogo está aberto. `null` = fechado.
  // `corInicial` é o tom que o diálogo MOSTROU ao abrir: confirmar compara com
  // ele, não com o mapa ao vivo, que pode chegar depois e não foi visto.
  const [sugestao, setSugestao] = useState<{ tag: string; corInicial: string | null } | null>(null);
  const { activeOrg } = useAuth();
  // A mesma régua do SeletorDeCorDaEtiqueta: POST /api/v1/tags/vocabulario exige
  // manager + MFA, então para quem a rota recusaria o clique continua DIRETO —
  // a tela não oferece o que a escrita recusa (#2718).
  const podeDefinirCor =
    !!activeOrg && ROLE_RANK[activeOrg.role] >= ROLE_RANK.manager;

  function apply(next: string[]) {
    mutation.mutate({ tags: next });
  }

  /** Grava a etiqueta com o tom escolhido. Devolve a tag gravada, ou `null` se recusada (duplicada/cheia). */
  function criar(raw: string, escolhida: string | null): string | null {
    const tag = normalizarTag(raw);
    if (!tag || tags.some((v) => normalizarTag(v) === tag) || tags.length >= 20)
      return null;
    apply([...tags, tag]);
    // A cor é VOCABULÁRIO, não da linha (#2718): chamada independente do
    // attach — a SQL faz append do verbete, e falhar aqui não desfaz a tag.
    if (escolhida) void definirCor(tag, escolhida);
    return tag;
  }

  /** Caminho DIGITADO: consome o tom escolhido no gatilho 🎨 e limpa o rascunho. */
  function add(raw: string) {
    if (criar(raw, cor)) {
      setDraft("");
      setCor(null);
    }
  }

  function remove(tag: string) {
    apply(tags.filter((v) => v !== tag));
  }

  // Sem sugestão cada operador digitava a sua variação da mesma tag (#852).
  // A comparação é entre formas NORMALIZADAS: um contato que já tem "VIP"
  // (gravado antes, pelo diálogo de contato, que não normaliza) recebia o chip
  // "+ vip" e ficava com as duas — a duplicação que a sugestão veio impedir.
  // E o chip MOSTRA a forma normalizada, não a que a fonte mandou: o rótulo
  // precisa ser o que o clique grava mesmo que a lista chegue crua (a rota a
  // normaliza hoje, mas a fonte está marcada para trocar).
  const jaTem = new Set(tags.map(normalizarTag));
  const suggestions = [...new Set((vocabulary ?? []).map(normalizarTag))]
    .filter((v) => v && !jaTem.has(v))
    .slice(0, 8);

  return (
    <div className="mt-2 space-y-2 rounded-md border border-border p-2">
      <div className="flex flex-wrap gap-1">
        {tags.length > 0 ? (
          tags.map((tag) => (
            <Fragment key={tag}>
              <ChipDeEtiqueta tag={tag} className="h-5 gap-1 px-1.5 text-[10px]">
                <button
                  type="button"
                  onClick={() => remove(tag)}
                  disabled={mutation.isPending}
                  aria-label={`${t("Remover tag")} ${tag}`}
                  className="rounded-sm hover:text-destructive"
                >
                  <X size={10} weight="bold" aria-hidden />
                </button>
              </ChipDeEtiqueta>
              {/* #2771 — a MESMA paleta da criação, ao lado de quem já está no
                  contato. Sem rota nova e sem reimplementation: o gatilho chama
                  o `definir_cor` que a rota já aceita, e o hook já invalida o
                  mapa — o chip repinta na hora, sem F5. Para `agent` o seletor
                  devolve `null`, como na #2718: a rota exigiria manager + MFA. */}
              <SeletorDeCorDaEtiqueta
                cor={cores[chaveDaEtiqueta(tag)] ?? null}
                onChange={(tom) => void definirCor(tag, tom)}
                tag={tag}
                rotulo={`${t("Cor da etiqueta")} ${tag}`}
                disabled={mutation.isPending}
              />
            </Fragment>
          ))
        ) : (
          <span className="text-xs text-muted-foreground">{t("Sem tags no contato.")}</span>
        )}
      </div>

      <div className="flex gap-1">
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add(draft);
            }
          }}
          placeholder={t("Nova tag…")}
          maxLength={TAMANHO_MAXIMO_DA_TAG}
          disabled={mutation.isPending || tags.length >= 20}
          className="h-7 text-xs"
          aria-label={t("Adicionar tag ao contato")}
        />
        <SeletorDeCorDaEtiqueta
          cor={cor}
          onChange={setCor}
          tag={draft.trim() || undefined}
          disabled={mutation.isPending || tags.length >= 20}
        />
        <Button
          size="sm"
          variant="outline"
          className="h-7 px-2"
          onClick={() => add(draft)}
          disabled={mutation.isPending || !draft.trim() || tags.length >= 20}
          aria-label={t("Adicionar tag")}
        >
          <Plus size={12} weight="regular" aria-hidden />
        </Button>
      </div>

      {suggestions.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {suggestions.map((tag) => (
            <button
              key={tag}
              type="button"
              // #2789 — passa pela caixa de diálogo para escolher a cor antes de
              // enviar; sem permissão o clique continua direto (a rota recusaria).
              onClick={() =>
                podeDefinirCor
                  ? setSugestao({ tag, corInicial: cores[chaveDaEtiqueta(tag)] ?? null })
                  : add(tag)
              }
              disabled={mutation.isPending || tags.length >= 20}
              className="inline-flex items-center gap-1 rounded-full border border-dashed border-border px-2 py-0.5 text-[10px] text-muted-foreground hover:border-solid hover:text-foreground disabled:opacity-50"
            >
              <PontoDaEtiqueta tag={tag} />
              + {tag}
            </button>
          ))}
        </div>
      )}

      {/* Montado só com a sugestão escolhida: cada abertura nasce com o tom do
          vocabulário pré-marcado, sem estado herdado da abertura anterior. */}
      {sugestao ? (
        <DialogoDeNovaEtiqueta
          tag={sugestao.tag}
          corInicial={sugestao.corInicial}
          onFechar={() => setSugestao(null)}
          onConfirmar={(tom) => {
            // No diálogo, `null` é "Sem cor" escolhido de propósito: a cor do
            // vocabulário só é regravada quando a escolha difere da que foi mostrada.
            const gravada = criar(sugestao.tag, null);
            if (gravada && tom !== sugestao.corInicial) void definirCor(gravada, tom);
            setSugestao(null);
          }}
          disabled={mutation.isPending}
        />
      ) : null}
    </div>
  );
}
