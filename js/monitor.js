// Moniteur en temps réel pendant l'enregistrement :
//  - bande du haut : volume du micro (dBFS), avec la zone idéale en vert et la saturation en rouge
//  - bande du bas  : confiance du modèle (0–100 %), en mode direct uniquement
// Les 30 dernières secondes défilent de droite à gauche.

const WINDOW_S = 30;
const DB_MIN = -60;
const DB_MAX = 0;

/** Seuils de volume (RMS en dBFS, mesuré sur ~20 ms). */
export const VOLUME = { low: -42, weak: -35, high: -8, clip: -0.5 };
/** Seuils de confiance du modèle. */
export const CONF = { good: 0.8, fair: 0.6 };

const toDb = (x) => 20 * Math.log10(Math.max(x, 1e-6));

export function confLevel(c) {
  if (c == null) return null;
  return c >= CONF.good ? 'ok' : c >= CONF.fair ? 'warn' : 'err';
}

export class Monitor {
  constructor(canvas, { onState } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.onState = onState;
    this.levels = [];
    this.confs = [];
    this.now = 0;
    this.running = false;
    this._lastEmit = 0;
    this._lastDraw = 0;
    const css = getComputedStyle(document.documentElement);
    const v = (n, d) => css.getPropertyValue(n).trim() || d;
    this.col = {
      accent: v('--accent', '#7c9cff'),
      ok: v('--ok', '#4fd1a5'),
      warn: v('--warn', '#f5b454'),
      err: v('--err', '#ff6b7a'),
      text: v('--text-3', '#6d7280'),
      line: 'rgba(255,255,255,0.08)',
    };
    new ResizeObserver(() => this.draw()).observe(canvas);
    this.draw();
  }

  reset() {
    this.levels = [];
    this.confs = [];
    this.now = 0;
    this.draw();
    this._emit(true);
  }

  /** Niveau du micro à l'instant t (secondes d'enregistrement). */
  addLevel(t, rms, peak) {
    const last = this.levels[this.levels.length - 1];
    const db = toDb(rms);
    const pk = toDb(peak);
    if (last && t - last.t < 0.05) {
      // ~20 points par seconde suffisent : on garde le maximum
      last.db = Math.max(last.db, db);
      last.pk = Math.max(last.pk, pk);
    } else {
      this.levels.push({ t, db, pk });
    }
    this.now = Math.max(this.now, t);
    while (this.levels.length && this.levels[0].t < this.now - WINDOW_S - 2) this.levels.shift();
    this._tick();
  }

  /** Confiance du modèle (0..1) pour l'audio situé au temps t. */
  addConf(t, conf) {
    if (conf == null || !Number.isFinite(conf)) return;
    this.confs.push({ t, v: conf });
    while (this.confs.length && this.confs[0].t < this.now - WINDOW_S - 2) this.confs.shift();
    this._tick();
  }

  start() {
    this.running = true;
    this.reset();
  }

  stop() {
    this.running = false;
    this.draw();
    this._emit(true);
  }

  _tick() {
    const now = performance.now();
    if (now - this._lastDraw > 60) { this._lastDraw = now; this.draw(); }
    this._emit();
  }

  // ---------- Diagnostic ----------
  volumeState() {
    // Analyse sur 6 s (une pause normale entre deux phrases ne déclenche rien)
    const win = this.levels.filter((l) => l.t >= this.now - 6);
    if (win.length < 20) return null;
    const dbs = win.map((l) => l.db).sort((a, b) => a - b);
    const p90 = dbs[Math.floor(dbs.length * 0.9)];
    const clips = this.levels.filter((l) => l.t >= this.now - 3 && l.pk > VOLUME.clip).length;
    if (clips >= 3 || p90 > VOLUME.high)
      return { level: 'err', label: 'Trop fort', hint: 'Le son sature : éloigne-toi un peu du micro ou parle moins fort.' };
    const last8 = this.levels.filter((l) => l.t >= this.now - 8);
    if (this.now >= 8 && Math.max(...last8.map((l) => l.db)) < -50)
      return { level: 'warn', label: 'Aucune voix', hint: 'Aucune voix depuis 8 s : vérifie que le bon micro est sélectionné et qu’il n’est pas coupé.' };
    if (p90 < -50) return { level: 'idle', label: 'Pause', hint: null };
    if (p90 < VOLUME.low) return { level: 'err', label: 'Trop faible', hint: 'Rapproche-toi du micro ou parle plus fort.' };
    if (p90 < VOLUME.weak) return { level: 'warn', label: 'Un peu faible', hint: 'Rapproche-toi un peu du micro pour une meilleure transcription.' };
    return { level: 'ok', label: 'Bon niveau', hint: null };
  }

  confState() {
    const recent = this.confs.filter((c) => c.t >= this.now - 15);
    if (!recent.length) return null;
    const m = recent.reduce((a, c) => a + c.v, 0) / recent.length;
    const level = confLevel(m);
    const pct = `${Math.round(m * 100)} %`;
    if (level === 'ok') return { level, label: `Bonne (${pct})`, hint: null };
    if (level === 'warn') return { level, label: `Moyenne (${pct})`, hint: 'Le modèle hésite : articule, évite de parler en même temps que d’autres, réduis le bruit ambiant.' };
    return { level, label: `Faible (${pct})`, hint: 'Le modèle comprend mal : vérifie la langue choisie, le volume et le bruit autour de toi.' };
  }

  _emit(force = false) {
    const now = performance.now();
    if (!force && now - this._lastEmit < 400) return;
    this._lastEmit = now;
    this.onState?.({ volume: this.volumeState(), conf: this.confState() });
  }

  // ---------- Dessin ----------
  draw() {
    const c = this.canvas;
    const dpr = window.devicePixelRatio || 1;
    const W = c.clientWidth;
    const H = c.clientHeight;
    if (!W || !H) return;
    if (c.width !== Math.round(W * dpr) || c.height !== Math.round(H * dpr)) {
      c.width = Math.round(W * dpr);
      c.height = Math.round(H * dpr);
    }
    const g = this.ctx;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);

    const volTop = 16;
    const volH = Math.round(H * 0.5);
    const confTop = volTop + volH + 22;
    const confH = H - confTop - 4;
    const x = (t) => W - ((this.now - t) / WINDOW_S) * W;
    const yDb = (db) => volTop + ((DB_MAX - Math.max(DB_MIN, Math.min(DB_MAX, db))) / (DB_MAX - DB_MIN)) * volH;
    const yConf = (v) => confTop + (1 - v) * confH;

    g.font = '600 10px system-ui, sans-serif';
    g.fillStyle = this.col.text;
    g.textBaseline = 'bottom';
    g.fillText('VOLUME', 0, volTop - 3);
    g.fillText('COMPRÉHENSION DU MODÈLE', 0, confTop - 3);
    g.textAlign = 'right';
    g.fillText('30 dernières s', W, volTop - 3);
    g.textAlign = 'left';

    // Zone de volume idéale + ligne de saturation
    g.fillStyle = 'rgba(79, 209, 165, 0.09)';
    g.fillRect(0, yDb(VOLUME.high), W, yDb(VOLUME.weak) - yDb(VOLUME.high));
    g.strokeStyle = 'rgba(255, 107, 122, 0.35)';
    g.setLineDash([3, 4]);
    g.beginPath();
    g.moveTo(0, yDb(-1));
    g.lineTo(W, yDb(-1));
    g.stroke();

    // Repères de confiance (60 % et 80 %)
    g.strokeStyle = this.col.line;
    for (const v of [CONF.fair, CONF.good]) {
      g.beginPath();
      g.moveTo(0, yConf(v));
      g.lineTo(W, yConf(v));
      g.stroke();
    }
    g.setLineDash([]);
    g.strokeRect(0.5, confTop + 0.5, W - 1, confH - 1);

    // Courbe de volume (crêtes en léger, moyenne en trait plein)
    const pts = this.levels.filter((l) => l.t >= this.now - WINDOW_S);
    if (pts.length > 1) {
      g.beginPath();
      pts.forEach((p, i) => (i ? g.lineTo(x(p.t), yDb(p.pk)) : g.moveTo(x(p.t), yDb(p.pk))));
      g.strokeStyle = 'rgba(124, 156, 255, 0.25)';
      g.lineWidth = 1;
      g.stroke();
      g.beginPath();
      pts.forEach((p, i) => (i ? g.lineTo(x(p.t), yDb(p.db)) : g.moveTo(x(p.t), yDb(p.db))));
      g.strokeStyle = this.col.accent;
      g.lineWidth = 1.6;
      g.stroke();
      g.fillStyle = this.col.err;
      for (const p of pts) if (p.pk > VOLUME.clip) g.fillRect(x(p.t) - 1, volTop, 2, 4);
    }

    // Points de confiance
    const cs = this.confs.filter((p) => p.t >= this.now - WINDOW_S);
    if (cs.length > 1) {
      g.beginPath();
      cs.forEach((p, i) => (i ? g.lineTo(x(p.t), yConf(p.v)) : g.moveTo(x(p.t), yConf(p.v))));
      g.strokeStyle = 'rgba(255,255,255,0.15)';
      g.lineWidth = 1;
      g.stroke();
    }
    for (const p of cs) {
      g.fillStyle = this.col[confLevel(p.v)];
      g.beginPath();
      g.arc(x(p.t), yConf(p.v), 2.6, 0, Math.PI * 2);
      g.fill();
    }
    if (!cs.length && this.running) {
      g.fillStyle = this.col.text;
      g.textBaseline = 'middle';
      g.font = '11px system-ui, sans-serif';
      g.fillText('S’affiche quand le modèle transcrit (mode direct)', 8, confTop + confH / 2);
    }
  }
}
