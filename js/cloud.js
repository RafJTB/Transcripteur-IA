// Compte Google (facultatif) : connexion, et sauvegarde / synchronisation des transcriptions
// dans le Google Drive de chaque utilisateur (dossier « Transcripteur IA »).
//
// - Connexion par redirection (OAuth 2.0 « application web côté client ») : pas de fenêtre
//   séparée, compatible avec l'isolation COOP/COEP qui rend le calcul multithread possible.
// - Droit demandé : drive.file = l'appli ne voit QUE les fichiers qu'elle a créés,
//   jamais le reste du Drive.
// - La transcription reste 100 % locale ; seuls les résultats (et l'audio) sont copiés
//   dans le Drive de la personne connectée. Personne d'autre n'y a accès.

import { Look, hash, isCustomPerso } from './presentation.js';
import { GOOGLE_CLIENT_ID } from './config.js';
import { History, Audios } from './history.js';

const SCOPES = 'openid email profile https://www.googleapis.com/auth/drive.file';
const FOLDER_NAME = 'Transcripteur IA';
const DRIVE = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const K = 'transcripteur.cloud.';

const ls = {
  get: (k, d = null) => { try { return localStorage.getItem(K + k) ?? d; } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem(K + k, v); } catch { /* ignore */ } },
  del: (k) => { try { localStorage.removeItem(K + k); } catch { /* ignore */ } },
};
const ss = {
  get: (k) => { try { return sessionStorage.getItem(K + k); } catch { return null; } },
  set: (k, v) => { try { sessionStorage.setItem(K + k, v); } catch { /* ignore */ } },
  del: (k) => { try { sessionStorage.removeItem(K + k); } catch { /* ignore */ } },
};
const json = (s, d) => { try { return JSON.parse(s) ?? d; } catch { return d; } };

/** Adresse de retour après la connexion : à déclarer telle quelle dans Google Cloud. */
export const redirectUri = () => location.origin + location.pathname;

// ======================================================================
// Connexion
// ======================================================================
export const Auth = {
  clientId: () => (GOOGLE_CLIENT_ID || ls.get('clientId', '') || '').trim(),
  setClientId(id) { id ? ls.set('clientId', id.trim()) : ls.del('clientId'); },
  /** Utilisateur connecté (mémorisé) : { email, name, picture } ou null. */
  user: () => json(ls.get('user'), null),
  token() {
    const t = json(ss.get('token'), null);
    return t && t.exp > Date.now() + 30_000 ? t.value : null;
  },
  /** Connecté, mais l'autorisation a expiré : il faut repasser par Google. */
  expired: () => !!Auth.user() && !Auth.token(),

  /** Comptes Google déjà utilisés dans ce navigateur (pour changer de compte en un clic). */
  accounts: () => json(ls.get('accounts'), []).filter((a) => a?.email),
  forgetAccount(email) { ls.set('accounts', JSON.stringify(Auth.accounts().filter((a) => a.email !== email))); },

  /**
   * Part chez Google, puis revient sur l'appli.
   * silent : sans écran si la session Google est ouverte ; email : compte voulu ; choose : choisir un autre compte.
   */
  signIn({ silent = false, email = null, choose = false } = {}) {
    const id = Auth.clientId();
    if (!id) throw new Error('La connexion Google n’est pas encore configurée (Paramètres).');
    const st = crypto.randomUUID();
    ss.set('state', st);
    const p = new URLSearchParams({
      client_id: id,
      redirect_uri: redirectUri(),
      response_type: 'token',
      scope: SCOPES,
      include_granted_scopes: 'true',
      state: st,
    });
    const u = Auth.user();
    const hint = choose ? null : email || u?.email;
    if (hint) p.set('login_hint', hint);
    if (silent) p.set('prompt', 'none');
    else if (choose || !hint) p.set('prompt', 'select_account');
    if (email || choose) ss.set('switching', '1');
    // Le compte actuel reste dans la liste pour pouvoir y revenir en un clic
    if (u && !Auth.accounts().some((x) => x.email === u.email)) ls.set('accounts', JSON.stringify([u, ...Auth.accounts()].slice(0, 6)));
    location.assign(`https://accounts.google.com/o/oauth2/v2/auth?${p}`);
  },

  /**
   * Retour de Google : lit le jeton dans l'adresse (#access_token=…) puis nettoie l'adresse.
   * @returns {Promise<null | {ok: true, first: boolean} | {ok: false, error: string}>}
   */
  async handleRedirect() {
    const h = location.hash.startsWith('#') ? new URLSearchParams(location.hash.slice(1)) : null;
    if (!h || (!h.has('access_token') && !h.has('error'))) return null;
    if (String(h.get('state') || '').startsWith('ms-')) return null; // retour de Microsoft (calendrier)
    history.replaceState(null, '', location.pathname + location.search);
    const expected = ss.get('state');
    ss.del('state');
    if (!expected || h.get('state') !== expected) return { ok: false, error: 'Réponse de Google inattendue (sécurité) : reconnecte-toi.' };
    if (h.has('error')) return { ok: false, error: h.get('error') };
    const value = h.get('access_token');
    const exp = Date.now() + (Number(h.get('expires_in')) || 3600) * 1000;
    ss.set('token', JSON.stringify({ value, exp }));
    ss.del('silent');
    if (!String(h.get('scope') || '').includes('drive.file')) return { ok: false, error: 'Accès à Google Drive refusé : coche la case « fichiers créés par cette application » à la connexion.' };
    const before = Auth.user();
    const r = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', { headers: { Authorization: `Bearer ${value}` } });
    if (!r.ok) return { ok: false, error: `Profil Google illisible (${r.status}).` };
    const p = await r.json();
    const user = { email: p.email, name: p.name || p.email, picture: p.picture || '' };
    // Changement de compte : le dossier Drive mémorisé appartenait à l'autre compte
    if (before && before.email !== user.email) ls.del('folderId');
    ls.set('user', JSON.stringify(user));
    ls.set('accounts', JSON.stringify([user, ...Auth.accounts().filter((a) => a.email !== user.email)].slice(0, 6)));
    ss.del('switching');
    return { ok: true, first: !before || before.email !== user.email };
  },

  /**
   * Au démarrage : autorisation expirée → reconnexion silencieuse (une seule tentative par onglet).
   * Renvoie true si la page part chez Google.
   */
  maybeSilentRefresh() {
    if (!Auth.clientId() || !Auth.expired() || ss.get('silent')) return false;
    ss.set('silent', '1');
    Auth.signIn({ silent: true });
    return true;
  },

  async signOut() {
    const t = Auth.token();
    ss.del('token');
    ss.del('silent');
    ls.del('user');
    ls.del('folderId');
    if (t) fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(t)}`, { method: 'POST' }).catch(() => {});
  },
};

// ======================================================================
// Google Drive (uniquement les fichiers créés par l'appli)
// ======================================================================
class DriveError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

async function api(url, opts = {}) {
  const t = Auth.token();
  if (!t) throw new DriveError(401, 'Reconnexion à Google nécessaire.');
  const r = await fetch(url, { ...opts, headers: { ...(opts.headers || {}), Authorization: `Bearer ${t}` } });
  if (r.status === 401) { ss.del('token'); throw new DriveError(401, 'Reconnexion à Google nécessaire.'); }
  if (!r.ok) {
    let msg = `${r.status}`;
    try { msg = (await r.json())?.error?.message || msg; } catch { /* ignore */ }
    throw new DriveError(r.status, `Google Drive : ${msg}`);
  }
  return r;
}

const q = (s) => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

export const Drive = {
  /** Dossier « Transcripteur IA » (créé au besoin). */
  async folder() {
    const cached = ls.get('folderId');
    if (cached) return cached;
    const query = `name='${q(FOLDER_NAME)}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
    const r = await (await api(`${DRIVE}/files?q=${encodeURIComponent(query)}&fields=files(id)&spaces=drive`)).json();
    let id = r.files?.[0]?.id;
    if (!id) {
      const c = await (await api(`${DRIVE}/files?fields=id`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: FOLDER_NAME, mimeType: 'application/vnd.google-apps.folder' }),
      })).json();
      id = c.id;
    }
    ls.set('folderId', id);
    return id;
  },

  /** Tous les fichiers de l'appli : [{ id, name, appProperties, size }]. */
  async list() {
    const folder = await Drive.folder();
    const out = [];
    let page = '';
    do {
      const query = `'${folder}' in parents and trashed=false`;
      const r = await (await api(`${DRIVE}/files?q=${encodeURIComponent(query)}&pageSize=1000&fields=nextPageToken,files(id,name,appProperties,size)${page ? `&pageToken=${page}` : ''}`)).json();
      out.push(...(r.files || []));
      page = r.nextPageToken || '';
    } while (page);
    return out;
  },

  /** Crée ou remplace un fichier (envoi en une fois, ou par morceaux au-delà de 5 Mo). */
  async put(fileId, name, blob, appProperties) {
    const meta = fileId ? { name, appProperties } : { name, appProperties, parents: [await Drive.folder()] };
    const type = blob.type || 'application/octet-stream';
    if (blob.size <= 5 * 1024 * 1024) {
      const form = new FormData();
      form.append('metadata', new Blob([JSON.stringify(meta)], { type: 'application/json' }));
      form.append('file', blob);
      const url = fileId ? `${UPLOAD}/files/${fileId}?uploadType=multipart&fields=id` : `${UPLOAD}/files?uploadType=multipart&fields=id`;
      return (await (await api(url, { method: fileId ? 'PATCH' : 'POST', body: form })).json()).id;
    }
    const start = await api(fileId ? `${UPLOAD}/files/${fileId}?uploadType=resumable&fields=id` : `${UPLOAD}/files?uploadType=resumable&fields=id`, {
      method: fileId ? 'PATCH' : 'POST',
      headers: { 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Type': type, 'X-Upload-Content-Length': String(blob.size) },
      body: JSON.stringify(meta),
    });
    const loc = start.headers.get('Location');
    if (!loc) throw new DriveError(0, 'Google Drive : envoi impossible (adresse d’envoi absente).');
    const r = await fetch(loc, { method: 'PUT', headers: { 'Content-Type': type }, body: blob });
    if (!r.ok) throw new DriveError(r.status, `Google Drive : envoi interrompu (${r.status}).`);
    return (await r.json()).id;
  },

  async getBlob(id) { return (await api(`${DRIVE}/files/${id}?alt=media`)).blob(); },
  async getJson(id) { return (await api(`${DRIVE}/files/${id}?alt=media`)).json(); },
  async getText(id) { return (await api(`${DRIVE}/files/${id}?alt=media`)).text(); },
  async remove(id) {
    try { await api(`${DRIVE}/files/${id}`, { method: 'DELETE' }); } catch (e) { if (e.status !== 404) throw e; }
  },
};

// ======================================================================
// Dossiers de travail (par compte ; « local » sans compte)
// ======================================================================
const ownerKey = () => Auth.user()?.email || 'local';

export const Folders = {
  /** Tous les dossiers, y compris supprimés (pierres tombales pour la synchro). */
  raw: () => json(ls.get(`folders.${ownerKey()}`), []),
  save(list) { ls.set(`folders.${ownerKey()}`, JSON.stringify(list)); Sync.schedule(); },
  list: () => Folders.raw().filter((f) => !f.deleted).sort((a, b) => a.name.localeCompare(b.name, 'fr')),
  get: (id) => Folders.list().find((f) => f.id === id) || null,
  add(name) {
    const f = { id: crypto.randomUUID().slice(0, 8), name: name.trim().slice(0, 60), updatedAt: Date.now() };
    Folders.save([...Folders.raw(), f]);
    return f;
  },
  rename(id, name) { Folders.save(Folders.raw().map((f) => (f.id === id ? { ...f, name: name.trim().slice(0, 60), updatedAt: Date.now() } : f))); },
  remove(id) { Folders.save(Folders.raw().map((f) => (f.id === id ? { ...f, deleted: true, updatedAt: Date.now() } : f))); },
  /** Fusion avec la version du Drive : la modification la plus récente gagne, dossier par dossier. */
  merge(remote) {
    const m = new Map(Folders.raw().map((f) => [f.id, f]));
    for (const f of remote || []) if (!m.has(f.id) || (m.get(f.id).updatedAt || 0) < (f.updatedAt || 0)) m.set(f.id, f);
    ls.set(`folders.${ownerKey()}`, JSON.stringify([...m.values()]));
  },
};

/** Transcription venue du Drive : une transcription interrompue ailleurs ne peut pas reprendre ici. */
function fromRemote(d, email) {
  const doc = { ...d, owner: email, remoteSeen: true };
  if ((doc.status === 'interrupted' || doc.status === 'running' || doc.status === 'live') && !doc.job) Object.assign(doc, { status: 'done', partial: true });
  return doc;
}

// ======================================================================
// Synchronisation (la dernière modification gagne)
// ======================================================================
const tombKey = () => `deleted.${Auth.user()?.email}`;
const listeners = new Set();

export const Sync = {
  /** Réunions supprimées ici, encore annulables : la synchronisation ne les fait pas revenir. */
  held: new Set(),
  status: 'idle', // idle | syncing | ok | error | expired | off
  error: '',
  lastAt: Number(ls.get('lastAt', 0)) || 0,
  _timer: 0,
  _running: null,
  _again: false,
  _remote: null, // dernière liste des fichiers (pour retrouver un audio sans relister)

  on(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  _set(status, error = '') {
    Sync.status = status;
    Sync.error = error;
    for (const fn of listeners) fn(Sync);
  },
  enabled: () => !!Auth.user() && !!Auth.clientId(),

  /** Transcription supprimée ici : à supprimer aussi du Drive à la prochaine synchro. */
  /** Envoyer aussi les vidéos de l'écran dans Google Drive (activé par défaut). */
  videosEnabled: () => ls.get('videos', '1') === '1',
  setVideosEnabled(on) { ls.set('videos', on ? '1' : '0'); if (on) Sync.schedule(1000); },

  /** Vidéo de l'écran de cet audio présente dans Google Drive ? (d'après la dernière synchro) */
  videoOnDrive: (aid) => Sync._remote?.find((x) => x.appProperties?.kind === 'video' && x.appProperties.aid === aid) || null,

  /** Supprime seulement la vidéo de l'écran dans Google Drive (le son est gardé). */
  forgetVideo(aid) {
    if (!Sync.enabled()) return;
    const t = json(ls.get(tombKey()), { docs: [], audios: [] });
    t.videos = [...new Set([...(t.videos || []), aid])];
    ls.set(tombKey(), JSON.stringify(t));
    Sync.schedule();
  },

  /** Vidéo absente de ce navigateur : récupérée du Drive. */
  async pullVideo(aid) {
    if (!Sync.enabled() || !Auth.token() || !aid) return null;
    let f = Sync.videoOnDrive(aid);
    if (!f) { Sync._remote = await Drive.list(); f = Sync.videoOnDrive(aid); }
    if (!f) return null;
    const blob = await Drive.getBlob(f.id);
    const rec = { id: `${aid}.video`, blob, name: 'Écran', durationS: Number(f.appProperties.dur) || undefined, createdAt: Date.now(), kind: 'video' };
    await Audios.put(rec);
    return rec;
  },

  forget(docId, audioId = null) {
    if (!Sync.enabled()) return;
    const t = json(ls.get(tombKey()), { docs: [], audios: [] });
    if (docId && !t.docs.includes(docId)) t.docs.push(docId);
    if (audioId && !t.audios.includes(audioId)) t.audios.push(audioId);
    ls.set(tombKey(), JSON.stringify(t));
    Sync.schedule();
  },

  /** Synchro groupée quelques secondes après une modification. */
  schedule(delay = 4000) {
    if (!Sync.enabled()) return;
    clearTimeout(Sync._timer);
    Sync._timer = setTimeout(() => Sync.run().catch(() => {}), delay);
  },

  async run() {
    if (!Sync.enabled()) return Sync._set('off');
    if (!Auth.token()) return Sync._set('expired', 'Reconnexion à Google nécessaire.');
    if (Sync._running) { Sync._again = true; return Sync._running; }
    Sync._running = Sync._doRun()
      .then((changed) => { Sync.lastAt = Date.now(); ls.set('lastAt', String(Sync.lastAt)); Sync._set('ok'); return changed; })
      .catch((e) => { Sync._set(e.status === 401 ? 'expired' : 'error', e.message); throw e; })
      .finally(() => {
        Sync._running = null;
        if (Sync._again) { Sync._again = false; Sync.schedule(1000); }
      });
    return Sync._running;
  },

  /** @returns {Promise<boolean>} true si des transcriptions locales ont changé */
  async _doRun() {
    Sync._set('syncing');
    const email = Auth.user().email;
    let changed = false;
    const files = await Drive.list();
    Sync._remote = files;
    const rDocs = new Map();
    const rAudios = new Map();
    const rVideos = new Map();
    let rFolders = null;
    for (const f of files) {
      const p = f.appProperties || {};
      if (p.kind === 'doc' && p.tid) rDocs.set(p.tid, f);
      else if (p.kind === 'audio' && p.aid) rAudios.set(p.aid, f);
      else if (p.kind === 'video' && p.aid) rVideos.set(p.aid, f);
      else if (p.kind === 'folders') rFolders = f;
    }

    // 0. Présentation (thème, fond, couleurs, effets) : la plus récente gagne. En premier (rapide),
    //    et isolée : un envoi d'audio qui échoue plus loin ne l'empêche pas.
    if (Look.enabled()) {
      try { await Sync._syncLook(files); } catch (e) { Look.setStatus('error', e.message); }
    }

    // 1. Suppressions faites sur ce navigateur
    const tomb = json(ls.get(tombKey()), { docs: [], audios: [] });
    for (const id of [...tomb.docs]) {
      if (rDocs.has(id)) { await Drive.remove(rDocs.get(id).id); rDocs.delete(id); }
      tomb.docs = tomb.docs.filter((x) => x !== id);
    }
    for (const id of [...tomb.audios]) {
      if (rAudios.has(id)) { await Drive.remove(rAudios.get(id).id); rAudios.delete(id); }
      // L'audio supprimé emporte sa vidéo d'écran
      if (rVideos.has(id)) { await Drive.remove(rVideos.get(id).id); rVideos.delete(id); }
      tomb.audios = tomb.audios.filter((x) => x !== id);
    }
    for (const id of [...(tomb.videos || [])]) {
      if (rVideos.has(id)) { await Drive.remove(rVideos.get(id).id); rVideos.delete(id); }
      tomb.videos = tomb.videos.filter((x) => x !== id);
    }
    ls.set(tombKey(), JSON.stringify(tomb));

    // 2. Transcriptions
    const all = await History.list();
    const local = all.filter((d) => d.owner === email);
    const localIds = new Set(local.map((d) => d.id));
    for (const d of local) {
      if (d.status === 'running' || d.status === 'live') continue; // en cours : envoyée à la fin
      const r = rDocs.get(d.id);
      const lu = d.updatedAt || d.createdAt || 0;
      if (!r) {
        if (d.remoteSeen) { await History.remove(d.id); changed = true; continue; } // supprimée ailleurs
        await Sync._upload(d, null);
      } else {
        const ru = Number(r.appProperties.u) || 0;
        if (lu > ru) await Sync._upload(d, r.id);
        else if (ru > lu) { await History.put(fromRemote(await Drive.getJson(r.id), email)); changed = true; }
        else if (!d.remoteSeen) await History.put({ ...d, remoteSeen: true });
      }
    }
    for (const [id, r] of rDocs) {
      if (localIds.has(id) || Sync.held.has(id)) continue; // en attente de suppression (« Annuler » possible)
      const d = await Drive.getJson(r.id);
      // Même identifiant chez un autre compte de ce navigateur : on ne mélange pas
      if (all.some((x) => x.id === id)) continue;
      await History.put(fromRemote(d, email));
      changed = true;
    }

    // 3. Audios d'origine (envoyés une fois ; récupérés seulement à l'ouverture)
    // Choix de l'utilisateur pour chaque audio (audioWhere) : « local » et « none » ne partent jamais ;
    // « drive » : la copie de ce PC est retirée une fois l'audio dans le Drive. Sans choix (anciennes transcriptions) : envoyé.
    // (relu après l'étape 2 : un choix fait sur un autre appareil est déjà arrivé ici, on ne renvoie donc pas
    // un audio que l'utilisateur a demandé de garder sur son PC ou d'effacer)
    const fresh = (await History.list()).filter((d) => d.owner === email);
    const whereOf = new Map(fresh.filter((d) => d.audioId).map((d) => [d.audioId, d.audioWhere || '']));
    for (const [aid, where] of whereOf) {
      if (where === 'local' || where === 'none') continue;
      if (!rAudios.has(aid)) {
        const a = await Audios.get(aid).catch(() => null);
        if (!a?.blob) continue;
        const ext = (a.blob.type.split('/')[1] || 'audio').split(';')[0];
        const id = await Drive.put(null, `audio-${aid}.${ext}`, a.blob, { kind: 'audio', aid, name: String(a.name || '').slice(0, 100), dur: String(Math.round(a.durationS || 0)) });
        rAudios.set(aid, { id, appProperties: { kind: 'audio', aid } });
        Sync._remote.push({ id, appProperties: { kind: 'audio', aid, name: String(a.name || '').slice(0, 100), dur: String(Math.round(a.durationS || 0)) } });
      }
      if (where === 'drive') await Audios.removeOnly(aid).catch(() => {});
    }

    // 3 bis. Vidéos de l'écran (option, activée par défaut) : envoyées une fois, nom lisible dans Drive
    if (Sync.videosEnabled()) {
      for (const d of local) {
        const aid = d.audioId;
        if (!aid || rVideos.has(aid) || d.audioWhere === 'local' || d.audioWhere === 'none') continue;
        const v = await Audios.get(`${aid}.video`).catch(() => null);
        if (!v?.blob?.size) continue;
        Sync._set('syncing', `Envoi de la vidéo de l’écran (${Math.round(v.blob.size / 1e6)} Mo)…`);
        const name = `${String(d.title || 'Réunion').replace(/[\\/:*?"<>|]+/g, ' ').slice(0, 80)} · écran.webm`;
        const id = await Drive.put(null, name, v.blob, { kind: 'video', aid, dur: String(Math.round(v.durationS || d.durationS || 0)) });
        rVideos.set(aid, { id, appProperties: { kind: 'video', aid } });
        Sync._remote.push({ id, appProperties: { kind: 'video', aid } });
      }
    }

    // 4. Dossiers
    if (rFolders) Folders.merge(await Drive.getJson(rFolders.id));
    const fl = new Blob([JSON.stringify(Folders.raw())], { type: 'application/json' });
    await Drive.put(rFolders?.id || null, 'dossiers.json', fl, { kind: 'folders' });

    return changed;
  },

  async _syncLook(files) {
    const newest = (kind) => files.filter((f) => f.appProperties?.kind === kind).sort((a, b) => (Number(b.appProperties.u) || 0) - (Number(a.appProperties.u) || 0))[0] || null;
    const rLook = newest('look');
    const rImg = files.filter((f) => f.appProperties?.kind === 'lookimg').pop() || null;
    let ru = Number(rLook?.appProperties?.u) || 0;
    const custom = Look.isCustom();
    let remote = null;
    // Le Drive ne contient qu'une présentation par défaut envoyée automatiquement (pas choisie par
    // l'utilisateur) : elle n'écrase jamais une vraie présentation personnalisée, qui est envoyée à la place.
    if (rLook && custom) {
      const p = rLook.appProperties || {};
      let rCustom = p.c === '1' ? true : p.c === '0' ? false : null;
      let rAuto = p.a === '1' ? true : p.a === '0' ? false : null;
      if (rCustom == null || rAuto == null) { // fichier d'une version précédente : on lit son contenu
        remote = await Drive.getJson(rLook.id);
        rCustom ??= remote.custom ?? (isCustomPerso(remote.perso) || !!remote.imgHash);
        rAuto ??= remote.auto ?? true;
      }
      if (!rCustom && rAuto) { ru = 0; Look.stamp(); }
    }
    // Réglages faits avant cette fonction (sans date), personnalisés : envoyés si le Drive n'a rien de mieux
    if (!Look.updatedAt() && custom && !ru) Look.stamp();
    const lu = Look.updatedAt();
    if (rLook && ru > lu) {
      // Réglages plus récents ailleurs : on les applique ici
      remote ??= await Drive.getJson(rLook.id);
      const img = remote.imgHash && remote.imgHash !== hash(Look.image()) && rImg ? await Drive.getText(rImg.id) : null;
      if (Look.apply(remote, img)) { Look.setStatus('in'); Sync.onLook?.(); }
    } else if (lu > ru) {
      // Réglages faits ici plus récents : on les envoie (l'image seulement si elle a changé)
      const snap = Look.snapshot();
      if (!snap.custom && snap.auto) return; // jamais de présentation par défaut envoyée sans que l'utilisateur l'ait choisie
      await Drive.put(rLook?.id || null, 'presentation.json', new Blob([JSON.stringify(snap)], { type: 'application/json' }), { kind: 'look', u: String(lu), c: snap.custom ? '1' : '0', a: snap.auto ? '1' : '0' });
      const img = Look.image();
      if (img && rImg?.appProperties?.h !== snap.imgHash) await Drive.put(rImg?.id || null, 'fond-perso.txt', new Blob([img], { type: 'text/plain' }), { kind: 'lookimg', h: snap.imgHash });
      Look.setStatus('out');
    } else if (rLook || lu) Look.setStatus('same');
  },

  async _upload(d, fileId) {
    const doc = { ...d, remoteSeen: true };
    delete doc.job; // état interne d'une transcription en cours : inutile ailleurs
    const blob = new Blob([JSON.stringify(doc)], { type: 'application/json' });
    const name = `${String(d.title || 'transcription').replace(/[\\/:*?"<>|]+/g, ' ').slice(0, 60)} · ${d.id}.json`;
    await Drive.put(fileId, name, blob, { kind: 'doc', tid: d.id, u: String(d.updatedAt || d.createdAt || 0) });
    if (!d.remoteSeen) await History.put({ ...d, remoteSeen: true });
  },

  /** Audio absent de ce navigateur (transcription faite sur un autre appareil) : récupéré du Drive. */
  async pullAudio(aid) {
    if (!Sync.enabled() || !Auth.token() || !aid) return null;
    let f = Sync._remote?.find((x) => x.appProperties?.kind === 'audio' && x.appProperties.aid === aid);
    if (!f) {
      Sync._remote = await Drive.list();
      f = Sync._remote.find((x) => x.appProperties?.kind === 'audio' && x.appProperties.aid === aid);
    }
    if (!f) return null;
    const blob = await Drive.getBlob(f.id);
    const rec = { id: aid, blob, name: f.appProperties.name || 'Audio', durationS: Number(f.appProperties.dur) || undefined, createdAt: Date.now() };
    await Audios.put(rec);
    return rec;
  },
};

// Présentation modifiée par l'utilisateur : synchronisation prochaine
Look.onTouch = () => Sync.schedule(1500);
