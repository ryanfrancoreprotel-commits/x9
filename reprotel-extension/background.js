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

// Lock síncrono contra POST duplicado (dois gatilhos concorrentes: alarme + clique + tab-close).
// Setado ANTES de qualquer await — é isso que garante "1 POST por reunião".
let finalizing = false;

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
         : '❌ Reprotel — Falha ao enviar. Verifique o N8N.',
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

// ── Limpeza de rascunhos/contadores antigos (>24h) no boot do service worker ──
chrome.runtime.onStartup.addListener(cleanupOldDrafts);
chrome.runtime.onInstalled.addListener(cleanupOldDrafts);
async function cleanupOldDrafts() {
  try {
    const all    = await chrome.storage.local.get(null);
    const cutoff  = Date.now() - 24 * 60 * 60 * 1000;
    const stale   = Object.keys(all).filter(k => k.startsWith('meet:') && (all[k]?.updatedAt || 0) < cutoff);
    // Remove também os seq: cuja reunião (meet:) já sumiu — não têm timestamp próprio.
    const liveMeet = new Set(Object.keys(all).filter(k => k.startsWith('meet:')).map(k => k.slice(5)));
    const orphanSeq = Object.keys(all).filter(k => k.startsWith('seq:') && !liveMeet.has(k.slice(4)));
    const toRemove = [...stale, ...orphanSeq];
    if (toRemove.length) await chrome.storage.local.remove(toRemove);
  } catch { /* sem storage / sem permissão */ }
}

// ── Envio ao N8N ──────────────────────────────────────────────
async function sendToN8N(data) {
  const m = data.metadata;
  const payload = {
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
    isFinal:        data.isFinal,
    reason:         data.reason,           // manual | grace-expired | tab-closed (diagnóstico)
    timestamp:     new Date().toISOString(),
    transcript:    data.transcript || '',
    lines:         data.lines || [],       // [{speaker, text, hash}] p/ merge dedupado no N8N
  };

  try {
    const response = await fetch(N8N_WEBHOOK_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload),
    });
    if (response.ok) {
      console.log('[Reprotel] Enviado para o N8N com sucesso! (seq', data.sequenceNumber, ')');
      return true;
    }
    console.error('[Reprotel] Erro N8N:', response.status, await response.text());
    return false;
  } catch (err) {
    console.error('[Reprotel] Falha na conexão:', err);
    return false;
  }
}
