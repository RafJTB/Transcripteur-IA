// Premier lancement : présentation en 3 étapes (ce que fait l'appli, le micro, par où commencer).
// Montrée une seule fois, à qui n'a encore aucune réunion ; « Revoir la présentation » dans l'Aide.

import { newId } from '../history.js';
import { listMicrophones } from '../audio.js';
import { $, esc, store, toast } from './core.js';
import { openDoc } from './history.js';
import { saveSound, selectTab, sound } from './recording.js';
import { myDocs, persist } from './transcription.js';
import { setView } from './views.js';

const I = {
  mic: '<svg viewBox="0 0 24 24"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>',
  people: '<svg viewBox="0 0 24 24"><circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><circle cx="17" cy="9" r="2.5"/><path d="M16 14.2a5 5 0 0 1 5.5 5.8"/></svg>',
  check: '<svg viewBox="0 0 24 24"><path d="M9 11l3 3 8-8"/><path d="M20 12v6a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h9"/></svg>',
  lock: '<svg viewBox="0 0 24 24"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>',
  file: '<svg viewBox="0 0 24 24"><path d="M12 15V4m0 0-4 4m4-4 4 4"/><path d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"/></svg>',
  spark: '<svg viewBox="0 0 24 24"><path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/></svg>',
  arrow: '<svg viewBox="0 0 24 24"><path d="M5 12h14M13 6l6 6-6 6"/></svg>',
};

let el = null, step = 0, stream = null, raf = 0, ctx = null;

/** Au démarrage : présentation si c'est la première fois (et qu'aucune réunion n'existe). */
export async function maybeOnboard() {
  if (store.get('onboarded') === '1') return;
  // Navigateur piloté par des tests : seulement si on le demande explicitement
  if (navigator.webdriver && store.get('onboard.force') !== '1') return;
  if ((await myDocs()).length) { store.set('onboarded', '1'); return; }
  openOnboarding();
}

export function openOnboarding() {
  close(false);
  step = 0;
  el = document.createElement('div');
  el.className = 'ob';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-modal', 'true');
  el.setAttribute('aria-labelledby', 'ob-title');
  el.innerHTML = '<div class="ob-card"><div class="ob-body" id="ob-body"></div><footer class="ob-foot"><span class="ob-dots" aria-hidden="true"><i></i><i></i><i></i></span><span class="grow"></span><button type="button" class="link-btn" data-ob="skip">Passer</button><button type="button" class="btn primary" data-ob="next"></button></footer></div>';
  document.body.appendChild(el);
  el.addEventListener('click', onClick);
  el.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(true); } });
  render();
}

function render() {
  const body = $('#ob-body', el);
  el.querySelectorAll('.ob-dots i').forEach((d, i) => d.classList.toggle('on', i === step));
  const next = $('[data-ob="next"]', el);
  $('[data-ob="skip"]', el).hidden = step === 2;
  next.hidden = step === 2;
  stopMic();
  if (step === 0) {
    next.innerHTML = `Commencer${I.arrow}`;
    body.innerHTML = `<div class="ob-hero"><span class="ob-logo">T</span></div>
      <h2 id="ob-title">Bienvenue dans Transcripteur IA</h2>
      <p class="ob-lead">Tes réunions transcrites, analysées et rangées, <b>sans jamais quitter ton PC</b>.</p>
      <ul class="ob-points">
        <li><span style="--c:139 92 246">${I.mic}</span><div><b>Transcription en direct</b><small>Le texte s’écrit pendant que tu parles, en salle ou en visio.</small></div></li>
        <li><span style="--c:16 185 129">${I.people}</span><div><b>Qui a dit quoi</b><small>Les voix sont reconnues et nommées, réunion après réunion.</small></div></li>
        <li><span style="--c:245 158 11">${I.check}</span><div><b>Décisions et actions</b><small>Relevées automatiquement, avec le responsable et l’échéance.</small></div></li>
        <li><span style="--c:59 130 246">${I.lock}</span><div><b>100 % sur ton appareil</b><small>L’audio et le texte ne partent nulle part sans ton accord.</small></div></li>
      </ul>`;
  } else if (step === 1) {
    next.innerHTML = `Continuer${I.arrow}`;
    body.innerHTML = `<h2 id="ob-title">Ton micro</h2>
      <p class="ob-lead">Parle quelques mots : la barre doit bouger. Tu pourras changer de micro à tout moment.</p>
      <div class="ob-mic">
        <button type="button" class="btn primary" data-ob="allow">${I.mic}Autoriser le micro</button>
        <label class="ob-select" hidden><span>Micro</span><select id="ob-device" aria-label="Micro utilisé"></select></label>
        <div class="ob-meter" aria-hidden="true"><i id="ob-level"></i></div>
        <small class="ob-hint" id="ob-hint">Le navigateur va te demander l’autorisation d’utiliser le micro.</small>
      </div>`;
  } else {
    body.innerHTML = `<h2 id="ob-title">Par où commencer ?</h2>
      <p class="ob-lead">Choisis, tu pourras tout faire ensuite depuis l’Accueil.</p>
      <div class="ob-choices">
        <button type="button" data-ob="record" style="--c:var(--rec-rgb)"><span>${I.mic}</span><b>Enregistrer une réunion</b><small>En salle ou en visio (Teams, Meet, Zoom)</small></button>
        <button type="button" data-ob="import" style="--c:59 130 246"><span>${I.file}</span><b>Importer un fichier</b><small>Un audio ou une vidéo déjà enregistré</small></button>
        <button type="button" data-ob="demo" style="--c:139 92 246"><span>${I.spark}</span><b>Découvrir avec un exemple</b><small>Une réunion de chantier déjà transcrite, à explorer</small></button>
      </div>`;
  }
  requestAnimationFrame(() => (step === 2 ? $('[data-ob="record"]', el) : $('[data-ob="next"]', el))?.focus());
}

async function onClick(e) {
  const a = e.target.closest('[data-ob]')?.dataset.ob;
  if (!a) return;
  if (a === 'skip') return close(true);
  if (a === 'next') { step = Math.min(2, step + 1); return render(); }
  if (a === 'allow') return startMic();
  if (a === 'record') { close(true); setView('record'); selectTab('mic'); return; }
  if (a === 'import') { close(true); setView('record'); selectTab('file'); $('#file-input')?.click(); return; }
  if (a === 'demo') { close(true); openDoc(await createDemo()); toast('Voici une réunion d’exemple : regarde les onglets Analyse et Actions.', 'ok', 6000); }
}

async function startMic(deviceId = sound.deviceId || '') {
  stopMic();
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: deviceId ? { deviceId: { exact: deviceId } } : true });
  } catch {
    $('#ob-hint', el).textContent = 'Micro refusé ou introuvable. Tu pourras l’autoriser plus tard depuis l’icône du cadenas, à gauche de l’adresse du site.';
    return;
  }
  $('[data-ob="allow"]', el).hidden = true;
  // Liste des micros (les noms ne sont connus qu'après l'autorisation)
  const mics = (await listMicrophones().catch(() => [])).filter((d) => d.deviceId && d.deviceId !== 'default');
  const sel = $('#ob-device', el);
  sel.innerHTML = `<option value="">Micro par défaut</option>${mics.map((d, i) => `<option value="${esc(d.deviceId)}"${d.deviceId === (sound.deviceId || '') ? ' selected' : ''}>${esc(d.label || `Micro ${i + 1}`)}</option>`).join('')}`;
  sel.closest('.ob-select').hidden = !mics.length;
  sel.onchange = () => {
    const d = mics.find((x) => x.deviceId === sel.value);
    sound.deviceId = sel.value;
    sound.deviceLabel = d?.label || '';
    saveSound();
    startMic(sel.value);
  };
  $('#ob-hint', el).textContent = 'Parle : la barre suit ta voix.';
  // Niveau du micro en direct
  ctx = new AudioContext();
  const an = ctx.createAnalyser();
  an.fftSize = 512;
  ctx.createMediaStreamSource(stream).connect(an);
  const buf = new Float32Array(an.fftSize);
  let peak = 0;
  const tick = () => {
    an.getFloatTimeDomainData(buf);
    let s = 0;
    for (const v of buf) s += v * v;
    const lvl = Math.min(1, Math.sqrt(s / buf.length) * 6);
    peak = Math.max(lvl, peak * 0.92);
    const bar = $('#ob-level', el);
    if (bar) bar.style.transform = `scaleX(${peak.toFixed(3)})`;
    if (peak > 0.15) $('#ob-hint', el).textContent = 'Parfait, on t’entend bien.';
    raf = requestAnimationFrame(tick);
  };
  tick();
}

function stopMic() {
  cancelAnimationFrame(raf);
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  ctx?.close().catch(() => {});
  ctx = null;
}

function close(done) {
  stopMic();
  if (done) store.set('onboarded', '1');
  el?.remove();
  el = null;
}

/** Réunion d'exemple (rangée dans « Exemple » sur l'Accueil, supprimable comme les autres). */
async function createDemo() {
  const t0 = Date.now() - 2 * 3600e3;
  const lines = [
    [0, 'Bonjour à tous, on fait le point sur la synthèse du bâtiment B.'],
    [1, 'Côté structure, la dalle du R+2 est coulée, on attend les réservations définitives.'],
    [0, 'Sur la maquette, il reste un clash entre la gaine CVC et le réseau d’eaux usées au R+1.'],
    [2, 'On valide le décalage de la gaine de vingt centimètres vers le nord.'],
    [0, 'Karim, tu peux mettre à jour la maquette fluides avant vendredi ?'],
    [2, 'Oui, je m’en occupe.'],
    [1, 'Il faut aussi vérifier la livraison de la grue pour lundi.'],
    [0, 'Julie va envoyer le compte rendu à la maîtrise d’ouvrage demain.'],
    [1, 'C’est acté pour le planning : réception des réseaux le 15.'],
    [0, 'Merci à tous, prochaine réunion de synthèse dans deux semaines.'],
  ];
  const doc = {
    id: newId(), title: 'Exemple · Réunion de synthèse BIM', createdAt: t0, updatedAt: Date.now(), durationS: lines.length * 42,
    status: 'done', model: 'Exemple', source: 'Réunion d’exemple', language: 'fr', demo: true,
    speakers: [{ name: 'Raf' }, { name: 'Marc' }, { name: 'Karim' }],
    segments: lines.map(([spk, text], i) => ({ text, start: i * 42, end: i * 42 + 38, spk, conf: 0.93 })),
  };
  await persist(doc); // rattachée au compte connecté, et synchronisée comme les autres
  return doc;
}
