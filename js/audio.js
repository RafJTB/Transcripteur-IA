// Décodage des fichiers audio/vidéo et enregistrement micro.
import { SAMPLE_RATE } from './config.js';

export const ACCEPTED_EXT = ['mp3', 'wav', 'm4a', 'mp4', 'webm', 'ogg', 'oga', 'opus', 'flac', 'aac', 'mov', 'mkv', 'weba'];
export const MAX_FILE_MB = 1500;

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
 * Enregistreur micro : démarrer / pause / reprendre / arrêter,
 * avec niveau sonore (0..1) et durée. Le résultat est un Blob (webm/opus).
 *
 * Point d'extension V2 (quasi temps réel) : `onBlock(Float32Array 16 kHz)`
 * sera alimenté par un AudioWorklet qui découpe le flux en blocs de quelques
 * secondes envoyés au worker pendant l'enregistrement.
 */
export class Recorder {
  constructor({ onLevel, onTick } = {}) {
    this.onLevel = onLevel;
    this.onTick = onTick;
    this.state = 'idle';
    this._elapsed = 0;
  }

  static async isAvailable() {
    return !!navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== 'undefined';
  }

  async start() {
    if (!(await Recorder.isAvailable())) throw new AudioError('mic-unsupported', 'Ce navigateur ne permet pas l’enregistrement audio.');
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch (e) {
      if (e.name === 'NotAllowedError' || e.name === 'SecurityError')
        throw new AudioError('mic-denied', 'Accès au micro refusé. Autorise le micro dans la barre d’adresse (icône cadenas) puis réessaie.');
      if (e.name === 'NotFoundError' || e.name === 'OverconstrainedError')
        throw new AudioError('mic-missing', 'Aucun micro détecté. Branche un micro ou un casque puis réessaie.');
      if (e.name === 'NotReadableError')
        throw new AudioError('mic-busy', 'Le micro est déjà utilisé par une autre application (Teams, Zoom…).');
      throw new AudioError('mic-error', `Erreur micro : ${e.message || e.name}`);
    }
    const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'].find((t) => MediaRecorder.isTypeSupported(t)) || '';
    this.chunks = [];
    this.mr = new MediaRecorder(this.stream, mime ? { mimeType: mime } : undefined);
    this.mr.ondataavailable = (e) => e.data.size && this.chunks.push(e.data);
    this.mr.start(1000);

    this.ctx = new AudioContext();
    const src = this.ctx.createMediaStreamSource(this.stream);
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    src.connect(this.analyser);
    this._buf = new Float32Array(this.analyser.fftSize);

    this.state = 'recording';
    this._elapsed = 0;
    this._last = performance.now();
    this._loop();
  }

  _loop() {
    if (this.state === 'idle') return;
    const now = performance.now();
    if (this.state === 'recording') this._elapsed += (now - this._last) / 1000;
    this._last = now;
    this.analyser.getFloatTimeDomainData(this._buf);
    let s = 0;
    for (let i = 0; i < this._buf.length; i++) s += this._buf[i] * this._buf[i];
    const level = this.state === 'recording' ? Math.min(1, Math.sqrt(s / this._buf.length) * 6) : 0;
    this.onLevel?.(level);
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
      try { this.mr.stop(); } catch { /* ignore */ }
    }
    this._cleanup();
  }

  _cleanup() {
    this.state = 'idle';
    cancelAnimationFrame(this._raf);
    this.stream?.getTracks().forEach((t) => t.stop());
    this.ctx?.close().catch(() => {});
    this.onLevel?.(0);
  }
}
