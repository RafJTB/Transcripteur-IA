// Suppression avec « Annuler » : la réunion disparaît tout de suite, et peut revenir pendant quelques
// secondes. L'effacement dans le Google Drive n'est lancé qu'à la fin de ce délai (ou au lancement suivant
// si l'onglet a été fermé entre-temps).

import { Audios, History } from '../history.js';
import { Folders, Sync } from '../cloud.js';
import { $, store } from './core.js';

const WINDOW = 7000;
const KEY = 'undo.pending';
const pending = () => { try { return JSON.parse(store.get(KEY, '[]')) || []; } catch { return []; } };
const savePending = (list) => store.set(KEY, JSON.stringify(list));

/** Message avec un bouton (« Annuler »). onExpire est appelé si le bouton n'a pas servi. */
export function actionToast(text, label, onAction, onExpire, ms = WINDOW) {
  const el = document.createElement('div');
  el.className = 'toast ok has-action';
  el.setAttribute('role', 'status');
  el.innerHTML = '<span class="t-txt"></span><button type="button" class="t-act"></button><i class="t-bar" aria-hidden="true"></i>';
  $('.t-txt', el).textContent = text;
  $('.t-act', el).textContent = label;
  el.style.setProperty('--t-ms', `${ms}ms`);
  $('#toasts').appendChild(el);
  let done = false;
  const close = () => { el.classList.add('out'); setTimeout(() => el.remove(), 300); };
  const timer = setTimeout(() => { if (done) return; done = true; close(); onExpire?.(); }, ms);
  $('.t-act', el).onclick = () => { if (done) return; done = true; clearTimeout(timer); close(); onAction?.(); };
  return el;
}

/**
 * Supprime une réunion (et son audio s'il ne sert qu'à elle), avec « Annuler ».
 * @param {object} it      la réunion
 * @param {Function} after appelée après la suppression et après une annulation (réafficher)
 */
export async function removeMeeting(it, after) {
  const doc = await History.get(it.id).catch(() => null) || it;
  let audio = null, video = null;
  if (it.audioId && !(await History.list()).some((d) => d.id !== it.id && d.audioId === it.audioId)) {
    audio = await Audios.get(it.audioId).catch(() => null);
    video = await Audios.get(`${it.audioId}.video`).catch(() => null);
  }
  await History.remove(it.id);
  if (audio) await Audios.remove(it.audioId);
  // Pendant le délai : la synchronisation ne la fait pas revenir depuis le Drive
  Sync.held.add(it.id);
  const entry = { docId: it.id, audioId: audio ? it.audioId : null, at: Date.now() };
  savePending([...pending().filter((p) => p.docId !== it.id), entry]);
  after?.({ removed: true, audioId: audio ? it.audioId : null });
  actionToast(`« ${String(it.title || 'Réunion').slice(0, 60)} » supprimée.`, 'Annuler', async () => {
    await History.put(doc);
    if (audio) await Audios.put(audio);
    if (video) await Audios.put(video).catch(() => {});
    Sync.held.delete(it.id);
    savePending(pending().filter((p) => p.docId !== it.id));
    after?.({ removed: false });
  }, () => commit(entry));
}

function commit(entry) {
  Sync.held.delete(entry.docId);
  savePending(pending().filter((p) => p.docId !== entry.docId));
  Sync.forget(entry.docId, entry.audioId || null);
}

/** Au lancement : termine les suppressions restées en attente (onglet fermé pendant le délai). */
export function commitStale() {
  for (const p of pending()) if (Date.now() - p.at > WINDOW) commit(p);
  for (const p of pending()) Sync.held.add(p.docId);
}

/** Supprime un dossier (pas ses réunions), avec « Annuler ». */
export function removeFolder(f, after) {
  Folders.remove(f.id);
  after?.({ removed: true });
  actionToast(`Dossier « ${String(f.name).slice(0, 50)} » supprimé.`, 'Annuler', () => {
    Folders.save(Folders.raw().map((x) => (x.id === f.id ? { ...x, deleted: false, updatedAt: Date.now() } : x)));
    after?.({ removed: false, id: f.id });
  });
}
