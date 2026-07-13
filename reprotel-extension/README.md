# Reprotel Daily Audit — Extensão Chrome

## Como instalar nos computadores dos líderes

### Passo 1 — Configurar o N8N primeiro
Antes de instalar a extensão, configure o N8N conforme o arquivo `N8N_INSTRUCOES.md`.
Você precisará da URL do webhook gerada pelo N8N.

### Passo 2 — Colocar a URL do webhook na extensão
Abra o arquivo `background.js` e substitua:
```
const N8N_WEBHOOK_URL = 'https://SEU_N8N.com/webhook/reprotel-daily-audit';
```
pela URL real do seu webhook N8N.

### Passo 3 — Instalar a extensão no Chrome
1. Abra o Chrome e acesse: `chrome://extensions/`
2. Ative o "Modo do desenvolvedor" (canto superior direito)
3. Clique em "Carregar sem compactação"
4. Selecione a pasta `reprotel-extension`
5. A extensão aparecerá na barra do Chrome

> ⚠️ **Ao ATUALIZAR a extensão:** depois de clicar em recarregar (⟳) em `chrome://extensions/`, **dê F5 na aba do Google Meet**. O content script só é atualizado quando a página recarrega — sem o F5, a versão antiga continua rodando.

### Passo 4 — Como usar (para os líderes)
1. Entre na reunião **Daily** (ou Treinamento) pelo Google Meet — o título precisa conter "Daily"/"Treinamento"
2. **Pronto, é automático:** ao entrar na call, a extensão **liga as legendas e começa a transcrever sozinha** (selo **REC** no ícone + banner "Transcrevendo… (N falas)"). Sem clicar em nada.
3. Conduza a reunião normalmente
4. Ao **sair da chamada**, encerra e envia sozinho (ou clique no ícone pra parar manualmente)
5. O **transcript** (texto da daily inteira, com os nomes) chega no N8N, que pontua e manda o score pro ClickUp

> **Auto-start:** a extensão detecta a entrada na daily e inicia automaticamente — só para reuniões com "Daily"/"Treinamento" no título. Para outras reuniões, dá pra iniciar manualmente clicando no ícone. Ela lê as **legendas ao vivo do Meet** e captura o texto de **todos** (líder + participantes, com nomes; o "Você" vira o nome real). Sem áudio.

## Mapeamento de times
A extensão detecta o time automaticamente pelo título da reunião:

| Título contém | Time detectado |
|---|---|
| "Design" | Design |
| "Copy" | Copy |
| "Conteúdo" | Conteúdo |
| "Email" | Email MKT |
| "Web" | Web |
| "Ads" | Ads |
| "CS" | CS |
| "Atendimento" | Atendimento |

## Arquivos da extensão
```
reprotel-extension/
├── manifest.json       # Configuração da extensão e permissões
├── background.js       # ← Coloque a URL do N8N aqui. Alterna iniciar/parar e envia o texto
├── content.js          # Roda no Meet: metadados, banner, auto-stop E lê as legendas
└── icon.png            # Ícone (adicione um PNG 48x48)
```

## Como a transcrição funciona (v10.0)
1. **Clique no ícone** → o `background.js` manda o `content.js` iniciar.
2. O `content.js` **liga as legendas ao vivo do Meet** (botão CC) e faz polling do DOM das legendas, capturando o texto de cada fala com o nome de quem falou.
3. O Meet rotula a sua própria fala como **"Você"** — a extensão troca pelo seu **nome real** (`getCurrentUser`).
4. Falas que somem da tela são finalizadas e commitadas (com dedup). Ao parar, o **transcript** completo + metadados vão ao webhook do N8N.

## Observações importantes
- Captura **todos** (líder + participantes), em **texto**, com nomes. Sem áudio, sem arquivos grandes.
- Depende das **legendas do Meet** estarem ligadas (a extensão tenta ligar sozinha; se não, ligue no **CC** / tecla **c**).
- Os **seletores** das legendas do Meet mudam com o tempo. Se parar de capturar, use a mensagem `DUMP_CAPTIONS` (ou faça dump do `innerHTML` do container `.a4cQT`/`[jsname="dsyhDe"]`) pra reajustar.
- Um clique no ícone alterna iniciar/parar; sair da chamada encerra sozinho.

### Campos enviados ao N8N
| Campo | Conteúdo |
|---|---|
| `transcript` | Texto da daily inteira (`Nome: fala`, um por linha) |
| `lineCount` | Número de falas capturadas |
| `hasTranscript` | Flag indicando se veio transcrição |
| `auditKey` | **Chave de continuidade** `meetingId\|YYYY-MM-DD` — junta pedaços da mesma daily |
| `sequenceNumber`, `isFinal` | Nº do POST da reunião e se é o envio final |
| `lines[]` | Falas estruturadas `{speaker, text, hash}` (hash p/ dedup no N8N) |
| `meetTitle`, `team`, `participants`, `date`, `duration`, … | Metadados da reunião |

## Sair e voltar da reunião (v8.0) — não pica mais

Antes, quando o líder saía e voltava (F5, queda de conexão, ou reingressar), a extensão
finalizava+enviava na hora e recomeçava do zero → transcrição picotada no ClickUp.

Agora há **continuidade de sessão**:

1. **Carência (grace) de 2 min:** ao detectar a saída, a extensão **não** envia na hora —
   abre uma janela de 2 min (via `chrome.alarms`, sobrevive ao service worker dormir).
2. **Reingresso dentro da carência:** retoma a **mesma** sessão (mesmo horário de início,
   mesmo transcript) — cancela o envio e continua transcrevendo.
3. **Reload da aba (F5/queda):** o transcript fica salvo em `chrome.storage.local` e é
   **restaurado** quando a aba recarrega (o content novo se reapresenta ao background).
4. **Fim real:** ninguém volta em 2 min → envia **um** POST só. Clique no ícone força o fim
   na hora, sem esperar a carência.
5. **Rede de segurança no N8N:** todo POST carrega `auditKey`; se ainda escapar um segundo
   POST da mesma daily, o N8N junta por essa chave (ver `N8N_INSTRUCOES.md`).

> A carência é a constante `GRACE_MINUTES` em `background.js` (padrão 2 min; mínimo ~1 min).

> **Backstop:** toda sessão tem um teto absoluto (`MAX_SESSION_HOURS`, padrão 4h) — se por
> qualquer motivo o estado travar, o envio é forçado nesse prazo. Nenhuma daily some.

> **Limitação conhecida:** se o líder **fecha a aba** exatamente no meio de uma fala, a última
> fala parcial pode se perder (o navegador nem sempre grava a tempo antes de matar a aba). O
> histórico até ~1,5s antes está salvo e é enviado. Reabrir a aba em até 4h retoma a sessão.

### Como testar (ponta a ponta)
Carregue a extensão (Passo 3) e entre numa call com "Daily"/"Treinamento" no título.

1. **Reload:** transcreva algumas falas, dê **F5**, reingresse, fale mais, saia de vez →
   **um** POST com as falas de antes **e** depois do F5. No console (`[Reprotel]`) deve
   aparecer "Sessão retomada" e **nenhum** envio no meio.
2. **Reingressar:** transcreva, clique "Sair da chamada", reingresse em **< 2 min** → o selo
   **REC** volta e a transcrição continua; um POST só no fim.
3. **Estado zumbi:** transcreva, dê F5 e **não** reingresse — o selo REC deve refletir
   captura real (reconciliação), não ficar fantasma.
4. **Fim real:** transcreva, saia e **não** volte → após ~2 min, um POST com `isFinal:true`.
5. **N8N idempotente:** force 2 POSTs com o mesmo `auditKey` → no ClickUp vira **uma** task
   com as falas mescladas, sem linha duplicada.
