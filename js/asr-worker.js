// Web Worker de transcription : charge Whisper (Transformers.js) et transcrit
// l'audio sans bloquer l'interface. Aucun audio ne quitte ce worker.
//
// Protocole (main -> worker) :
//   { type: 'detect' }
//   { type: 'cache-status', models: [{ id, repo, device, dtype }] }
//   { type: 'cache-clear', repo, device, dtype }
//   { type: 'load', repo, device, dtype }
//   { type: 'transcribe', jobId, audio: Float32Array, language, chunkLengthS, strideLengthS,
//     offsetS?, resumeSeqs?, quiet? }
//   { type: 'cancel' }
// Reprise : `resumeSeqs` contient les blocs déjà transcrits (renvoyés un par un dans les
// messages 'progress') ; le découpage étant déterministe, on repart du bloc suivant.
// Direct : fenêtre courte (chunkLengthS = 0), `quiet` = pas de messages de progression.
//
// Voxtral Realtime (kind 'voxtral') : vrai flux continu.
//   { type: 'stream-start', jobId }   puis   { type: 'stream-audio', pcm }   …   { type: 'stream-end' }
//   → 'stream-seg' (phrase validée), 'stream-partial' (phrase en cours), 'stream-pos', 'stream-done'
//   { type: 'stream-abort' } arrête sans rien garder.
//   'transcribe' fonctionne aussi avec Voxtral (fichiers, reprise par sessions de ~2 min).

import { TRANSFORMERS_URL } from './config.js';
import { VoxtralSession, planSessions, SESSION_SOFT_S, SESSION_HARD_S } from './voxtral-engine.js';
import { boostForAsr } from './audio.js';

const { pipeline, env, ModelRegistry, VoxtralRealtimeForConditionalGeneration, VoxtralRealtimeProcessor, LogitsProcessor } = await import(TRANSFORMERS_URL);

/**
 * Capteur de confiance : à chaque mot (token) généré, mesure la probabilité que le modèle
 * accorde à son choix (0 à 1). Ne modifie rien. C'est une confiance du modèle, pas une
 * garantie : il peut se tromper avec assurance (noms propres, jargon).
 */
class ConfidenceProbe extends LogitsProcessor {
  constructor() {
    super();
    this.last = null;
    this.lastId = -1;
    this.onToken = null;
  }

  _call(input_ids, logits) {
    const d = logits.data;
    const V = logits.dims.at(-1);
    let max = -Infinity;
    let arg = 0;
    for (let i = 0; i < V; i++) if (d[i] > max) { max = d[i]; arg = i; }
    if (!Number.isFinite(max)) { this.last = null; return logits; }
    let sum = 0;
    for (let i = 0; i < V; i++) { const v = d[i]; if (v > -1e30) sum += Math.exp(v - max); }
    this.last = 1 / sum;
    this.lastId = arg;
    this.onToken?.(arg, this.last);
    return logits;
  }
}
const probe = new ConfidenceProbe();
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);

env.allowLocalModels = false; // tout vient du Hub (puis du cache navigateur)

const TASK = 'automatic-speech-recognition';
const SR = 16000;
let asr = null; // Whisper (pipeline)
let vox = null; // Voxtral { model, processor, tokenizer }
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
      out[m.id] = m.kind === 'voxtral'
        ? await ModelRegistry.is_cached(m.repo, { device: m.device, dtype: m.dtype })
        : await ModelRegistry.is_pipeline_cached(TASK, m.repo, { device: m.device, dtype: m.dtype });
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

async function unload() {
  try { await asr?.dispose(); } catch { /* ignore */ }
  try { await vox?.model.dispose(); } catch { /* ignore */ }
  asr = null;
  vox = null;
  loadedKey = null;
}

async function load({ repo, device, dtype, kind }) {
  const key = `${repo}|${device}|${JSON.stringify(dtype)}`;
  if ((asr || vox) && loadedKey === key) return post({ type: 'ready', repo, device, cached: true });
  await unload();
  post({ type: 'load-start', repo, device });
  const t0 = performance.now();
  const progress_callback = (p) => {
    if (p.status === 'progress_total') {
      post({ type: 'load-progress', progress: p.progress, loaded: p.loaded, total: p.total });
    } else if (p.status === 'initiate' || p.status === 'download' || p.status === 'done') {
      post({ type: 'load-file', status: p.status, file: p.file });
    }
  };
  if (kind === 'voxtral') {
    const [model, processor] = await Promise.all([
      VoxtralRealtimeForConditionalGeneration.from_pretrained(repo, { device, dtype, progress_callback }),
      VoxtralRealtimeProcessor.from_pretrained(repo),
    ]);
    vox = { model, processor, tokenizer: processor.tokenizer, probe };
    post({ type: 'warmup' });
    const s = new VoxtralSession(vox, {});
    const run = s.run();
    s.push(new Float32Array(16000));
    s.finishInput();
    await run;
  } else {
    asr = await pipeline(TASK, repo, { device, dtype, progress_callback });
    // Préchauffage : la première inférence WebGPU compile les shaders (plusieurs secondes).
    post({ type: 'warmup' });
    await asr(new Float32Array(16000), { language: 'fr', task: 'transcribe', max_new_tokens: 2 });
  }
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

/**
 * Filet de sécurité : une suite de 1 à 6 mots répétée 4 fois ou plus d'affilée
 * (« j'aime, j'aime, j'aime, j'aime ») est ramenée à une seule occurrence.
 * Algorithme mot à mot, en temps linéaire (une expression régulière à rétro-références
 * pouvait bloquer le navigateur sur un long texte répétitif).
 */
function collapseRepeats(text) {
  const parts = text.match(/\S+\s*/g);
  if (!parts || parts.length < 4) return text.trim();
  const norm = parts.map((p) => p.toLowerCase().replace(/[^\p{L}\p{N}'’-]/gu, ''));
  const same = (a, b, n) => {
    for (let k = 0; k < n; k++) if (!norm[a + k] || norm[a + k] !== norm[b + k]) return false;
    return true;
  };
  const out = [];
  let i = 0;
  while (i < parts.length) {
    let jump = 0;
    for (let n = 1; n <= 6 && i + n * 4 <= parts.length; n++) {
      let reps = 1;
      while (i + (reps + 1) * n <= parts.length && same(i, i + reps * n, n)) reps++;
      if (reps >= 4) { out.push(...parts.slice(i, i + n)); jump = reps * n; break; }
    }
    if (jump) i += jump;
    else out.push(parts[i++]);
  }
  return out.join('').replace(/\s{2,}/g, ' ').trim();
}

/**
 * Y a-t-il quelque chose à transcrire dans ce bloc ? On ne saute que le silence numérique,
 * ou un bruit faible et uniforme (rien ne dépasse le fond). Les voix lointaines, faibles
 * mais qui ressortent du bruit, sont gardées (un seuil fixe les ignorait).
 */
function hasSpeech(a) {
  const F = 1600;
  const fr = [];
  for (let k = 0; k + F <= a.length; k += F) {
    let e = 0;
    for (let i = k; i < k + F; i++) e += a[i] * a[i];
    fr.push(Math.sqrt(e / F));
  }
  if (!fr.length) return rms(a) > 0.0004;
  fr.sort((x, y) => x - y);
  const p95 = fr[Math.floor(fr.length * 0.95)];
  const p20 = fr[Math.floor(fr.length * 0.2)];
  if (p95 < 0.0004) return false; // silence numérique (−68 dBFS)
  if (p95 < 0.003 && p95 < p20 * 1.6) return false; // bruit faible et plat
  return true;
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

/** Whisper : chaque phrase reçoit la confiance de la fenêtre de 30 s dont le centre est le plus proche. */
function withConf(segs, seqs) {
  for (const s of segs) {
    const mid = (s.start + s.end) / 2;
    let best = null;
    let bestD = Infinity;
    for (const q of seqs) {
      if (q.conf == null || !q.span) continue;
      const d = Math.abs((q.span[0] + q.span[1]) / 2 - mid);
      if (mid >= q.span[0] && mid <= q.span[1] && d < bestD) { bestD = d; best = q.conf; }
    }
    if (best != null) s.conf = Math.round(best * 100) / 100;
  }
  return segs;
}

async function transcribe(job) {
  if (vox) return transcribeVoxtral(job);
  return transcribeWhisper(job);
}

/** Fichier avec Voxtral : sessions de ~2 min ; chaque session terminée est sauvegardée (reprise). */
async function transcribeVoxtral({ jobId, audio, offsetS = 0, resumeSeqs = [] }) {
  cancelRequested = false;
  audio = boostForAsr(audio); // Voxtral est sensible au volume absolu : on remonte les voix faibles
  const sessions = planSessions(audio);
  const seqs = resumeSeqs.slice(0, sessions.length);
  const first = seqs.length;
  const all = () => seqs.flatMap((q) => q.segments || []);
  const t0 = performance.now();
  const totalS = audio.length / SR;
  let lastTick = 0;
  for (let i = first; i < sessions.length; i++) {
    await new Promise((r) => setTimeout(r, 0));
    if (cancelRequested) return post({ type: 'cancelled', jobId });
    const w = sessions[i];
    const partial = [];
    const s = new VoxtralSession(vox, {
      offsetS: offsetS + w.off / SR,
      clean: collapseRepeats,
      onSegment: (x) => partial.push(x),
      onStep: (t) => {
        if (cancelRequested) s.abort();
        const now = performance.now();
        if (now - lastTick < 1500) return;
        lastTick = now;
        // Signe de vie + progression fine (le chien de garde de l'interface s'en sert)
        post({ type: 'tick', jobId, doneS: t - offsetS, totalS, segments: [...all(), ...cleanList(partial)] });
      },
    });
    const run = s.run();
    s.push(audio.subarray(w.off, w.end));
    s.finishInput();
    const segs = await run;
    if (cancelRequested) return post({ type: 'cancelled', jobId });
    seqs.push({ segments: cleanList(segs) });
    const elapsed = (performance.now() - t0) / 1000;
    const doneHere = i + 1 - first;
    post({
      type: 'progress', jobId, done: i + 1, total: sessions.length, index: i, seq: seqs[i], first, elapsed,
      eta: (elapsed / doneHere) * (sessions.length - i - 1), segments: all(),
    });
  }
  post({ type: 'result', jobId, segments: all(), seconds: (performance.now() - t0) / 1000, audioSeconds: totalS });
}

function cleanList(segs) {
  return segs.filter((x) => x.text && !HALLUCINATIONS.some((r) => r.test(x.text)));
}

// ---------- Direct avec Voxtral ----------
let live = null;

async function streamStart({ jobId }) {
  if (!vox) throw new Error('Modèle Voxtral non chargé');
  const st = { jobId, ended: false, aborted: false, cur: null, overflow: [], all: [], doneS: 0, probs: [] };
  live = st;
  let offset = 0; // échantillons déjà traités par les sessions précédentes
  while (!st.aborted) {
    const s = new VoxtralSession(vox, {
      offsetS: offset / SR,
      clean: collapseRepeats,
      onSegment: (x) => {
        if (!cleanList([x]).length) return;
        st.all.push(x);
        post({ type: 'stream-seg', jobId, segment: x });
      },
      onPartial: (x) => post({ type: 'stream-partial', jobId, partial: x }),
      onStep: (t, p, isText) => {
        st.doneS = t;
        if (isText && p != null) st.probs.push(p);
        if (Math.round(t / 0.08) % 6 === 0) {
          post({ type: 'stream-pos', jobId, doneS: t, conf: mean(st.probs) });
          st.probs = [];
        }
      },
      yieldEvery: 2,
    });
    st.cur = s;
    for (const p of st.overflow) s.push(p);
    st.overflow = [];
    if (st.ended) s.finishInput();
    await s.run();
    if (st.aborted || st.ended && !st.overflow.length && s.inputEnded && !st.cutPending) break;
    offset += st.cutAt ?? s.len;
    st.cutAt = null;
    st.cutPending = false;
  }
  if (live === st) live = null;
  if (!st.aborted) post({ type: 'stream-done', jobId, segments: st.all });
}

function streamAudio(pcm) {
  const st = live;
  if (!st || st.aborted) return;
  const s = st.cur;
  if (!s || s.inputEnded) return st.overflow.push(pcm);
  s.push(pcm);
  // Session longue : on coupe sur un silence pour libérer la mémoire du modèle.
  const len = s.seconds;
  if (len > SESSION_HARD_S || (len > SESSION_SOFT_S && rms(pcm) < 0.004)) {
    st.cutAt = s.len;
    st.cutPending = true;
    s.finishInput();
  }
}

function streamEnd() {
  const st = live;
  if (!st) return;
  st.ended = true;
  st.cutPending = false;
  if (st.cur && !st.cur.inputEnded) st.cur.finishInput();
}

function streamAbort() {
  const st = live;
  if (!st) return;
  st.aborted = true;
  st.cur?.abort();
  live = null;
}

/** Transcrit une fenêtre (≤ 30 s) : décodage glouton, puis nouvel essai si boucle de répétition. */
async function generateWindow(sub, language) {
  const { processor, model, tokenizer } = asr;
  const hop = processor.feature_extractor.config.hop_length;
  const { input_features } = await processor(sub);
  // Plafond de tokens proportionnel à la durée : coupe court aux boucles de répétition.
  const maxTokens = Math.min(440, Math.ceil((sub.length / SR) * 10) + 24);
  const special = new Set(tokenizer.all_special_ids.map(Number));
  const tsBegin = tokenizer.timestamp_begin;
  let tokens = [];
  let conf = null;
  for (let k = 0; k < DECODE_STRATEGIES.length; k++) {
    const probs = [];
    probe.onToken = (id, p) => { if (id < tsBegin && !special.has(id)) probs.push(p); };
    const out = await model.generate({
      logits_processor: [probe],
      inputs: input_features,
      language,
      task: 'transcribe',
      return_timestamps: true,
      num_frames: Math.floor(sub.length / hop),
      max_new_tokens: maxTokens,
      ...DECODE_STRATEGIES[k],
    });
    const cand = (out[0].tolist ? out[0].tolist() : out.tolist()[0]).map(Number);
    const loop = looksLikeLoop(tokenizer.decode(cand, { skip_special_tokens: true }), cand.length >= maxTokens);
    if (!tokens.length || !loop) { tokens = cand; conf = mean(probs); }
    if (!loop || cancelRequested) break;
  }
  probe.onToken = null;
  input_features.dispose?.();
  return { tokens, conf };
}

function similar(a, b) {
  const wa = new Set(a.toLowerCase().match(/[\p{L}\p{N}']+/gu) || []);
  const wb = new Set(b.toLowerCase().match(/[\p{L}\p{N}']+/gu) || []);
  if (!wa.size || !wb.size) return 0;
  let inter = 0;
  for (const w of wa) if (wb.has(w)) inter++;
  return inter / (wa.size + wb.size - inter);
}

/** Segments d'une fenêtre isolée (sans chevauchement), décalés de offsetS. */
function decodeSingle(tokens, conf, lenSamples, offsetS) {
  const { processor, model, tokenizer } = asr;
  const timePrecision = processor.feature_extractor.config.chunk_length / model.config.max_source_positions;
  const [, opt] = tokenizer._decode_asr([{ tokens, stride: [lenSamples / SR, 0, 0] }], { time_precision: timePrecision, return_timestamps: true, force_full_sequences: false });
  const segs = cleanSegments(opt.chunks || [], offsetS);
  if (conf != null) for (const x of segs) x.conf = Math.round(conf * 100) / 100;
  return segs;
}

/**
 * Rattrapage : repère les passages de plus de 4 s sans texte où l'on entend pourtant des voix,
 * et les transcrit à part. Les résultats très peu sûrs (< 25 %) sont écartés (bruit pris pour de la voix).
 */
async function fillGaps(audio, segs, { offsetS = 0, language, maxPasses = 8 }) {
  const total = audio.length / SR;
  const sorted = [...segs].sort((a, b) => a.start - b.start);
  const gaps = [];
  let prev = 0;
  for (const x of sorted) {
    const st = x.start - offsetS;
    if (st - prev >= 4) gaps.push([prev, st]);
    prev = Math.max(prev, x.end - offsetS);
  }
  if (total - prev >= 4) gaps.push([prev, total]);
  const added = [];
  let passes = 0;
  for (const [g0, g1] of gaps) {
    for (let a = g0; a < g1 - 1 && passes < maxPasses; a += 28) {
      if (cancelRequested) break;
      const b = Math.min(g1, a + 28);
      const sub = audio.subarray(Math.round(a * SR), Math.round(b * SR));
      if (!hasSpeech(sub)) continue;
      passes++;
      const { tokens, conf } = await generateWindow(sub, language);
      if (conf != null && conf < 0.25) continue;
      for (const x of decodeSingle(tokens, conf, sub.length, offsetS + a)) {
        if (x.start - offsetS >= b) continue;
        // Anti-doublon : même phrase que celle juste avant, collée à elle → déjà transcrite
        const before = [...sorted, ...added].filter((y) => y.end <= x.start + 0.5).sort((p, q) => q.end - p.end)[0];
        if (before && x.start - before.end < 1.5 && similar(before.text, x.text) >= 0.7) continue;
        added.push(x);
      }
    }
  }
  if (!added.length) return segs;
  return [...segs, ...added].sort((x, y) => x.start - y.start);
}

async function transcribeWhisper({ jobId, audio, language, chunkLengthS = 30, strideLengthS = 5, offsetS = 0, resumeSeqs = [], quiet = false }) {
  if (!asr) throw new Error('Modèle non chargé');
  cancelRequested = false;
  const { processor, model, tokenizer } = asr;
  const fe = processor.feature_extractor.config;
  const sr = fe.sampling_rate;
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

  const seqs = resumeSeqs.slice(0, windows.length);
  const first = seqs.length;
  const t0 = performance.now();
  for (let i = first; i < windows.length; i++) {
    // Laisse passer les messages en attente (ex. « cancel ») : les await de l'inférence
    // ne rendent pas la main à la boucle d'événements du worker.
    await new Promise((r) => setTimeout(r, 0));
    if (cancelRequested) {
      post({ type: 'cancelled', jobId });
      return;
    }
    const w = windows[i];
    const sub = audio.subarray(w.off, w.end);
    const { tokens, conf } = hasSpeech(sub) ? await generateWindow(sub, language) : { tokens: [], conf: null };
    const strideS = windows.length > 1 ? strideLengthS : 0;
    seqs.push({ tokens, conf, span: [offsetS + w.off / sr, offsetS + w.end / sr], stride: [sub.length / sr, w.first ? 0 : strideS, w.last ? 0 : strideS] });
    if (quiet) continue;

    // Aperçu : le dernier bloc est traité comme final (sa zone de chevauchement droite est incluse)
    const preview = seqs.map((q, k) => (k === seqs.length - 1 ? { ...q, stride: [q.stride[0], q.stride[1], 0] } : q));
    const [, opt] = tokenizer._decode_asr(preview, {
      time_precision: timePrecision,
      return_timestamps: true,
      force_full_sequences: false,
    });
    const elapsed = (performance.now() - t0) / 1000;
    const doneHere = i + 1 - first;
    post({
      type: 'progress',
      jobId,
      done: i + 1,
      total: windows.length,
      index: i,
      seq: seqs[i],
      elapsed,
      first,
      eta: (elapsed / doneHere) * (windows.length - i - 1),
      segments: withConf(cleanSegments(opt.chunks || [], offsetS), seqs),
    });
  }
  const [, opt] = tokenizer._decode_asr(seqs, {
    time_precision: timePrecision,
    return_timestamps: true,
    force_full_sequences: false,
  });
  let segments = withConf(cleanSegments(opt.chunks || [], offsetS), seqs);
  // Whisper s'arrête parfois après la 1re phrase d'un bloc (son faible ou bruité) :
  // on retranscrit les trous de plus de 4 s où l'on entend pourtant des voix.
  if (!quiet) segments = await fillGaps(audio, segments, { offsetS, language });
  if (cancelRequested && !quiet) return post({ type: 'cancelled', jobId });
  post({
    type: 'result',
    jobId,
    segments,
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
        if (loadedKey?.startsWith(data.repo + '|')) await unload();
        if (data.kind === 'voxtral') await ModelRegistry.clear_cache(data.repo, { device: data.device, dtype: data.dtype });
        else await ModelRegistry.clear_pipeline_cache(TASK, data.repo, { device: data.device, dtype: data.dtype });
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
      case 'stream-start':
        await streamStart(data);
        break;
      case 'stream-audio':
        streamAudio(data.pcm);
        break;
      case 'stream-end':
        streamEnd();
        break;
      case 'stream-abort':
        streamAbort();
        break;
    }
  } catch (e) {
    console.error(e);
    if (data.type === 'load') {
      asr = null;
      vox = null;
      loadedKey = null;
    }
    if (data.type === 'stream-start') live = null;
    post({ type: 'error', during: data.type, jobId: data.jobId, kind: classifyError(e), message: String(e?.message || e) });
  }
};

post({ type: 'boot' });
