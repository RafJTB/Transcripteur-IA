// Configuration centrale : modèles, langues, paramètres de découpage.
// Versions vérifiées le 17/11/2026 sur npm et Hugging Face.

/**
 * Connexion Google (facultative) : identifiant client OAuth « Application Web » créé dans
 * Google Cloud (pas un secret). Vide = connexion désactivée, sauf si un identifiant est saisi
 * dans Paramètres (pratique pour tester).
 */
export const GOOGLE_CLIENT_ID = '770910751766-si7jchglbtg2sndoo9gjtrc6kpd9m4in.apps.googleusercontent.com';

export const TRANSFORMERS_VERSION = '4.3.2';
export const TRANSFORMERS_URL =
  `https://cdn.jsdelivr.net/npm/@huggingface/transformers@${TRANSFORMERS_VERSION}/dist/transformers.min.js`;

/**
 * Chaque modèle a une variante par backend :
 *  - webgpu : encodeur en précision élevée (qualité) + décodeur q4 (vitesse)
 *  - wasm   : tout en q8 (le plus rapide sur CPU)
 * Tailles en Mo = somme réelle des fichiers ONNX sur Hugging Face.
 */
export const MODELS = [
  {
    id: 'base',
    repo: 'onnx-community/whisper-base',
    label: 'Rapide',
    name: 'Whisper Base',
    params: '74 M',
    description: 'Léger et rapide. Correct sur une voix claire, plus d’erreurs sur le vocabulaire technique.',
    variants: {
      webgpu: { dtype: { encoder_model: 'fp32', decoder_model_merged: 'q4' }, sizeMB: 206 },
      wasm: { dtype: { encoder_model: 'q8', decoder_model_merged: 'q8' }, sizeMB: 77 },
    },
  },
  {
    id: 'small',
    repo: 'onnx-community/whisper-small',
    label: 'Équilibré',
    name: 'Whisper Small',
    params: '244 M',
    description: 'Nettement meilleur en français que Base. Bon compromis sur la plupart des PC.',
    variants: {
      webgpu: { dtype: { encoder_model: 'fp32', decoder_model_merged: 'q4' }, sizeMB: 586 },
      wasm: { dtype: { encoder_model: 'q8', decoder_model_merged: 'q8' }, sizeMB: 249 },
    },
  },
  {
    id: 'turbo',
    repo: 'onnx-community/whisper-large-v3-turbo',
    label: 'Précis',
    name: 'Whisper Large v3 Turbo',
    params: '809 M',
    description: 'La meilleure précision. Conçu pour WebGPU ; très lent sans carte graphique.',
    variants: {
      // shader-f16 disponible : encodeur fp16 (meilleure qualité)
      webgpu: { dtype: { encoder_model: 'fp16', decoder_model_merged: 'q4' }, sizeMB: 1609 },
      // pas de shader-f16 : encodeur q4 (fp32 = 2,5 Go, trop lourd)
      webgpuNoF16: { dtype: { encoder_model: 'q4', decoder_model_merged: 'q4' }, sizeMB: 759 },
      wasm: { dtype: { encoder_model: 'q8', decoder_model_merged: 'q8' }, sizeMB: 1085 },
    },
    heavy: true,
  },
  {
    id: 'voxtral',
    kind: 'voxtral',
    repo: 'onnx-community/Voxtral-Mini-4B-Realtime-2602-ONNX',
    label: 'Temps réel',
    name: 'Voxtral Realtime (Mistral)',
    params: '4 B',
    description: 'Vrai temps réel : le texte suit la parole avec ~0,5 s de décalage. Langue détectée automatiquement. Carte graphique obligatoire.',
    variants: {
      webgpu: { dtype: { audio_encoder: 'q4f16', embed_tokens: 'q4f16', decoder_model_merged: 'q4f16' }, sizeMB: 2835 },
      webgpuNoF16: { dtype: { audio_encoder: 'q4', embed_tokens: 'q4', decoder_model_merged: 'q4' }, sizeMB: 3184 },
      // Pas de version processeur : 4 milliards de paramètres, beaucoup trop lent sans carte graphique.
    },
    heavy: true,
    gpuOnly: true,
  },
];

export const DEFAULT_MODEL = 'small';

/** Retourne la variante adaptée aux capacités détectées (null = modèle inutilisable sur ce PC). */
export function pickVariant(model, caps) {
  if (model.gpuOnly && !caps.webgpu) return null;
  if (caps.webgpu) {
    if (!caps.f16 && model.variants.webgpuNoF16) return { device: 'webgpu', ...model.variants.webgpuNoF16 };
    return { device: 'webgpu', ...model.variants.webgpu };
  }
  return { device: 'wasm', ...model.variants.wasm };
}

/** Modèle plus léger à proposer en cas d'échec (mémoire insuffisante, etc.). */
export function lighterModel(id) {
  const i = MODELS.findIndex((m) => m.id === id);
  return i > 0 ? MODELS[i - 1] : null;
}

/** Modèle conçu pour le flux continu (direct sans re-transcription). */
export const isStreaming = (model) => model?.kind === 'voxtral';

// Whisper (Transformers.js v4) ne détecte pas la langue automatiquement :
// elle doit être fournie explicitement. Voxtral, lui, la détecte seul.
export const LANGUAGES = [
  ['fr', 'Français'], ['en', 'Anglais'], ['es', 'Espagnol'], ['de', 'Allemand'],
  ['it', 'Italien'], ['pt', 'Portugais'], ['nl', 'Néerlandais'], ['ar', 'Arabe'],
  ['zh', 'Chinois'], ['ja', 'Japonais'], ['ru', 'Russe'], ['pl', 'Polonais'],
  ['tr', 'Turc'], ['ro', 'Roumain'],
];

// Découpage des fichiers longs : fenêtres de 30 s (taille native de Whisper),
// chevauchement de 5 s de chaque côté, fusionné au niveau des tokens.
export const CHUNKING = { chunkLengthS: 30, strideLengthS: 5 };


export const SAMPLE_RATE = 16000;

/**
 * Assistant : petit modèle de langage local (Transformers.js).
 * Avec une carte graphique (WebGPU) : Qwen3 1,7B ; sinon Qwen3 0,6B sur le processeur.
 */
export const LLM_MODELS = {
  large: { repo: 'onnx-community/Qwen3-1.7B-ONNX', device: 'webgpu', dtype: 'q4f16', sizeMB: 1430, label: 'Qwen3 1,7B' },
  small: { repo: 'onnx-community/Qwen3-0.6B-ONNX', device: 'wasm', dtype: 'q8', sizeMB: 620, label: 'Qwen3 0,6B' },
};

/**
 * Espaces collaboratifs (Supabase) : adresse du projet et clé publique « anon » / « publishable ».
 * Ces deux valeurs sont faites pour être publiques (la sécurité vient des règles d'accès du script SQL).
 * Vides : à renseigner dans l'appli (onglet Espaces). Ne jamais mettre la clé « service_role ».
 */
export const SUPABASE_URL = 'https://qcrtmhghjaetfxnwsqto.supabase.co';
export const SUPABASE_ANON_KEY = 'sb_publishable_ChGBljQJ7O0ks4eNnsn4Zw_hbJnlu7c';
