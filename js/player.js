// Lecteur audio du résultat : forme d'onde cliquable, position, vitesse,
// repères des passages à vérifier, et phrase en cours de lecture.

const SPEEDS = [1, 1.25, 1.5, 2, 0.75];
const BINS = 1600;

/** Crêtes de l'audio (0..1) regroupées en `bins` colonnes. Un seul passage, rapide même sur 1 h. */
export function computePeaks(pcm, bins = BINS) {
  const out = new Float32Array(bins);
  if (!pcm?.length) return out;
  const step = pcm.length / bins;
  for (let b = 0; b < bins; b++) {
    const from = Math.floor(b * step);
    const to = Math.min(pcm.length, Math.floor((b + 1) * step));
    let m = 0;
    for (let i = from; i < to; i++) {
      const v = pcm[i] < 0 ? -pcm[i] : pcm[i];
      if (v > m) m = v;
    }
    out[b] = m;
  }
  // Normalisation douce : un enregistrement faible reste lisible
  let max = 0;
  for (const v of out) if (v > max) max = v;
  if (max > 0) for (let b = 0; b < bins; b++) out[b] = Math.sqrt(out[b] / max);
  return out;
}

/** Index de la phrase qui contient l'instant t (segments triés), ou -1. */
export function segmentAt(segs, t) {
  let lo = 0;
  let hi = segs.length - 1;
  let best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (segs[mid].start <= t + 0.05) { best = mid; lo = mid + 1; } else hi = mid - 1;
  }
  if (best < 0) return -1;
  const s = segs[best];
  const next = segs[best + 1];
  // Jusqu'au début de la phrase suivante (les petites pauses restent sur la phrase en cours)
  return t <= Math.max(s.end, next ? Math.min(next.start, s.end + 1.5) : s.end + 1.5) ? best : -1;
}

export class Player {
  /**
   * @param {{root: HTMLElement, audio: HTMLAudioElement, canvas: HTMLCanvasElement, play: HTMLElement,
   *          time: HTMLElement, dur: HTMLElement, speed: HTMLElement, fmt: (s:number)=>string,
   *          onTime?: (t:number, playing:boolean)=>void, markers?: ()=>number[]}} o
   */
  constructor(o) {
    Object.assign(this, o);
    this.peaks = null;
    this.duration = 0;
    this._raf = 0;
    this.ctx = this.canvas.getContext('2d');
    const css = getComputedStyle(document.documentElement);
    this.col = { accent: css.getPropertyValue('--accent').trim() || '#7c9cff', warn: css.getPropertyValue('--warn').trim() || '#f5b454' };

    this.play.onclick = () => this.toggle();
    this.speed.onclick = () => {
      const i = (SPEEDS.indexOf(this.audio.playbackRate) + 1) % SPEEDS.length;
      this.audio.playbackRate = SPEEDS[i];
      this.speed.textContent = `${String(SPEEDS[i]).replace('.', ',')}×`;
    };
    const seekFromEvent = (e) => {
      const r = this.canvas.getBoundingClientRect();
      this.seek(((e.clientX - r.left) / r.width) * this.duration);
    };
    this.canvas.addEventListener('pointerdown', (e) => {
      seekFromEvent(e);
      this.canvas.setPointerCapture(e.pointerId);
      const move = (ev) => seekFromEvent(ev);
      this.canvas.addEventListener('pointermove', move);
      this.canvas.addEventListener('pointerup', () => this.canvas.removeEventListener('pointermove', move), { once: true });
    });
    this.canvas.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowLeft') { this.seek(this.audio.currentTime - 5); e.preventDefault(); }
      if (e.key === 'ArrowRight') { this.seek(this.audio.currentTime + 5); e.preventDefault(); }
    });
    this.audio.addEventListener('play', () => { this._state(); this._loop(); });
    this.audio.addEventListener('pause', () => this._state());
    this.audio.addEventListener('ended', () => this._state());
    this.audio.addEventListener('seeked', () => this._tick());
    this.audio.addEventListener('timeupdate', () => { if (this.audio.paused) this._tick(); });
    new ResizeObserver(() => this.draw()).observe(this.canvas);
  }

  /** Nouvel audio (pcm 16 kHz pour la forme d'onde, durée connue même pour un webm sans durée). */
  load(url, pcm, durationS) {
    this.audio.pause();
    this.audio.src = url;
    this.peaks = computePeaks(pcm);
    this.duration = durationS || 0;
    this.dur.textContent = this.fmt(this.duration);
    this.root.hidden = false;
    this._tick();
  }

  clear() {
    this.audio.pause();
    this.audio.removeAttribute('src');
    this.audio.load();
    this.peaks = null;
    this.duration = 0;
    this.root.hidden = true;
    this.onTime?.(-1, false);
  }

  get loaded() { return !!this.peaks && !this.root.hidden; }

  toggle() {
    if (!this.loaded) return;
    if (this.audio.paused) this.audio.play().catch(() => {});
    else this.audio.pause();
  }

  seek(t, { play = false } = {}) {
    if (!this.loaded) return;
    this.audio.currentTime = Math.max(0, Math.min(this.duration || 0, t));
    if (play) this.audio.play().catch(() => {});
    this._tick();
  }

  _state() {
    this.root.classList.toggle('playing', !this.audio.paused);
    this.play.setAttribute('aria-label', this.audio.paused ? 'Lecture' : 'Pause');
    this._tick();
  }

  _loop() {
    cancelAnimationFrame(this._raf);
    const f = () => {
      this._tick();
      if (!this.audio.paused) this._raf = requestAnimationFrame(f);
    };
    this._raf = requestAnimationFrame(f);
  }

  _tick() {
    const t = this.audio.currentTime || 0;
    this.time.textContent = this.fmt(t);
    this.canvas.setAttribute('aria-valuenow', Math.round(t));
    this.draw();
    this.onTime?.(t, !this.audio.paused);
  }

  draw() {
    const c = this.canvas;
    const W = c.clientWidth;
    const H = c.clientHeight;
    if (!W || !H) return;
    const dpr = window.devicePixelRatio || 1;
    if (c.width !== Math.round(W * dpr) || c.height !== Math.round(H * dpr)) {
      c.width = Math.round(W * dpr);
      c.height = Math.round(H * dpr);
    }
    const g = this.ctx;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    if (!this.peaks) return;
    const bar = 3;
    const n = Math.floor(W / bar);
    const pos = this.duration ? (this.audio.currentTime || 0) / this.duration : 0;
    const mid = H / 2;
    for (let i = 0; i < n; i++) {
      // Maximum des crêtes couvertes par cette barre
      const a = Math.floor((i / n) * this.peaks.length);
      const b = Math.max(a + 1, Math.floor(((i + 1) / n) * this.peaks.length));
      let v = 0;
      for (let k = a; k < b; k++) if (this.peaks[k] > v) v = this.peaks[k];
      const h = Math.max(2, v * (H - 10));
      g.fillStyle = i / n < pos ? this.col.accent : 'rgba(255,255,255,0.2)';
      g.fillRect(i * bar, mid - h / 2, bar - 1.2, h);
    }
    // Passages à vérifier
    g.fillStyle = this.col.warn;
    for (const t of this.markers?.() || []) {
      if (!this.duration) break;
      g.fillRect(Math.round((t / this.duration) * W) - 1, 0, 2, 4);
    }
    // Tête de lecture
    g.fillStyle = '#e9eaee';
    g.fillRect(Math.round(pos * W), 0, 1.5, H);
  }
}
