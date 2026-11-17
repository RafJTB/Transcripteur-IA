// Web Worker de transcription : charge Whisper (Transformers.js) et transcrit
// l'audio sans bloquer l'interface. Aucun audio ne quitte ce worker.
//
// Protocole (main -> worker) :
//   { type: 'detect' }
//   { type: 'cache-status', models: [{ id, repo, device, dtype }] }
//   { type: 'cache-clear', repo, device, dtype }
//   { type: 'load', repo, device, dtype }
//   { type: 'transcribe', jobId, audio: Float32Array, language, chunkLengthS, strideLengthS, offsetS? }
//   { type: 'cancel' }
// La V2 « quasi temps réel » réutilisera 'transcribe' sur des blocs courts
// (chunkLengthS = 0, offsetS = position du bloc) sans changer le protocole.

import { TRANSFORMERS_URL } from './config.js';

const { pipeline, env, ModelRegistry } = await import(TRANSFORMERS_URL);

env.allowLocalModels = false; // tout vient du Hub (puis du cache navigateur)

const TASK = 'automatic-speech-recognition';
let asr = null;
let loadedKey = null;
let cancelRequested = false;

const post = (msg, transfer) => self.postMessage(msg, transfer || []);

// ---------- Détection matérielle ----------
async function detect() {
  const caps = { webgpu: false, f16: false, adapter: null, threads: navigator.hardwareConcurrency || 1,
    crossOriginIsolated: self.crossOriginIsolated === true, memoryGB: navigator.deviceMemory ?? null };
  try {
    if ('gpu' in navigator) {
      const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
      if (adapter) {
        const info = adapter.info || {};
        caps.adapter = [info.vendor, info.architecture, info.description].filter(Boolean).join(' · ') || 'GPU';
        caps.maxBufferMB = Math.round((adapter.limits?.maxBufferSize ?? 0) / 1048576);
        // Adaptateur logiciel (SwiftShader, WARP, llvmpipe…) : bien plus lent que le WASM → ignoré.
        caps.softwareGpu = info.isFallbackAdapter === true ||
          /swiftshader|llvmpipe|lavapipe|warp|basic render|software/i.test(`${info.vendor} ${info.architecture} ${info.description} ${info.device}`);
        caps.webgpu = !caps.softwareGpu;
        caps.f16 = caps.webgpu && adapter.features.has('shader-f16');
      }
    }
  } catch (e) {
    caps.webgpuError = String(e?.message || e);
  }
  return caps;
}

// ---------- Cache ----------
async function cacheStatus(models) {
  const out = {};
  for (const m of models) {
    try {
      out[m.id] = await ModelRegistry.is_pipeline_cached(TASK, m.repo, { device: m.device, dtype: m.dtype });
    } catch {
      out[m.id] = false;
    }
  }
  return out;
}

// ---------- Chargement ----------
function classifyError(e) {
  const msg = String(e?.message || e || '');
  if (/memory|alloc|OOM|out of range|RangeError|Array buffer|bad_alloc|too large|exceed|Aborted\(\)/i.test(msg))
    return 'memory';
  if (/webgpu|gpu|adapter|device (was )?lost|shader/i.test(msg)) return 'webgpu';
  if (/fetch|network|Failed to fetch|NetworkError|load failed|404|ERR_/i.test(msg)) return 'network';
  return 'unknown';
}

async function load({ repo, device, dtype }) {
  const key = `${repo}|${device}|${JSON.stringify(dtype)}`;
  if (asr && loadedKey === key) return post({ type: 'ready', repo, device, cached: true });
  if (asr) {
    try { await asr.dispose(); } catch { /* ignore */ }
    asr = null;
    loadedKey = null;
  }
  post({ type: 'load-start', repo, device });
  const t0 = performance.now();
  asr = await pipeline(TASK, repo, {
    device,
    dtype,
    progress_callback: (p) => {
      if (p.status === 'progress_total') {
        post({ type: 'load-progress', progress: p.progress, loaded: p.loaded, total: p.total });
      } else if (p.status === 'initiate' || p.status === 'download' || p.status === 'done') {
        post({ type: 'load-file', status: p.status, file: p.file });
      }
    },
  });
  // Préchauffage : la première inférence WebGPU compile les shaders (plusieurs secondes).
  post({ type: 'warmup' });
  await asr(new Float32Array(16000), { language: 'fr', task: 'transcribe', max_new_tokens: 2 });
  loadedKey = key;
  post({ type: 'ready', repo, device, seconds: (performance.now() - t0) / 1000 });
}

// ---------- Transcription ----------
const HALLUCINATIONS = [
  /amara\.org/i,
  /sous-titr(age|es?)\s+(réalisés?\s+)?(par|st'?|société|radio|fr)/i,
  /^\s*sous-titrage\s+st'?\s*\d+\s*$/i,
  /^\s*(\[|\()?\s*(musique|music|applaudissements)\s*(\]|\))?\s*$/i,
];

// Décodage glouton d'abord ; si boucle détectée, nouvel essai avec échantillonnage (comme Whisper d'OpenAI).
const DECODE_STRATEGIES = [
  {},
  { do_sample: true, temperature: 0.4, no_repeat_ngram_size: 6 },
  { do_sample: true, temperature: 0.8, no_repeat_ngram_size: 4 },
];

/** Boucle typique : texte très répétitif ou plafond de tokens atteint avec peu de mots distincts. */
function looksLikeLoop(text, hitMax) {
  const w = text.toLowerCase().match(/[\p{L}\p{N}']+/gu) || [];
  if (w.length < 12) return false;
  const grams = new Map();
  let top = 0;
  for (let i = 0; i + 2 < w.length; i++) {
    const g = w[i] + ' ' + w[i + 1] + ' ' + w[i + 2];
    const c = (grams.get(g) || 0) + 1;
    grams.set(g, c);
    top = Math.max(top, c);
  }
  const uniq = new Set(w).size / w.length;
  return (top * 3) / w.length > 0.45 || uniq < 0.25 || (hitMax && uniq < 0.5);
}

/** Filet de sécurité : « x, x, x, x » (4 répétitions ou plus) → « x ». */
function collapseRepeats(text) {
  return text.replace(/(?<![\p{L}\p{N}'’-])((?:[\p{L}\p{N}'’-]+[\s,.;!?]*){1,6}?)(?:\1){3,}/giu, '$1').replace(/\s{2,}/g, ' ').trim();
}

function rms(a) {
  let s = 0;
  for (let i = 0; i < a.length; i += 4) s += a[i] * a[i];
  return Math.sqrt(s / Math.max(1, a.length / 4));
}

function cleanSegments(chunks, offsetS) {
  const out = [];
  for (const c of chunks) {
    const text = collapseRepeats((c.text || '').trim());
    if (!text) continue;
    if (HALLUCINATIONS.some((r) => r.test(text))) continue;
    const [s, e] = c.timestamp;
    out.push({ start: (s ?? 0) + offsetS, end: (e ?? s ?? 0) + offsetS, text });
  }
  // Fin manquante (dernier segment coupé) : on prend le début du suivant
  for (let i = 0; i < out.length; i++) {
    if (!(out[i].end > out[i].start)) out[i].end = out[i + 1]?.start ?? out[i].start + 2;
  }
  return out;
}

async function transcribe({ jobId, audio, language, chunkLengthS = 30, strideLengthS = 5, offsetS = 0 }) {
  if (!asr) throw new Error('Modèle non chargé');
  cancelRequested = false;
  const { processor, model, tokenizer } = asr;
  const fe = processor.feature_extractor.config;
  const sr = fe.sampling_rate;
  const hop = fe.hop_length;
  const timePrecision = fe.chunk_length / model.config.max_source_positions;

  // Fenêtres avec chevauchement (même logique que le pipeline officiel,
  // mais pilotée ici pour avoir progression, annulation et résultats partiels).
  const windows = [];
  if (chunkLengthS > 0 && audio.length > sr * chunkLengthS) {
    const win = sr * chunkLengthS;
    const stride = sr * strideLengthS;
    const jump = win - 2 * stride;
    for (let off = 0; ; off += jump) {
      const isLast = off + win >= audio.length;
      windows.push({ off, end: Math.min(off + win, audio.length), first: off === 0, last: isLast });
      if (isLast) break;
    }
  } else {
    windows.push({ off: 0, end: audio.length, first: true, last: true });
  }

  const seqs = [];
  const t0 = performance.now();
  for (let i = 0; i < windows.length; i++) {
    if (cancelRequested) {
      post({ type: 'cancelled', jobId });
      return;
    }
    const w = windows[i];
    const sub = audio.subarray(w.off, w.end);
    let tokens = [];
    if (rms(sub) > 0.0015) {
      const { input_features } = await processor(sub);
      // Plafond de tokens proportionnel à la durée : coupe court aux boucles de répétition.
      const maxTokens = Math.min(440, Math.ceil((sub.length / sr) * 10) + 24);
      for (let k = 0; k < DECODE_STRATEGIES.length; k++) {
        const out = await model.generate({
          inputs: input_features,
          language,
          task: 'transcribe',
          return_timestamps: true,
          num_frames: Math.floor(sub.length / hop),
          max_new_tokens: maxTokens,
          ...DECODE_STRATEGIES[k],
        });
        const cand = out[0].tolist ? out[0].tolist() : out.tolist()[0];
        const loop = looksLikeLoop(tokenizer.decode(cand, { skip_special_tokens: true }), cand.length >= maxTokens);
        if (!tokens.length || !loop) tokens = cand;
        if (!loop) break;
        if (cancelRequested) break;
      }
      input_features.dispose?.();
    }
    const strideS = windows.length > 1 ? strideLengthS : 0;
    seqs.push({ tokens, stride: [sub.length / sr, w.first ? 0 : strideS, w.last ? 0 : strideS] });

    // Aperçu : le dernier bloc est traité comme final (sa zone de chevauchement droite est incluse)
    const preview = seqs.map((q, k) => (k === seqs.length - 1 ? { ...q, stride: [q.stride[0], q.stride[1], 0] } : q));
    const [, opt] = tokenizer._decode_asr(preview, {
      time_precision: timePrecision,
      return_timestamps: true,
      force_full_sequences: false,
    });
    const elapsed = (performance.now() - t0) / 1000;
    post({
      type: 'progress',
      jobId,
      done: i + 1,
      total: windows.length,
      elapsed,
      eta: (elapsed / (i + 1)) * (windows.length - i - 1),
      segments: cleanSegments(opt.chunks || [], offsetS),
    });
  }
  const [, opt] = tokenizer._decode_asr(seqs, {
    time_precision: timePrecision,
    return_timestamps: true,
    force_full_sequences: false,
  });
  post({
    type: 'result',
    jobId,
    segments: cleanSegments(opt.chunks || [], offsetS),
    seconds: (performance.now() - t0) / 1000,
    audioSeconds: audio.length / sr,
  });
}

// ---------- Boucle de messages ----------
self.onmessage = async ({ data }) => {
  try {
    switch (data.type) {
      case 'detect':
        post({ type: 'caps', caps: await detect() });
        break;
      case 'cache-status':
        post({ type: 'cache', status: await cacheStatus(data.models) });
        break;
      case 'cache-clear':
        if (asr && loadedKey?.startsWith(data.repo + '|')) {
          try { await asr.dispose(); } catch { /* ignore */ }
          asr = null;
          loadedKey = null;
        }
        await ModelRegistry.clear_pipeline_cache(TASK, data.repo, { device: data.device, dtype: data.dtype });
        post({ type: 'cache-cleared', repo: data.repo });
        break;
      case 'load':
        await load(data);
        break;
      case 'transcribe':
        await transcribe(data);
        break;
      case 'cancel':
        cancelRequested = true;
        break;
    }
  } catch (e) {
    console.error(e);
    if (data.type === 'load') {
      asr = null;
      loadedKey = null;
    }
    post({ type: 'error', during: data.type, jobId: data.jobId, kind: classifyError(e), message: String(e?.message || e) });
  }
};

post({ type: 'boot' });
