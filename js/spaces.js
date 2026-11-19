// Espaces collaboratifs : couche d'accès à Supabase (connexion, espaces, membres, transcriptions, audio).
// La base et les règles d'accès sont décrites dans supabase/schema.sql.
// Tout ce qui est partagé dans un espace est stocké sur le projet Supabase configuré (et non plus seulement ici).

import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';

const SDK_URL = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.118.0/+esm';
const LS = 'transcripteur.spaces.';
const lsGet = (k, d = '') => { try { return localStorage.getItem(LS + k) ?? d; } catch { return d; } };
const lsSet = (k, v) => { try { v ? localStorage.setItem(LS + k, v) : localStorage.removeItem(LS + k); } catch { /* ignore */ } };
const BUCKET = 'space-audio';

/** « https://xxx.supabase.co/rest/v1/ » (adresse de l'API copiée telle quelle) → « https://xxx.supabase.co ». */
export const normalizeUrl = (u) => {
  const t = String(u || '').trim();
  const m = t.match(/^(https:\/\/[a-z0-9-]+\.supabase\.(?:co|in))(?:\/.*)?$/i);
  return m ? m[1].toLowerCase() : t.replace(/\/+$/, '');
};

let client = null;
let clientKey = '';

export const Spaces = {
  /** Adresse et clé publique du projet : config.js, sinon réglées dans l'appli. */
  url: () => normalizeUrl(SUPABASE_URL || lsGet('url')),
  key: () => (SUPABASE_ANON_KEY || lsGet('key')).trim(),
  configured: () => /^https:\/\/[a-z0-9-]+\.supabase\.(co|in)$/i.test(Spaces.url()) && Spaces.key().length > 20,
  fixed: () => !!(SUPABASE_URL && SUPABASE_ANON_KEY),
  setConfig(url, key) { lsSet('url', url.trim()); lsSet('key', key.trim()); client = null; },

  /** Client Supabase (chargé à la demande). Pour les tests, window.__spacesClient le remplace. */
  async client() {
    if (window.__spacesClient) return window.__spacesClient;
    if (!Spaces.configured()) throw new Error('Espace collaboratif pas encore configuré.');
    const k = `${Spaces.url()}|${Spaces.key()}`;
    if (client && clientKey === k) return client;
    const { createClient } = await import(SDK_URL);
    client = createClient(Spaces.url(), Spaces.key(), {
      auth: { flowType: 'pkce', persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, storageKey: 'transcripteur.spaces.auth' },
    });
    clientKey = k;
    return client;
  },

  /** Retour de Google (?code=…) : la session est créée par le client ; on nettoie l'adresse. */
  isAuthReturn: () => new URLSearchParams(location.search).has('code') && lsGet('pending') === '1',

  async user() {
    const c = await Spaces.client();
    const { data } = await c.auth.getSession();
    const u = data?.session?.user;
    if (!u) return null;
    return { id: u.id, email: (u.email || '').toLowerCase(), name: u.user_metadata?.full_name || u.user_metadata?.name || u.email, picture: u.user_metadata?.avatar_url || '' };
  },

  async signIn(loginHint = '') {
    const c = await Spaces.client();
    lsSet('pending', '1');
    const { error } = await c.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: location.origin + location.pathname, queryParams: { prompt: 'select_account', ...(loginHint ? { login_hint: loginHint } : {}) } },
    });
    if (error) { lsSet('pending', ''); throw error; }
  },

  async finishSignIn() {
    lsSet('pending', '');
    const c = await Spaces.client();
    const code = new URLSearchParams(location.search).get('code');
    // Le client échange le code tout seul (detectSessionInUrl) ; au cas où, on le fait nous-mêmes
    let { data } = await c.auth.getSession();
    if (!data?.session && code) {
      const r = await c.auth.exchangeCodeForSession(code);
      if (r.error) throw r.error;
    }
    const u = new URL(location.href);
    u.searchParams.delete('code');
    history.replaceState(null, '', u.pathname + (u.search || '') + u.hash);
  },

  async signOut() {
    const c = await Spaces.client();
    await c.auth.signOut();
  },

  // ---------- Espaces ----------
  async list() {
    const c = await Spaces.client();
    const { data, error } = await c.from('spaces').select('id, name, owner, created_at, space_members(count), space_docs(count)').order('created_at', { ascending: true });
    if (error) throw error;
    return (data || []).map((s) => ({ ...s, members: s.space_members?.[0]?.count ?? 0, docs: s.space_docs?.[0]?.count ?? 0 }));
  },
  async create(name) {
    const c = await Spaces.client();
    const { data, error } = await c.from('spaces').insert({ name: name.trim().slice(0, 80) }).select().single();
    if (error) throw error;
    return data;
  },
  async rename(id, name) {
    const c = await Spaces.client();
    const { error } = await c.from('spaces').update({ name: name.trim().slice(0, 80) }).eq('id', id);
    if (error) throw error;
  },
  async remove(id) {
    const c = await Spaces.client();
    // Les fichiers audio de l'espace d'abord (la base les supprime en cascade, pas le stockage)
    const { data: files } = await c.storage.from(BUCKET).list(id, { limit: 1000 });
    if (files?.length) await c.storage.from(BUCKET).remove(files.map((f) => `${id}/${f.name}`));
    const { error } = await c.from('spaces').delete().eq('id', id);
    if (error) throw error;
  },

  // ---------- Membres ----------
  async members(spaceId) {
    const c = await Spaces.client();
    const { data, error } = await c.from('space_members').select('email, role, created_at').eq('space_id', spaceId).order('created_at');
    if (error) throw error;
    return data || [];
  },
  async invite(spaceId, email) {
    const c = await Spaces.client();
    const { error } = await c.from('space_members').insert({ space_id: spaceId, email: email.trim().toLowerCase() });
    if (error) throw error;
  },
  async removeMember(spaceId, email) {
    const c = await Spaces.client();
    const { error } = await c.from('space_members').delete().eq('space_id', spaceId).eq('email', email);
    if (error) throw error;
  },

  // ---------- Transcriptions ----------
  async docs(spaceId) {
    const c = await Spaces.client();
    const { data, error } = await c.from('space_docs')
      .select('id, title, duration_s, audio_path, audio_bytes, created_by, author_name, author_email, created_at')
      .eq('space_id', spaceId).order('created_at', { ascending: false });
    if (error) throw error;
    return data || [];
  },
  async doc(id) {
    const c = await Spaces.client();
    const { data, error } = await c.from('space_docs').select('*').eq('id', id).single();
    if (error) throw error;
    return data;
  },
  /** Partage une transcription (texte + audio compressé facultatif). */
  async share(spaceId, doc, audioBlob, me) {
    const c = await Spaces.client();
    let audio_path = null;
    if (audioBlob) {
      audio_path = `${spaceId}/${crypto.randomUUID()}.ogg`;
      const { error } = await c.storage.from(BUCKET).upload(audio_path, audioBlob, { contentType: 'audio/ogg', upsert: false });
      if (error) throw error;
    }
    // On ne partage que ce qui sert : pas l'état interne ni les empreintes de voix
    const { job, owner, remoteSeen, audioId, folderId, actionState, ...rest } = doc;
    const clean = { ...rest, speakers: (doc.speakers || []).map(({ emb, learned, known, ...p }) => p) };
    const { data, error } = await c.from('space_docs').insert({
      space_id: spaceId, title: doc.title, doc: clean, duration_s: doc.durationS || null,
      audio_path, audio_bytes: audioBlob?.size || null, author_name: me?.name || null, author_email: me?.email || null,
    }).select('id').single();
    if (error) {
      if (audio_path) await c.storage.from(BUCKET).remove([audio_path]).catch(() => {});
      throw error;
    }
    return data.id;
  },
  async unshare(row) {
    const c = await Spaces.client();
    if (row.audio_path) await c.storage.from(BUCKET).remove([row.audio_path]).catch(() => {});
    const { error } = await c.from('space_docs').delete().eq('id', row.id);
    if (error) throw error;
  },
  async audio(path) {
    const c = await Spaces.client();
    const { data, error } = await c.storage.from(BUCKET).download(path);
    if (error) throw error;
    return data;
  },
};

/** Messages d'erreur de Supabase, en clair. */
export function spacesError(e) {
  const t = String(e?.message || e || '');
  if (/relation .* does not exist|schema cache|Could not find the table/i.test(t)) return 'La base n’est pas encore prête : exécute le script SQL (Paramètres de l’espace collaboratif).';
  if (/Bucket not found/i.test(t)) return 'Le stockage audio n’est pas prêt : exécute le script SQL complet.';
  if (/row-level security|permission denied|violates/i.test(t)) return 'Action non autorisée pour ton compte dans cet espace.';
  if (/duplicate key/i.test(t)) return 'Cette personne est déjà membre.';
  if (/Failed to fetch|NetworkError|network/i.test(t)) return 'Impossible de joindre le serveur de l’espace collaboratif (connexion ?).';
  if (/exceeded|too large|Payload/i.test(t)) return 'Fichier trop lourd pour l’espace (limite 50 Mo).';
  if (/provider is not enabled|Unsupported provider/i.test(t)) return 'La connexion Google n’est pas activée dans Supabase (Authentication → Providers → Google).';
  return t || 'Erreur inconnue.';
}
