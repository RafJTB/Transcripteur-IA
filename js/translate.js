// Traduction locale de la transcription (vers le français par défaut).
//
// 1. Traducteur intégré de Chrome (API Translator, sur l'appareil) quand il existe.
// 2. Sinon, un modèle de traduction dans un worker (Transformers.js) :
//    - Opus-MT (≈ 107 Mo) pour les paires courantes vers le français,
//    - NLLB-200 (≈ 900 Mo) pour les autres langues.
// Rien n'est envoyé sur Internet (seuls les modèles sont téléchargés une fois).

/** Paires Opus-MT disponibles vers le français (Xenova/opus-mt-xx-fr). */
const OPUS_TO_FR = new Set(['en', 'es', 'de', 'it', 'nl', 'ro', 'ru']);
/** Codes NLLB-200. */
const NLLB = {
  fr: 'fra_Latn', en: 'eng_Latn', es: 'spa_Latn', de: 'deu_Latn', it: 'ita_Latn', pt: 'por_Latn', nl: 'nld_Latn',
  ar: 'arb_Arab', zh: 'zho_Hans', ja: 'jpn_Jpan', ru: 'rus_Cyrl', pl: 'pol_Latn', tr: 'tur_Latn', ro: 'ron_Latn',
};

export const LOCAL_MODELS = {
  opus: { label: 'Opus-MT', sizeMB: 107 },
  nllb: { label: 'NLLB-200', sizeMB: 895 },
};

/** Modèle local à utiliser pour une paire. */
export function localPlan(from, to = 'fr') {
  if (to === 'fr' && OPUS_TO_FR.has(from)) return { kind: 'opus', repo: `Xenova/opus-mt-${from}-fr`, ...LOCAL_MODELS.opus };
  if (NLLB[from] && NLLB[to]) return { kind: 'nllb', repo: 'Xenova/nllb-200-distilled-600M', src: NLLB[from], tgt: NLLB[to], ...LOCAL_MODELS.nllb };
  return null;
}

/** Promesse limitée dans le temps : certaines versions de Chrome ne répondent jamais. */
function within(promise, ms, what) {
  let t;
  return Promise.race([promise, new Promise((_, reject) => { t = setTimeout(() => reject(new Error(`${what} : pas de réponse`)), ms); })])
    .finally(() => clearTimeout(t));
}

/** État du traducteur de Chrome pour cette paire : 'available' | 'downloadable' | 'downloading' | 'unavailable' | null (absent). */
export async function chromeAvailability(from, to = 'fr') {
  if (!('Translator' in self)) return null;
  try {
    return await within(self.Translator.availability({ sourceLanguage: from, targetLanguage: to }), 3000, 'Traducteur de Chrome');
  } catch {
    return 'unavailable';
  }
}

/** Description lisible du moteur qui sera utilisé. */
export async function describeEngine(from, to = 'fr', { cached = false } = {}) {
  const a = await chromeAvailability(from, to);
  if (a === 'available') return { engine: 'chrome', text: 'Traducteur intégré de Chrome · prêt' };
  if (a === 'downloadable' || a === 'downloading') return { engine: 'chrome', text: 'Traducteur intégré de Chrome · petit pack de langue à télécharger une fois' };
  const p = localPlan(from, to);
  if (!p) return { engine: null, text: 'Aucun traducteur local pour cette langue.' };
  const size = p.sizeMB >= 1000 ? `${(p.sizeMB / 1000).toFixed(1).replace('.', ',')} Go` : `${p.sizeMB} Mo`;
  return { engine: p.kind, text: `Modèle ${p.label} · ${cached ? 'en cache' : `${size} à télécharger une fois`}` };
}

/**
 * Traducteur prêt à l'emploi. `onProgress({phase:'download'|'translate', value 0..1})`.
 * À créer juste après un clic (Chrome exige une action de l'utilisateur pour télécharger un pack).
 */
export async function createTranslator(from, to = 'fr', { onProgress, workerUrl } = {}) {
  const a = await chromeAvailability(from, to);
  if (a && a !== 'unavailable') {
    try {
      // Création : on attend tant que le pack de langue progresse, sinon on abandonne au bout de 20 s
      let alive = Date.now();
      const created = self.Translator.create({
        sourceLanguage: from,
        targetLanguage: to,
        monitor(m) { m.addEventListener('downloadprogress', (e) => { alive = Date.now(); onProgress?.({ phase: 'download', value: e.loaded }); }); },
      });
      const t = await new Promise((resolve, reject) => {
        const iv = setInterval(() => { if (Date.now() - alive > 20000) { clearInterval(iv); reject(new Error('Traducteur de Chrome : pas de réponse')); } }, 1000);
        created.then((v) => { clearInterval(iv); resolve(v); }, (e) => { clearInterval(iv); reject(e); });
      });
      // Vérification réelle avant de s'en servir
      await within(t.translate('Hello.'), 15000, 'Traducteur de Chrome');
      return {
        engine: 'chrome',
        label: 'Traducteur de Chrome',
        async translate(texts) {
          const out = [];
          for (const s of texts) out.push(s.trim() ? await within(t.translate(s), 30000, 'Traducteur de Chrome') : s);
          return out;
        },
        destroy() { t.destroy?.(); },
      };
    } catch (e) {
      console.warn('Traducteur de Chrome indisponible, modèle local à la place', e);
    }
  }
  const plan = localPlan(from, to);
  if (!plan) throw new Error('Aucun traducteur local pour cette langue.');
  return localTranslator(plan, { onProgress, workerUrl });
}

/** Démarre le worker et attend qu'il soit prêt à recevoir des messages. */
function spawn(workerUrl) {
  const w = new Worker(workerUrl, { type: 'module' });
  return within(new Promise((resolve, reject) => {
    w.onmessage = ({ data }) => { if (data.type === 'boot') resolve(w); };
    w.onerror = (e) => { e.preventDefault?.(); reject(new Error('Impossible de charger le traducteur (cdn.jsdelivr.net doit être accessible au premier lancement).')); };
  }), 60000, 'Traducteur local').catch((e) => { w.terminate(); throw e; });
}

async function localTranslator(plan, { onProgress, workerUrl }) {
  const w = await spawn(workerUrl);
  let seq = 0;
  const pending = new Map();
  w.onmessage = ({ data: m }) => {
    if (m.type === 'progress') return onProgress?.({ phase: 'download', value: m.value });
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    m.type === 'error' ? p.reject(new Error(m.message)) : p.resolve(m);
  };
  w.onerror = (e) => { for (const p of pending.values()) p.reject(new Error(e.message || 'Le traducteur a planté.')); pending.clear(); };
  const call = (msg) => new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    w.postMessage({ ...msg, id });
  });
  const ready = call({ type: 'load', repo: plan.repo });
  return ready.then(() => ({
    engine: plan.kind,
    label: plan.label,
    async translate(texts) {
      const r = await call({ type: 'translate', repo: plan.repo, texts, src: plan.src, tgt: plan.tgt });
      return r.texts;
    },
    destroy() { w.terminate(); },
  }), (e) => { w.terminate(); throw e; });
}

/** Le modèle local de cette paire est-il déjà dans le cache du navigateur ? */
export async function localCached(from, to = 'fr', workerUrl) {
  const plan = localPlan(from, to);
  if (!plan) return false;
  let w;
  try {
    w = await spawn(workerUrl);
    return await new Promise((resolve) => {
      w.onmessage = ({ data: m }) => resolve(!!m.cached);
      w.onerror = () => resolve(false);
      w.postMessage({ type: 'cache-status', repo: plan.repo, id: 0 });
      setTimeout(() => resolve(false), 8000);
    });
  } catch {
    return false;
  } finally {
    w?.terminate();
  }
}
