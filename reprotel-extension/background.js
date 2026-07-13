// ============================================================
// Reprotel Daily Audit — Background Service Worker v11.0
// ------------------------------------------------------------
// 1 clique no ícone = iniciar/parar a auditoria.
// Sair e voltar da reunião NÃO recomeça: há uma CARÊNCIA (grace) e a
// transcrição é RETOMADA (mesma sessão). Só ao fim real o TEXTO da
// daily + metadados vão ao N8N — uma vez só.
// Sem áudio, sem offscreen, sem tabCapture.
// ============================================================

const N8N_WEBHOOK_URL    = 'https://n8n.reprotel.com.br/webhook/reprotel-daily-audit';
const GRACE_MINUTES      = 2;              // carência antes de finalizar (mín. prático do chrome.alarms ~1 min)
const GRACE_ALARM        = 'reprotel-grace';
const MAX_SESSION_HOURS  = 4;              // backstop absoluto: teto de uma sessão sem enviar
const MAX_ALARM          = 'reprotel-maxsession';

// ── Outbox durável: se o POST ao N8N falhar (rede instável), o payload NÃO se perde. ──
// Ele é salvo em chrome.storage.local e re-tentado sozinho: no boot do SW, num alarme
// periódico (~5min) e logo após cada envio bem-sucedido. Só sai do outbox no sucesso do POST.
// Idempotência (contrato explícito com o N8N): cada payload leva um `deliveryId` ESTÁVEL
// por item de outbox. O N8N DEVE deduplicar por deliveryId — não por hash das lines (que
// muda entre pedaços). Isso cobre a janela em que o SW morre entre o POST 200 e o remove(k):
// o item volta no próximo boot e é reenviado com o MESMO deliveryId, então o N8N ignora a 2ª.
const OUTBOX_PREFIX      = 'outbox:';
const OUTBOX_DEAD_PREFIX = 'outbox:dead:';  // itens que estouraram a idade e viraram morto p/ inspeção manual
const RETRY_ALARM        = 'reprotel-outbox-retry';
const RETRY_MINUTES      = 5;              // cadência base do reenvio (periodicInMinutes do alarme)
const OUTBOX_MAX_ITEMS   = 50;            // teto de itens no outbox (FIFO: o mais velho cai primeiro)
const OUTBOX_MAX_AGE_MS  = 3 * 24 * 60 * 60 * 1000;  // desiste de um item após 3 dias tentando
const BACKOFF_CAP_MS     = 60 * 60 * 1000;           // teto do backoff exponencial (60min)

// Lock síncrono contra POST duplicado (dois gatilhos concorrentes: alarme + clique + tab-close).
// Setado ANTES de qualquer await — é isso que garante "1 POST por reunião".
let finalizing = false;

// Lock assíncrono próprio do drain do outbox (NÃO reutiliza o finalizing, que é do
// finalizeAndSend): evita dois drainOutbox concorrentes martelando o N8N em paralelo.
let draining = false;

// Contador em memória só pra desempatar dois enqueues no MESMO milissegundo (Date.now()
// igual). Some quando o SW dorme, mas a chave já leva Date.now(); isto é só o desempate.
let outboxTick = 0;

// ── Estado persistido (sobrevive ao service worker ser descarregado) ──
async function getState() {
  const { recordingState } = await chrome.storage.session.get('recordingState');
  return recordingState || null;
}
async function setState(state) {
  await chrome.storage.session.set({ recordingState: state });
}
async function clearState() {
  await chrome.storage.session.remove('recordingState');
}

// ── Selo "REC" no ícone ───────────────────────────────────────
async function setBadge(tabId, on) {
  try {
    await chrome.action.setBadgeText({ text: on ? 'REC' : '', tabId });
    if (on) await chrome.action.setBadgeBackgroundColor({ color: '#E02B20', tabId });
  } catch { /* aba pode ter fechado */ }
}

// ── Banner no Meet (feedback) ─────────────────────────────────
function notifyTab(tabId, text, bannerType, autoHideMs) {
  chrome.tabs.sendMessage(tabId, { type: 'BANNER', text, bannerType, autoHideMs }).catch(() => {});
}

// Executa uma ação de badge SÓ se existir sessão ATIVA (não em 'grace') desta tab/meetingKey.
// Guard contra mensagens de saúde tardias (RECORDING_OK/STALLED) que chegam DEPOIS da
// finalização (clearState) ou já na carência, e ressuscitariam o selo numa sessão encerrada.
async function badgeIfActive(tabId, meetingKey, fn) {
  if (!tabId) return;
  const state = await getState();
  if (!state || state.tabId !== tabId || state.status !== 'active') return;
  if (meetingKey && state.meetingKey && state.meetingKey !== meetingKey) return;
  fn(tabId);
}

// Pergunta ao content a VERDADE: o líder está na call agora? (aba morta = não).
async function tabInCall(tabId) {
  try {
    const r = await chrome.tabs.sendMessage(tabId, { type: 'PING_INCALL' });
    return !!(r && r.inCall);
  } catch { return false; }
}

// ── Clique no ícone = alternar. Parar = fim explícito IMEDIATO (sem carência). ──
chrome.action.onClicked.addListener(async (tab) => {
  const state = await getState();
  if (state) {
    await finalizeAndSend(state, { reason: 'manual' });
  } else {
    await startRecording(tab);
  }
});

// ── Mensagens do content script (todas respondem {ok} para o ack) ─────
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.type) {
    case 'CONTENT_LEAVE':                    // saiu da call → abre a carência
      onLeaveDetected(message.meetingKey)
        .then(() => sendResponse({ ok: true })).catch(() => sendResponse({ ok: false }));
      return true;
    case 'AUTO_START':                       // entrou na daily (ou reingressou) → inicia/retoma
      if (!sender.tab) { sendResponse({ ok: false }); return true; }
      startRecording(sender.tab, message.meetingKey)
        .then(() => sendResponse({ ok: true })).catch(() => sendResponse({ ok: false }));
      return true;
    case 'CONTENT_HELLO':                    // content novo (reload) se apresenta → reconcilia
      if (!sender.tab) { sendResponse({ ok: false }); return true; }
      reconcile(sender.tab, message.meetingKey)
        .then(() => sendResponse({ ok: true })).catch(() => sendResponse({ ok: false }));
      return true;
    case 'RECORDING_STALLED':                // content detectou captura travada → badge "!"
      // Só mexe no badge se ESTA aba ainda tem sessão ATIVA. Depois da finalização (clearState)
      // uma mensagem tardia de saúde vira no-op, não regrava selo numa sessão já encerrada.
      badgeIfActive(sender.tab?.id, message.meetingKey, tabId => {
        chrome.action.setBadgeText({ text: '!', tabId }).catch(() => {});
        chrome.action.setBadgeBackgroundColor({ color: '#F59E0B', tabId }).catch(() => {});
      }).finally(() => sendResponse({ ok: true }));
      return true;
    case 'RECORDING_OK':                     // captura recuperou → volta o selo REC normal
      // Mesmo guard: não ressuscita o "REC" se finalizeAndSend já limpou o badge (getState()===null).
      badgeIfActive(sender.tab?.id, message.meetingKey, tabId => setBadge(tabId, true))
        .finally(() => sendResponse({ ok: true }));
      return true;
  }
});

// ── Iniciar / retomar ─────────────────────────────────────────
async function startRecording(tab, meetingKeyHint) {
  if (!tab?.id) return;

  if (!(tab.url || '').includes('meet.google.com')) {
    await chrome.action.setBadgeText({ text: '!', tabId: tab.id }).catch(() => {});
    setTimeout(() => chrome.action.setBadgeText({ text: '', tabId: tab.id }).catch(() => {}), 2500);
    return;
  }

  const state = await getState();
  if (state) {
    // Já existe sessão dessa reunião → SEMPRE retoma (cancela carência se houver, religa a
    // captura). Fazer isto independente de active/grace fecha a race de ordem de mensagens.
    if (!meetingKeyHint || state.meetingKey === meetingKeyHint) {
      await resumeSession(state, tab.id);
    }
    return;
  }

  // Sessão nova.
  const metadata   = await chrome.tabs.sendMessage(tab.id, { type: 'GET_METADATA' }).catch(() => ({}));
  const meetingKey = metadata.meetingKey || meetingKeyHint || '';

  let res;
  try {
    res = await chrome.tabs.sendMessage(tab.id, { type: 'START_TRANSCRIPTION', meetingKey });
  } catch (err) {
    // Normal quando a aba do Meet não foi recarregada após atualizar a extensão
    // (o content script ainda não está injetado nela). Basta dar F5 na aba.
    console.warn('[Reprotel] Aba do Meet sem content script — dê F5 na aba.');
    return;
  }
  if (!res?.ok) {
    notifyTab(tab.id, '❌ Reprotel — não consegui iniciar a transcrição. Recarregue o Meet.', 'warning', 6000);
    return;
  }

  await setState({ tabId: tab.id, meetingKey, metadata, startTime: new Date().toISOString(), status: 'active' });
  await setBadge(tab.id, true);
  // Backstop: garante que a sessão será finalizada em no máximo MAX_SESSION_HOURS, aconteça o
  // que acontecer (persiste através de reloads/descarga do SW).
  await chrome.alarms.create(MAX_ALARM, { delayInMinutes: MAX_SESSION_HOURS * 60 });
}

// Retoma a sessão: cancela o alarme da carência e religa a captura no content.
async function resumeSession(state, tabId) {
  await chrome.alarms.clear(GRACE_ALARM);
  await setState({ ...state, tabId, status: 'active' });
  await chrome.tabs.sendMessage(tabId, { type: 'RESUME_TRANSCRIPTION', meetingKey: state.meetingKey }).catch(() => {});
  await setBadge(tabId, true);
  console.log('[Reprotel] Sessão retomada (carência cancelada).');
}

// ── Content novo (reload da aba) se apresenta → corrige o estado "zumbi" ──
async function reconcile(tab, meetingKey) {
  const state = await getState();
  if (!state) return;                                                    // nada gravando
  if (meetingKey && state.meetingKey && state.meetingKey !== meetingKey) return; // outra reunião
  // Estava gravando e o content é novo (perdeu a memória no reload) → religa e restaura.
  await resumeSession(state, tab.id);
  console.log('[Reprotel] Reconciliado após reload da aba.');
}

// ── Saída detectada → abre a carência (NÃO envia ainda) ───────
async function onLeaveDetected(meetingKey) {
  const state = await getState();
  if (!state || state.status === 'grace') return;
  if (meetingKey && state.meetingKey && state.meetingKey !== meetingKey) return;
  // SEMPRE arma a carência aqui (sem checar tabInCall): se foi só um flicker de reconexão,
  // o reingresso (AUTO_START) cancela o alarme logo em seguida. Assim o ACK {ok:true} é honesto
  // — significa mesmo "carência armada", e o content não desiste de avisar por engano.
  await setState({ ...state, status: 'grace' });
  await chrome.alarms.create(GRACE_ALARM, { delayInMinutes: GRACE_MINUTES });
  notifyTab(state.tabId, '⏸️ Reprotel — saída detectada, aguardando reingresso…', 'warning', 5000);
  console.log('[Reprotel] Carência iniciada (', GRACE_MINUTES, 'min).');
}

// ── Alarme da carência expira → verifica a verdade → finaliza ou retoma ──
chrome.alarms.onAlarm.addListener(async (alarm) => {
  // Backstop absoluto: nenhuma sessão fica pendurada sem enviar além de MAX_SESSION_HOURS.
  // Cobre QUALQUER estado travado (re-arma infinita, active órfão, isInCall falso-positivo).
  if (alarm.name === MAX_ALARM) {
    const state = await getState();
    if (state) {
      console.warn('[Reprotel] Backstop de', MAX_SESSION_HOURS, 'h — forçando envio.');
      await finalizeAndSend(state, { reason: 'max-duration' });
    }
    return;
  }
  // Alarme periódico do outbox: tenta reenviar o que ficou pendente. Independente
  // do GRACE/MAX (retorna antes do 'if (alarm.name !== GRACE_ALARM) return;').
  if (alarm.name === RETRY_ALARM) {
    await drainOutbox();
    return;
  }
  if (alarm.name !== GRACE_ALARM) return;
  const state = await getState();
  if (!state || state.status !== 'grace') return;   // reingressou no meio-tempo: cancelado
  // Rede de segurança: se o líder ainda está na call (ex.: o AUTO_START de reingresso não
  // chegou), NÃO finaliza e NÃO retoma aqui — só RE-ARMA a carência pra checar de novo. Assim
  // nunca fica um estado "active" órfão; o content segue reenviando AUTO_START e retoma de fato.
  if (await tabInCall(state.tabId)) {
    await chrome.alarms.create(GRACE_ALARM, { delayInMinutes: GRACE_MINUTES });
    console.log('[Reprotel] Ainda na call no fim da carência — re-armando.');
    return;
  }
  await finalizeAndSend(state, { reason: 'grace-expired' });
});

// ── Aba do Meet fechada durante a gravação → finaliza (usa o rascunho salvo) ──
chrome.tabs.onRemoved.addListener(async (tabId) => {
  const state = await getState();
  if (!state || state.tabId !== tabId) return;
  // Fechar a aba ≠ acabar a reunião (pode reabrir). Abre a carência: se reabrir e reentrar na
  // call em GRACE_MINUTES, a sessão é retomada (restaurada do storage); senão, o alarme finaliza.
  await onLeaveDetected(state.meetingKey);
});

// ── Finalizar + enviar (idempotente: 1 POST por reunião) ──────
async function finalizeAndSend(state, { reason }) {
  if (finalizing) return;                   // lock síncrono: evita POST duplicado concorrente
  finalizing = true;
  try {
    await clearState();
    await chrome.alarms.clear(GRACE_ALARM);
    await chrome.alarms.clear(MAX_ALARM);

    notifyTab(state.tabId, '⏳ Reprotel — Finalizando e enviando…', 'recording');

    // 1) Tenta coletar do content (aba viva).
    let result = { transcript: '', lineCount: 0, lines: [] };
    try {
      const r = await chrome.tabs.sendMessage(state.tabId, { type: 'STOP_TRANSCRIPTION' });
      if (r) result = r;
    } catch (err) {
      console.warn('[Reprotel] Content indisponível no fim; usando o transcript salvo.');
    }

    // 2) Fallback: se o content não devolveu nada (aba fechou), lê do storage.local.
    if (!result.transcript) {
      const saved = await readSaved(state.meetingKey);
      if (saved) {
        const lines = saved.lines || [];
        result = {
          transcript: saved.text || '',
          lines,
          lineCount:  lines.length || (saved.transcript || []).length,
        };
      }
    }

    await setBadge(state.tabId, false);

    // Metadados frescos (o líder pode já ter saído → cai pro estado salvo).
    let metadata = state.metadata || {};
    try {
      const fresh = await chrome.tabs.sendMessage(state.tabId, { type: 'GET_METADATA' });
      if (fresh) metadata = fresh;
    } catch { /* usa o do estado */ }

    const startDate = new Date(state.startTime);
    const endDate   = new Date();
    const seq       = await bumpSequence(state.meetingKey);

    const ok = await sendToN8N({
      metadata: {
        ...metadata,
        date:          startDate.toLocaleDateString('pt-BR'),
        startTime:     startDate.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }),
        endTime:       endDate.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }),
        duration:      `${Math.round((endDate - startDate) / 60000)}min`,
        lineCount:     result.lineCount,
        hasTranscript: !!result.transcript,
      },
      transcript:     result.transcript,
      lines:          result.lines || [],
      auditKey:       state.meetingKey,
      sequenceNumber: seq,
      isFinal:        true,
      reason,
    });

    // Limpa o rascunho e o contador dessa reunião.
    await chrome.storage.local.remove(['meet:' + state.meetingKey, 'seq:' + state.meetingKey]).catch(() => {});

    notifyTab(
      state.tabId,
      ok ? '✅ Reprotel — Transcrição enviada!'
         : '⚠️ Reprotel — Sem conexão com o N8N; guardado, vou reenviar sozinho.',
      ok ? 'success' : 'warning',
      6000,
    );
  } finally {
    finalizing = false;
  }
}

// Lê o rascunho salvo pelo content (fallback quando a aba fechou antes do fim).
async function readSaved(meetingKey) {
  try {
    const k = 'meet:' + meetingKey;
    const obj = await chrome.storage.local.get(k);
    return obj[k] || null;
  } catch { return null; }
}

// Contador de POSTs por reunião (rastreio/idempotência no N8N).
async function bumpSequence(meetingKey) {
  const k = 'seq:' + meetingKey;
  try {
    const obj  = await chrome.storage.local.get(k);
    const next = (obj[k] || 0) + 1;
    await chrome.storage.local.set({ [k]: next });
    return next;
  } catch { return 1; }
}

// ── Boot do service worker: limpeza + retomada do outbox ──
// Limpa rascunhos/contadores antigos (>24h) E cuida do outbox: recria o alarme
// periódico de reenvio e tenta drenar uma vez (se o SW foi descarregado no meio
// de uma pendência, é aqui que a retomada volta a acontecer).
chrome.runtime.onStartup.addListener(bootTasks);
chrome.runtime.onInstalled.addListener(bootTasks);
async function bootTasks() {
  await cleanupOldDrafts();
  // NÃO cria o RETRY_ALARM aqui de forma incondicional: o drainOutbox() abaixo já cria o
  // alarme SÓ se encontrar item vivo pendente (e o limpa se o outbox estiver vazio), e o
  // enqueueOutbox o cria ao guardar um novo item. Assim, num boot com outbox vazio, o SW
  // não fica acordando à toa a cada RETRY_MINUTES.
  await drainOutbox();
}

async function cleanupOldDrafts() {
  try {
    const all    = await chrome.storage.local.get(null);
    const cutoff  = Date.now() - 24 * 60 * 60 * 1000;
    // Ancorado em 'meet:'/'seq:'. O outbox usa o prefixo 'outbox:', então NÃO é
    // tocado aqui — ele tem seu próprio ciclo de descarte por idade (OUTBOX_MAX_AGE_MS)
    // e por teto (OUTBOX_MAX_ITEMS) dentro do drainOutbox()/trimOutbox().
    const stale   = Object.keys(all).filter(k => k.startsWith('meet:') && (all[k]?.updatedAt || 0) < cutoff);
    // Remove também os seq: cuja reunião (meet:) já sumiu — não têm timestamp próprio.
    const liveMeet = new Set(Object.keys(all).filter(k => k.startsWith('meet:')).map(k => k.slice(5)));
    const orphanSeq = Object.keys(all).filter(k => k.startsWith('seq:') && !liveMeet.has(k.slice(4)));
    const toRemove = [...stale, ...orphanSeq];
    if (toRemove.length) await chrome.storage.local.remove(toRemove);
  } catch { /* sem storage / sem permissão */ }
}

// ── Envio ao N8N ──────────────────────────────────────────────

// Monta o objeto payload a partir dos dados da finalização. É uma cópia completa
// e autossuficiente (não depende de meet:/seq: sobreviverem), pra poder ser
// guardada no outbox e reenviada mais tarde sem perder nada.
function buildPayload(data) {
  const m = data.metadata;
  return {
    schemaVersion: 2,
    auditKey:      data.auditKey,          // chave de idempotência p/ o N8N juntar pedaços (meetingId|YYYY-MM-DD)
    meetTitle:     m.meetTitle,
    meetingId:     m.meetingId,
    currentUser:   m.currentUser,
    participants:  m.participants,
    team:          m.team,
    listId:        m.listId,
    date:          m.date,
    startTime:     m.startTime,
    endTime:       m.endTime,
    duration:      m.duration,
    meetingType:   m.meetingType,
    lineCount:     m.lineCount,
    hasTranscript: m.hasTranscript,
    sequenceNumber: data.sequenceNumber,   // nº do POST desta reunião (normalmente 1)
    deliveryId:     null,                   // preenchido só se cair no outbox — chave de idempotência do N8N
    isFinal:        data.isFinal,
    reason:         data.reason,           // manual | grace-expired | tab-closed (diagnóstico)
    timestamp:     new Date().toISOString(),
    transcript:    data.transcript || '',
    lines:         data.lines || [],       // [{speaker, text, hash}] p/ merge dedupado no N8N
  };
}

// Só faz o fetch e devolve boolean. SEM efeitos colaterais de storage — é usada
// tanto no envio inicial quanto no drain do outbox.
async function postToN8N(payload) {
  try {
    const response = await fetch(N8N_WEBHOOK_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload),
    });
    if (response.ok) {
      console.log('[Reprotel] Enviado para o N8N com sucesso! (seq', payload.sequenceNumber, ')');
      return true;
    }
    console.error('[Reprotel] Erro N8N:', response.status, await response.text());
    return false;
  } catch (err) {
    console.error('[Reprotel] Falha na conexão:', err);
    return false;
  }
}

// Ponto de entrada do envio. Monta o payload, tenta postar; se falhar, enfileira no
// outbox (nunca perde a transcrição) e retorna false; se der certo, dispara um drain
// best-effort (pra empurrar pendências antigas na carona) e retorna true.
async function sendToN8N(data) {
  const payload = buildPayload(data);
  const ok = await postToN8N(payload);
  if (!ok) {
    await enqueueOutbox(payload);
    return false;
  }
  // Sucesso: aproveita pra tentar drenar pendências acumuladas (sem await bloqueante).
  drainOutbox();
  return true;
}

// ── Outbox durável ────────────────────────────────────────────

// Backoff exponencial com teto (em ms). Como o alarme periódico é de RETRY_MINUTES,
// o backoff só serve pra PULAR tentativas dentro do mesmo ciclo/rajada; a cadência
// base do reenvio continua sendo o alarme de ~5min.
function backoff(attempts) {
  return Math.min(RETRY_MINUTES * 60000 * Math.pow(2, Math.max(0, attempts - 1)), BACKOFF_CAP_MS);
}

// Aplica o teto OUTBOX_MAX_ITEMS: se estourar, descarta os itens mais antigos por
// firstEnqueuedAt (FIFO) até caber. Evita o storage.local encher se o N8N ficar dias fora.
async function trimOutbox() {
  try {
    const all   = await chrome.storage.local.get(null);
    // Só itens VIVOS do outbox (exclui os 'outbox:dead:*', que são arquivo morto p/ inspeção).
    const keys  = Object.keys(all).filter(k => k.startsWith(OUTBOX_PREFIX) && !k.startsWith(OUTBOX_DEAD_PREFIX));
    if (keys.length <= OUTBOX_MAX_ITEMS) return;
    // Ordena do mais velho pro mais novo e remove o excedente do começo.
    keys.sort((a, b) => (all[a]?.firstEnqueuedAt || 0) - (all[b]?.firstEnqueuedAt || 0));
    const excess = keys.slice(0, keys.length - OUTBOX_MAX_ITEMS);
    if (excess.length) {
      await chrome.storage.local.remove(excess);
      console.warn('[Reprotel] Outbox cheio — descartei', excess.length, 'item(ns) mais antigo(s).');
    }
  } catch { /* storage indisponível: best-effort */ }
}

// Salva o payload num item de outbox. A chave leva Date.now()+tick (id monotônico
// INDEPENDENTE do contador seq:, que é apagado a cada finalização e reinicia em 1). Assim
// dois POSTs falhos da MESMA reunião no mesmo dia NUNCA colidem/se sobrescrevem — cada
// finalização vira um item distinto. O mesmo id vira o `deliveryId` gravado no payload,
// que é a chave de idempotência do N8N (estável entre reenvios do mesmo item).
async function enqueueOutbox(payload) {
  try {
    await trimOutbox(); // respeita o teto ANTES de somar mais um
    const now = Date.now();
    const deliveryId = now + '-' + (outboxTick = (outboxTick + 1) % 1e6);
    const key = OUTBOX_PREFIX + (payload.auditKey || '') + ':' + deliveryId;
    // Carimba o deliveryId no próprio payload: sobrevive à serialização e volta idêntico
    // em cada reenvio, então o N8N dedupa mesmo se o SW morrer entre o 200 e o remove(k).
    payload.deliveryId = deliveryId;
    await chrome.storage.local.set({
      [key]: { payload, attempts: 0, firstEnqueuedAt: now, lastTriedAt: now, nextTryAt: now },
    });
    // Garante o alarme periódico pra tentar de novo mesmo se o SW dormir.
    await chrome.alarms.create(RETRY_ALARM, { periodicInMinutes: RETRY_MINUTES });
    console.warn('[Reprotel] POST falhou — guardado no outbox:', key);
  } catch { /* storage indisponível: best-effort, degradar sem quebrar a finalização */ }
}

// Move um item vencido pro arquivo morto e AVISA de forma visível (não some no silêncio).
// A chave morta preserva o payload completo pra reenvio manual (basta o suporte repostar
// no N8N). Badge de erro fica grudado até a aba fechar; banner aparece se houver aba do Meet.
async function moveToDead(key, item) {
  try {
    const deadKey = OUTBOX_DEAD_PREFIX + (item.payload?.auditKey || '') + ':' + (item.payload?.deliveryId || Date.now());
    await chrome.storage.local.set({ [deadKey]: { ...item, diedAt: Date.now() } }).catch(() => {});
    await chrome.storage.local.remove(key).catch(() => {});
    console.warn('[Reprotel] Item do outbox venceu (>', OUTBOX_MAX_AGE_MS / 86400000, 'dias) — movido pra', deadKey, '(NÃO foi apagado; reenvie manual).');
    await warnDeadItem();
  } catch { /* best-effort */ }
}

// Sinaliza a perda potencial em TODAS as abas do Meet abertas: badge vermelho "ERR" +
// banner de aviso. É o alarme visível que o achado pediu (em vez de só console.warn).
async function warnDeadItem() {
  try {
    const tabs = await chrome.tabs.query({ url: 'https://meet.google.com/*' });
    for (const t of tabs) {
      if (!t.id) continue;
      chrome.action.setBadgeText({ text: 'ERR', tabId: t.id }).catch(() => {});
      chrome.action.setBadgeBackgroundColor({ color: '#DC2626', tabId: t.id }).catch(() => {});
      notifyTab(t.id, '⛔ Reprotel — uma auditoria antiga não foi enviada ao N8N (guardada localmente). Avise o suporte pra reenviar.', 'warning', 12000);
    }
  } catch { /* best-effort */ }
}

// Percorre os itens do outbox e tenta reenviar em SÉRIE (pra não martelar o N8N).
// Respeita nextTryAt (backoff) e OUTBOX_MAX_AGE_MS (desiste por idade). Sucesso remove
// a chave; falha incrementa attempts e adia o nextTryAt. Guard com o lock 'draining'.
async function drainOutbox() {
  if (draining) return;                    // já rodando: não reentra
  draining = true;
  try {
    let all;
    try { all = await chrome.storage.local.get(null); }
    catch { return; }                      // sem storage: best-effort
    // Só itens VIVOS (exclui 'outbox:dead:*', que não são reenviados).
    const keys = Object.keys(all).filter(k => k.startsWith(OUTBOX_PREFIX) && !k.startsWith(OUTBOX_DEAD_PREFIX));
    if (!keys.length) {
      // Outbox vazio: limpa o alarme periódico pra economizar wakeups do SW.
      await chrome.alarms.clear(RETRY_ALARM).catch(() => {});
      return;
    }

    const now = Date.now();
    for (const k of keys) {
      const item = all[k];
      if (!item || !item.payload) { await chrome.storage.local.remove(k).catch(() => {}); continue; }

      // Ainda no backoff: pula neste ciclo (o alarme periódico volta depois).
      if (now < (item.nextTryAt || 0)) continue;

      // Velho demais: NÃO apaga (era perda de dado silenciosa). Move pro arquivo morto
      // 'outbox:dead:*' e sinaliza visivelmente (badge de erro persistente + banner na
      // aba do Meet, se houver). Assim a transcrição fica pra inspeção/reenvio manual em
      // vez de sumir só com um console.warn que ninguém lê.
      if (now - (item.firstEnqueuedAt || now) > OUTBOX_MAX_AGE_MS) {
        await moveToDead(k, item);
        continue;
      }

      const ok = await postToN8N(item.payload);
      if (ok) {
        await chrome.storage.local.remove(k).catch(() => {});
      } else {
        // Falhou de novo: incrementa tentativas e adia conforme o backoff.
        const attempts = (item.attempts || 0) + 1;
        item.attempts    = attempts;
        item.lastTriedAt = Date.now();
        item.nextTryAt   = Date.now() + backoff(attempts);
        await chrome.storage.local.set({ [k]: item }).catch(() => {});
      }
    }

    // Sobrou item VIVO? garante o alarme. Esvaziou? limpa o alarme (economiza wakeups).
    // Os 'outbox:dead:*' NÃO contam: são arquivo morto, não geram reenvio nem wakeup.
    const after   = await chrome.storage.local.get(null).catch(() => ({}));
    const remaining = Object.keys(after).filter(x => x.startsWith(OUTBOX_PREFIX) && !x.startsWith(OUTBOX_DEAD_PREFIX));
    if (remaining.length) {
      await chrome.alarms.create(RETRY_ALARM, { periodicInMinutes: RETRY_MINUTES }).catch(() => {});
    } else {
      await chrome.alarms.clear(RETRY_ALARM).catch(() => {});
    }
  } finally {
    draining = false;
  }
}
