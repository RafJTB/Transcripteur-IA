// Outils : diagnostic du micro et calibration.

import { CALIBRATION_CONFIGS, DICTATION, LAPTOP_PRESET, analyzeRoom, dictationScore } from '../calibration.js';
import { CHUNKING } from '../config.js';
import { decodeToMono16k } from '../audio.js';
import { $, esc, modelById, progress, state, toast } from './core.js';
import { updateButtons } from './doc.js';
import { request } from './engine.js';
import { micBusy, monitor, recorder, renderRec, saveSound, sound } from './recording.js';
import { renderSound, startMicTest, stopMicTest } from './sound.js';
import { confirmBigDownload, ensureLoaded } from './transcription.js';

/** Fenêtre guidée : une étape = un texte + des boutons ; renvoie la valeur du bouton (null si fermé). */
export const tool = {
  meter: false,
  _resolve: null,
  _timer: null,
  open(title) {
    $('#tool-title').textContent = title;
    $('#tool').hidden = false;
    this.cancelled = false;
  },
  close() {
    $('#tool').hidden = true;
    this.cancelled = true;
    this.meter = false;
    clearInterval(this._timer);
    this._resolve?.(null);
    this._resolve = null;
  },
  /** Affiche une étape. `timeout` (s) : valide automatiquement le dernier bouton à la fin du délai. */
  show({ step = '', html, actions = [], meter = false, timeout = 0 }) {
    if (this.cancelled) return Promise.resolve(null);
    clearInterval(this._timer);
    $('#tool-step').textContent = step;
    $('#tool-body').innerHTML = html;
    this.meter = meter;
    $('#tool-meter').hidden = !meter;
    $('#tool-timer').textContent = '';
    const box = $('#tool-actions');
    box.innerHTML = '';
    return new Promise((resolve) => {
      this._resolve = resolve;
      const done = (v) => { clearInterval(this._timer); this._resolve = null; resolve(v); };
      for (const a of actions) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'btn' + (a.primary ? ' primary' : '');
        b.textContent = a.label;
        b.onclick = () => (a.value === null ? this.close() : done(a.value));
        box.appendChild(b);
      }
      box.lastElementChild?.focus();
      if (timeout) {
        const end = performance.now() + timeout * 1000;
        const last = actions[actions.length - 1];
        this._timer = setInterval(() => {
          const left = Math.ceil((end - performance.now()) / 1000);
          $('#tool-timer').textContent = `${Math.max(0, left)} s`;
          if (left <= 0) done(last.value);
        }, 200);
      }
      if (!actions.length) this._resolve = resolve; // étape d'attente : se termine par close() ou par le code
    });
  },
  /** Étape sans bouton (attente), à remplacer par la suivante. */
  wait(step, html) {
    if (this.cancelled) return;
    clearInterval(this._timer);
    $('#tool-step').textContent = step;
    $('#tool-body').innerHTML = html;
    this.meter = false;
    $('#tool-meter').hidden = true;
    $('#tool-actions').innerHTML = '<button class="btn" type="button">Annuler</button>';
    $('#tool-actions button').onclick = () => this.close();
  },
};

function toolBusy() {
  if (state.phase !== 'idle' || micBusy()) {
    toast('Attends la fin de la transcription ou de l’enregistrement en cours.', 'warn');
    return true;
  }
  return false;
}

/** Arrête proprement le micro s'il a été ouvert par un outil. */
export function toolCleanup() {
  tool.meter = false;
  if (recorder.state === 'preview') recorder.stopPreview();
  else if (recorder.state !== 'idle') recorder.cancel();
  monitor.stop();
  renderRec();
}

export function applyLaptopPreset() {
  Object.assign(sound, LAPTOP_PRESET);
  saveSound();
  recorder.setGain(sound.gainDb);
  recorder.setHighpass(sound.highpass);
  if (recorder.state === 'preview') { stopMicTest(); startMicTest(); }
  renderSound();
  toast('Réglages optimisés pour le micro du PC : réduction du bruit, annulation d’écho, gain automatique et filtre des basses activés.', 'ok', 6000);
}

const rowHtml = (x, best = false) => `
  <div class="tool-row${best ? ' best' : ''}" data-level="${x.level}">
    <span class="dot"></span><strong>${esc(x.label)}</strong><span class="v">${esc(x.value)}</span>
    ${x.text ? `<small>${esc(x.text)}</small>` : ''}${x.diff ? `<div class="diff">${x.diff}</div>` : ''}
  </div>`;

export async function runDiagnostic() {
  if (toolBusy()) return;
  stopMicTest();
  tool.open('Diagnostic de la pièce');
  try {
    const go = await tool.show({
      step: 'Étape 1 / 3',
      html: `<p>On mesure ta pièce avec le <strong>micro brut</strong> (sans traitement du navigateur), pour juger la pièce elle-même.</p>
        <ol><li><strong>3 secondes de silence complet</strong> : ne parle pas, ne touche pas au clavier.</li>
        <li>Puis <strong>lis une phrase à voix haute</strong>, normalement, à ta place habituelle devant le PC.</li></ol>`,
      actions: [{ label: 'Annuler', value: null }, { label: 'Commencer', value: 'go', primary: true }],
    });
    if (!go) return;
    await recorder.start({ preview: true, settings: { ...sound, noiseSuppression: false, autoGainControl: false, echoCancellation: false, highpass: false, gainDb: 0 } });
    monitor.start();
    // 1. Silence
    const t0 = monitor.now;
    for (let n = 3; n > 0 && !tool.cancelled; n--) {
      tool.wait('Étape 2 / 3', `<p class="tool-big">Silence…</p><p>Ne parle pas, ne touche à rien : <strong>${n} s</strong></p>`);
      tool.meter = true; $('#tool-meter').hidden = false;
      await new Promise((r) => setTimeout(r, 1000));
    }
    if (tool.cancelled) return;
    await new Promise((r) => setTimeout(r, 400));
    const silence = monitor.levels.filter((l) => l.t >= t0 + 0.4);
    // 2. Voix
    const t1 = monitor.now;
    const done = await tool.show({
      step: 'Étape 2 / 3',
      meter: true,
      timeout: 15,
      html: `<p>Lis cette phrase à voix haute, normalement, <strong>en marquant de courtes pauses</strong> :</p><blockquote class="tool-sentence">${esc(DICTATION[0])}</blockquote>`,
      actions: [{ label: 'Annuler', value: null }, { label: 'J’ai fini', value: 'done', primary: true }],
    });
    const speech = monitor.levels.filter((l) => l.t >= t1);
    toolCleanup();
    if (!done) return;
    const res = analyzeRoom(silence, speech);
    if (!res) {
      await tool.show({ step: 'Résultat', html: '<p>Mesure trop courte : recommence en laissant le micro ouvert quelques secondes de plus.</p>', actions: [{ label: 'Fermer', value: null }] });
      return;
    }
    const next = await tool.show({
      step: 'Étape 3 / 3 · Résultat',
      html: `<p class="tool-verdict">${esc(res.verdict)}</p>
        <div class="tool-results">${res.items.map((x) => rowHtml(x)).join('')}</div>
        <div class="tool-advice"><p>Conseils</p><ul>${res.advice.map((a) => `<li>${esc(a)}</li>`).join('')}</ul></div>
        <p>Mesure indicative faite avec le micro brut. L’écho est estimé d’après la vitesse à laquelle le son retombe après chaque mot.</p>`,
      actions: [{ label: 'Fermer', value: null }, { label: 'Calibrer les réglages', value: 'calib', primary: true }],
    });
    if (next === 'calib') { tool.close(); runCalibration(); }
  } catch (e) {
    toolCleanup();
    if (!tool.cancelled) { tool.close(); toast(e.message, 'err', 7000); }
  } finally {
    if (recorder.state !== 'idle') toolCleanup();
    renderSound();
  }
}

export async function runCalibration() {
  if (toolBusy()) return;
  stopMicTest();
  const model = modelById(state.modelId);
  tool.open('Calibration par dictée');
  try {
    const go = await tool.show({
      step: 'Présentation',
      html: `<p>Tu vas lire <strong>3 phrases</strong>, une par réglage. Pour chacune, l’app transcrit ta lecture et calcule le <strong>pourcentage de mots justes</strong>.</p>
        <ul>${CALIBRATION_CONFIGS.map((c, i) => `<li>Lecture ${i + 1} : ${esc(c.label)}</li>`).join('')}</ul>
        <p>Installe-toi comme d’habitude devant le PC et lis normalement, sans forcer. Modèle utilisé : <strong>${esc(model.name)}</strong>. Durée : environ 1 minute.</p>
        <p>Les écarts de 1 ou 2 % ne sont pas significatifs (deux lectures ne sont jamais identiques).</p>`,
      actions: [{ label: 'Annuler', value: null }, { label: 'Commencer', value: 'go', primary: true }],
    });
    if (!go) return;
    if (!(await confirmBigDownload(model))) return tool.close();
    tool.wait('Préparation', `<p class="tool-big">Préparation du modèle…</p><p>${esc(model.name)} — la première fois, il peut être téléchargé.</p>`);
    await ensureLoaded(model);
    state.phase = 'idle';
    progress.hide();
    updateButtons();
    if (tool.cancelled) return;

    const results = [];
    for (const [i, cfg] of CALIBRATION_CONFIGS.entries()) {
      const sentence = DICTATION[i];
      const step = `Lecture ${i + 1} / ${CALIBRATION_CONFIGS.length}`;
      const ready = await tool.show({
        step,
        html: `<p>Réglage testé : <strong>${esc(cfg.label)}</strong></p><p>Clique sur « Commencer à lire », puis lis :</p><blockquote class="tool-sentence">${esc(sentence)}</blockquote>`,
        actions: [{ label: 'Annuler', value: null }, { label: 'Commencer à lire', value: 'go', primary: true }],
      });
      if (!ready) return;
      await recorder.start({ settings: { ...sound, ...cfg.settings } });
      monitor.start();
      const done = await tool.show({
        step,
        meter: true,
        timeout: 25,
        html: `<p class="tool-rec">● Enregistrement — lis la phrase :</p><blockquote class="tool-sentence">${esc(sentence)}</blockquote>`,
        actions: [{ label: 'Annuler', value: null }, { label: 'J’ai fini', value: 'done', primary: true }],
      });
      if (!done) return;
      const rec = await recorder.stop();
      monitor.stop();
      renderRec();
      tool.wait(step, '<p class="tool-big">Analyse de la lecture…</p><p>Transcription et comparaison avec la phrase lue.</p>');
      const pcm = await decodeToMono16k(rec.blob);
      const jobId = ++state.jobId;
      const r = await request(
        { type: 'transcribe', jobId, audio: pcm, language: 'fr', chunkLengthS: CHUNKING.chunkLengthS, strideLengthS: CHUNKING.strideLengthS, offsetS: 0, quiet: true },
        ['result', 'cancelled'],
        [pcm.buffer]
      );
      if (tool.cancelled) return;
      const hyp = (r.segments || []).map((x) => x.text).join(' ');
      const sc = dictationScore(sentence, hyp);
      const confs = (r.segments || []).map((x) => x.conf).filter((x) => x != null);
      results.push({ cfg, score: sc.score, ops: sc.ops, conf: confs.length ? confs.reduce((a, b) => a + b, 0) / confs.length : null });
    }

    // Meilleur réglage ; à 3 points près, on garde le réglage recommandé (A), plus simple
    const A = results[0];
    let best = [...results].sort((a, b) => b.score - a.score)[0];
    const close = best.score - A.score < 0.03;
    if (close) best = A;
    // « Compris : » = la transcription, mots faux surlignés + nombre de mots oubliés
    const diffHtml = (ops) => {
      const said = ops.filter((o) => o.type !== 'del').map((o) => (o.type === 'ok' ? esc(o.hyp ?? o.ref) : `<mark>${esc(o.hyp)}</mark>`)).join(' ');
      const missed = ops.filter((o) => o.type === 'del').length;
      return `<span class="lbl">Compris :</span> ${said || '<em>rien</em>'}${missed ? ` <span class="missed">· ${missed} mot${missed > 1 ? 's' : ''} oublié${missed > 1 ? 's' : ''}</span>` : ''}`;
    };
    const lvl = (s) => (s >= 0.9 ? 'ok' : s >= 0.75 ? 'warn' : 'err');
    const rows = results.map((x) => rowHtml({
      level: lvl(x.score),
      label: x.cfg.label,
      value: `${Math.round(x.score * 100)} %`,
      text: `${x.cfg.short}${x.conf != null ? ` · confiance du modèle ${Math.round(x.conf * 100)} %` : ''}`,
      diff: diffHtml(x.ops),
    }, x === best)).join('');
    const top = Math.max(...results.map((x) => x.score));
    const verdict = top < 0.5
      ? 'Scores trop faibles pour départager les réglages : le problème vient d’ailleurs (distance, bruit, écho ou modèle).'
      : close
        ? `Les réglages se valent (écart de ${Math.round((top - A.score) * 100)} point${top - A.score >= 0.015 ? 's' : ''} au plus) : on garde le réglage recommandé.`
        : `Meilleur réglage : « ${best.cfg.label} » (${Math.round(best.score * 100)} % de mots justes).`;
    const tip = best.score < 0.75
      ? '<div class="tool-advice"><p>Score faible quel que soit le réglage</p><ul><li>Rapproche-toi du PC, réduis le bruit ambiant, ou essaie un modèle plus précis.</li><li>Lance le « Diagnostic de la pièce » pour savoir si le problème vient de l’environnement.</li></ul></div>'
      : '';
    const act = await tool.show({
      step: 'Résultat',
      html: `<p class="tool-verdict">${esc(verdict)}</p><div class="tool-results">${rows}</div>${tip}
        <p>Mots surlignés : mal compris. Le réglage encadré en vert sera appliqué.</p>`,
      actions: [{ label: 'Fermer', value: null }, { label: 'Recommencer', value: 'again' }, { label: 'Appliquer ce réglage', value: 'apply', primary: true }],
    });
    if (act === 'apply') {
      Object.assign(sound, best.cfg.settings);
      saveSound();
      renderSound();
      tool.close();
      toast(`Réglage appliqué : ${best.cfg.label}.`, 'ok', 5000);
    } else if (act === 'again') {
      tool.close();
      runCalibration();
    }
  } catch (e) {
    console.error(e);
    toolCleanup();
    if (!tool.cancelled) { tool.close(); toast(`Calibration interrompue : ${e.message}`, 'err', 8000); }
  } finally {
    if (recorder.state !== 'idle') toolCleanup();
    if (state.phase === 'loading') { state.phase = 'idle'; progress.hide(); updateButtons(); }
    renderSound();
  }
}
