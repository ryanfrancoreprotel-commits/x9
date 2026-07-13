# N8N — Consolidação idempotente da daily (Camada 2)

Este guia descreve o que o workflow do N8N precisa fazer para **juntar pedaços da mesma
daily numa única task do ClickUp**, em vez de criar registros picotados.

A extensão (v8.0+) já foi corrigida para **não picotar na origem** (carência + retomada de
sessão — ver `background.js`). Esta camada no N8N é a **rede de segurança**: cobre o caso raro
em que a carência de 2 min expira antes do líder voltar e, mesmo assim, chegam 2 POSTs da
mesma reunião.

> Contexto atual: **só o líder grava** cada daily. Por isso **não** há dedup entre vários
> gravadores nem corrida de POSTs simultâneos — a lógica abaixo é a versão simples.

## Webhook

`POST https://n8n.reprotel.com.br/webhook/reprotel-daily-audit`

## Payload novo (o que a extensão manda agora)

```jsonc
{
  "schemaVersion": 2,
  "auditKey": "abc-defg-hij|2026-07-13",   // ← CHAVE de idempotência (meetingId|YYYY-MM-DD)
  "meetingId": "abc-defg-hij",
  "meetTitle": "Daily | Conteúdo",
  "team": "Conteúdo",
  "listId": "901326679617",                 // lista do ClickUp do time (detectada pelo título)
  "currentUser": "Danilo Souza",
  "participants": ["Danilo Souza", "Ana", "Rai"],
  "date": "13/07/2026",
  "startTime": "09:58",
  "endTime": "10:07",
  "duration": "9min",
  "meetingType": "daily",
  "lineCount": 42,
  "hasTranscript": true,
  "sequenceNumber": 1,                       // nº do POST desta reunião (normalmente 1)
  "isFinal": true,
  "deliveryId": null,                        // null no envio normal; id ESTÁVEL nos reenvios do outbox
  "timestamp": "2026-07-13T13:07:12Z",
  "transcript": "Ana: bom dia pessoal\nRai: bom dia...",  // texto pronto (compatível com o fluxo antigo)
  "lines": [                                 // estruturado, com hash por fala (p/ dedup no merge)
    { "speaker": "Ana", "text": "bom dia pessoal", "hash": "a1b2c3d4" },
    { "speaker": "Rai", "text": "bom dia...",       "hash": "e5f6a7b8" }
  ]
}
```

Campos **novos** em relação ao fluxo antigo: `schemaVersion`, `auditKey`, `sequenceNumber`,
`isFinal`, `lines[]`. O resto é retrocompatível — se preferir, o fluxo antigo continua
funcionando só com `transcript`; a consolidação abaixo é o upgrade.

## Lógica do workflow (CRIAR vs. ANEXAR)

A regra é simples: **existe task com esse `auditKey`? Não → cria. Sim → mescla.**

```
ENTRADA: payload do webhook

1. auditKey := payload.auditKey            (se vier vazio, derive de meetTitle + date)

2. BUSCAR no ClickUp uma task da lista `listId` cujo custom field "audit_key" == auditKey
   (ClickUp API: Get Tasks filtrando por custom field)

3a. NÃO existe → CRIAR task
    - name = `${meetTitle} — ${date}`         (ex: "Daily | Conteúdo — 13/07/2026")
    - list = listId
    - custom field "audit_key" = auditKey     ← âncora da idempotência (crie esse campo na lista)
    - descrição/corpo = payload.transcript
    - guardar o conjunto de hashes das lines (p/ dedup futuro) — ver nota abaixo

3b. EXISTE → ANEXAR (merge, sem sobrescrever)
    - Carregar os hashes já vistos dessa task
    - novasFalas = lines onde hash NÃO está no conjunto visto
    - se novasFalas vazio → nada a acrescentar (POST repetido/retry) → responder 200 e sair
    - senão:
        - acrescentar novasFalas ao corpo (ordem por chegada) OU reconstruir o corpo
          a partir do conjunto completo de falas dedupadas (idempotente)
        - atualizar hashes vistos += novasFalas.hash
        - agregar: participants = união; endTime = mais recente; duration recalculada
```

### Onde guardar os "hashes vistos"

- **Opção A (recomendada):** numa tabela chave-valor no Postgres/Supabase que o N8N já acessa,
  keyed por `auditKey`. Mais confiável que custom field.
- **Opção B (sem banco):** num custom field JSON na própria task do ClickUp.

Como só há 1 gravador, na prática o merge quase nunca dispara — mas ele garante que
"carência expirou e o líder voltou depois" vire **1 task**, não 2.

## Idempotência de reenvio (outbox) — `deliveryId`

A extensão v9.0 tem um **outbox**: se o POST falhar por rede, o payload é guardado e
**reenviado sozinho** depois. Isso cria um segundo tipo de duplicata, diferente do picote:
**o MESMO envio pode chegar 2x** (ex.: o service worker morre entre o N8N responder `200` e
a extensão remover o item do outbox → no próximo boot ela reenvia o mesmo payload).

Pra isso, cada item de outbox leva um **`deliveryId` estável** (o mesmo em todos os reenvios
daquele item). Regra no N8N:

- Se `deliveryId` **não for null** e você já processou esse `deliveryId` antes → **ignore** (é reenvio).
- No envio normal (caminho feliz), `deliveryId` vem `null` → processe normal.

Ou seja, o N8N precisa de **duas** chaves:
- `auditKey` → junta **pedaços diferentes** da mesma daily (o picote).
- `deliveryId` → descarta **o mesmo pedaço chegando 2x** (o reenvio).

## Itens "mortos" (`outbox:dead:*`)

Se um item ficar **3 dias** sem conseguir enviar (N8N fora por muito tempo), a extensão
**não apaga** — move pra uma chave `outbox:dead:*` no `chrome.storage.local` da máquina do
líder e mostra um badge **ERR** vermelho. O suporte pode inspecionar e **repostar manualmente**
o payload no webhook. Nada de transcrição some em silêncio.

## Passo a passo de setup

1. Na lista de cada time no ClickUp, criar o custom field **`audit_key`** (texto).
2. No workflow do webhook, inserir os nós: dedup-por-`deliveryId` → buscar-por-`audit_key` → IF existe → (create | append).
3. Testar com 2 POSTs de mesmo `auditKey` (ver `README.md` → verificação, teste 5): vira **uma** task, falas mescladas, sem linha repetida.
4. Testar com 2 POSTs de mesmo `deliveryId` (não-null): o 2º deve ser **ignorado**.
