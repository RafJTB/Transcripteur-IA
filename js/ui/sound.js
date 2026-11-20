// Réglages du son et réglage automatique.

import { DEFAULT_AUDIO_SETTINGS, canPickOutput, isBluetooth, listMicrophones, listSpeakers } from '../audio.js';
import { pickVariant } from '../config.js';
import { $, caps, modelById, state, status, store, toast } from './core.js';
import { applyLaptopPreset, runCalibration, runDiagnostic, tool, toolCleanup } from './diagnostic.js';
import { renderLangHint, renderLiveHint, renderModelPick } from './engine.js';
import { micBusy, monitor, recorder, saveSound, sound, warnFallback } from './recording.js';

// ======================================================================
// Réglages du son (sous le graphique)
// ======================================================================
const fmtGain = (db) => (db > 0 ? `+${db} dB` : `${db} dB`).replace('-', '−');

export function renderSound() {
  $('#gain').value = sound.gainDb;
  $('#gain-val').textContent = fmtGain(sound.gainDb);
  $('#opt-agc').checked = sound.autoGainControl;
  $('#opt-ns').checked = sound.noiseSuppression;
  $('#opt-ec').checked = sound.echoCancellation;
  $('#opt-hp').checked = sound.highpass;
  $('#mic-device').value = sound.deviceId;
  if ($('#mic-device').value !== sound.deviceId) $('#mic-device').value = '';
  $('#out-device').value = sound.outputId;
  if ($('#out-device').value !== sound.outputId) $('#out-device').value = '';
  renderBtHint();
  renderSoundSummary();
  const busy = micBusy();
  const testing = recorder.state === 'preview';
  // Ces réglages imposent de rouvrir le micro : figés pendant un enregistrement
  ['#mic-device', '#opt-agc', '#opt-ns', '#opt-ec', '#tool-diag', '#tool-calib'].forEach((id) => ($(id).disabled = busy));
  $('#gain-auto').disabled = !(busy || testing);
  $('#mic-test').disabled = busy;
  $('#mic-test').classList.toggle('active', testing);
  $('#mic-test span').textContent = testing ? 'Arrêter le test' : 'Tester le micro';
  const hint = $('#sc-hint');
  if (busy) {
    hint.className = 'sc-hint';
    hint.textContent = 'Pendant l’enregistrement, seuls le gain et le filtre des basses sont modifiables.';
  } else if (sound.autoGainControl && sound.gainDb !== 0) {
    hint.className = 'sc-hint warn';
    hint.textContent = 'Le gain automatique compense en partie ton réglage : coupe-le pour un contrôle total.';
  } else {
    hint.className = 'sc-hint';
    hint.textContent = testing ? 'Règle le gain pour que la courbe reste dans la zone verte.' : '';
  }
}

function renderSoundSummary() {
  const sel = $('#mic-device');
  const name = sel.selectedOptions[0]?.textContent || 'Micro par défaut';
  $('#sound-sum').textContent = `${name.length > 28 ? name.slice(0, 27) + '…' : name} · gain ${fmtGain(sound.gainDb)}`;
  const chips = [['Gain auto', sound.autoGainControl], ['Anti-bruit', sound.noiseSuppression], ['Anti-écho', sound.echoCancellation], ['Filtre basses', sound.highpass]];
  $('#sound-chips').innerHTML = chips.map(([l, on]) => `<span class="chip${on ? '' : ' off'}">${l}</span>`).join('');
}

/**
 * Options d'une liste d'appareils : « Par défaut (nom réel) », puis chaque appareil.
 * Un appareil choisi mais absent reste affiché « non connecté » : le choix est gardé pour son retour.
 */
function deviceOptions(list, kind, chosenId, chosenLabel) {
  const def = list.find((d) => d.deviceId === 'default');
  const defName = def?.label?.replace(/^(par défaut|default)\s*[-–:]\s*/i, '');
  const word = kind === 'in' ? 'Micro' : 'Sortie';
  const real = list.filter((d) => d.deviceId && d.deviceId !== 'default');
  const opts = [new Option(defName ? `Par défaut (${defName})` : `${word} par défaut`, '')];
  real.forEach((d, i) => opts.push(new Option(d.label || `${word} ${i + 1}`, d.deviceId)));
  if (chosenId && !real.some((d) => d.deviceId === chosenId)) opts.push(new Option(`${chosenLabel || word + ' choisi'} — non connecté`, chosenId));
  return { real, opts };
}

/** Windows peut changer l'identifiant d'un casque : on le retrouve par son nom. */
function relink(real, idKey, labelKey) {
  if (!sound[idKey] || real.some((d) => d.deviceId === sound[idKey])) return false;
  const same = sound[labelKey] && real.find((d) => d.label === sound[labelKey]);
  if (!same) return false;
  sound[idKey] = same.deviceId;
  return true;
}

let knownDevices = null;
export async function refreshDevices(fromEvent = false) {
  const mics = await listMicrophones();
  const outs = await listSpeakers();
  const realIn = mics.filter((d) => d.deviceId && d.deviceId !== 'default');
  const realOut = outs.filter((d) => d.deviceId && d.deviceId !== 'default');
  const changed = relink(realIn, 'deviceId', 'deviceLabel') | relink(realOut, 'outputId', 'outputLabel');
  if (changed) saveSound();
  $('#mic-device').replaceChildren(...deviceOptions(mics, 'in', sound.deviceId, sound.deviceLabel).opts);
  $('#out-device').replaceChildren(...deviceOptions(outs, 'out', sound.outputId, sound.outputLabel).opts);
  $('#out-row').hidden = !canPickOutput();
  // Annonce discrète d'un casque qui vient d'être connecté
  const ids = new Set([...realIn, ...realOut].map((d) => d.deviceId));
  if (fromEvent && knownDevices?.size) {
    const fresh = [...realIn, ...realOut].filter((d) => !knownDevices.has(d.deviceId) && d.label);
    const names = [...new Set(fresh.map((d) => d.label))];
    if (names.length) toast(`Appareil connecté : ${names[0]}. Choisis-le dans « Réglages du son » si tu veux l’utiliser.`, 'ok', 5000);
  }
  knownDevices = ids;
  await applyOutput(false);
  renderSound();
}

/** Envoie la relecture vers la sortie choisie (casque, haut-parleurs). */
async function applyOutput(loud = true) {
  if (!canPickOutput()) return;
  const el = $('#audio-player');
  const id = $('#out-device').value === sound.outputId ? sound.outputId : '';
  if (el.sinkId === id) return;
  try {
    await el.setSinkId(id);
  } catch (e) {
    if (loud) toast(`Impossible d’utiliser cette sortie : ${e.message || e.name}`, 'err', 6000);
  }
}

/** Conseil Bluetooth : le micro d'un casque sans fil dégrade le son (profil « mains libres »). */
function renderBtHint() {
  const sel = $('#mic-device');
  const label = sel.selectedOptions[0]?.textContent || '';
  $('#bt-hint').hidden = !isBluetooth(label);
}

/** Petit carillon joué sur la sortie choisie. */
let chimeUrl = null;
async function testOutput() {
  if (!chimeUrl) {
    const rate = 22050;
    const n = Math.round(rate * 0.7);
    const buf = new ArrayBuffer(44 + n * 2);
    const v = new DataView(buf);
    const str = (o, t) => [...t].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
    str(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); str(8, 'WAVEfmt ');
    v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    str(36, 'data'); v.setUint32(40, n * 2, true);
    for (let i = 0; i < n; i++) {
      const t = i / rate;
      const f = t < 0.25 ? 660 : 880;
      const local = t < 0.25 ? t : t - 0.25;
      const env = Math.min(1, local * 80) * Math.exp(-local * 6);
      v.setInt16(44 + i * 2, Math.sin(2 * Math.PI * f * t) * env * 0.35 * 32767, true);
    }
    chimeUrl = URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
  }
  const a = new Audio(chimeUrl);
  try {
    if (sound.outputId && canPickOutput()) await a.setSinkId(sound.outputId);
    await a.play();
  } catch (e) {
    toast(`Lecture impossible sur cette sortie : ${e.message || e.name}`, 'err', 6000);
  }
}

/** Applique un changement de réglage. Gain et filtre : immédiat. Autres : rouvre le micro en test. */
async function applySound(key, value) {
  sound[key] = value;
  saveSound();
  if (key === 'gainDb') recorder.setGain(value);
  else if (key === 'highpass') recorder.setHighpass(value);
  else if (recorder.state === 'preview') { stopMicTest(); await startMicTest(); }
  renderSound();
}

export async function startMicTest() {
  if (micBusy() || recorder.state === 'preview') return;
  try {
    await recorder.start({ preview: true, settings: sound });
  } catch (e) {
    status(e.message, 'err');
    toast(e.message, 'err', 7000);
    return;
  }
  warnFallback();
  monitor.start();
  refreshDevices(); // les noms des micros sont visibles après autorisation
  renderSound();
}

export function stopMicTest() {
  if (recorder.state !== 'preview') return;
  recorder.stopPreview();
  monitor.stop();
  renderSound();
}

function autoGain() {
  const delta = monitor.gainAdvice();
  if (delta == null) return toast('Parle normalement quelques secondes, puis clique à nouveau.', 'warn', 4000);
  const next = Math.max(-12, Math.min(24, Math.round(sound.gainDb + delta)));
  if (next === sound.gainDb) return toast(`Le niveau est déjà bon (gain ${fmtGain(next)}).`, 'ok', 3000);
  applySound('gainDb', next);
  toast(`Gain ajusté à ${fmtGain(next)}.${sound.autoGainControl ? ' Coupe le gain automatique pour un réglage plus stable.' : ''}`, 'ok', 5000);
}

export function bindSound() {
  // Modification à la main : pendant un enregistrement, le gain auto s'arrête ;
  // sinon, le réglage automatique du son se désactive pour garder ton choix.
  const manual = (e) => {
    if (!e.isTrusted || !state.autoTune) return;
    if (micBusy()) { liveGain.locked = true; return; }
    if (recorder.state === 'preview') return;
    setAutoTune(false, 'Réglage automatique désactivé : tes réglages manuels sont gardés.');
  };
  ['#gain', '#opt-agc', '#opt-ns', '#opt-ec', '#opt-hp'].forEach((id) => $(id).addEventListener(id === '#gain' ? 'input' : 'change', manual));
  $('#gain').addEventListener('input', (e) => applySound('gainDb', Number(e.target.value)));
  $('#opt-agc').onchange = (e) => applySound('autoGainControl', e.target.checked);
  $('#opt-ns').onchange = (e) => applySound('noiseSuppression', e.target.checked);
  $('#opt-ec').onchange = (e) => applySound('echoCancellation', e.target.checked);
  $('#opt-hp').onchange = (e) => applySound('highpass', e.target.checked);
  $('#mic-device').onchange = (e) => {
    sound.deviceLabel = e.target.value ? e.target.selectedOptions[0].textContent.replace(/ — non connecté$/, '') : '';
    applySound('deviceId', e.target.value);
  };
  $('#out-device').onchange = async (e) => {
    sound.outputId = e.target.value;
    sound.outputLabel = e.target.value ? e.target.selectedOptions[0].textContent.replace(/ — non connecté$/, '') : '';
    saveSound();
    await applyOutput();
    renderSound();
  };
  $('#out-test').onclick = testOutput;
  $('#mic-test').onclick = () => (recorder.state === 'preview' ? stopMicTest() : startMicTest());
  $('#gain-auto').onclick = autoGain;
  $('#preset-laptop').onclick = applyLaptopPreset;
  $('#tool-diag').onclick = runDiagnostic;
  $('#tool-calib').onclick = runCalibration;
  $('#tool-close').onclick = () => tool.close();
  $('#sound-reset').onclick = async () => {
    Object.assign(sound, DEFAULT_AUDIO_SETTINGS);
    saveSound();
    applyOutput(false);
    recorder.setGain(0);
    recorder.setHighpass(false);
    if (recorder.state === 'preview') { stopMicTest(); await startMicTest(); }
    renderSound();
    toast('Réglages du son par défaut rétablis.', 'ok', 2500);
  };
  navigator.mediaDevices?.addEventListener?.('devicechange', () => refreshDevices(true));
  refreshDevices();
}

// ======================================================================
// Réglage automatique : diagnostic du PC et du son avant l'enregistrement
// ======================================================================
const AUTO_TTL = 60 * 60 * 1000; // un diagnostic du son reste valable 1 h pour le même micro
const LAPTOP_MIC = /array|réseau de micro|intégr|internal|built-?in|realtek|conexant|smart sound|intel/i;
const HEADPHONES = /casque|headphone|headset|écouteur|earbud|airpods|buds|bluetooth|hands-?free|mains libres/i;

/** Modèle conseillé pour transcrire en direct sur ce PC. */
function autoModelFor(c = caps()) {
  const mem = c.memoryGB ?? 8;
  if (c.webgpu && mem >= 4) return { id: 'small', why: 'carte graphique disponible' };
  return { id: 'base', why: c.webgpu ? 'mémoire limitée' : 'pas de carte graphique' };
}

/** Réglages du son selon la pièce et le matériel. */
function autoSoundFrom({ noise, label, outLabel }) {
  const bt = isBluetooth(label);
  const laptop = !bt && LAPTOP_MIC.test(label || '');
  const headphones = HEADPHONES.test(outLabel || '') || bt;
  const noisy = noise > -58;
  const quiet = noise < -72;
  const settings = {
    autoGainControl: true,
    noiseSuppression: noisy || laptop || bt || !quiet,
    echoCancellation: !headphones,
    highpass: laptop || noisy,
    gainDb: 0,
  };
  const micKind = bt ? 'micro Bluetooth' : laptop ? 'micro du PC' : label ? 'micro externe' : 'micro';
  const room = quiet ? 'pièce calme' : noisy ? 'pièce bruyante' : 'bruit léger';
  return { settings, micKind, room, headphones };
}

const AI_ICONS = {
  mic: '<svg viewBox="0 0 24 24"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>',
  bt: '<svg viewBox="0 0 24 24"><path d="m7 7 10 10-5 5V2l5 5L7 17"/></svg>',
  chip: '<svg viewBox="0 0 24 24"><path d="M13 2 4 14h7l-1 8 9-12h-7z"/></svg>',
  check: '<svg viewBox="0 0 24 24"><path d="m5 12 5 5 9-10"/></svg>',
};
const aiChip = (cls, icon, html, title = '') => `<span class="ai-chip ${cls}"${title ? ` title="${title}"` : ''}>${icon}${html}</span>`;

export function renderAutoInfo() {
  const el = $('#auto-info');
  $('#toggle-auto').checked = state.autoTune;
  $('#auto-redo').hidden = !state.autoTune;
  const m = modelById(state.modelId);
  const manualModel = store.get('model.manual') === '1';
  const model = aiChip('model', AI_ICONS.chip, `${m.label}<em>${manualModel ? 'ton choix' : 'auto'}</em>`, 'Modèle de transcription');
  if (!state.autoTune) { el.innerHTML = `<span class="ai-note">Réglages manuels du son</span>${model}`; return; }
  let last = null;
  try { last = JSON.parse(store.get('auto.last', 'null')); } catch { /* ignore */ }
  if (!last) { el.innerHTML = `<span class="ai-note">3 s de diagnostic au premier enregistrement</span>${model}`; return; }
  const r = last.res, st = r.settings;
  const kind = r.micKind[0].toUpperCase() + r.micKind.slice(1);
  const lvl = r.room === 'pièce calme' ? 1 : r.room === 'pièce bruyante' ? 3 : 2;
  const bars = `<i class="ai-bars l${lvl}"><b></b><b></b><b></b></i>`;
  const db = String(Math.round(last.noise)).replace('-', '−');
  const filters = [st.noiseSuppression && 'Anti-bruit', st.echoCancellation && 'Anti-écho', st.highpass && 'Coupe-bas'].filter(Boolean);
  el.innerHTML =
    aiChip('mic', /bluetooth/i.test(r.micKind) ? AI_ICONS.bt : AI_ICONS.mic, kind, 'Micro détecté') +
    aiChip(`noise l${lvl}`, bars, `${db} dB`, `Bruit de fond : ${r.room}`) +
    model +
    (filters.length ? aiChip('filter', AI_ICONS.check, filters.join('<s>·</s>'), 'Filtres activés') : aiChip('filter off', '', 'Son brut'));
}

export function setAutoTune(on, msg = '') {
  state.autoTune = on;
  store.set('auto', on ? '1' : '0');
  if (on) store.del('model.manual');
  renderAutoInfo();
  if (msg) toast(msg, 'ok', 5000);
}

/**
 * Avant l'enregistrement : choisit le modèle, puis mesure le bruit de fond (3 s) pour régler le son.
 * Renvoie false si l'utilisateur annule.
 */
export async function autoSetup({ force = false } = {}) {
  // 1. Modèle (instantané)
  if (state.caps && store.get('model.manual') !== '1') {
    const pick = autoModelFor();
    if (pick.id !== state.modelId && pickVariant(modelById(pick.id), caps())) {
      state.modelId = pick.id;
      store.set('model', pick.id);
      renderModelPick();
      renderLiveHint();
      renderLangHint();
    }
  }
  // 2. Son : diagnostic récent pour ce micro → réutilisé, l'enregistrement démarre tout de suite
  const key = sound.deviceId || 'default';
  let last = null;
  try { last = JSON.parse(store.get('auto.last', 'null')); } catch { /* ignore */ }
  if (!force && last && last.key === key && Date.now() - last.at < AUTO_TTL) {
    applyAutoSound(last.res.settings);
    renderAutoInfo();
    return true;
  }
  stopMicTest();
  tool.open('Réglage automatique');
  try {
    await recorder.start({ preview: true, settings: { ...sound, noiseSuppression: false, autoGainControl: false, echoCancellation: false, highpass: false, gainDb: 0 } });
    monitor.start();
    const t0 = monitor.now;
    const r = await tool.show({
      step: 'Diagnostic du son',
      meter: true,
      timeout: 3,
      html: `<p class="tool-big">Silence 3 secondes…</p><p>On mesure le bruit de ta pièce et ton micro pour tout régler automatiquement. Ne parle pas, ne touche pas au clavier.</p>`,
      actions: [{ label: 'Annuler', value: null }, { label: 'Démarrer sans attendre', value: 'go', primary: true }],
    });
    const levels = monitor.levels.filter((l) => l.t >= t0 + 0.3).map((l) => l.db).sort((a, b) => a - b);
    const label = recorder.deviceLabel || '';
    toolCleanup();
    tool.close();
    if (r === null) return false; // annulé
    const outLabel = $('#out-device').selectedOptions[0]?.textContent || '';
    if (levels.length >= 15) {
      const noise = levels[Math.floor(levels.length * 0.2)];
      const res = autoSoundFrom({ noise, label, outLabel });
      store.set('auto.last', JSON.stringify({ key, at: Date.now(), noise, res }));
      applyAutoSound(res.settings);
      const on = [res.settings.noiseSuppression && 'anti-bruit', res.settings.echoCancellation && 'anti-écho', res.settings.highpass && 'filtre des basses'].filter(Boolean);
      toast(`Réglé : ${res.micKind}, ${res.room}${on.length ? ` · ${on.join(', ')}` : ''} · modèle ${modelById(state.modelId).label}.`, 'ok', 5000);
    } else if (last?.res) {
      applyAutoSound(last.res.settings); // mesure trop courte : on garde le dernier réglage
    }
    renderAutoInfo();
    return true;
  } catch (e) {
    toolCleanup();
    tool.close();
    toast(e.message, 'err', 7000);
    return false;
  }
}

function applyAutoSound(settings) {
  Object.assign(sound, settings);
  saveSound();
  renderSound();
}

/** Pendant l'enregistrement : corrige le gain si la voix est trop faible ou sature. */
const liveGain = { timer: 0, locked: false, told: false };
export function startAutoGain() {
  clearInterval(liveGain.timer);
  liveGain.locked = false;
  if (!state.autoTune) return;
  liveGain.timer = setInterval(() => {
    if (!micBusy()) return clearInterval(liveGain.timer);
    if (liveGain.locked || recorder.state !== 'recording') return;
    const d = monitor.gainAdvice();
    if (d == null || (d < 5 && d > -4)) return;
    const next = Math.max(-12, Math.min(18, Math.round(sound.gainDb + Math.max(-6, Math.min(6, d)))));
    if (next === sound.gainDb) return;
    applySound('gainDb', next);
    if (!liveGain.told) { liveGain.told = true; toast(`Gain ajusté automatiquement (${fmtGain(next)}).`, 'ok', 3000); }
  }, 5000);
}
