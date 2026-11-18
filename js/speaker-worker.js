// Worker « Qui parle ? » : repère les voix (pyannote-segmentation-3.0) puis calcule
// l'empreinte de chaque voix (WeSpeaker ResNet34). ~33 Mo, téléchargés une seule fois.
//   { type: 'run', id, pcm }  → { type: 'progress', id, value, stage } … { type: 'result', id, items }
//   items : [{ regions: [[début, fin], …], dur, emb: Float32Array }]
//   { type: 'cancel', id } : arrêt à la fenêtre suivante

import { TRANSFORMERS_URL } from './config.js';

const { AutoProcessor, AutoModelForAudioFrameClassification, AutoFeatureExtractor, AutoModel, env } = await import(TRANSFORMERS_URL);
env.allowLocalModels = false;

export const SEG_REPO = 'onnx-community/pyannote-segmentation-3.0';
export const EMB_REPO = 'onnx-community/wespeaker-voxceleb-resnet34-LM';
const OPTS = { device: 'wasm', dtype: 'fp32' };
const SR = 16000;
const WIN = 10; // secondes, taille d'entrée de pyannote
const MIN_REGION = 0.25; // plage de parole minimale gardée (s)
const MIN_VOICE = 0.8; // parole minimale pour calculer une empreinte (s)
const MAX_VOICE = 12; // au-delà, l'empreinte n'est pas meilleure

const post = (m, transfer) => self.postMessage(m, transfer || []);
let models = null;

async function load(onProgress) {
  if (models) return models;
  const files = new Map();
  const progress_callback = (p) => {
    if (p.status !== 'progress' || !p.total) return;
    files.set(p.file, { loaded: p.loaded, total: p.total });
    let l = 0;
    let t = 0;
    for (const f of files.values()) { l += f.loaded; t += f.total; }
    onProgress?.(t ? l / t : 0);
  };
  const [segProc, segModel, embFx, embModel] = await Promise.all([
    AutoProcessor.from_pretrained(SEG_REPO, { progress_callback }),
    AutoModelForAudioFrameClassification.from_pretrained(SEG_REPO, { ...OPTS, progress_callback }),
    AutoFeatureExtractor.from_pretrained(EMB_REPO, { progress_callback }),
    AutoModel.from_pretrained(EMB_REPO, { ...OPTS, progress_callback }),
  ]);
  models = { segProc, segModel, embFx, embModel };
  return models;
}

/** Plages de parole par voix locale (0..2) dans une fenêtre, en secondes absolues. */
async function voicesIn(chunk, offset) {
  const { segProc, segModel } = models;
  const inputs = await segProc(chunk);
  const { logits } = await segModel(inputs);
  const [res] = segProc.post_process_speaker_diarization(logits, chunk.length);
  const voices = [[], [], []];
  for (const r of res || []) {
    // Classes « powerset » : 1..3 = une seule voix ; 0 = silence ; 4..6 = deux voix en même temps (ignorées)
    if (r.id < 1 || r.id > 3) continue;
    if (r.end - r.start < MIN_REGION) continue;
    voices[r.id - 1].push([offset + r.start, offset + r.end]);
  }
  return voices;
}

/** Empreinte vocale d'un ensemble de plages (audio mis bout à bout). */
async function embed(pcm, regions) {
  const { embFx, embModel } = models;
  let n = 0;
  for (const [s, e] of regions) n += Math.round((e - s) * SR);
  n = Math.min(n, MAX_VOICE * SR);
  const audio = new Float32Array(n);
  let at = 0;
  for (const [s, e] of regions) {
    if (at >= n) break;
    const part = pcm.subarray(Math.round(s * SR), Math.round(e * SR));
    const take = Math.min(part.length, n - at);
    audio.set(part.subarray(0, take), at);
    at += take;
  }
  const inputs = await embFx(audio.subarray(0, at));
  const out = await embModel(inputs);
  const t = out.embeddings ?? out.last_hidden_state ?? Object.values(out)[0];
  return Float32Array.from(t.data);
}

let cancelled = new Set();

async function run(id, pcm) {
  post({ type: 'progress', id, stage: 'load', value: 0 });
  await load((v) => post({ type: 'progress', id, stage: 'load', value: v }));
  const total = pcm.length / SR;
  const items = [];
  const step = WIN * SR;
  const windows = Math.max(1, Math.ceil(pcm.length / step));
  for (let w = 0; w < windows; w++) {
    await new Promise((r) => setTimeout(r, 0)); // laisse passer un éventuel « cancel »
    if (cancelled.has(id)) throw new Error('cancelled');
    const from = w * step;
    const chunk = pcm.slice(from, Math.min(pcm.length, from + step));
    if (chunk.length < SR * 0.5) break;
    const voices = await voicesIn(chunk, from / SR);
    for (const regions of voices) {
      const dur = regions.reduce((x, [s, e]) => x + (e - s), 0);
      if (dur < MIN_VOICE) continue;
      const emb = await embed(pcm, regions);
      items.push({ regions, dur, emb });
    }
    post({ type: 'progress', id, stage: 'analyse', value: Math.min(1, ((w + 1) * WIN) / total) });
  }
  return items;
}

self.onmessage = async ({ data: m }) => {
  try {
    if (m.type === 'cancel') return cancelled.add(m.id);
    if (m.type === 'run') {
      const items = await run(m.id, m.pcm);
      cancelled.delete(m.id);
      return post({ type: 'result', id: m.id, items }, items.map((it) => it.emb.buffer));
    }
  } catch (e) {
    cancelled.delete(m.id);
    post({ type: 'error', id: m.id, message: e?.message || String(e) });
  }
};

post({ type: 'boot' });
