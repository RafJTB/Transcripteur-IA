// Assistant IA : conversation, périmètre, moteurs local et Claude.

import { Folders } from '../cloud.js';
import { LLM_MODELS } from '../config.js';
import { buildContext, buildMessages, citedRefs, isFollowUp, renderAnswer, taskOf } from '../assistant.js';
import { fmtClock, toTxt } from '../exporters.js';
import { searchMeetings } from '../insights.js';
import { $, $$, CLAUDE_ICON, ask, caps, esc, fmtMB, fmtShortDur, fold, lsGet, lsSet, relDay, toast, writeClipboard } from './core.js';
import { STAT_ICONS, actionSources, docIcon } from './dashboard.js';
import { openInClaude } from './doc.js';
import { myDocs } from './transcription.js';

// ---------- Assistant (recherche locale + Claude) ----------
const chatLog = [];
function chatAdd(role, html) {
  chatLog.push({ role, html });
  if (chatLog.length > 12) chatLog.shift();
  renderChat();
}
// ---------- Périmètre de l'assistant : toutes les réunions, un dossier ou une réunion ----------
let asstScope = (() => { try { return JSON.parse(lsGet('assistant.scope', 'null')) || { type: 'all' }; } catch { return { type: 'all' }; } })();
const FOLDER_SVG = '<svg viewBox="0 0 24 24"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>';
const ALL_SVG = '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M8 4v5"/></svg>';

/** Réunions concernées par le périmètre choisi. */
function scopeDocs(docs) {
  if (asstScope.type === 'folder') return docs.filter((d) => (asstScope.id === 'none' ? !Folders.get(d.folderId) : d.folderId === asstScope.id));
  if (asstScope.type === 'doc') return docs.filter((d) => d.id === asstScope.id);
  return docs;
}

/** Le périmètre existe-t-il encore (dossier supprimé, réunion effacée…) ? Sinon : toutes les réunions. */
async function checkScope() {
  if (asstScope.type === 'folder' && asstScope.id !== 'none' && !Folders.get(asstScope.id)) setScope({ type: 'all' }, { quiet: true });
  if (asstScope.type === 'doc' && !(await myDocs()).some((d) => d.id === asstScope.id)) setScope({ type: 'all' }, { quiet: true });
}

function renderScopeChip() {
  const chip = $('#asst-scope');
  if (!chip) return;
  const icon = asstScope.type === 'folder' ? FOLDER_SVG : asstScope.type === 'doc' ? STAT_ICONS.docs.replace('M3 7a2', 'M3 7a2') : ALL_SVG;
  chip.classList.toggle('on', asstScope.type !== 'all');
  chip.innerHTML = `${asstScope.type === 'doc' ? '<svg viewBox="0 0 24 24"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/></svg>' : icon}<span><small>Sur</small>${esc(asstScope.label || 'Toutes les réunions')}</span><svg class="chev" viewBox="0 0 24 24"><path d="m6 9 6 6 6-6"/></svg>`;
  $('#asst-scope-clear').hidden = asstScope.type === 'all';
}

export function setScope(sc, { quiet = false } = {}) {
  asstScope = sc.type === 'all' ? { type: 'all' } : sc;
  lsSet('assistant.scope', JSON.stringify(asstScope));
  conv = null;
  renderScopeChip();
  if (!quiet) {
    chatAdd('sys', asstScope.type === 'all' ? 'Je réponds maintenant sur <b>toutes tes réunions</b>.' : `Je réponds maintenant sur <b>${esc(asstScope.label)}</b>${asstScope.type === 'folder' ? ` (${asstScope.n || 0} réunion${(asstScope.n || 0) > 1 ? 's' : ''})` : ''}.`);
    $('#chat-input')?.focus();
  }
}

/** Fenêtre de choix du périmètre (dossiers et réunions, avec recherche). */
async function openScopePicker() {
  const pop = $('#scope-pop');
  if (!pop.hidden) return closeScopePicker();
  const docs = (await myDocs()).filter((d) => d.segments?.length);
  const folders = Folders.list();
  const count = (id) => docs.filter((d) => (id === 'none' ? !Folders.get(d.folderId) : d.folderId === id)).length;
  const render = (q = '') => {
    const f = [...q.trim()].map(fold).join('');
    const match = (t) => !f || [...String(t)].map(fold).join('').includes(f);
    const row = (attrs, icon, title, sub, active) => `<button type="button" class="sp-row${active ? ' active' : ''}" ${attrs}><span class="sp-ico">${icon}</span><span class="sp-txt"><b>${esc(title)}</b>${sub ? `<small>${esc(sub)}</small>` : ''}</span>${active ? '<i class="sp-on"></i>' : ''}</button>`;
    let html = '';
    if (match('Toutes les réunions')) html += row('data-scope="all"', ALL_SVG, 'Toutes les réunions', `${docs.length} réunion${docs.length > 1 ? 's' : ''}`, asstScope.type === 'all');
    const fl = folders.filter((x) => match(x.name));
    if (fl.length || (folders.length && match('Sans dossier'))) {
      html += '<p class="sp-label">Projets (dossiers)</p>';
      html += fl.map((x) => row(`data-scope="folder" data-id="${esc(x.id)}" data-label="${esc(x.name)}" data-n="${count(x.id)}"`, FOLDER_SVG, x.name, `${count(x.id)} réunion${count(x.id) > 1 ? 's' : ''}`, asstScope.type === 'folder' && asstScope.id === x.id)).join('');
      if (folders.length && match('Sans dossier') && count('none')) html += row(`data-scope="folder" data-id="none" data-label="Sans dossier" data-n="${count('none')}"`, FOLDER_SVG, 'Sans dossier', `${count('none')} réunion${count('none') > 1 ? 's' : ''}`, asstScope.type === 'folder' && asstScope.id === 'none');
    }
    const dl = docs.filter((d) => match(d.title)).slice(0, 30);
    if (dl.length) {
      html += '<p class="sp-label">Réunions</p>';
      html += dl.map((d) => { const [tone, icon] = docIcon(d.title); return row(`data-scope="doc" data-id="${esc(d.id)}" data-label="${esc(d.title)}"`, `<span class="r-ico ${tone}">${icon}</span>`, d.title, `${relDay(d.createdAt)}${d.durationS ? ` · ${fmtShortDur(d.durationS)}` : ''}${Folders.get(d.folderId) ? ` · ${Folders.get(d.folderId).name}` : ''}`, asstScope.type === 'doc' && asstScope.id === d.id); }).join('');
    }
    $('#sp-list').innerHTML = html || '<p class="sp-empty">Aucun résultat.</p>';
  };
  render();
  pop.hidden = false;
  $('#sp-search').value = '';
  $('#sp-search').oninput = (e) => render(e.target.value);
  $('#sp-search').focus();
}

function closeScopePicker() {
  const pop = $('#scope-pop');
  if (pop) pop.hidden = true;
}

export function bindScope() {
  $('#asst-scope').onclick = (e) => { e.stopPropagation(); openScopePicker(); };
  $('#asst-scope-clear').onclick = (e) => { e.stopPropagation(); closeScopePicker(); setScope({ type: 'all' }); };
  $('#sp-list').addEventListener('click', (e) => {
    const b = e.target.closest('[data-scope]');
    if (!b) return;
    closeScopePicker();
    setScope({ type: b.dataset.scope, id: b.dataset.id, label: b.dataset.label, n: Number(b.dataset.n) || undefined });
  });
  $('#sp-search').addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { closeScopePicker(); $('#chat-input').focus(); }
    if (e.key === 'Enter') { e.preventDefault(); $('#sp-list [data-scope]:not(.active)')?.click() || $('#sp-list [data-scope]')?.click(); }
  });
  document.addEventListener('pointerdown', (e) => { if (!e.target.closest('#scope-pop, #asst-scope')) closeScopePicker(); });
  // « @ » au début du champ : ouvre le choix
  $('#chat-input').addEventListener('input', (e) => {
    if (e.target.value.endsWith('@') && $('#scope-pop').hidden) { e.target.value = e.target.value.slice(0, -1); openScopePicker(); }
  });
  renderScopeChip();
  checkScope();
}

export function renderChat() {
  const box = $('#chat');
  if (!chatLog.length) {
    box.innerHTML = `<div class="chat-hello"><span class="bot-ico">${'<svg viewBox="0 0 24 24"><path d="M4 10v4M8 7v10M12 4v16M16 8v8M20 11v2"/></svg>'}</span><div><p>Pose une question sur tes réunions : je lis tes transcriptions et je te réponds en citant mes sources.</p>
      <div class="chat-sugg"><button type="button" data-q="Quelles décisions cette semaine ?">Décisions de la semaine</button><button type="button" data-q="Quelles actions restent à faire ?">Actions à faire</button><button type="button" data-q="Questionne-moi sur ces réunions">Me questionner</button></div></div></div>`;
    return;
  }
  box.innerHTML = chatLog.map((m) => m.role === 'sys' ? `<p class="msg-sys">${m.html}</p>` : `<div class="msg ${m.role}">${m.role === 'bot' ? '<span class="bot-ico"><svg viewBox="0 0 24 24"><path d="M4 10v4M8 7v10M12 4v16M16 8v8M20 11v2"/></svg></span>' : ''}<div class="bubble">${m.html}</div></div>`).join('');
  box.scrollTop = box.scrollHeight;
}

export let lastQuestion = '';
/** Conversation en cours : extraits utilisés, type de demande et échanges (remise à zéro au changement de périmètre). */
let conv = null;

// ---------- Moteurs de l'assistant ----------
const CLAUDE_SDK_URL = 'https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk@1.5.0/+esm';
const CLAUDE_MODELS = [
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5 (le plus capable)', fallbacks: true },
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5 (rapide)', fallbacks: true },
  { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5 (le plus économique)', fallbacks: false },
];
const asstEngine = () => lsGet('assistant.engine', 'auto');
const claudeKey = () => lsGet('assistant.key', '');
/**
 * Modèles locaux à essayer, dans l'ordre. Sur carte graphique : format q4f16 si elle gère la
 * demi-précision (shader-f16), sinon q4. Les échecs mémorisés sont sautés.
 */
function localCandidates() {
  const e = asstEngine();
  const gpu = caps().webgpu;
  const f16 = !!caps().f16;
  const failed = (k) => !!lsGet(`assistant.failed.${k}`, '');
  const big = { ...LLM_MODELS.large, dtype: f16 ? 'q4f16' : 'q4', sizeMB: f16 ? 1430 : 2150, key: `large-${f16 ? 'q4f16' : 'q4'}` };
  const smallGpu = { ...LLM_MODELS.small, device: 'webgpu', dtype: f16 ? 'q4f16' : 'q4', sizeMB: f16 ? 570 : 920, key: `small-gpu-${f16 ? 'q4f16' : 'q4'}`, light: true };
  const smallCpu = { ...LLM_MODELS.small, key: 'small-cpu', light: true };
  const xl = { ...LLM_MODELS.xl, key: 'xl-q4f16' };
  let list;
  if (e === 'local-xl') list = gpu && f16 ? [xl, big, smallGpu] : gpu ? [big, smallGpu] : [smallCpu];
  else if (e === 'local-large') list = gpu ? [big, smallGpu, smallCpu] : [smallCpu];
  else if (e === 'local-small') list = gpu ? [smallGpu, smallCpu] : [smallCpu];
  else list = gpu ? [big, smallGpu] : [];
  const ok = list.filter((m) => !failed(m.key));
  // Choix explicite : on retente au moins le dernier ; automatique : recherche simple si tout a échoué
  return ok.length || e === 'auto' ? ok : list.slice(-1);
}
/** Premier modèle local qui sera essayé (pour l'affichage). */
const localLlm = () => localCandidates()[0] || LLM_MODELS.small;

let llm = null;
let llmReady = null;
let llmSeq = 0;
const llmPending = new Map();
let llmIdle = null;
function llmWorker() {
  if (llm) return llm;
  llm = new Worker(new URL('../llm-worker.js', import.meta.url), { type: 'module' });
  // Le worker charge Transformers.js avant d'écouter : les messages attendent son signal « ready »
  let ready;
  llmReady = new Promise((r) => (ready = r));
  llm.onmessage = ({ data: m }) => {
    if (m.type === 'ready') return ready();
    if (m.type === 'progress') { for (const p of llmPending.values()) p.onProgress?.(m); return; }
    const p = llmPending.get(m.id);
    if (!p) return;
    if (m.type === 'token') return p.onToken?.(m.text);
    llmPending.delete(m.id);
    if (m.type === 'error') p.reject(new Error(m.message));
    else p.resolve(m);
  };
  llm.onerror = (e) => {
    for (const p of llmPending.values()) p.reject(new Error(e.message || 'Le modèle local s’est arrêté (mémoire insuffisante ?).'));
    llmPending.clear();
    llm?.terminate();
    llm = null;
    llmReady = null;
  };
  return llm;
}
function llmCall(msg, { onToken, onProgress } = {}) {
  const id = ++llmSeq;
  clearTimeout(llmIdle);
  return new Promise((resolve, reject) => {
    llmPending.set(id, { resolve, reject, onToken, onProgress });
    const w = llmWorker();
    llmReady.then(() => w.postMessage({ ...msg, id }));
  }).finally(() => {
    // Mémoire libérée après 15 min sans question
    llmIdle = setTimeout(() => { if (!llmPending.size && llm) { llm.terminate(); llm = null; llmReady = null; } }, 15 * 60 * 1000);
  });
}

export let asstBusy = false;
export let asstAbort = null;

/** Messages d'erreur du moteur local, en clair. */
function llmError(e) {
  const t = String(e?.message || e);
  if (e?.detail) return e;
  if (/bad_alloc|out of memory|OOM|memory/i.test(t)) return new Error('Mémoire insuffisante pour faire tourner ce modèle sur cet appareil.');
  if (/fetch|network|Failed to load/i.test(t)) return new Error('Téléchargement du modèle impossible (connexion, ou Hugging Face bloqué par le réseau).');
  return new Error(`Le modèle local a rencontré une erreur : ${t.slice(0, 160)}`);
}

async function answerLocal(messages, opts) {
  const tries = localCandidates();
  let lastErr = null;
  const errors = [];
  for (let k = 0; k < tries.length; k++) {
    const m = tries[k];
    try {
      const text = await answerLocalWith(m, messages, opts, k > 0);
      if (text != null && k > 0) opts.onNote?.(`${tries[0].label} n’a pas pu démarrer sur cet appareil : réponse de ${m.label}${m.light ? ' (modèle léger, réponses plus approximatives)' : ''}.`);
      return text;
    } catch (e) {
      lastErr = e;
      const raw = String(e?.message || e);
      if (llm) { llm.terminate(); llm = null; llmReady = null; }
      // Un problème de réseau n'est pas un échec du modèle : on s'arrête là, on pourra réessayer
      if (/fetch|network|Failed to load|ERR_|timeout/i.test(raw)) {
        const err = new Error(`Téléchargement de ${m.label} interrompu (connexion ?). Repose ta question pour reprendre.`);
        err.detail = `${m.repo} · ${m.device} · ${m.dtype} — ${raw.slice(0, 300)}`;
        throw err;
      }
      lsSet(`assistant.failed.${m.key}`, raw.slice(0, 300));
      errors.push(`${m.label} (${m.device}, ${m.dtype}) : ${raw.slice(0, 220)}`);
      if (k < tries.length - 1) opts.onStatus(`${m.label} n’a pas pu démarrer (${llmError(e).message.replace(/\.$/, '')}) : essai avec ${tries[k + 1].label}…`);
    }
  }
  const err = llmError(lastErr);
  err.message = `Aucun modèle local n’a pu démarrer sur cet appareil : je passe en recherche simple. Envoie-moi le détail ci-dessous, ou choisis Claude dans Paramètres → Assistant IA.`;
  err.detail = `${caps().adapter || 'Pas de carte graphique'} · f16 ${caps().f16 ? 'oui' : 'non'} · ${errors.join(' | ')}`;
  throw err;
}

async function answerLocalWith(m, messages, { onToken, onStatus, max = 450 }, consented = false) {
  const spec = { repo: m.repo, device: m.device, dtype: m.dtype };
  const { cached } = await llmCall({ type: 'cache-status', ...spec });
  if (!cached && !consented && lsGet('assistant.consent', '') !== `${m.repo}|${m.dtype}`) {
    const ok = await ask('Activer l’assistant IA ?', `L’assistant utilise un modèle de langage qui tourne sur ton appareil : ${m.label} (${fmtMB(m.sizeMB)}), téléchargé une seule fois. Tes réunions ne sont envoyées nulle part.`, `Télécharger (${fmtMB(m.sizeMB)})`);
    if (!ok) return null;
    lsSet('assistant.consent', `${m.repo}|${m.dtype}`);
  }
  onStatus(cached ? `Chargement de ${m.label} et lecture de tes réunions…` : `Téléchargement de ${m.label}…`);
  asstAbort = () => llm?.postMessage({ type: 'stop' });
  let first = true;
  const r = await llmCall({ type: 'chat', ...spec, messages, max }, {
    onProgress: (p) => onStatus(p.value >= 0.999 && p.total > 50e6 ? `${m.label} prêt : lecture de tes réunions…` : `Téléchargement de ${m.label}… ${Math.round(p.value * 100)} % (${fmtMB(p.loaded / 1e6)} / ${fmtMB(p.total / 1e6)})`),
    onToken: (t) => { if (first) { first = false; onStatus(''); } onToken(t); },
  });
  return r.text;
}

async function answerClaude(messages, { onToken, onStatus }) {
  const key = claudeKey();
  if (!key) throw new Error('Aucune clé API Claude : renseigne-la dans Paramètres → Assistant IA.');
  onStatus('Claude réfléchit…');
  const { default: Anthropic } = await import(CLAUDE_SDK_URL);
  const client = new Anthropic({ apiKey: key, dangerouslyAllowBrowser: true });
  const model = CLAUDE_MODELS.find((x) => x.id === lsGet('assistant.model', CLAUDE_MODELS[0].id)) || CLAUDE_MODELS[0];
  const [sys, ...rest] = messages;
  const params = {
    model: model.id,
    max_tokens: 16000,
    system: sys.content,
    messages: rest,
    // Réflexion moyenne : nettement plus pertinent que « low » pour relier des réunions, corriger un quiz…
    output_config: { effort: 'medium' },
    // Les extraits (dans la consigne système) et la conversation sont mis en cache : les questions suivantes coûtent ~10 fois moins
    cache_control: { type: 'ephemeral' },
  };
  // Si le modèle décline une demande, l'API la relance sur un autre modèle (activé par défaut)
  if (model.fallbacks) Object.assign(params, { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' });
  const stream = model.fallbacks ? client.beta.messages.stream(params) : client.messages.stream(params);
  asstAbort = () => stream.abort();
  let text = '';
  try {
    for await (const ev of stream) {
      if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta') {
        if (!text) onStatus('');
        text += ev.delta.text;
        onToken(ev.delta.text);
      }
    }
    const final = await stream.finalMessage();
    if (final.stop_reason === 'refusal') throw new Error('Claude a décliné cette demande.');
  } catch (e) {
    if (e instanceof Anthropic.APIUserAbortError) return text;
    if (e instanceof Anthropic.AuthenticationError) throw new Error('Clé API Claude refusée : vérifie-la dans Paramètres → Assistant IA.');
    if (e instanceof Anthropic.PermissionDeniedError) throw new Error('Cette clé API n’a pas accès à ce modèle.');
    if (e instanceof Anthropic.RateLimitError) throw new Error('Trop de demandes à Claude pour l’instant : réessaie dans une minute.');
    if (e instanceof Anthropic.APIConnectionError) throw new Error('Impossible de joindre Claude (connexion internet ?).');
    if (e instanceof Anthropic.APIError) throw new Error(`Erreur de l’API Claude (${e.status ?? '?'}) : ${e.message}`);
    throw e;
  }
  return text;
}

/** Ancienne réponse par mots-clés (moteur « Recherche simple », ou si le modèle n'est pas disponible). */
function keywordAnswer(q, sources, note = '') {
  const openOnly = /reste|à faire|a faire|en cours/i.test(q);
  if (openOnly) sources.forEach((s) => (s.items = s.items.filter((x) => !x.done)));
  const { intent, hits } = searchMeetings(q, sources, { limit: 6 });
  const task = taskOf(q);
  if (task !== 'qa' && task !== 'list') {
    if (!hits.length) hits.push(...sources.flatMap((s) => s.items.map((x) => ({ doc: s.doc, ...x }))).sort((a, b) => b.doc.createdAt - a.doc.createdAt).slice(0, 6));
    note = `<p class="chat-note">${task === 'quiz' ? 'Un quiz' : task === 'draft' ? 'Une rédaction' : 'Une synthèse'} demande un modèle de langage (Claude, ou un modèle local qui a pu démarrer). En attendant, voici les décisions et actions récentes.</p>${note}`;
  }
  const claudeBtn = `<button class="chat-claude" type="button" data-claude>${CLAUDE_ICON}Demander à Claude</button>`;
  if (!hits.length) return `<p>Je n’ai rien trouvé de net dans tes transcriptions. Essaie avec d’autres mots (un nom de projet, un lot, une personne).</p>${note}${claudeBtn}`;
  const lead = intent === 'decision' ? 'Voici les décisions trouvées' : intent === 'action' ? (openOnly ? 'Voici les actions encore à faire' : 'Voici les actions trouvées') : 'Voici les passages les plus proches';
  const li = hits.map((h) => `<li><button type="button" data-open="${esc(h.doc.id)}" data-i="${h.i}">${h.type === 'decision' ? '<i class="tag dec">Décision</i>' : h.type === 'action' ? `<i class="tag act">Action${h.who ? ` · ${esc(h.who)}` : ''}</i>` : ''}${esc(h.text.length > 150 ? h.text.slice(0, 149) + '…' : h.text)}<small>${esc(h.doc.title)} · ${relDay(h.doc.createdAt)} · ${fmtClock(h.start)}</small></button></li>`).join('');
  return `<p><svg class="ok-ico" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="m8 12.5 2.6 2.5L16 9.5"/></svg>${lead} :</p><ul class="chat-hits">${li}</ul>${note}<p class="chat-note">Recherche par mots-clés. ${claudeBtn}</p>`;
}

function setChatBusy(on) {
  asstBusy = on;
  $('#chat-form').classList.toggle('busy', on);
  $('.chat-send').setAttribute('aria-label', on ? 'Arrêter la réponse' : 'Envoyer');
  $('.chat-send').innerHTML = on ? '<svg viewBox="0 0 24 24"><rect x="7" y="7" width="10" height="10" rx="2"/></svg>' : '<svg viewBox="0 0 24 24"><path d="M4 12 20 4l-4 16-4-7z"/><path d="m12 13 8-9"/></svg>';
}

export async function askAssistant(q) {
  q = q.trim();
  if (!q || asstBusy) return;
  lastQuestion = q;
  chatAdd('me', esc(q));
  await checkScope();
  const all = (await myDocs()).filter((d) => d.status !== 'running' && d.status !== 'live' && d.segments?.length);
  if (!all.length) return chatAdd('bot', '<p>Tu n’as encore aucune transcription : enregistre une réunion et je pourrai répondre à tes questions.</p>');
  const docs = scopeDocs(all);
  if (!docs.length) return chatAdd('bot', `<p>« ${esc(asstScope.label)} » ne contient aucune transcription. Choisis un autre projet avec la pastille « Sur : … » sous la conversation.</p>`);
  const sources = actionSources(docs);
  const engine = asstEngine();
  if (engine === 'search') return chatAdd('bot', keywordAnswer(q, sources));
  if (engine === 'auto' && (!caps().webgpu || !localCandidates().length))
    return chatAdd('bot', keywordAnswer(q, sources, '<p class="chat-note">Sans carte graphique compatible, je fais une recherche dans tes réunions. Pour des réponses rédigées : Claude (clé API) ou le modèle léger, dans Paramètres → Assistant IA.</p>'));
  const claude = engine === 'claude';
  const local = !claude && localLlm();
  const scopeKey = JSON.stringify(asstScope);
  const scoped = asstScope.type !== 'all';
  const budget = claude ? 60000 : local.light ? 3000 : (local.key || '').startsWith('xl') ? 7000 : 5000;
  // Suite de la conversation (réponse à un quiz, « développe », « et pour le lot 3 ? ») : mêmes extraits
  let task = taskOf(q);
  const same = conv && conv.scopeKey === scopeKey && conv.engine === engine;
  let follow = same && isFollowUp(q, conv.task, task);
  let built = follow ? null : buildContext(q, sources, { budget, task, scoped, scopeLabel: asstScope.label });
  if (!follow && same && task === 'qa' && !built.hits && conv.task !== 'qa') { follow = true; built = null; }
  if (follow) task = conv.task === 'quiz' ? 'quiz' : task;
  const { refs, context } = built || conv;
  if (!follow) conv = { scopeKey, engine, task, refs, context, turns: [] };
  // Historique : complet pour Claude, court pour les modèles locaux (un petit modèle s'y perd)
  const messages = buildMessages(q, context, conv.turns, {
    task,
    contextInSystem: claude,
    keepRefs: true,
    maxTurns: claude ? 12 : local.light ? 1 : 3,
    maxChars: claude ? 4000 : local.light ? 400 : 900,
  });
  // Bulle de réponse mise à jour au fil de l'eau
  chatAdd('bot', '<p class="typing"><i></i><i></i><i></i></p>');
  const bubble = $$('#chat .msg.bot .bubble').pop();
  const status = document.createElement('p');
  status.className = 'chat-status';
  let text = '';
  let raf = 0;
  const paint = () => {
    raf = 0;
    bubble.innerHTML = (text ? renderAnswer(text, refs) : '<p class="typing"><i></i><i></i><i></i></p>');
    if (status.textContent) bubble.append(status);
    $('#chat').scrollTop = $('#chat').scrollHeight;
  };
  const onToken = (t) => { text += t; if (!raf) raf = requestAnimationFrame(paint); };
  const onStatus = (s) => { status.textContent = s; if (!raf) raf = requestAnimationFrame(paint); };
  let note = '';
  const onNote = (n) => { note = n; };
  setChatBusy(true);
  try {
    const max = task === 'summary' || task === 'draft' ? 800 : 500;
    const out = claude ? await answerClaude(messages, { onToken, onStatus }) : await answerLocal(messages, { onToken, onStatus, onNote, max });
    if (out == null) { bubble.innerHTML = keywordAnswer(q, sources, '<p class="chat-note">Assistant IA non activé : voici une recherche par mots-clés.</p>'); return; }
    text = out || text;
    if (!claude && localLlm().light && task !== 'qa' && task !== 'list' && !note) note = `Le modèle léger (0,6B) n’est pas assez puissant pour ${task === 'quiz' ? 'un quiz' : task === 'draft' ? 'rédiger un texte' : 'une synthèse'} : le résultat est souvent confus. Choisis Claude (le plus fiable) ou un modèle local plus gros dans Paramètres → Assistant IA.`;
    if (!text.trim()) text = 'Je n’ai pas pu formuler de réponse. Reformule ta question, ou demande à Claude.';
    status.textContent = '';
    // Quiz : pas de sources « par défaut » sous une question, elles donneraient la réponse
    const src = citedRefs(text, refs, 4, task === 'qa' || task === 'list' || task === 'summary');
    const engineLabel = claude ? (CLAUDE_MODELS.find((x) => x.id === lsGet('assistant.model', CLAUDE_MODELS[0].id)) || CLAUDE_MODELS[0]).label.replace(/ \(.*/, '') : `${localLlm().label}, sur ton appareil`;
    bubble.innerHTML = renderAnswer(text, refs)
      + (src.length ? `<ul class="chat-src">${src.map((r) => `<li><button type="button" data-open="${esc(r.doc.id)}" data-i="${r.i}"><b>${r.n}</b><span>« ${esc(r.text.length > 110 ? r.text.slice(0, 109) + '…' : r.text)} »<small>${esc(r.doc.title)} · ${relDay(r.doc.createdAt)} · ${fmtClock(r.start)}</small></span></button></li>`).join('')}</ul>` : '')
      + (note ? `<p class="chat-note warn">${esc(note)}</p>` : '')
      + `<p class="chat-note">${esc(engineLabel)} · à vérifier dans les sources.${claude ? '' : ` <button class="chat-claude" type="button" data-claude>${CLAUDE_ICON}Demander à Claude</button>`}</p>`;
    conv.turns.push({ q, a: text });
    conv.task = task;
    chatLog[chatLog.length - 1].html = bubble.innerHTML;
  } catch (e) {
    console.warn(e);
    bubble.innerHTML = `<p class="chat-err">${esc(e.message || String(e))}</p>${e.detail ? `<details class="chat-detail"><summary>Détail technique</summary><code>${esc(e.detail)}</code></details>` : ''}` + keywordAnswer(q, sources, '');
    chatLog[chatLog.length - 1].html = bubble.innerHTML;
  } finally {
    asstAbort = null;
    setChatBusy(false);
    $('#chat').scrollTop = $('#chat').scrollHeight;
  }
}

/** Paramètres → Assistant IA → Tester : lance le modèle sur une question simple et produit un rapport. */
async function runAssistantTest() {
  const out = $('#asst-report');
  const lines = [];
  const log = (t) => { lines.push(t); out.hidden = false; $('#asst-report pre').textContent = lines.join('\n'); };
  const c = caps();
  log(`Navigateur : ${navigator.userAgent.match(/(Edg|Chrome|Firefox|Safari)\/[\d.]+/g)?.join(' ') || navigator.userAgent.slice(0, 80)}`);
  log(`Carte graphique : ${c.webgpu ? c.adapter || 'oui' : 'non disponible'}${c.softwareGpu ? ' (logicielle)' : ''} · demi-précision (f16) : ${c.f16 ? 'oui' : 'non'} · tampon max : ${c.maxBufferMB ?? '?'} Mo · mémoire : ${navigator.deviceMemory ?? '?'} Go · cœurs : ${navigator.hardwareConcurrency ?? '?'}`);
  const engine = asstEngine();
  log(`Moteur choisi : ${engine}`);
  if (engine === 'claude' || engine === 'search') return log('Le test concerne le modèle local : choisis « Local » dans le menu Moteur.');
  const tries = localCandidates();
  if (!tries.length) return log('Pas de carte graphique compatible : en automatique, l’assistant fait une recherche simple. Choisis « Local léger » pour tester le modèle sur le processeur.');
  $('#asst-test').disabled = true;
  for (const [k, m] of tries.entries()) {
    const t0 = performance.now();
    log(`→ ${m.label} · ${m.device} · ${m.dtype} (${fmtMB(m.sizeMB)})…`);
    try {
      let first = 0;
      let txt = '';
      const r = await answerLocalWith(m, [{ role: 'system', content: 'Réponds en un seul mot.' }, { role: 'user', content: 'Dis simplement : bonjour' }], {
        onToken: (t) => { if (!first) first = performance.now(); txt += t; },
        onStatus: (s) => { if (s) $('#asst-report small').textContent = s; },
      }, k > 0);
      if (r == null) { log('  annulé (téléchargement refusé).'); break; }
      log(`  ✓ OK en ${((performance.now() - t0) / 1000).toFixed(1)} s (1er mot après ${first ? ((first - t0) / 1000).toFixed(1) : '?'} s) : « ${(r || txt).trim().slice(0, 40)} »`);
      lsSet(`assistant.failed.${m.key}`, '');
      localStorage.removeItem(`assistant.failed.${m.key}`);
      break;
    } catch (e) {
      log(`  ✗ échec : ${String(e?.message || e).slice(0, 400)}`);
      if (!/fetch|network|Failed to load|ERR_|timeout/i.test(String(e?.message))) lsSet(`assistant.failed.${m.key}`, String(e?.message || e).slice(0, 300));
      if (llm) { llm.terminate(); llm = null; llmReady = null; }
    }
  }
  $('#asst-report small').textContent = '';
  $('#asst-test').disabled = false;
  renderAssistantSettings();
}

/** Paramètres → Assistant IA */
function renderAssistantSettings() {
  const sel = $('#asst-engine');
  if (!sel) return;
  sel.value = asstEngine();
  const isClaude = sel.value === 'claude';
  $('#asst-claude').hidden = !isClaude;
  $('#asst-model').value = lsGet('assistant.model', CLAUDE_MODELS[0].id);
  $('#asst-key').value = claudeKey() ? '••••••••••••' : '';
  const m = localLlm();
  const fails = Object.keys(localStorage).filter((k) => k.startsWith('assistant.failed.')).map((k) => `${k.slice(17)} : ${localStorage.getItem(k)}`);
  const failed = fails.join(' | ');
  const noGpu = !caps().webgpu;
  $('#asst-retry').hidden = !failed;
  $('#asst-fail').hidden = !failed;
  $('#asst-fail').textContent = failed ? `Échecs mémorisés : ${failed}` : '';
  $('#asst-info').textContent = sel.value === 'search' ? 'Recherche par mots-clés dans tes réunions, sans modèle de langage.'
    : sel.value === 'auto' && caps().webgpu && !localCandidates().length ? 'Aucun modèle local n’a pu démarrer sur cette carte graphique : recherche dans tes réunions, sans réponse rédigée. Lance le test pour voir pourquoi, ou choisis Claude.'
    : sel.value === 'auto' && failed && m.light ? `${m.label} sur la carte graphique (le modèle plus précis n’a pas pu démarrer). Réponses plus approximatives ; réessaie ou choisis Claude.`
    : sel.value === 'auto' && noGpu ? 'Pas de carte graphique compatible détectée : recherche dans tes réunions, sans réponse rédigée. Pour des réponses rédigées, choisis Claude (le plus fiable) ou le modèle local léger (expérimental, réponses approximatives).'
    : sel.value === 'local-xl' && !(caps().webgpu && caps().f16) ? 'Qwen3 4B demande une carte graphique récente (WebGPU avec demi-précision) : elle n’est pas disponible ici, le modèle 1,7B sera utilisé à la place.'
    : sel.value === 'local-xl' ? `${m.label} (${fmtMB(m.sizeMB)}), sur la carte graphique. Le plus intelligent des modèles locaux (raisonne mieux, suit mieux les consignes), mais il demande environ 4 Go de mémoire graphique et met plus de temps à répondre. Rien ne quitte ton appareil.`
    : sel.value === 'local-small' ? `${m.label} (${fmtMB(m.sizeMB)}), sur ${m.device === 'webgpu' ? 'la carte graphique' : 'le processeur'}. Expérimental : petit modèle, réponses parfois approximatives ; vérifie dans les sources.${m.device === 'wasm' ? ' 20 s à 2 min par réponse.' : ''}`
    : isClaude ? 'Le plus intelligent : comprend les demandes complexes, relie plusieurs réunions, te fait réviser un dossier… Les extraits utiles de tes réunions (jusqu’à environ 60 000 caractères) et ta question sont envoyés à Claude (Anthropic) via ta clé API. Facturé à l’usage : de l’ordre de quelques centimes par question avec Opus, moins pour les questions suivantes d’une même conversation.'
    : `${m.label} (${fmtMB(m.sizeMB)}), sur ${m.device === 'webgpu' ? 'la carte graphique' : 'le processeur'}. Rien ne quitte ton appareil.${m.device === 'wasm' ? ' Sans carte graphique, une réponse prend de 20 s à 1 min.' : ''}`;
}

export function bindAssistantSettings() {
  const sel = $('#asst-engine');
  if (!sel) return;
  // Anciens échecs (avant la chaîne de repli) : on retente avec la nouvelle logique
  localStorage.removeItem('assistant.largeFailed');
  $('#asst-model').innerHTML = CLAUDE_MODELS.map((m) => `<option value="${m.id}">${esc(m.label)}</option>`).join('');
  sel.onchange = () => { lsSet('assistant.engine', sel.value); renderAssistantSettings(); };
  $('#asst-model').onchange = (e) => lsSet('assistant.model', e.target.value);
  $('#asst-key').onfocus = (e) => { if (e.target.value.startsWith('•')) e.target.value = ''; };
  $('#asst-key').onchange = (e) => {
    const v = e.target.value.trim();
    if (v.startsWith('•')) return;
    lsSet('assistant.key', v);
    renderAssistantSettings();
    toast(v ? 'Clé API enregistrée dans ce navigateur.' : 'Clé API effacée.', 'ok', 3000);
  };
  $('#asst-retry').onclick = () => {
    Object.keys(localStorage).filter((k) => k.startsWith('assistant.failed.') || k === 'assistant.largeFailed').forEach((k) => localStorage.removeItem(k));
    renderAssistantSettings();
    toast('Échecs oubliés : pose ta question à l’assistant (ou lance le test) pour réessayer.', 'ok', 4000);
  };
  $('#asst-test').onclick = runAssistantTest;
  $('#asst-report-copy').onclick = async () => { await writeClipboard($('#asst-report pre').textContent); toast('Rapport copié : colle-le dans la conversation.', 'ok', 3000); };
  $('#asst-key-clear').onclick = () => { lsSet('assistant.key', ''); renderAssistantSettings(); toast('Clé API effacée.', 'ok', 2500); };
  renderAssistantSettings();
}

/** Claude : la question + les transcriptions les plus utiles (dans la limite d'une consigne raisonnable). */
export async function askClaudeAbout(q) {
  const docs = scopeDocs((await myDocs()).filter((d) => d.segments?.length));
  const { hits } = searchMeetings(q, actionSources(docs), { limit: 20 });
  const ids = [...new Set(hits.map((h) => h.doc.id))];
  const pick = [...ids.map((id) => docs.find((d) => d.id === id)), ...docs].filter((d, i, a) => d && a.indexOf(d) === i).slice(0, 5);
  let budget = 60000;
  const parts = [];
  for (const d of pick) {
    const txt = toTxt(d.segments, { timestamps: false, speakers: (d.speakers || []).map((p) => p.name) });
    if (budget <= 2000) break;
    const cut = txt.slice(0, budget);
    budget -= cut.length;
    parts.push(`<reunion titre="${d.title.replace(/"/g, "'")}" date="${new Date(d.createdAt).toLocaleDateString('fr-FR')}">\n${cut}\n</reunion>`);
  }
  const prompt = `Voici des transcriptions automatiques de mes réunions (elles peuvent contenir des erreurs de reconnaissance). Réponds à ma question en t’appuyant uniquement sur leur contenu, en citant la réunion et la date. Si l’information n’y est pas, dis-le.\n\nQuestion : ${q}\n\n${parts.join('\n\n')}`;
  await openInClaude(prompt);
}
