// Transcription en direct pendant l'enregistrement.
//
// Principe : on garde tout l'audio du micro (16 kHz). Toutes les ~3 s, on transcrit
// la partie « non validée » (depuis la position P jusqu'à maintenant, 30 s max).
// Les phrases terminées depuis plus d'une seconde sont validées (P avance) ;
// la dernière phrase, peut-être coupée, reste provisoire et sera retranscrite au tour suivant.
// À l'arrêt, la fin non validée est retranscrite normalement (meilleure qualité).
import { SAMPLE_RATE as SR } from './config.js';

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

  /** Saute le silence en début de fenêtre (Whisper date mal une phrase précédée de silence). */
  _skipSilence(from, to) {
    const frame = SR / 10; // 100 ms
    let i = from;
    while (i + frame <= to) {
      let e = 0;
      for (let k = i; k < i + frame; k++) e += this.buf[k] * this.buf[k];
      if (Math.sqrt(e / frame) > 0.006) break;
      i += frame;
    }
    return Math.max(from, i - SR / 4); // 250 ms de marge
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
