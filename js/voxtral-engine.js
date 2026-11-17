// Moteur Voxtral Realtime (Mistral) : vraie transcription en flux continu.
//
// Contrairement à Whisper (qui relit des blocs de 30 s), Voxtral écrit le texte au fil
// de l'audio : un pas de génération = 80 ms d'audio, avec ~480 ms de décalage.
//
// Le cache du modèle grossit avec la durée (~100 Ko par pas). Pour ne pas saturer la
// mémoire d'une carte graphique intégrée, on découpe en « sessions » d'environ 2 min,
// coupées sur un silence. Chaque session repart d'un état neuf.
//
// Ce module ne dépend pas du navigateur : il reçoit le modèle, le processeur et le
// tokenizer déjà chargés (testable sous Node avec un mini-modèle).

const SR = 16000;
const STEP_S = 0.08; // 1 token = 80 ms d'audio
export const SESSION_SOFT_S = 110; // au-delà, on coupe au premier silence
export const SESSION_HARD_S = 150; // coupe forcée

function rms(a, from = 0, to = a.length) {
  let s = 0;
  for (let i = from; i < to; i++) s += a[i] * a[i];
  return Math.sqrt(s / Math.max(1, to - from));
}

/** Points de coupe d'un fichier : sessions ≤ 150 s, coupées sur le passage le plus calme. */
export function planSessions(audio) {
  const out = [];
  let start = 0;
  const frame = SR / 10;
  while (start < audio.length) {
    if (audio.length - start <= SESSION_HARD_S * SR) {
      out.push({ off: start, end: audio.length });
      break;
    }
    let best = start + SESSION_HARD_S * SR;
    let bestE = Infinity;
    for (let i = start + SESSION_SOFT_S * SR; i + frame <= start + SESSION_HARD_S * SR; i += frame) {
      const e = rms(audio, i, i + frame);
      if (e < bestE) { bestE = e; best = i + frame / 2; }
      if (e < 0.004) break; // vrai silence trouvé : on coupe tout de suite
    }
    out.push({ off: start, end: Math.round(best) });
    start = Math.round(best);
  }
  return out;
}

/**
 * Découpe le flux de tokens en phrases horodatées.
 * Nouvelle phrase : après ~0,8 s sans texte, sur une ponctuation finale, ou au-delà de 15 s.
 */
class Segmenter {
  constructor(tokenizer, offsetS, { onSegment, onPartial, onStep, clean }) {
    this.tok = tokenizer;
    this.offsetS = offsetS;
    this.onSegment = onSegment;
    this.onPartial = onPartial;
    this.onStep = onStep;
    this.clean = clean || ((t) => t);
    this.special = new Set((tokenizer.all_special_ids || []).map(Number));
    this.k = -1;
    this.ids = [];
    this.start = 0;
    this.lastT = 0;
    this.silence = 0;
  }

  put(value) {
    if (this.k < 0) { this.k = 0; return; } // premier appel = invite (BOS + pads)
    for (const raw of value[0] ?? []) this._token(Number(raw));
  }

  _token(id) {
    const t = this.offsetS + (this.k + 1) * STEP_S;
    this.k++;
    this.onStep?.(t);
    if (this.special.has(id) || id < 1000) {
      // Pas de texte sur ce pas (silence, remplissage)
      if (++this.silence >= 10 && this.ids.length) this.flush();
      return;
    }
    const piece = this.tok.decode([id]);
    if (this.ids.length && t - this.start > 15 && /^\s/.test(piece)) this.flush();
    if (!this.ids.length) this.start = Math.max(this.offsetS, t - 0.4);
    this.ids.push(id);
    this.lastT = t;
    this.silence = 0;
    const text = this.tok.decode(this.ids, { skip_special_tokens: true }).trim();
    if (/[.!?…]$/.test(text) && t - this.start > 1.5) return this.flush();
    this.onPartial?.({ start: this.start, end: t, text });
  }

  end() {
    this.flush();
  }

  flush() {
    if (!this.ids.length) return;
    const text = this.clean(this.tok.decode(this.ids, { skip_special_tokens: true }).trim());
    const seg = { start: this.start, end: this.lastT + STEP_S, text };
    this.ids = [];
    this.silence = 0;
    if (text) this.onSegment?.(seg);
    this.onPartial?.(null);
  }
}

/**
 * Une session de flux : on y pousse l'audio (16 kHz mono) au fur et à mesure,
 * `run()` transcrit jusqu'à ce que l'entrée soit terminée (`finishInput`).
 */
export class VoxtralSession {
  constructor(vox, { offsetS = 0, onSegment, onPartial, onStep, clean, yieldEvery = 8 } = {}) {
    this.vox = vox;
    this.offsetS = offsetS;
    this.handlers = { onSegment, onPartial, onStep, clean };
    this.buf = new Float32Array(SR * 30);
    this.len = 0;
    this.inputEnded = false;
    this.aborted = false;
    this.yieldEvery = yieldEvery;
    this._wake = null;
  }

  push(pcm) {
    if (this.inputEnded) return;
    if (this.len + pcm.length > this.buf.length) {
      const b = new Float32Array(Math.max(this.buf.length * 2, this.len + pcm.length));
      b.set(this.buf.subarray(0, this.len));
      this.buf = b;
    }
    this.buf.set(pcm, this.len);
    this.len += pcm.length;
    this._notify();
  }

  get seconds() {
    return this.len / SR;
  }

  /** Fin de l'audio : on ajoute le silence nécessaire pour que le modèle « vide » son décalage. */
  finishInput() {
    if (this.inputEnded) return;
    const { processor } = this.vox;
    this.push(new Float32Array(processor.num_right_pad_tokens * processor.raw_audio_length_per_tok));
    this.inputEnded = true;
    this._notify();
  }

  abort() {
    this.aborted = true;
    this.inputEnded = true;
    this._notify();
  }

  _notify() {
    const w = this._wake;
    this._wake = null;
    w?.();
  }

  _waitData() {
    return new Promise((r) => (this._wake = r));
  }

  async _features(firstFeatures) {
    const self = this;
    const { processor } = this.vox;
    const { hop_length, n_fft } = processor.feature_extractor.config;
    const winHalf = Math.floor(n_fft / 2);
    return (async function* () {
      yield firstFeatures;
      let mel = processor.num_mel_frames_first_audio_chunk;
      let start = mel * hop_length - winHalf;
      let n = 0;
      while (!self.aborted) {
        const end = start + processor.num_samples_per_audio_chunk;
        while (self.len < end && !self.inputEnded) await self._waitData();
        if (self.len < end || self.aborted) return;
        // Rend la main régulièrement : les messages (audio, annulation) peuvent arriver.
        if (++n % self.yieldEvery === 0) await new Promise((r) => setTimeout(r, 0));
        const { input_features } = await processor(self.buf.slice(start, end), { is_streaming: true, is_first_audio_chunk: false });
        yield input_features;
        mel += processor.audio_length_per_tok;
        start = mel * hop_length - winHalf;
      }
    })();
  }

  /** Transcrit toute la session. Renvoie la liste des phrases. */
  async run() {
    const { model, processor, tokenizer } = this.vox;
    const segments = [];
    const need = processor.num_samples_first_audio_chunk;
    while (this.len < need && !this.inputEnded) await this._waitData();
    if (this.aborted) return segments;
    if (this.len < need) {
      // Session très courte : on complète avec du silence
      const b = new Float32Array(need);
      b.set(this.buf.subarray(0, this.len));
      this.buf = b;
      this.len = need;
    }
    const first = await processor(this.buf.slice(0, need), { is_streaming: true, is_first_audio_chunk: true });
    const seg = new Segmenter(tokenizer, this.offsetS, {
      ...this.handlers,
      onSegment: (s) => { segments.push(s); this.handlers.onSegment?.(s); },
    });
    await model.generate({
      input_ids: first.input_ids,
      input_features: await this._features(first.input_features),
      max_new_tokens: Math.ceil(SESSION_HARD_S / STEP_S) + 200,
      do_sample: false,
      streamer: seg,
    });
    seg.end();
    return segments;
  }
}
