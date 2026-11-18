// Worker de traduction locale (Transformers.js) : Opus-MT ou NLLB-200, sur le processeur.
//   { type: 'load', id, repo }                       → { type: 'loaded', id } (+ { type: 'progress', value })
//   { type: 'translate', id, repo, texts, src, tgt } → { type: 'result', id, texts }
//   { type: 'cache-status', id, repo }               → { type: 'cache', id, cached }

import { TRANSFORMERS_URL } from './config.js';

const { pipeline, env, ModelRegistry } = await import(TRANSFORMERS_URL);
env.allowLocalModels = false;

const TASK = 'translation';
const OPTS = { device: 'wasm', dtype: 'q8' };
let tr = null;
let loadedRepo = null;

const post = (m) => self.postMessage(m);

async function load(repo) {
  if (tr && loadedRepo === repo) return;
  await tr?.dispose?.();
  tr = null;
  const files = new Map();
  tr = await pipeline(TASK, repo, {
    ...OPTS,
    progress_callback: (p) => {
      if (p.status !== 'progress' || !p.total) return;
      files.set(p.file, { loaded: p.loaded, total: p.total });
      let l = 0;
      let t = 0;
      for (const f of files.values()) { l += f.loaded; t += f.total; }
      post({ type: 'progress', value: t ? l / t : 0 });
    },
  });
  loadedRepo = repo;
}

self.onmessage = async ({ data: m }) => {
  try {
    if (m.type === 'cache-status') {
      const cached = await ModelRegistry.is_pipeline_cached(TASK, m.repo, OPTS).catch(() => false);
      return post({ type: 'cache', id: m.id, cached });
    }
    if (m.type === 'load') {
      await load(m.repo);
      return post({ type: 'loaded', id: m.id });
    }
    if (m.type === 'translate') {
      await load(m.repo);
      const opts = m.src ? { src_lang: m.src, tgt_lang: m.tgt } : {};
      const out = [];
      for (const text of m.texts) {
        if (!text.trim()) { out.push(text); continue; }
        const [r] = await tr(text, { ...opts, max_new_tokens: 400 });
        out.push((r?.translation_text ?? '').trim());
      }
      return post({ type: 'result', id: m.id, texts: out });
    }
  } catch (e) {
    post({ type: 'error', id: m.id, message: e?.message || String(e) });
  }
};

// Prêt : les messages envoyés avant ce point seraient perdus
post({ type: 'boot' });
