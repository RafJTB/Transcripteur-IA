// Qui parle ? : intervenants, voix connues.

import { VoiceBook, centroids, matchVoices, packEmb } from '../voices.js';
import { assignSpeakers, buildTimeline, clusterSpeakers, defaultSpeakerName, orderSpeakers, speakerColor, speakingTime } from '../speakers.js';
import { $, ask, esc, state, store, toast } from './core.js';
import { renderMeta, renderSegments, saveDoc } from './doc.js';
import { renderInsights } from './doc-tabs.js';
import { notify } from './notifs.js';
import { loadDocAudio } from './recording.js';
import { persist } from './transcription.js';
import { autoRun } from './translation.js';
import { personName } from '../calendar.js';

// ======================================================================
// Qui parle ? (pyannote + WeSpeaker, dans un worker ; ~33 Mo téléchargés une fois)
// ======================================================================
const SPK_WORKER = new URL('../speaker-worker.js', import.meta.url);
let spkWorker = null;
let spkSeq = 0;
let spkRun = null;
/** Empreintes vocales déjà calculées, par transcription : changer le nombre de personnes est instantané. */
export const spkCache = new Map();

/** Noms des intervenants (pour les exports), ou null s'il n'y en a pas plusieurs. */
export function speakerNames() {
  const sp = state.doc?.speakers;
  return sp?.length > 1 ? sp.map((p) => p.name) : null;
}

function spkEngine() {
  if (!spkWorker) {
    spkWorker = new Promise((resolve, reject) => {
      const w = new Worker(SPK_WORKER, { type: 'module' });
      const fail = (msg) => { clearTimeout(t); w.terminate(); reject(new Error(msg)); };
      const t = setTimeout(() => fail('le module ne démarre pas.'), 60000);
      w.onerror = (e) => { e.preventDefault?.(); fail('impossible de charger le module (cdn.jsdelivr.net et huggingface.co doivent être accessibles au premier lancement).'); };
      w.onmessage = ({ data }) => {
        if (data.type !== 'boot') return;
        clearTimeout(t);
        w.onmessage = null;
        w.onerror = null;
        resolve(w);
      };
    });
    spkWorker.catch(() => (spkWorker = null));
  }
  return spkWorker;
}

/** Empreintes vocales de l'audio (voir speaker-worker.js). */
async function analyseVoices(pcm, onProgress) {
  const w = await spkEngine();
  const id = ++spkSeq;
  return new Promise((resolve, reject) => {
    const h = ({ data }) => {
      if (data.id !== id) return;
      if (data.type === 'progress') return onProgress?.(data);
      w.removeEventListener('message', h);
      if (data.type === 'result') resolve(data.items);
      else reject(new Error(data.message));
    };
    w.addEventListener('message', h);
    w.postMessage({ type: 'run', id, pcm });
  });
}

let spkStatusTimer = 0;
function spkStatus(text, done = false) {
  clearTimeout(spkStatusTimer);
  const el = $('#spk-status');
  el.hidden = !text;
  el.classList.toggle('done', done);
  $('#spk-status-text').textContent = text;
  if (done) spkStatusTimer = setTimeout(() => (el.hidden = true), 5000);
}

/**
 * Identifie les intervenants d'une transcription.
 * k : nombre de personnes imposé (null = automatique). manual : lancé par le bouton.
 */
export function identifySpeakers(doc, { k = doc?.speakerCount ?? null, manual = false } = {}) {
  if (!doc?.segments?.length) return null;
  if (spkRun) {
    if (manual) toast('Analyse des voix déjà en cours…', 'warn', 3000);
    return spkRun;
  }
  spkRun = (async () => {
    let items = spkCache.get(doc.id);
    if (!items) {
      spkStatus('Qui parle ? Préparation…');
      const pcm = (await loadDocAudio(doc)) ? state.audio.pcm : null;
      if (!pcm) {
        spkStatus('');
        if (manual) toast('L’audio de cette transcription n’est plus disponible : impossible de reconnaître les voix.', 'warn', 6000);
        return;
      }
      items = await analyseVoices(pcm, (p) => {
        const pct = `${Math.round((p.value || 0) * 100)} %`;
        spkStatus(p.stage === 'load' ? `Qui parle ? Téléchargement du module (≈ 33 Mo, une seule fois)… ${pct}` : `Qui parle ? Analyse des voix… ${pct}`);
      });
      spkCache.set(doc.id, items);
    }
    // La traduction numérote les phrases : on attend qu'elle ait fini avant d'en couper
    await autoRun?.promise?.catch(() => {});
    if (doc.status === 'running' || doc.status === 'live') return spkStatus('');
    if (!items.length) {
      spkStatus('');
      if (manual) toast('Aucune voix nette détectée dans cet audio.', 'warn', 5000);
      return;
    }
    const known = applySpeakers(doc, items, k);
    const n = doc.speakers.length;
    const kn = known.length ? ` · ${known.join(', ')} reconnu${known.length > 1 ? 's' : ''}` : '';
    spkStatus((n > 1 ? `${n} personnes` : 'Une seule voix') + (kn || (n > 1 ? ' reconnues' : ' reconnue')), true);
    if (n > 1) notify({ kind: 'ok', title: `${n} personnes reconnues`, text: known.length ? `« ${doc.title} » : ${known.join(', ')} reconnu${known.length > 1 ? 's' : ''} à la voix.` : `« ${doc.title} » : renomme-les dans l’onglet Transcription.`, docId: doc.id });
  })()
    .catch((e) => { spkStatus(''); toast(`Qui parle ? ${e.message}`, 'err', 8000); })
    .finally(() => { spkRun = null; });
  return spkRun;
}

/** Regroupe les voix et attribue chaque phrase (rapide : empreintes déjà calculées). */
export function applySpeakers(doc, items, k) {
  const labels = clusterSpeakers(items, { k });
  const timeline = buildTimeline(items, labels);
  const base = doc.segments.map(({ spk, ...rest }) => rest);
  const names = (doc.speakers || []).map((p) => p.name);
  const { segments, speakers, order } = orderSpeakers(assignSpeakers(base, timeline), names);
  // Empreinte de chaque personne (pour le carnet de voix), puis reconnaissance des voix connues
  const cents = centroids(items, labels);
  speakers.forEach((p, n) => { const c = cents.get(order[n]); if (c) p.emb = packEmb(c); });
  const known = recognizeVoices(speakers);
  doc.segments = segments;
  doc.speakers = speakers;
  doc.speakerCount = k;
  if (state.doc === doc) {
    state.segments = doc.segments;
    renderSegments(state.segments, {});
    renderSpeakers();
    renderMeta();
  }
  persist(doc);
  return known;
}

/**
 * Donne leur nom aux voix déjà connues (carnet de voix). Renvoie les noms reconnus.
 * Un nom du carnet n'est jamais donné à deux personnes à la fois.
 */
function recognizeVoices(speakers) {
  if (!state.voiceId) return [];
  const book = VoiceBook.load();
  if (!book.length) return [];
  const m = matchVoices(speakers.map((p) => p.emb || null), book);
  const found = [];
  speakers.forEach((p, n) => {
    if (m[n].index < 0) { delete p.known; return; }
    p.name = book[m[n].index].name;
    p.known = Math.round(m[n].sim * 100) / 100;
    p.learned = p.name;
    found.push(p.name);
  });
  // Un autre intervenant ne garde pas un nom désormais porté par une voix reconnue
  const taken = new Set(found.map((x) => x.toLowerCase()));
  speakers.forEach((p, n) => { if (p.known == null && taken.has(p.name.toLowerCase())) p.name = defaultSpeakerName(n); });
  return found;
}

/** Après un renommage : la voix est apprise (ou affinée) dans le carnet. */
export function learnSpeaker(n) {
  const p = state.doc?.speakers?.[n];
  if (!state.voiceId || !p?.emb || !p.name || /^Personne \d+$/.test(p.name) || p.learned === p.name) return;
  const isNew = !VoiceBook.load().some((v) => v.name.toLowerCase() === p.name.toLowerCase());
  VoiceBook.learn(p.name, p.emb);
  p.learned = p.name;
  saveDoc(0);
  renderVoices();
  toast(isNew ? `Voix de ${p.name} mémorisée : reconnaissance automatique aux prochaines réunions.` : `Voix de ${p.name} affinée.`, 'ok', 4000);
}

/** Paramètres : liste des voix connues. */
function renderVoices() {
  const box = $('#voice-list');
  if (!box) return;
  $('#toggle-voiceid').checked = state.voiceId;
  const book = VoiceBook.load().sort((a, b) => a.name.localeCompare(b.name, 'fr'));
  $('#voice-clear').hidden = !book.length;
  box.innerHTML = book.length
    ? book.map((v) => `<li><span class="v-av">${esc(v.name.slice(0, 1).toUpperCase())}</span><span class="v-name">${esc(v.name)}<small>appris sur ${v.n || 1} réunion${(v.n || 1) > 1 ? 's' : ''}</small></span><button class="icon-btn sm" type="button" data-forget="${esc(v.name)}" aria-label="Oublier la voix de ${esc(v.name)}" title="Oublier cette voix"><svg viewBox="0 0 24 24"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg></button></li>`).join('')
    : '<li class="none">Aucune voix pour l’instant. Renomme un intervenant (« Personne 1 » → « Julie ») : sa voix sera reconnue aux réunions suivantes.</li>';
}

export function bindVoices() {
  $('#toggle-voiceid').onchange = (e) => {
    state.voiceId = e.target.checked;
    store.set('voiceid', state.voiceId ? '1' : '0');
  };
  $('#voice-list').addEventListener('click', (e) => {
    const b = e.target.closest('[data-forget]');
    if (!b) return;
    VoiceBook.remove(b.dataset.forget);
    renderVoices();
    toast(`Voix de ${b.dataset.forget} oubliée.`, 'ok', 3000);
  });
  $('#voice-clear').onclick = async () => {
    if (!(await ask('Oublier toutes les voix connues ?', 'Les intervenants ne seront plus reconnus automatiquement. Les transcriptions ne changent pas.', 'Tout oublier', { danger: true }))) return;
    VoiceBook.clear();
    renderVoices();
  };
  renderVoices();
}

/** Barre des intervenants : noms modifiables, temps de parole, nombre de personnes. */
export function renderSpeakers() {
  const d = state.doc;
  const sp = d?.speakers;
  $('#spk-panel').hidden = !sp?.length;
  $('#spk-side').hidden = !state.segments.length || d?.status === 'running' || d?.status === 'live';
  renderInsights();
  if (!sp?.length) return;
  const t = speakingTime(state.segments, sp.length);
  const tot = t.reduce((a, b) => a + b, 0) || 1;
  const list = $('#spk-list');
  const focused = document.activeElement?.closest?.('#spk-list') ? document.activeElement.dataset.n : null;
  list.replaceChildren(...sp.map((p, n) => {
    const item = document.createElement('label');
    item.className = 'spk-item';
    item.style.setProperty('--spk', speakerColor(n));
    item.title = 'Clique pour renommer';
    item.innerHTML = '<span class="dot"></span><input class="spk-name" spellcheck="false" maxlength="40" /><small></small>';
    const input = $('input', item);
    input.value = p.name;
    input.dataset.n = n;
    input.size = Math.max(6, Math.min(22, p.name.length + 1));
    input.setAttribute('aria-label', `Nom de ${p.name}`);
    $('small', item).textContent = `${Math.round((t[n] / tot) * 100)} %`;
    return item;
  }));
  // Participants de la réunion (calendrier) proposés comme noms
  const names = [...new Set((d.event?.attendees || []).concat(d.event?.organizer ? [d.event.organizer] : []).map(personName).filter(Boolean))];
  let dl = $('#spk-names');
  if (!dl) { dl = document.createElement('datalist'); dl.id = 'spk-names'; document.body.append(dl); }
  dl.innerHTML = names.map((n) => `<option value="${n.replace(/"/g, '&quot;')}"></option>`).join('');
  for (const inp of list.querySelectorAll('input.spk-name')) if (names.length) inp.setAttribute('list', 'spk-names'); else inp.removeAttribute('list');
  if (focused != null) $(`#spk-list input[data-n="${focused}"]`)?.focus();
  $('#spk-count').value = d.speakerCount ? String(d.speakerCount) : '';
}

/** Après une correction : retire les intervenants sans phrase et renumérote. */
function compactSpeakers(d) {
  const used = [...new Set(state.segments.map((s) => s.spk).filter((x) => x != null))].sort((a, b) => a - b);
  const map = new Map(used.map((o, n) => [o, n]));
  // Les noms par défaut suivent la nouvelle numérotation ; les noms choisis sont gardés
  d.speakers = used.map((o, n) => {
    const p = d.speakers[o] || { name: '' };
    return { ...p, name: !p.name || /^Personne \d+$/.test(p.name) ? defaultSpeakerName(n) : p.name };
  });
  state.segments = state.segments.map((s) => (s.spk == null ? s : { ...s, spk: map.get(s.spk) }));
  d.segments = state.segments;
}

/** Menu d'une étiquette : attribuer cette prise de parole à quelqu'un d'autre. */
export function openSpeakerMenu(chip) {
  const d = state.doc;
  const i = Number(chip.dataset.i);
  if (!d?.speakers || !state.segments[i]) return;
  const pop = $('#spk-pop');
  const from = state.segments[i].spk;
  const opts = d.speakers.map((p, n) => ({ n, label: p.name })).filter((o) => o.n !== from);
  opts.push({ n: d.speakers.length, label: 'Nouvelle personne' });
  pop.innerHTML = '<p>Ce passage est dit par…</p>';
  for (const o of opts) {
    const b = document.createElement('button');
    b.type = 'button';
    b.innerHTML = '<span class="dot"></span>';
    b.append(o.label);
    b.style.setProperty('--spk', speakerColor(o.n));
    b.onclick = () => {
      if (o.n >= d.speakers.length) d.speakers.push({ name: defaultSpeakerName(o.n), seconds: 0 });
      for (let j = i; j < state.segments.length && state.segments[j].spk === from; j++) state.segments[j] = { ...state.segments[j], spk: o.n };
      compactSpeakers(d);
      closeSpeakerMenu();
      renderSegments(state.segments, {});
      renderSpeakers();
      saveDoc();
    };
    pop.append(b);
  }
  const r = chip.getBoundingClientRect();
  pop.hidden = false;
  pop.style.left = `${Math.min(r.left, innerWidth - pop.offsetWidth - 12)}px`;
  pop.style.top = `${r.bottom + pop.offsetHeight + 8 > innerHeight ? r.top - pop.offsetHeight - 6 : r.bottom + 6}px`;
  pop.querySelector('button')?.focus();
}

export function closeSpeakerMenu() { $('#spk-pop').hidden = true; }
