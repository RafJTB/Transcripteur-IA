// Moniteur en temps réel pendant l'enregistrement :
//  - bande du haut : volume du micro (dBFS), avec la zone idéale en vert et la saturation en rouge
//  - bande du bas  : confiance du modèle (0–100 %), en mode direct uniquement
// Les 30 dernières secondes défilent de droite à gauche.
// En relecture, le graphique suit la position de lecture : 20 s avant, 10 s après, tête de lecture.

const WINDOW_S = 30;
const DB_MIN = -60;
const DB_MAX = 0;

/** Seuils de volume (RMS en dBFS, mesuré sur ~20 ms). */
export const VOLUME = { low: -42, weak: -35, high: -8, clip: -0.5 };
/** Seuils de confiance du modèle. */
export const CONF = { good: 0.8, fair: 0.6 };

const toDb = (x) => 20 * Math.log10(Math.max(x, 1e-6));
const PLAY_AHEAD_S = 10; // relecture : ce qui arrive juste après la position
const STEP_S = 0.05; // un point de volume toutes les 50 ms (comme en direct)

/** Volume d'un audio complet (16 kHz) : un point { t, db, pk } toutes les 50 ms. Rapide même sur 1 h. */
export function levelsOf(pcm, rate = 16000) {
  const step = Math.round(rate * STEP_S);
  const sub = Math.round(rate * 0.02); // RMS sur ~20 ms, maximum sur 50 ms (comme le direct)
  const out = [];
  for (let from = 0; from + sub <= pcm.length; from += step) {
    const to = Math.min(pcm.length, from + step);
    let best = 0;
    let pk = 0;
    for (let a = from; a + sub <= to; a += sub) {
      let e = 0;
      for (let i = a; i < a + sub; i++) {
        const v = pcm[i];
        e += v * v;
        const m = v < 0 ? -v : v;
        if (m > pk) pk = m;
      }
      if (e > best) best = e;
    }
    out.push({ t: (from + step / 2) / rate, db: toDb(Math.sqrt(best / sub)), pk: toDb(pk) });
  }
  return out;
}

/** Premier index de `arr` (trié par t) dont t ≥ x. */
function lowerBound(arr, x) {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid].t < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
/** Points de `arr` dans [a, b]. */
const range = (arr, a, b) => arr.slice(lowerBound(arr, a), lowerBound(arr, b + 1e-9));

export function confLevel(c) {
  if (c == null) return null;
  return c >= CONF.good ? 'ok' : c >= CONF.fair ? 'warn' : 'err';
}

const clock = (s) => {
  s = Math.max(0, Math.floor(s));
  const h = Math.floor(s / 3600);
  const m = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const sec = String(s % 60).padStart(2, '0');
  return h ? `${h}:${m}:${sec}` : `${m}:${sec}`;
};

export class Monitor {
  constructor(canvas, { onState } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.onState = onState;
    this.levels = [];
    this.confs = [];
    this.now = 0;
    this.running = false;
    this.playback = null; // { levels, confs } de l'audio relu
    this.playT = null; // position de lecture affichée (null : pas de relecture)
    this._lastEmit = 0;
    this._lastDraw = 0;
    this.refreshColors();
    new ResizeObserver(() => this.draw()).observe(canvas);
    this.draw();
  }

  /** Couleurs lues dans le thème (clair ou sombre). À rappeler quand le thème change. */
  refreshColors() {
    const css = getComputedStyle(document.documentElement);
    const v = (n, d) => css.getPropertyValue(n).trim() || d;
    const rgb = (n, a, d) => `rgb(${v(n, d)} / ${a})`;
    this.col = {
      accent: v('--accent', '#4d8dff'),
      ok: v('--ok', '#34c690'),
      warn: v('--warn', '#f2b24c'),
      err: v('--err', '#f26b79'),
      text: v('--text-3', '#6c7588'),
      line: rgb('--ov', 0.08, '255 255 255'),
      path: rgb('--ov', 0.15, '255 255 255'),
      zone: rgb('--ok-rgb', 0.1, '52 198 144'),
      clipLine: rgb('--err-rgb', 0.35, '242 107 121'),
      peak: rgb('--accent-rgb', 0.25, '77 141 255'),
      head: v('--text', '#e7eaf0'),
      veil: rgb('--card-solid-rgb', 0.45, '17 24 35'),
    };
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
    this.playback = null;
    this.playT = null;
    this.reset();
  }

  // ---------- Relecture ----------
  /** Audio relu : volume calculé une fois pour tout le fichier. */
  setPlayback(pcm) {
    this.playback = { levels: pcm?.length ? levelsOf(pcm) : [], confs: this.playback?.confs || [] };
  }

  /** Compréhension du modèle phrase par phrase (au milieu de chaque phrase). */
  setPlaybackConfs(segments) {
    if (!this.playback) return;
    this.playback.confs = (segments || [])
      .filter((s) => s.conf != null && Number.isFinite(s.conf) && !s.edited)
      .map((s) => ({ t: (s.start + s.end) / 2, v: s.conf }))
      .sort((a, b) => a.t - b.t);
  }

  /** Affiche la relecture à la position t (secondes). Sans effet pendant un enregistrement. */
  showAt(t) {
    if (this.running || !this.playback) return;
    this.playT = t;
    this.levels = this.playback.levels;
    this.confs = this.playback.confs;
    this.now = t;
    this._tick();
  }

  /** Fin de la relecture : retour au graphique vide. */
  clearPlayback() {
    if (this.playT == null && !this.playback) return;
    this.playback = null;
    this.playT = null;
    if (!this.running) this.reset();
  }

  get replaying() { return this.playT != null && !this.running; }

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
    const win = range(this.levels, this.now - 6, this.now);
    if (win.length < 20) return null;
    const dbs = win.map((l) => l.db).sort((a, b) => a - b);
    const p90 = dbs[Math.floor(dbs.length * 0.9)];
    const clips = range(this.levels, this.now - 3, this.now).filter((l) => l.pk > VOLUME.clip).length;
    if (clips >= 3 || p90 > VOLUME.high)
      return { level: 'err', label: 'Trop fort', hint: 'Le son sature : éloigne-toi un peu du micro ou parle moins fort.' };
    // Bruit de fond de la pièce et ce qui en ressort (seuil adaptatif, comme la transcription)
    const last8 = range(this.levels, this.now - 8, this.now).map((l) => l.db).sort((a, b) => a - b);
    const floor = last8[Math.floor(last8.length * 0.15)];
    const top8 = last8[last8.length - 1];
    if (this.now >= 8 && (top8 < floor + 6 || top8 < -68))
      return { level: 'warn', label: 'Aucune voix', hint: 'Rien ne ressort du bruit depuis 8 s : vérifie que le bon micro est sélectionné et qu’il n’est pas coupé.' };
    if (p90 < floor + 6) return { level: 'idle', label: 'Pause', hint: null };
    if (p90 < -50)
      return { level: 'err', label: 'Voix très faibles', hint: 'Les voix arrivent très faiblement (loin du micro). Active le gain automatique ou monte le gain ; la transcription les amplifie, mais la qualité baisse avec la distance.' };
    if (p90 < VOLUME.low) return { level: 'err', label: 'Trop faible', hint: 'Rapproche-toi du micro ou parle plus fort.' };
    if (p90 < VOLUME.weak) return { level: 'warn', label: 'Un peu faible', hint: 'Rapproche-toi un peu du micro pour une meilleure transcription.' };
    return { level: 'ok', label: 'Bon niveau', hint: null };
  }

  /**
   * Correction de gain conseillée (dB) pour que la voix soit autour de −20 dBFS,
   * d'après les 6 dernières secondes. null s'il n'y a pas assez de parole.
   */
  gainAdvice(target = -20) {
    const win = range(this.levels, this.now - 6, this.now);
    if (win.length < 40) return null;
    const dbs = win.map((l) => l.db).sort((a, b) => a - b);
    const p90 = dbs[Math.floor(dbs.length * 0.9)];
    if (p90 < -55) return null;
    const peak = Math.max(...win.map((l) => l.pk));
    // Ne jamais pousser les crêtes au-delà de −3 dBFS
    return Math.min(target - p90, -3 - peak);
  }

  confState() {
    const recent = range(this.confs, this.now - 15, this.now);
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
    const ahead = this.replaying ? PLAY_AHEAD_S : 0;
    const end = this.now + ahead; // instant affiché au bord droit
    const x = (t) => W - ((end - t) / WINDOW_S) * W;
    const yDb = (db) => volTop + ((DB_MAX - Math.max(DB_MIN, Math.min(DB_MAX, db))) / (DB_MAX - DB_MIN)) * volH;
    const yConf = (v) => confTop + (1 - v) * confH;

    g.font = '600 10px system-ui, sans-serif';
    g.fillStyle = this.col.text;
    g.textBaseline = 'bottom';
    g.fillText('VOLUME', 0, volTop - 3);
    g.fillText('COMPRÉHENSION DU MODÈLE', 0, confTop - 3);
    g.textAlign = 'right';
    g.fillText(this.replaying ? `Relecture · ${clock(this.now)}` : '30 dernières s', W, volTop - 3);
    g.textAlign = 'left';

    // Zone de volume idéale + ligne de saturation
    g.fillStyle = this.col.zone;
    g.fillRect(0, yDb(VOLUME.high), W, yDb(VOLUME.weak) - yDb(VOLUME.high));
    g.strokeStyle = this.col.clipLine;
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
    const pts = range(this.levels, end - WINDOW_S, end);
    if (pts.length > 1) {
      g.beginPath();
      pts.forEach((p, i) => (i ? g.lineTo(x(p.t), yDb(p.pk)) : g.moveTo(x(p.t), yDb(p.pk))));
      g.strokeStyle = this.col.peak;
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
    const cs = range(this.confs, end - WINDOW_S, end);
    if (cs.length > 1) {
      g.beginPath();
      cs.forEach((p, i) => (i ? g.lineTo(x(p.t), yConf(p.v)) : g.moveTo(x(p.t), yConf(p.v))));
      g.strokeStyle = this.col.path;
      g.lineWidth = 1;
      g.stroke();
    }
    for (const p of cs) {
      g.fillStyle = this.col[confLevel(p.v)];
      g.beginPath();
      g.arc(x(p.t), yConf(p.v), 2.6, 0, Math.PI * 2);
      g.fill();
    }
    // Tête de lecture (relecture)
    if (this.replaying) {
      const px = Math.round(x(this.now)) + 0.5;
      g.strokeStyle = this.col.head;
      g.lineWidth = 1.5;
      g.beginPath();
      g.moveTo(px, volTop);
      g.lineTo(px, confTop + confH);
      g.stroke();
      // Ce qui n'est pas encore lu : légèrement voilé
      g.fillStyle = this.col.veil;
      g.fillRect(px + 1, volTop, W - px - 1, volH);
      g.fillRect(px + 1, confTop + 1, W - px - 2, confH - 2);
    }
    if (!cs.length && this.replaying) {
      g.fillStyle = this.col.text;
      g.textBaseline = 'middle';
      g.font = '11px system-ui, sans-serif';
      g.fillText('Pas de mesure de compréhension pour ce passage', 8, confTop + confH / 2);
    }
    if (!cs.length && this.running) {
      g.fillStyle = this.col.text;
      g.textBaseline = 'middle';
      g.font = '11px system-ui, sans-serif';
      g.fillText('S’affiche quand le modèle transcrit (mode direct)', 8, confTop + confH / 2);
    }
  }
}
