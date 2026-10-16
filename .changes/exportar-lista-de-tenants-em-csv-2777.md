---
impacto: capacidade_nova
secao: adicionado
titulo: A lista de instalações do admin pode ser baixada em CSV, sem levar o que a anonimização apagou
---

Quem opera a plataforma não tinha como tirar o inventário das instalações que administra — faturamento, atendimento, revenda, e o pedido do titular que pergunta "quais instâncias minhas existem e desde quando". A lista já existia na tela; não saía daqui. Agora `GET /api/v1/admin/tenants/export` devolve as mesmas 11 colunas da listagem em CSV, com o mesmo guard `requirePlatformAdmin`, o mesmo `querySchema` e o MESMO leitor de dados (`app/api/v1/admin/tenants/_lista.ts`, de onde a rota de listagem também passou a ler): `?q=` e `?status=` viajam inteiros, e o arquivo devolve exatamente os `id`s que a tela devolveria com a mesma query. Envelope igual ao export de auditoria — BOM UTF-8, escape RFC 4180 e `Content-Disposition` datado.

O centro da issue é o corte: um tenant `status=redacted` sai sem `display_name`, `legal_name` nem `cnpj` originais. O worker de LGPD que anonimiza uma organização só vira o `status` — a tabela guarda os valores de antes —, então a regra mora em `_csv.ts` e vem de `lib/lgpd/cascata.ts`: o texto de identidade sai como `NOTA_REDIGIDA`, o que a anonimização já redigiu passa intacto (a regra é idempotente, como a cascata) e `cnpj` sai vazio, porque documento não tem forma redigida. `id` e `slug` ficam: sem eles o arquivo não é inventário nenhum.

Sai até 10.000 linhas (o teto do export de auditoria); passou disso, o corte acontece e o header `X-Export-Truncado: true` diz. Grava `platform.tenants_exported` na auditoria com total, se cortou e quais filtros valiam — nunca o texto da busca. `?formato` desconhecido é 422. Nenhuma mudança de banco.

Contribuição de @webtecnica (#2777).
