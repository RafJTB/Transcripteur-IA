// Calendrier Outlook (Microsoft 365, Outlook.com) : connexion Microsoft et lecture de l'agenda, en lecture seule.
// Connexion OAuth 2.0 « code + PKCE » (application monopage), directement depuis le navigateur : aucun serveur,
// aucun secret. L'appli est déclarée une fois dans le portail Microsoft (Entra ID) : son identifiant est public.

import { OUTLOOK_CLIENT_ID } from './config.js';
import { graphToEvent } from './calendar.js';

const AUTH = 'https://login.microsoftonline.com/common/oauth2/v2.0';
const GRAPH = 'https://graph.microsoft.com/v1.0';
const SCOPES = 'openid profile offline_access User.Read Calendars.Read';
const LS = 'transcripteur.outlook.';
const ls = {
  get: (k, d = '') => { try { return localStorage.getItem(LS + k) ?? d; } catch { return d; } },
  set: (k, v) => { try { v ? localStorage.setItem(LS + k, v) : localStorage.removeItem(LS + k); } catch { /* ignore */ } },
};
const ss = {
  get: (k) => { try { return sessionStorage.getItem(LS + k); } catch { return null; } },
  set: (k, v) => { try { sessionStorage.setItem(LS + k, v); } catch { /* ignore */ } },
  del: (k) => { try { sessionStorage.removeItem(LS + k); } catch { /* ignore */ } },
};
const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const randomString = (n = 48) => b64url(crypto.getRandomValues(new Uint8Array(n)));
const redirectUri = () => location.origin + location.pathname;
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Messages d'erreur de Microsoft, en clair. */
export function outlookError(code = '', desc = '') {
  const t = `${code} ${desc}`;
  if (/AADSTS65001|AADSTS90094|admin.*(consent|approv)|consentement de l.administrateur|approbation/i.test(t)) return 'Ton organisation demande l’accord de son service informatique pour lire l’agenda depuis une appli externe. Demande-lui d’autoriser « Transcripteur IA », ou importe un fichier .ics exporté d’Outlook.';
  if (/AADSTS50011|redirect_uri/i.test(t)) return `Adresse de retour refusée par Microsoft : dans l’inscription de l’appli (Authentification → Application monopage), ajoute exactement ${redirectUri()}`;
  if (/AADSTS700016|AADSTS700054|unauthorized_client|application.*not found/i.test(t)) return 'Identifiant d’application inconnu de Microsoft, ou appli inscrite pour un seul type de comptes : vérifie l’ID (client) et le choix « comptes d’annuaire et comptes Microsoft personnels ».';
  if (/AADSTS9002326|Cross-origin token redemption/i.test(t)) return 'L’adresse de retour est déclarée comme « Web » : déclare-la comme « Application monopage (SPA) » dans l’inscription de l’appli.';
  if (/access_denied|AADSTS65004|consent_required/i.test(t)) return 'Accès à l’agenda refusé à la connexion.';
  if (/invalid_grant|AADSTS700082|AADSTS70008|interaction_required|login_required/i.test(t)) return 'Connexion Microsoft expirée : reconnecte-toi.';
  if (/Failed to fetch|NetworkError/i.test(t)) return 'Impossible de joindre Microsoft (connexion ?).';
  return `Microsoft a refusé : ${desc || code || 'erreur inconnue'}`;
}
class OutlookError extends Error {
  constructor(code, desc, needSignIn = false) { super(outlookError(code, desc)); this.code = code; this.needSignIn = needSignIn; }
}

export const Outlook = {
  clientId: () => (OUTLOOK_CLIENT_ID || ls.get('client')).trim(),
  fixed: () => !!OUTLOOK_CLIENT_ID,
  configured: () => GUID.test(Outlook.clientId()),
  setClientId(id) { ls.set('client', String(id || '').trim()); },
  redirectUri,
  user() { try { return JSON.parse(ls.get('user', 'null')); } catch { return null; } },
  connected: () => !!Outlook.user() && !!ls.get('tokens'),

  /** Va sur la page de connexion de Microsoft (retour sur cette page avec #code=…&state=ms-…). */
  async signIn(loginHint = '') {
    if (!Outlook.configured()) throw new Error('Identifiant d’application Microsoft manquant.');
    const verifier = randomString(48);
    const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
    const state = `ms-${randomString(12)}`;
    ss.set('verifier', verifier);
    ss.set('state', state);
    const q = new URLSearchParams({
      client_id: Outlook.clientId(), response_type: 'code', redirect_uri: redirectUri(), response_mode: 'fragment',
      scope: SCOPES, state, code_challenge: challenge, code_challenge_method: 'S256', prompt: 'select_account',
      ...(loginHint ? { login_hint: loginHint } : {}),
    });
    location.assign(`${AUTH}/authorize?${q}`);
  },

  /** Retour de Microsoft ? (fragment avec un « state » qui commence par « ms- ») */
  isReturn() {
    const h = new URLSearchParams(location.hash.slice(1));
    return (h.has('code') || h.has('error')) && String(h.get('state') || '').startsWith('ms-');
  },

  /** Termine la connexion : échange le code contre des jetons, lit le profil. */
  async handleRedirect() {
    if (!Outlook.isReturn()) return null;
    const h = new URLSearchParams(location.hash.slice(1));
    history.replaceState(null, '', location.pathname + location.search);
    const expected = ss.get('state');
    const verifier = ss.get('verifier');
    ss.del('state');
    ss.del('verifier');
    if (h.has('error')) return { ok: false, error: outlookError(h.get('error'), h.get('error_description')) };
    if (!expected || h.get('state') !== expected || !verifier) return { ok: false, error: 'Réponse de Microsoft inattendue (sécurité) : reconnecte-toi.' };
    try {
      await tokenRequest({ grant_type: 'authorization_code', code: h.get('code'), redirect_uri: redirectUri(), code_verifier: verifier });
      const me = await graph('/me?$select=displayName,mail,userPrincipalName');
      const user = { name: me.displayName || '', email: String(me.mail || me.userPrincipalName || '').toLowerCase() };
      ls.set('user', JSON.stringify(user));
      return { ok: true, user };
    } catch (e) {
      ls.set('tokens', '');
      return { ok: false, error: e.message };
    }
  },

  signOut() { ls.set('tokens', ''); ls.set('user', ''); },

  /**
   * Événements entre deux dates (répétitions dépliées par Microsoft), hors annulations.
   * @returns {Promise<object[]>}
   */
  async events(from, to) {
    const q = new URLSearchParams({
      startDateTime: new Date(from).toISOString(), endDateTime: new Date(to).toISOString(), $top: '250', $orderby: 'start/dateTime',
      $select: 'id,iCalUId,subject,start,end,isAllDay,isCancelled,isOnlineMeeting,onlineMeeting,location,organizer,attendees,bodyPreview,webLink,type,showAs',
    });
    let url = `/me/calendarView?${q}`;
    const out = [];
    for (let page = 0; url && page < 10; page++) {
      const r = await graph(url, { Prefer: 'outlook.timezone="UTC", outlook.body-content-type="text"' });
      for (const g of r.value || []) out.push(graphToEvent(g));
      url = r['@odata.nextLink'] || '';
    }
    return out.filter((e) => !e.cancelled && e.start != null).sort((a, b) => a.start - b.start);
  },
};

async function tokenRequest(params) {
  let r;
  try {
    r = await fetch(`${AUTH}/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: Outlook.clientId(), scope: SCOPES, ...params }) });
  } catch (e) { throw new OutlookError('network', e.message); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw new OutlookError(j.error || `HTTP ${r.status}`, j.error_description || '', /invalid_grant|interaction_required/.test(j.error || ''));
  ls.set('tokens', JSON.stringify({ access: j.access_token, refresh: j.refresh_token || '', exp: Date.now() + (Number(j.expires_in) || 3600) * 1000 - 60000 }));
  return j.access_token;
}

/** Jeton valide (renouvelé si besoin avec le jeton de rafraîchissement). */
async function accessToken() {
  let t;
  try { t = JSON.parse(ls.get('tokens', 'null')); } catch { t = null; }
  if (!t) throw new OutlookError('login_required', '', true);
  if (t.access && t.exp > Date.now()) return t.access;
  if (!t.refresh) throw new OutlookError('login_required', '', true);
  try {
    return await tokenRequest({ grant_type: 'refresh_token', refresh_token: t.refresh });
  } catch (e) {
    if (e.needSignIn) ls.set('tokens', '');
    throw e;
  }
}

async function graph(path, headers = {}) {
  const token = await accessToken();
  let r;
  try {
    r = await fetch(path.startsWith('http') ? path : GRAPH + path, { headers: { Authorization: `Bearer ${token}`, ...headers } });
  } catch (e) { throw new OutlookError('network', e.message); }
  const j = await r.json().catch(() => ({}));
  if (r.status === 401) { ls.set('tokens', ''); throw new OutlookError('login_required', '', true); }
  if (!r.ok) throw new OutlookError(j.error?.code || `HTTP ${r.status}`, j.error?.message || '');
  return j;
}
