// Worker de l'assistant : petit modèle de langage local (Transformers.js), WebGPU ou processeur.
//   { type: 'cache-status', id, repo, device, dtype }        → { type: 'cache', id, cached }
//   { type: 'load', id, repo, device, dtype }                → { type: 'loaded', id } (+ { type: 'progress', value })
//   { type: 'chat', id, repo, device, dtype, messages, max } → { type: 'token', id, text }… puis { type: 'done', id, text }
//   { type: 'stop' }                                         → interrompt la génération en cours
//   { type: 'dispose', id }                                  → libère la mémoire
// Rien ne quitte l'appareil : le modèle est téléchargé une fois depuis Hugging Face puis gardé en cache.

import { TRANSFORMERS_URL } from './config.js';

const { AutoTokenizer, AutoModelForCausalLM, TextStreamer, InterruptableStoppingCriteria, env, ModelRegistry } = await import(TRANSFORMERS_URL);
env.allowLocalModels = false;

let tok = null;
let model = null;
let key = null;
const stopper = new InterruptableStoppingCriteria();
const post = (m) => self.postMessage(m);

async function load({ repo, device, dtype }) {
  const k = `${repo}|${device}|${dtype}`;
  if (model && key === k) return;
  await model?.dispose?.();
  model = tok = null;
  key = null;
  const files = new Map();
  const progress_callback = (p) => {
    if (p.status !== 'progress' || !p.total) return;
    files.set(p.file, { loaded: p.loaded, total: p.total });
    let l = 0, t = 0;
    for (const f of files.values()) { l += f.loaded; t += f.total; }
    post({ type: 'progress', value: t ? l / t : 0, loaded: l, total: t });
  };
  tok = await AutoTokenizer.from_pretrained(repo, { progress_callback });
  model = await AutoModelForCausalLM.from_pretrained(repo, { device, dtype, progress_callback });
  key = k;
}

/** Retire un éventuel bloc de réflexion (<think>…</think>) des modèles qui en produisent. */
const clean = (t) => t.replace(/<think>[\s\S]*?(<\/think>|$)/g, '').replace(/^\s+/, '');

self.onmessage = async ({ data: m }) => {
  try {
    if (m.type === 'stop') return stopper.interrupt();
    if (m.type === 'cache-status') {
      let cached = false;
      try { cached = await ModelRegistry.is_cached(m.repo, { device: m.device, dtype: m.dtype }); } catch { cached = false; }
      return post({ type: 'cache', id: m.id, cached: !!cached });
    }
    if (m.type === 'dispose') {
      await model?.dispose?.();
      model = tok = null;
      key = null;
      return post({ type: 'disposed', id: m.id });
    }
    if (m.type === 'load') {
      await load(m);
      return post({ type: 'loaded', id: m.id });
    }
    if (m.type === 'chat') {
      await load(m);
      const inputs = tok.apply_chat_template(m.messages, { add_generation_prompt: true, return_dict: true, enable_thinking: false });
      let raw = '';
      let sent = '';
      const streamer = new TextStreamer(tok, {
        skip_prompt: true,
        skip_special_tokens: true,
        callback_function: (t) => {
          raw += t;
          const c = clean(raw);
          if (c.length > sent.length && c.startsWith(sent)) { post({ type: 'token', id: m.id, text: c.slice(sent.length) }); sent = c; }
        },
      });
      stopper.reset();
      await model.generate({
        ...inputs,
        max_new_tokens: m.max || 400,
        do_sample: false,
        repetition_penalty: 1.08,
        streamer,
        stopping_criteria: stopper,
      });
      return post({ type: 'done', id: m.id, text: clean(raw).trim() });
    }
  } catch (e) {
    post({ type: 'error', id: m.id, message: e?.message || String(e) });
  }
};
post({ type: 'ready' });
