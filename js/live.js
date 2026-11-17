// Transcription en direct pendant l'enregistrement.
//
// Principe : on garde tout l'audio du micro (16 kHz). Toutes les ~3 s, on transcrit
// la partie « non validée » (depuis la position P jusqu'à maintenant, 30 s max).
// Les phrases terminées depuis plus d'une seconde sont validées (P avance) ;
// la dernière phrase, peut-être coupée, reste provisoire et sera retranscrite au tour suivant.
// À l'arrêt, la fin non validée est retranscrite normalement (meilleure qualité).
import { SAMPLE_RATE as SR } from './config.js';
import { speechStart } from './audio.js';

export class LiveSession {
  /**
   * @param {(pcm: Float32Array, offsetS: number) => Promise<Array<{start:number,end:number,text:string}>>} transcribeWindow
   * @param {(s: LiveSession) => void} onUpdate
   */
  constructor({ transcribeWindow, onUpdate, onError, stepS = 3, maxWindowS = 28 }) {
    this.transcribeWindow = transcribeWindow;
    this.onUpdate = onUpdate;
    this.onError = onError;
    this.stepS = stepS;
    this.maxWindowS = maxWindowS;
    this.buf = new Float32Array(SR * 120);
    this.len = 0; // échantillons reçus
    this.P = 0; // échantillons validés
    this.lastRunLen = 0;
    this.committed = [];
    this.tentative = [];
    this.ready = false; // modèle chargé ?
    this.busy = false;
    this.stopped = false;
    this.failed = false;
    this.timer = setInterval(() => this._tick(), 400);
  }

  push(pcm) {
    if (this.stopped) return;
    if (this.len + pcm.length > this.buf.length) {
      const bigger = new Float32Array(Math.max(this.buf.length * 2, this.len + pcm.length));
      bigger.set(this.buf.subarray(0, this.len));
      this.buf = bigger;
    }
    this.buf.set(pcm, this.len);
    this.len += pcm.length;
  }

  /** Audio complet reçu (copie). */
  get pcm() {
    return this.buf.slice(0, this.len);
  }

  get committedS() {
    return this.P / SR;
  }

  /** Retard du texte affiché (validé ou provisoire) par rapport au micro, en secondes. */
  get lagS() {
    return (this.len - this.lastRunLen) / SR;
  }

  /** Saute le silence en début de fenêtre (seuil adapté au bruit de la pièce). */
  _skipSilence(from, to) {
    return speechStart(this.buf, from, to);
  }

  async _tick() {
    if (!this.ready || this.busy || this.stopped || this.failed) return;
    if (this.len - this.lastRunLen < this.stepS * SR || this.len - this.P < SR) return;
    this.busy = true;
    try {
      await this._step();
    } catch (e) {
      this.failed = true;
      this.onError?.(e);
    } finally {
      this.busy = false;
    }
  }

  async _step() {
    const lenAtRun = this.len;
    const start = this._skipSilence(this.P, lenAtRun);
    if (lenAtRun - start < SR / 2) {
      // Rien que du silence depuis P : on avance sans appeler le modèle.
      this.P = Math.max(this.P, lenAtRun - SR);
      this.lastRunLen = lenAtRun;
      return;
    }
    const end = Math.min(lenAtRun, start + this.maxWindowS * SR);
    const segs = await this.transcribeWindow(this.buf.slice(start, end), start / SR);
    if (this.stopped) return;
    this.lastRunLen = lenAtRun;
    const winEndS = end / SR;
    const winDurS = (end - start) / SR;

    // Phrases stables : terminées au moins 1 s avant la fin de la fenêtre (jamais la dernière).
    let n = 0;
    for (let i = 0; i < segs.length - 1; i++) if (segs[i].end <= winEndS - 1) n = i + 1;
    // Whisper a manifestement fini (plus rien depuis 3 s dans une fenêtre d'au moins 8 s) :
    // on valide tout et la fenêtre suivante repart après, au lieu d'attendre qu'elle soit pleine.
    if (segs.length && winDurS >= 8 && segs[segs.length - 1].end <= winEndS - 3) n = segs.length;
    // Fenêtre presque pleine sans coupure nette : on force la validation pour avancer.
    if (n === 0 && winDurS >= this.maxWindowS - 4 && segs.length) n = Math.max(1, segs.length - 1);

    if (n > 0) {
      this.committed.push(...segs.slice(0, n));
      const newP = Math.round(segs[n - 1].end * SR);
      this.P = Math.min(end, Math.max(newP, start + SR / 2));
    } else if (!segs.length && winDurS >= 8) {
      // Long passage sans parole : on avance en gardant 2 s de marge.
      this.P = end - 2 * SR;
    }
    this.tentative = segs.slice(n);
    this.onUpdate?.(this);
  }

  /** Arrête les transcriptions en direct (attend celle en cours). */
  async stop() {
    this.stopped = true;
    clearInterval(this.timer);
    while (this.busy) await new Promise((r) => setTimeout(r, 50));
  }
}

/**
 * Direct avec Voxtral Realtime : l'audio est envoyé en continu au worker, qui renvoie
 * les phrases au fil de l'eau (~0,5 s de décalage). À l'arrêt, pas de re-transcription :
 * on attend juste que le modèle ait fini de traiter l'audio déjà reçu.
 * Même interface que LiveSession pour le reste de l'application.
 */
export class VoxtralLive {
  constructor({ send, onUpdate, onError }) {
    this.kind = 'voxtral';
    this.send = send;
    this.onUpdate = onUpdate;
    this.onError = onError;
    this.buf = new Float32Array(SR * 120);
    this.len = 0;
    this.pending = [];
    this.committed = [];
    this.tentative = [];
    this.doneS = 0;
    this.ready = false;
    this.failed = false;
    this.stopped = false;
    this.finishing = false;
    this.jobId = null;
    this._done = null;
  }

  push(pcm) {
    if (this.stopped) return;
    if (this.len + pcm.length > this.buf.length) {
      const b = new Float32Array(Math.max(this.buf.length * 2, this.len + pcm.length));
      b.set(this.buf.subarray(0, this.len));
      this.buf = b;
    }
    this.buf.set(pcm, this.len);
    this.len += pcm.length;
    if (this.failed) return;
    if (this.ready) this._send(pcm);
    else this.pending.push(pcm.slice());
  }

  _send(pcm) {
    const copy = pcm.slice();
    this.send({ type: 'stream-audio', pcm: copy }, [copy.buffer]);
  }

  /** Le modèle est chargé : on démarre le flux et on envoie l'audio mis en attente. */
  start(jobId) {
    this.jobId = jobId;
    this.send({ type: 'stream-start', jobId });
    for (const p of this.pending) this._send(p);
    this.pending = [];
    this.ready = true;
    this.onUpdate?.(this);
  }

  /** Messages du worker. */
  handle(m) {
    if (m.jobId !== this.jobId) return;
    if (m.type === 'stream-seg') {
      this.committed.push(m.segment);
      this.tentative = [];
    } else if (m.type === 'stream-partial') {
      this.tentative = m.partial ? [m.partial] : [];
    } else if (m.type === 'stream-pos') {
      this.doneS = m.doneS;
    } else if (m.type === 'stream-done') {
      this.tentative = [];
      this._done?.(m.segments);
      this._done = null;
    }
    this.onUpdate?.(this);
  }

  fail(e) {
    if (this.failed) return;
    this.failed = true;
    this._done?.(null);
    this._done = null;
    this.onError?.(e);
  }

  get pcm() {
    return this.buf.slice(0, this.len);
  }

  get committedS() {
    return this.committed.length ? this.committed[this.committed.length - 1].end : 0;
  }

  get P() {
    return Math.min(this.len, Math.round(this.committedS * SR));
  }

  /** Audio reçu mais pas encore traité par le modèle, en secondes. */
  get lagS() {
    return this.ready ? Math.max(0, this.len / SR - this.doneS) : 0;
  }

  /** Arrêt normal : renvoie toutes les phrases (null si le direct a échoué). */
  finish() {
    if (!this.ready || this.failed) return Promise.resolve(null);
    this.finishing = true;
    return new Promise((resolve) => {
      this._done = resolve;
      this.send({ type: 'stream-end' });
    });
  }

  /** Arrêt sans rien garder. */
  async stop() {
    this.stopped = true;
    if (this.ready && !this.failed) this.send({ type: 'stream-abort' });
    this._done?.(null);
    this._done = null;
  }
}
