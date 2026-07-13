// ============================================================
// Reprotel Daily Audit — Content Script v10.0 (Legendas)
// ------------------------------------------------------------
// Liga as legendas ao vivo do Google Meet e captura o TEXTO de
// todos os participantes (com os nomes de quem fala). Sem áudio,
// sem offscreen, sem tabCapture. Ao parar, envia o transcript ao N8N.
// ============================================================

const TEAMS = [
  { keywords: ['cs', 'onboard'],                   matchAll: true,  team: 'CS Onboard',  listId: '901326577901' },
  { keywords: ['atendimento'],                      matchAll: false, team: 'Atendimento', listId: '901319425135' },
  { keywords: ['email'],                            matchAll: false, team: 'Email MKT',   listId: '901314467929' },
  { keywords: ['web'],                              matchAll: false, team: 'Web',         listId: '901315139843' },
  { keywords: ['design'],                           matchAll: false, team: 'Design',      listId: '901314310844' },
  { keywords: ['copy'],                             matchAll: false, team: 'Copy',        listId: '901314436724' },
  { keywords: ['conteúdo', 'conteudo', 'content'],  matchAll: false, team: 'Conteúdo',   listId: '901326679617' },
  { keywords: ['ads'],                              matchAll: false, team: 'Ads',         listId: '901315117592' },
  { keywords: ['cs'],                               matchAll: false, team: 'CS',          listId: '901315445687' },
];

let isRecording         = false;
let banner              = null;
let stopMonitorInterval = null;
let autoStarted         = false;
let autoStartPoll       = null;

// Legendas
let capPoll          = null;
let capCheckTimer    = null;
let capEnableRetry   = null;
let capObserver      = null;
let lastSyncTs       = 0;
let blockText     = new Map();  // elemento → { speaker, text } (estado atual da fala)
let transcript    = [];          // falas finalizadas { speaker, text }
let committedKeys = new Set();
let participantsSeen = new Set(); // nomes vistos durante a call (acumulado)
let selfNameCache    = '';        // nome do líder (cacheado enquanto na call)

// ── Monitor de saúde da captura ("captura silenciosamente quebrada") ──
// Se o Google trocar os seletores do Meet, a extensão pode ficar com o selo REC
// gravando ZERO sem ninguém perceber. Este monitor compara o crescimento do
// transcript ao longo do tempo com o estado das legendas e alerta o líder no banner.
let capHealthTimer   = null;      // interval do check contínuo
let lastGrowthTs     = 0;         // timestamp da última fala nova (sinal "captura viva")
let lastLineCount    = 0;         // último transcript.length observado pelo monitor
let captureStalled   = false;     // estado atual do alerta (alterna o banner, evita log repetido)

// STALL_MS: janela de silêncio antes de gritar por QUEBRA INEQUÍVOCA de seletor
// (container/botão da legenda sumiram). Aqui 3.5min é seguro: se o seletor sumiu, sumiu.
const STALL_MS           = 3.5 * 60 * 1000;
// NOGROWTH_STALL_MS: janela SÓ pro caso "zero crescimento" (legenda ligada mas sem fala
// nova). Silêncio numa daily real (alguém compartilhando tela, rodada terminada) NÃO é
// quebra — por isso a janela é bem maior que a de quebra de seletor, pra não dar falso
// alarme numa pausa legítima. Só vira alerta se, além do silêncio longo, houver com quem
// falar na call (getParticipants().length > 1).
const NOGROWTH_STALL_MS  = 9 * 60 * 1000;
const HEALTH_INTERVAL_MS = 30 * 1000;   // frequência do check contínuo

// Continuidade da sessão (sair e voltar = mesma reunião, não uma nova)
let currentMeetingKey = '';       // meetingId|YYYY-MM-DD, congelada durante a call
let persistTimer      = null;     // debounce da persistência em storage.local
let leaveSignaled     = false;    // já avisei o background que saí (evita spam de CONTENT_LEAVE)
let leaving           = false;    // trava síncrona: o interval async não reentra em requestLeave
let helloSent         = false;    // já anunciei presença (CONTENT_HELLO) nesta carga do content

// ── Leitura dos metadados ─────────────────────────────────────

// Escapa metacaracteres de regex numa keyword antes de montar o RegExp.
// Defensivo: as keywords atuais são só letras (cs, web, ads…), mas se um dia
// entrar algo com ponto/parêntese/etc, isso evita quebrar o RegExp.
function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Casa a keyword como PALAVRA INTEIRA (não substring). Usa lookaround Unicode:
// o negative-lookbehind (?<![\p{L}\p{N}]) exige que o caractere ANTES da kw NÃO
// seja letra/número; o negative-lookahead (?![\p{L}\p{N}]) exige o mesmo DEPOIS.
// Por que não usar \b? O \b do JS é ASCII: ele trata ç/ú/õ como fronteira de
// palavra, então "preçoconteudo" casaria "conteudo" por engano. Com \p{L}\p{N}
// (flag u), acentos contam como parte da palavra e essa fronteira falsa some.
// A flag i mantém o case-insensitive (o texto já vem em lower, mas fica redundante seguro).
function hasWord(text, kw) {
  const re = new RegExp('(?<![\\p{L}\\p{N}])' + escapeRegex(kw) + '(?![\\p{L}\\p{N}])', 'iu');
  return re.test(text);
}

function detectTeam(title) {
  const lower = title.toLowerCase();
  for (const entry of TEAMS) {
    // Palavra inteira em vez de substring: "Docs review" não vira mais CS,
    // "Webinar" não vira Web, "roadmap" não vira Ads. A prioridade (ordem do
    // TEAMS) e a regra matchAll de "CS Onboard" continuam intactas.
    const matched = entry.matchAll
      ? entry.keywords.every(kw => hasWord(lower, kw))
      : entry.keywords.some(kw => hasWord(lower, kw));
    if (matched) return entry;
  }
  return null;
}

function getMeetTitle() {
  // [data-meeting-title] funciona em algumas telas; in-call costuma ser null.
  const dom = document.querySelector('[data-meeting-title]')?.textContent?.trim();
  if (dom) return dom;
  // Fonte confiável: o título da aba — "Meet: Daily | Conteudo" ou "... - Google Meet".
  return document.title
    .replace(/^Meet[:\s-]+/i, '')
    .replace(/\s*-\s*Google Meet\s*$/i, '')
    .trim();
}

function getMeetingId() {
  const match = location.pathname.match(/\/([a-z]+-[a-z]+-[a-z]+)/);
  return match ? match[1] : location.pathname.split('/').pop() || '';
}

// Data local YYYY-MM-DD (fuso da máquina) — isola a ocorrência do dia da daily recorrente.
function localDateStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Chave de continuidade da reunião. Congela na 1ª chamada (não muda à meia-noite durante a call).
// O background é a fonte da verdade: ao (re)iniciar, ele reenvia a key e sobrescreve esta.
function meetingKey() {
  if (!currentMeetingKey) currentMeetingKey = getMeetingId() + '|' + localDateStr();
  return currentMeetingKey;
}

// Coleta os nomes dos tiles visíveis AGORA e acumula (pessoas entram/saem/scroll).
function snapshotParticipantTiles() {
  document.querySelectorAll('[data-participant-id]').forEach(t => {
    let name = '';
    // 1) botão/elemento "Mais opções para {nome}" dentro do tile
    const cand = [...t.querySelectorAll('[aria-label]')]
      .find(e => /mais op[çc][õo]es para/i.test(e.getAttribute('aria-label') || ''));
    const m = cand?.getAttribute('aria-label')?.match(/mais op[çc][õo]es para\s+(.+)$/i);
    if (m) name = m[1].trim();
    // 2) fallback: elemento com classe exatamente "notranslate" (o nome do tile)
    if (!name) {
      const nt = [...t.querySelectorAll('.notranslate')]
        .find(e => typeof e.className === 'string' && e.className.trim() === 'notranslate' && (e.innerText || '').trim());
      if (nt) name = nt.innerText.trim();
    }
    if (name && name.length > 1 && !/^voc[eê]$/i.test(name)) participantsSeen.add(name);
  });
}

// Participantes = todos vistos nos tiles + todos que falaram (transcript).
function getParticipants() {
  snapshotParticipantTiles();
  const self = getCurrentUser();
  const all = new Set(participantsSeen);
  for (const l of transcript) {
    let sp = l.speaker;
    if (sp && self && /^voc[eê]$/i.test(sp)) sp = self;
    if (sp) all.add(sp);
  }
  return [...all];
}

function getCurrentUser() {
  let name = '';
  // 1) atributos diretos (funcionam em algumas telas).
  for (const s of ['[data-self-name]', '.awLEm']) {
    const t = document.querySelector(s)?.textContent?.trim();
    if (t && !/^voc[eê]$/i.test(t)) { name = t; break; }
  }
  // 2) in-call: o botão "Mais opções para {nome}" carrega o nome do líder.
  if (!name) {
    for (const b of document.querySelectorAll('button[aria-label]')) {
      const m = (b.getAttribute('aria-label') || '')
        .match(/(?:mais op[çc][õo]es para|more options for)\s+(.+)$/i);
      if (m && m[1].trim()) { name = m[1].trim(); break; }
    }
  }
  if (name) selfNameCache = name;  // guarda enquanto está na call
  return name || selfNameCache;     // usa o cache se já saiu da call (stop)
}

function collectMetadata() {
  const title = getMeetTitle();
  const team  = detectTeam(title);
  return {
    meetTitle:    title,
    meetingId:    getMeetingId(),
    meetingKey:   meetingKey(),
    currentUser:  getCurrentUser(),
    participants: getParticipants(),
    team:         team?.team   || '',
    listId:       team?.listId || '',
    meetingType:  title.toLowerCase().includes('treinamento') ? 'treinamento' : 'daily',
  };
}

// ── Banner UI ─────────────────────────────────────────────────

function showBanner(text, type = 'recording') {
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'reprotel-audit-banner';
    Object.assign(banner.style, {
      position:      'fixed',
      top:           '16px',
      left:          '50%',
      transform:     'translateX(-50%)',
      zIndex:        '2147483647',
      padding:       '9px 20px',
      borderRadius:  '24px',
      fontFamily:    '"Google Sans", Arial, sans-serif',
      fontSize:      '13px',
      fontWeight:    '600',
      boxShadow:     '0 4px 24px rgba(0,0,0,0.5)',
      userSelect:    'none',
      pointerEvents: 'none',
      whiteSpace:    'nowrap',
    });
    document.body.appendChild(banner);
  }
  const styles = {
    recording: { background: 'linear-gradient(135deg,#E02B20,#B71C1C)', color: '#fff' },
    warning:   { background: '#f59e0b', color: '#000' },
    success:   { background: '#22c55e', color: '#fff' },
  };
  Object.assign(banner.style, styles[type] || styles.recording);
  banner.textContent = text;
  banner.style.display = 'block';
}

function hideBanner() {
  if (banner) banner.style.display = 'none';
}

// ── Legendas do Meet ──────────────────────────────────────────

function captionsButton() {
  return document.querySelector('button[jsname="RrG0hf"]')
    || [...document.querySelectorAll('button[aria-label], [role="button"][aria-label]')]
         .find(b => /legenda|caption|subtitle/i.test(b.getAttribute('aria-label') || ''))
    || null;
}

// As legendas do Meet NÃO usam aria-pressed; o estado vem do texto do aria-label:
// "Ativar legendas" = desligadas | "Desativar legendas" = ligadas.
function captionsOn() {
  if (findCapContainer()) return true;
  const b = captionsButton();
  if (!b) return false;
  return /desativar|turn off|disable|ocultar/i.test(b.getAttribute('aria-label') || '');
}

function enableCaptions() {
  const b = captionsButton();
  if (!b) return false;
  if (captionsOn()) return true;
  if (/ativar|turn on|enable|mostrar/i.test(b.getAttribute('aria-label') || '')) {
    try { b.click(); console.log('[Reprotel] Liguei as legendas.'); } catch {}
  }
  return true;
}

function findCapContainer() {
  const sels = [
    '.a4cQT',
    'div[jsname="dsyhDe"]',
    '[role="region"][aria-label*="legenda" i]',
    '[role="region"][aria-label*="caption" i]',
  ];
  for (const s of sels) {
    const el = document.querySelector(s);
    if (el) return el;
  }
  return null;
}

function readCaptionLines() {
  const c = findCapContainer();
  if (!c) return [];

  // SÓ blocos de legenda reais (.nMcdL). Sem fallback p/ c.children — era ele
  // que pegava os controles de config da legenda (language, font, settings...).
  const out = [];
  for (const b of c.querySelectorAll('.nMcdL')) {
    const spEl = b.querySelector('.NWpY1d, .zs7s8d, .KcIKyf');
    const txEl = b.querySelector('.bh44bd, .iTTPOb, .VbkSUe, [jsname="tgaKEf"]');
    let speaker = (spEl?.innerText || '').trim();
    let text    = (txEl?.innerText || '').trim();

    // Fallback de texto SÓ dentro de um bloco de legenda real (não pega lixo).
    if (!text) {
      const full = (b.innerText || '').trim();
      if (full) {
        text = (speaker && full.startsWith(speaker)) ? full.slice(speaker.length).trim() : full;
      }
    }
    if (text) out.push({ el: b, speaker, text });
  }
  return out;
}

function commitLine(val) {
  if (!val || !val.text) return;
  const key = ((val.speaker || '') + '|' + val.text).toLowerCase();
  if (committedKeys.has(key)) return;
  committedKeys.add(key);
  transcript.push({ speaker: val.speaker, text: val.text });
  // Marca "a captura está viva": toda vez que uma fala nova é commitada, renova
  // o relógio de frescor que o checkCaptureHealth() lê pra decidir se travou.
  lastGrowthTs = Date.now();
  console.log('[Reprotel] fala:', (val.speaker ? val.speaker + ': ' : '') + val.text);
  if (isRecording) schedulePersist();
}

// Disparado pelo MutationObserver — limita a no máximo ~4x/s.
function scheduleSync() {
  const now = Date.now();
  if (now - lastSyncTs < 250) return;
  lastSyncTs = now;
  syncCaptions();
}

function syncCaptions() {
  snapshotParticipantTiles(); // acumula quem está visível ao longo da call
  getCurrentUser();           // mantém o nome do líder em cache
  const lines = readCaptionLines();
  const seen = new Set();
  for (const { el, speaker, text } of lines) {
    seen.add(el);
    blockText.set(el, { speaker, text }); // mantém sempre a versão mais recente da fala
  }
  // Falas que saíram da tela já estão finalizadas → commita.
  for (const [el, val] of [...blockText]) {
    if (!seen.has(el) && !document.contains(el)) {
      commitLine(val);
      blockText.delete(el);
    }
  }
  if (isRecording) {
    // Se o monitor detectou que a captura travou, mostra o alerta em vez do "recording".
    // Precisa passar por aqui (via flag captureStalled) porque o capPoll roda a cada
    // 700ms e sobrescreveria qualquer showBanner de aviso solto.
    if (captureStalled) {
      showBanner('⚠️ Reprotel — parei de capturar. Ligue as legendas (CC / tecla "c") ou avise o suporte.', 'warning');
    } else {
      showBanner('🔴 Reprotel — Transcrevendo a auditoria…', 'recording');
    }
  }
}

// Monitor contínuo de saúde da captura (roda a cada HEALTH_INTERVAL_MS enquanto grava).
// É READ-ONLY sobre o DOM: não commita, não persiste, não toca em carência/envio/sequence.
// Só decide se a captura travou e alterna o estado captureStalled (banner + telemetria).
function checkCaptureHealth() {
  // Fora de call ou sem gravar → não alerta (evita ruído na carência com o líder fora).
  if (!isRecording || !isInCall()) return;

  const now       = Date.now();
  const container = findCapContainer();
  const on        = captionsOn();
  const button    = captionsButton();

  // Rede extra: se o transcript cresceu desde o último check (caso commitLine mude
  // de forma no futuro), renova o frescor por conta própria.
  if (transcript.length > lastLineCount) lastGrowthTs = now;
  lastLineCount = transcript.length;

  // Alguma fala em andamento na tela AGORA também conta como sinal de vida
  // (evita falso-positivo em monólogo longo que ainda não saiu da tela pra commitar).
  let liveText = false;
  for (const [, val] of blockText) { if (val && val.text) { liveText = true; break; } }

  // Caso 1 — quebra de seletor: o botão diz que a legenda está LIGADA, mas o
  // container de legenda sumiu (e/ou o próprio botão sumiu) há mais de STALL_MS.
  const containerGone = on && !container && (now - lastGrowthTs > STALL_MS);
  const buttonGone    = !button && !container && (now - lastGrowthTs > STALL_MS);

  // Caso 2 — zero crescimento: legenda ligada, mas o transcript não cresce E não
  // há fala em andamento em blockText há mais de NOGROWTH_STALL_MS. Se a legenda estiver
  // DESLIGADA (on === false), NÃO é quebra: é opção do usuário (o capEnableRetry religa),
  // então não dispara aqui.
  // Anti-falso-positivo (daily silenciosa): silêncio só vira alerta se (1) passou a janela
  // MAIOR (NOGROWTH_STALL_MS, não os 3.5min da quebra de seletor) E (2) há mais de 1
  // participante na call — se o líder está sozinho, silêncio é esperado, não é captura quebrada.
  const someoneToTalk = getParticipants().length > 1;
  const noGrowth = on && !liveText && someoneToTalk && (now - lastGrowthTs > NOGROWTH_STALL_MS);

  const stalled = containerGone || buttonGone || noGrowth;

  if (stalled) {
    if (!captureStalled) {
      captureStalled = true;
      console.warn('[Reprotel] Captura parece travada (sem falas novas há', Math.round((now - lastGrowthTs) / 1000), 's). Verifique as legendas do Meet.');
      // Best-effort: pede pro background marcar o badge com "!". Não bloqueia nada.
      chrome.runtime.sendMessage({ type: 'RECORDING_STALLED', meetingKey: meetingKey() }).catch(() => {});
    }
  } else if (captureStalled) {
    // Voltou a capturar → limpa o alerta (o syncCaptions restaura o banner "recording").
    captureStalled = false;
    console.log('[Reprotel] Captura recuperada — voltando ao normal.');
    chrome.runtime.sendMessage({ type: 'RECORDING_OK', meetingKey: meetingKey() }).catch(() => {});
  }
}

function finalizeCaptions() {
  for (const [, val] of blockText) commitLine(val);
  blockText.clear();
}

// Resolve o "Você" do Meet para o nome real do líder.
function resolveSpeaker(speaker, self) {
  if (speaker && self) {
    const low = speaker.trim().toLowerCase();
    if (low === 'você' || low === 'voce' || low === 'you') return self;
  }
  return speaker || '';
}

function buildTranscriptText() {
  const self = getCurrentUser(); // nome real do líder (o Meet rotula como "Você")
  return transcript.map(l => {
    const sp = resolveSpeaker(l.speaker, self);
    return sp ? `${sp}: ${l.text}` : l.text;
  }).join('\n');
}

// Hash curto (FNV-1a) de uma fala normalizada — chave de dedup pro N8N mesclar pedaços.
function normText(s) { return (s || '').toLowerCase().replace(/\s+/g, ' ').trim(); }
function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}
function lineHash(speaker, text) { return fnv1a(normText(speaker) + '|' + normText(text)); }

// Falas estruturadas com hash (speaker já resolvido, nunca "Você") pro merge dedupado no N8N.
function buildLines() {
  const self = getCurrentUser();
  return transcript.map(l => {
    const sp = resolveSpeaker(l.speaker, self);
    return { speaker: sp, text: l.text, hash: lineHash(sp, l.text) };
  });
}

// ── Persistência da sessão (sobrevive a reload / sair e voltar) ────

function storageKey() { return 'meet:' + meetingKey(); }

// Salva o transcript no chrome.storage.local sob a meetingKey. drain=true drena as falas
// em andamento (só no LEAVE/pagehide, onde não haverá continuação da mesma legenda).
async function persistTranscript(drain = false) {
  if (drain) finalizeCaptions();
  try {
    await chrome.storage.local.set({
      [storageKey()]: {
        transcript,
        text:             buildTranscriptText(),   // fallback do background se a aba fechar
        lines:            buildLines(),            // fallback com hash p/ o merge no N8N
        committedKeys:    [...committedKeys],
        participantsSeen: [...participantsSeen],
        selfNameCache,
        updatedAt: Date.now(),
      },
    });
  } catch { /* contexto invalidado / storage indisponível */ }
}

// Debounce: escreve no máximo ~1x/1.5s durante a captura, pro storage ficar quase sempre atual
// (quanto menor, menos falas o fallback perde se a aba fechar de repente).
function schedulePersist() {
  if (persistTimer) return;
  persistTimer = setTimeout(() => { persistTimer = null; persistTranscript(false); }, 1500);
}

// Recarrega o transcript salvo e MESCLA no estado de memória (dedup por committedKeys).
async function restoreTranscript() {
  let saved;
  try {
    const obj = await chrome.storage.local.get(storageKey());
    saved = obj[storageKey()];
  } catch { return false; }
  if (!saved) return false;

  const memLines = transcript;                       // falas que já estavam em memória (cenário SPA)
  transcript    = (saved.transcript || []).slice();  // histórico salvo primeiro (preserva ordem)
  committedKeys = new Set(saved.committedKeys || []);
  for (const l of memLines) {                        // acrescenta as de memória que não estejam no salvo
    const k = ((l.speaker || '') + '|' + l.text).toLowerCase();
    if (!committedKeys.has(k)) { transcript.push(l); committedKeys.add(k); }
  }
  (saved.participantsSeen || []).forEach(p => participantsSeen.add(p));
  if (saved.selfNameCache && !selfNameCache) selfNameCache = saved.selfNameCache;
  console.log('[Reprotel] Sessão retomada:', transcript.length, 'falas restauradas.');
  return true;
}

function startCaptions(opts = {}) {
  if (!opts.keepState) {
    transcript = [];
    committedKeys.clear();
    participantsSeen.clear();
  }
  blockText.clear();  // o Map referencia elementos DOM; sempre recomeça vazio

  enableCaptions();

  // Mantém as legendas SEMPRE ligadas durante a auditoria: se o usuário (ou o
  // próprio Meet) desligar, a extensão religa em ~1.5s. Não dá pra desabilitar o
  // botão do Meet, mas dá pra reativar continuamente — então na prática o líder
  // não consegue manter a legenda desligada enquanto a auditoria roda.
  if (capEnableRetry) clearInterval(capEnableRetry);
  capEnableRetry = setInterval(() => {
    if (isRecording && !captionsOn()) enableCaptions();
  }, 1500);

  if (capPoll) clearInterval(capPoll);
  capPoll = setInterval(syncCaptions, 700);

  // MutationObserver: continua capturando mesmo com a aba em SEGUNDO PLANO.
  // (O Chrome estrangula setInterval em abas inativas; observers de DOM, não.)
  if (capObserver) capObserver.disconnect();
  capObserver = new MutationObserver(scheduleSync);
  capObserver.observe(document.body, { childList: true, subtree: true, characterData: true });

  // Se em 8s não apareceu nenhuma legenda, avisa pra ligar manualmente.
  if (capCheckTimer) clearTimeout(capCheckTimer);
  capCheckTimer = setTimeout(() => {
    if (isRecording && !findCapContainer() && transcript.length === 0) {
      showBanner('⚠️ Reprotel — Ligue as legendas (CC / tecla "c") pra transcrever.', 'warning');
    }
  }, 8000);

  // Baseline do monitor de saúde ao (re)começar a captura: zera o alerta e marca
  // o frescor agora, pra uma sessão retomada não herdar um stall antigo nem gritar
  // de cara mesmo com o transcript já cheio.
  lastGrowthTs   = Date.now();
  lastLineCount  = transcript.length;
  captureStalled = false;
  // Timer contínuo de saúde (o capCheckTimer de 8s acima é só o aviso de arranque).
  if (capHealthTimer) clearInterval(capHealthTimer);
  capHealthTimer = setInterval(checkCaptureHealth, HEALTH_INTERVAL_MS);

  return true;
}

function stopCaptions() {
  if (capPoll) { clearInterval(capPoll); capPoll = null; }
  if (capCheckTimer) { clearTimeout(capCheckTimer); capCheckTimer = null; }
  if (capEnableRetry) { clearInterval(capEnableRetry); capEnableRetry = null; }
  if (capObserver) { capObserver.disconnect(); capObserver = null; }
  if (persistTimer) { clearTimeout(persistTimer); persistTimer = null; }
  // Para o monitor de saúde e zera o alerta, pra não deixar o banner de warning
  // grudado se depois começar outra sessão na mesma aba.
  if (capHealthTimer) { clearInterval(capHealthTimer); capHealthTimer = null; }
  captureStalled = false;
  finalizeCaptions();
  const text = buildTranscriptText();
  console.log('[Reprotel] Transcrição final:', transcript.length, 'falas,', text.length, 'caracteres');
  return { transcript: text, lineCount: transcript.length, lines: buildLines() };
}

// (Re)inicia a captura. resume=true → retoma a sessão salva (sair e voltar / reload da aba).
async function beginCapture({ resume, meetingKeyFromBg }) {
  if (meetingKeyFromBg) currentMeetingKey = meetingKeyFromBg;
  isRecording   = true;
  leaveSignaled = false;
  // Restaura do storage SÓ quando a memória está vazia (reload da aba). No resume da MESMA
  // aba a memória é a fonte da verdade — restaurar reordenaria as falas.
  const restored = resume && transcript.length === 0 ? await restoreTranscript() : false;
  // resume nunca zera a memória (retomar = continuar); só START novo limpa.
  startCaptions({ keepState: resume || restored });
  // Ao (re)começar, força o banner "recording" JÁ (startCaptions zerou captureStalled), sem
  // esperar o próximo tick do capHealthTimer/capPoll. Cobre o reingresso via AUTO_START quando
  // o badge/banner tinham ficado em "!" na sessão anterior — não deixa o alerta grudado.
  showBanner('🔴 Reprotel — Transcrevendo a auditoria…', 'recording');
  // E reafirma pro background que a captura está OK (badge volta pra REC se estava em "!").
  // O badgeIfActive do background ignora se não houver sessão ativa, então é seguro/idempotente.
  chrome.runtime.sendMessage({ type: 'RECORDING_OK', meetingKey: meetingKey() }).catch(() => {});
  setupAutoStop();
}

// ── Auto-stop (detecta o fim da reunião) ──────────────────────

function setupAutoStop() {
  if (stopMonitorInterval) return;

  const leaveSelectors = [
    '[aria-label*="Sair da chamada"]',
    '[aria-label*="Leave call"]',
    '[aria-label*="Encerrar chamada"]',
    'button[jsname="CQylAd"]',
  ];

  const attached = new Set();

  stopMonitorInterval = setInterval(async () => {
    if (!isRecording) return;
    const inCall = isInCall();

    // Saiu da call (o botão de sair sumiu) → abre a carência no background (ack-based).
    if (!inCall) { requestLeave('left-call'); return; }

    // Voltou pra call na MESMA aba durante a carência → pede pra retomar.
    // Só zera leaveSignaled quando o background CONFIRMA (se o AUTO_START se perder, retenta).
    if (leaveSignaled) {
      try {
        const res = await chrome.runtime.sendMessage({ type: 'AUTO_START', meetingKey: meetingKey() });
        if (res && res.ok) leaveSignaled = false;
      } catch { /* SW indisponível; tenta no próximo tick */ }
    }

    // Liga listeners no botão "Sair" pra reagir ao clique um pouco antes do poll.
    leaveSelectors.forEach(sel => {
      document.querySelectorAll(sel).forEach(btn => {
        if (!attached.has(btn)) {
          attached.add(btn);
          btn.addEventListener('click', () => requestLeave('leave-click'), { once: true });
        }
      });
    });
  }, 2000);
}

function clearMonitor() {
  if (stopMonitorInterval) {
    clearInterval(stopMonitorInterval);
    stopMonitorInterval = null;
  }
}

// Saída detectada → NÃO finaliza na hora. Persiste e avisa o background pra abrir a carência.
// isRecording continua true: se a call religar nesta aba, o capPoll segue capturando.
// Ack-based: só marca leaveSignaled quando o background CONFIRMA — se a mensagem se perder
// (SW dormindo), o próximo tick reenvia. Nunca zera otimista.
async function requestLeave(reason) {
  if (!isRecording || leaveSignaled || leaving) return;
  leaving = true;  // trava síncrona (setada antes de qualquer await): o interval async não reentra
  try {
    // NÃO drena as falas em andamento aqui: pode ser só um flicker e a legenda continuar —
    // drenar parciais fragmentaria a fala. O drain fica no pagehide (aba morrendo) e no STOP.
    await persistTranscript(false);
    const res = await chrome.runtime.sendMessage({ type: 'CONTENT_LEAVE', reason, meetingKey: meetingKey() });
    if (res && res.ok) leaveSignaled = true;
  } catch { /* SW indisponível; tenta de novo no próximo tick */ }
  finally { leaving = false; }
}

// ── Auto-start: inicia sozinho ao entrar numa Daily ───────────

// "Entrou na call" = o botão "Sair da chamada" existe (jsname CQylAd).
function isInCall() {
  return !!(document.querySelector('button[jsname="CQylAd"]')
    || [...document.querySelectorAll('button[aria-label]')]
         .find(b => /sair da chamada|leave call|encerrar chamada/i.test(b.getAttribute('aria-label') || '')));
}

function tryAutoStart() {
  if (!isInCall()) { autoStarted = false; return; } // saiu/lobby → destrava pra re-detectar reentrada
  if (autoStarted || isRecording) return;
  const title = getMeetTitle().toLowerCase();
  if (!(title.includes('daily') || title.includes('treinamento'))) return; // só dailies/treinamentos
  autoStarted = true;
  console.log('[Reprotel] Entrou na daily — iniciando auto-transcrição.');
  chrome.runtime.sendMessage({ type: 'AUTO_START', meetingKey: meetingKey() }).catch(() => {});
}

// Anuncia presença ao background assim que entra na call. Se o background já estava gravando
// (ex.: reload da aba), ele responde com RESUME_TRANSCRIPTION e o transcript é restaurado.
// Ack-based: só marca helloSent quando o background CONFIRMA — se o SW estava dormindo e a
// mensagem se perdeu, o próximo tick reenvia (evita estado "zumbi").
async function announcePresence() {
  if (helloSent || !isInCall()) return;
  try {
    const res = await chrome.runtime.sendMessage({ type: 'CONTENT_HELLO', meetingKey: meetingKey() });
    if (res && res.ok) helloSent = true;
  } catch { /* SW indisponível; tenta no próximo tick */ }
}

// ── Listener de mensagens ─────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.type) {
    case 'GET_METADATA':
      sendResponse(collectMetadata());
      return true;

    case 'PING_INCALL':                 // background pergunta a verdade antes de finalizar
      sendResponse({ inCall: isInCall() });
      return true;

    case 'START_TRANSCRIPTION':
      beginCapture({ resume: false, meetingKeyFromBg: message.meetingKey });
      sendResponse({ ok: true });
      return true;

    case 'RESUME_TRANSCRIPTION':
      beginCapture({ resume: true, meetingKeyFromBg: message.meetingKey });
      sendResponse({ ok: true });
      return true;

    case 'STOP_TRANSCRIPTION': {
      const result = stopCaptions();
      isRecording       = false;
      leaveSignaled     = false;
      autoStarted       = false;
      helloSent         = false;
      currentMeetingKey = '';
      clearMonitor();
      sendResponse(result);
      return true;
    }

    case 'DUMP_CAPTIONS': {
      // Diagnóstico: devolve o HTML do container de legendas (pra ajustar seletores).
      const c = findCapContainer();
      sendResponse({ found: !!c, html: c ? c.outerHTML.slice(0, 4000) : '' });
      return true;
    }

    case 'BANNER':
      showBanner(message.text, message.bannerType || 'recording');
      if (message.autoHideMs) setTimeout(hideBanner, message.autoHideMs);
      return false;
  }
});

// ── Init ──────────────────────────────────────────────────────

// Vigia a entrada na call pra iniciar a transcrição automaticamente e anunciar presença
// (o background retoma a sessão se já estava gravando antes de um reload da aba).
autoStartPoll = setInterval(() => { announcePresence(); tryAutoStart(); }, 2000);
setTimeout(() => { announcePresence(); tryAutoStart(); }, 1500);

// Antes da aba morrer (reload/fechar): grava o que der no storage.local (best-effort).
window.addEventListener('pagehide', () => {
  if (isRecording) { try { finalizeCaptions(); } catch {} persistTranscript(true); }
});
