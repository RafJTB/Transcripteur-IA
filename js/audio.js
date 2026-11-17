// Décodage des fichiers audio/vidéo et enregistrement micro.
import { SAMPLE_RATE } from './config.js';

export const ACCEPTED_EXT = ['mp3', 'wav', 'm4a', 'mp4', 'webm', 'ogg', 'oga', 'opus', 'flac', 'aac', 'mov', 'mkv', 'weba'];
export const MAX_FILE_MB = 1500;

/** Réglages du son par défaut (identiques au comportement d'origine). */
export const DEFAULT_AUDIO_SETTINGS = Object.freeze({
  deviceId: '',
  gainDb: 0,
  autoGainControl: true,
  noiseSuppression: true,
  echoCancellation: true,
  highpass: false,
});

/** Liste des micros (les noms n'apparaissent qu'après la première autorisation du micro). */
export async function listMicrophones() {
  try {
    const all = await navigator.mediaDevices.enumerateDevices();
    return all.filter((d) => d.kind === 'audioinput' && d.deviceId !== 'communications');
  } catch {
    return [];
  }
}

export class AudioError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/**
 * Décode un fichier (audio ou vidéo) en Float32Array mono 16 kHz.
 * Le navigateur rééchantillonne directement grâce à l'OfflineAudioContext à 16 kHz.
 */
export async function decodeToMono16k(blob) {
  if (blob.size > MAX_FILE_MB * 1048576) {
    throw new AudioError('too-large', `Fichier trop volumineux (${Math.round(blob.size / 1048576)} Mo). Limite conseillée : ${MAX_FILE_MB} Mo.`);
  }
  const buf = await blob.arrayBuffer();
  const ctx = new OfflineAudioContext(1, 1, SAMPLE_RATE);
  let decoded;
  try {
    decoded = await ctx.decodeAudioData(buf);
  } catch {
    throw new AudioError('unsupported', 'Format non pris en charge ou fichier sans piste audio lisible par le navigateur.');
  }
  const n = decoded.length;
  if (!n) throw new AudioError('empty', 'Le fichier ne contient pas d’audio.');
  if (decoded.numberOfChannels === 1) return decoded.getChannelData(0).slice();
  const out = new Float32Array(n);
  const chans = decoded.numberOfChannels;
  for (let c = 0; c < chans; c++) {
    const d = decoded.getChannelData(c);
    for (let i = 0; i < n; i++) out[i] += d[i] / chans;
  }
  return out;
}

export function isAcceptedFile(file) {
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  return ACCEPTED_EXT.includes(ext) || /^(audio|video)\//.test(file.type);
}

/**
 * Rééchantillonneur en flux (fréquence native du micro → 16 kHz) par moyenne de blocs,
 * suffisant pour la voix et sans état compliqué.
 */
class StreamResampler {
  constructor(inRate, outRate = SAMPLE_RATE) {
    this.ratio = inRate / outRate;
    this.rest = new Float32Array(0);
  }

  push(input) {
    const data = new Float32Array(this.rest.length + input.length);
    data.set(this.rest);
    data.set(input, this.rest.length);
    const r = this.ratio;
    const n = Math.floor(data.length / r);
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const a = Math.floor(i * r);
      const b = Math.max(a + 1, Math.floor((i + 1) * r));
      let s = 0;
      for (let j = a; j < b; j++) s += data[j];
      out[i] = s / (b - a);
    }
    this.rest = data.slice(Math.floor(n * r));
    return out;
  }
}

/**
 * Enregistreur micro : démarrer / pause / reprendre / arrêter / supprimer,
 * avec niveau sonore (0..1) et durée.
 *  - onChunk(blob, idx) : morceau compressé toutes les secondes (sauvegarde anti-plantage)
 *  - onPcm(Float32Array 16 kHz) : audio brut pour la transcription en direct (si `pcm: true`)
 * Le résultat final est un Blob (webm/opus).
 */
export class Recorder {
  constructor({ onLevel, onTick, onChunk, onPcm } = {}) {
    this.onLevel = onLevel;
    this.onTick = onTick;
    this.onChunk = onChunk;
    this.onPcm = onPcm;
    this.state = 'idle';
    this._elapsed = 0;
  }

  static async isAvailable() {
    return !!navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== 'undefined';
  }

  get mimeType() {
    return this.mr?.mimeType || 'audio/webm';
  }

  /**
   * Démarre le micro.
   *  - `preview: true` : test du micro (niveau seulement, rien n'est enregistré)
   *  - `settings` : réglages du son (voir DEFAULT_AUDIO_SETTINGS)
   * Chaîne audio : micro → filtre des basses (option) → gain → [enregistrement, transcription, mesure]
   * Le gain est donc appliqué à tout : ce que tu vois sur le graphique est ce que le modèle entend.
   */
  async start({ pcm = false, preview = false, settings = DEFAULT_AUDIO_SETTINGS } = {}) {
    if (!(await Recorder.isAvailable())) throw new AudioError('mic-unsupported', 'Ce navigateur ne permet pas l’enregistrement audio.');
    const audio = {
      channelCount: 1,
      echoCancellation: settings.echoCancellation,
      noiseSuppression: settings.noiseSuppression,
      autoGainControl: settings.autoGainControl,
    };
    if (settings.deviceId) audio.deviceId = { exact: settings.deviceId };
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio });
    } catch (e) {
      if (e.name === 'OverconstrainedError' && settings.deviceId) {
        // Micro choisi débranché : on reprend le micro par défaut
        return this.start({ pcm, preview, settings: { ...settings, deviceId: '' } });
      }
      if (e.name === 'NotAllowedError' || e.name === 'SecurityError')
        throw new AudioError('mic-denied', 'Accès au micro refusé. Autorise le micro dans la barre d’adresse (icône cadenas) puis réessaie.');
      if (e.name === 'NotFoundError' || e.name === 'OverconstrainedError')
        throw new AudioError('mic-missing', 'Aucun micro détecté. Branche un micro ou un casque puis réessaie.');
      if (e.name === 'NotReadableError')
        throw new AudioError('mic-busy', 'Le micro est déjà utilisé par une autre application (Teams, Zoom…).');
      throw new AudioError('mic-error', `Erreur micro : ${e.message || e.name}`);
    }
    this.deviceLabel = this.stream.getAudioTracks()[0]?.label || '';

    this.ctx = new AudioContext();
    if (this.ctx.state === 'suspended') await this.ctx.resume().catch(() => {});
    const src = this.ctx.createMediaStreamSource(this.stream);
    this.highpass = this.ctx.createBiquadFilter();
    this.highpass.type = 'highpass';
    this.highpass.Q.value = 0.7;
    this.gain = this.ctx.createGain();
    src.connect(this.highpass).connect(this.gain);
    this.setHighpass(settings.highpass);
    this.setGain(settings.gainDb);

    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    this.gain.connect(this.analyser);
    this._buf = new Float32Array(this.analyser.fftSize);

    this.mr = null;
    if (!preview) {
      // On enregistre le son APRÈS réglages (gain, filtre)
      const dest = this.ctx.createMediaStreamDestination();
      this.gain.connect(dest);
      const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'].find((t) => MediaRecorder.isTypeSupported(t)) || '';
      this.chunks = [];
      this.mr = new MediaRecorder(dest.stream, mime ? { mimeType: mime } : undefined);
      this.mr.ondataavailable = (e) => {
        if (!e.data.size) return;
        this.chunks.push(e.data);
        this.onChunk?.(e.data, this.chunks.length - 1);
      };
      this.mr.start(1000);
    }

    if (pcm && !preview) {
      await this.ctx.audioWorklet.addModule(new URL('./pcm-worklet.js', import.meta.url));
      const node = new AudioWorkletNode(this.ctx, 'pcm-capture');
      const resampler = new StreamResampler(this.ctx.sampleRate);
      node.port.onmessage = (e) => {
        if (this.state !== 'recording') return; // pause : on ignore l'audio
        this.onPcm?.(resampler.push(e.data));
      };
      const mute = this.ctx.createGain();
      mute.gain.value = 0;
      this.gain.connect(node).connect(mute).connect(this.ctx.destination);
      this._worklet = node;
    }

    this.state = preview ? 'preview' : 'recording';
    this._elapsed = 0;
    this._last = performance.now();
    this._loop();
  }

  /** Gain en décibels (−12 à +24), réglable pendant l'enregistrement. */
  setGain(db) {
    if (!this.gain || this.ctx?.state === 'closed') return;
    const v = Math.pow(10, (Number(db) || 0) / 20);
    this.gain.gain.setTargetAtTime(v, this.ctx.currentTime, 0.03);
  }

  /** Filtre des basses : supprime les grondements (ventilation, chocs sur la table) sous ~90 Hz. */
  setHighpass(on) {
    if (!this.highpass || this.ctx?.state === 'closed') return;
    this.highpass.frequency.setTargetAtTime(on ? 90 : 10, this.ctx.currentTime, 0.03);
  }

  /** Fin du test du micro. */
  stopPreview() {
    if (this.state === 'preview') this._cleanup();
  }

  _loop() {
    if (this.state === 'idle') return;
    const now = performance.now();
    const active = this.state === 'recording' || this.state === 'preview';
    if (active) this._elapsed += (now - this._last) / 1000;
    this._last = now;
    this.analyser.getFloatTimeDomainData(this._buf);
    let s = 0;
    let peak = 0;
    for (let i = 0; i < this._buf.length; i++) {
      const v = this._buf[i];
      s += v * v;
      if (Math.abs(v) > peak) peak = Math.abs(v);
    }
    const rms = Math.sqrt(s / this._buf.length);
    const level = active ? Math.min(1, rms * 6) : 0;
    // level : 0..1 pour le vumètre ; rms / peak bruts (0..1) pour le graphique en décibels
    this.onLevel?.(level, active ? { rms, peak, t: this._elapsed } : null);
    this.onTick?.(this._elapsed);
    this._raf = requestAnimationFrame(() => this._loop());
  }

  pause() {
    if (this.state !== 'recording') return;
    this.mr.pause();
    this.state = 'paused';
  }

  resume() {
    if (this.state !== 'paused') return;
    this.mr.resume();
    this.state = 'recording';
  }

  stop() {
    return new Promise((resolve) => {
      if (!this.mr || this.state === 'idle') return resolve(null);
      this.mr.onstop = () => {
        const blob = new Blob(this.chunks, { type: this.mr.mimeType || 'audio/webm' });
        this._cleanup();
        resolve({ blob, seconds: this._elapsed });
      };
      this.mr.stop();
    });
  }

  cancel() {
    if (this.mr && this.state !== 'idle') {
      this.mr.onstop = null;
      this.mr.ondataavailable = null; // plus aucune sauvegarde
      this.chunks = [];
      try { this.mr.stop(); } catch { /* ignore */ }
    }
    this._cleanup();
  }

  _cleanup() {
    this.state = 'idle';
    cancelAnimationFrame(this._raf);
    if (this._worklet) { this._worklet.port.onmessage = null; this._worklet = null; }
    this.stream?.getTracks().forEach((t) => t.stop());
    this.ctx?.close().catch(() => {});
    this.gain = null;
    this.highpass = null;
    this.onLevel?.(0);
  }
}
