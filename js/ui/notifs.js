// Notifications (cloche).

import { History, newId } from '../history.js';
import { $, esc2, store, toast } from './core.js';
import { openDoc } from './history.js';
import { isMine } from './transcription.js';
import { setView } from './views.js';
import { openSpace } from './spaces.js';

// ======================================================================
// Centre de notifications (cloche) : événements importants, notifications Windows en option
// ======================================================================
const NOTIF_MAX = 30;
export const notifs = {
  list() { try { return JSON.parse(store.get('notifs', '[]')); } catch { return []; } },
  save(l) { store.set('notifs', JSON.stringify(l.slice(0, NOTIF_MAX))); },
};

/**
 * Ajoute une notification.
 * system : aussi une notification Windows si l'onglet est en arrière-plan (et si autorisé).
 * docId : un clic ouvre la transcription ; action 'account' : ouvre le compte.
 */
export function notify({ kind = 'ok', title, text = '', docId = null, action = null, system = false }) {
  const n = { id: newId(), at: Date.now(), kind, title, text, docId, action, read: false };
  notifs.save([n, ...notifs.list()]);
  renderBell();
  if (system && document.hidden && store.get('notifs.system') === '1' && 'Notification' in window && Notification.permission === 'granted') {
    try {
      const sys = new Notification(title, { body: text, icon: 'icons/icon-192.png', tag: n.id });
      sys.onclick = () => { window.focus(); openNotif(n); sys.close(); };
    } catch { /* ignore */ }
  }
}

function ago(t) {
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return 'à l’instant';
  if (s < 3600) return `il y a ${Math.round(s / 60)} min`;
  if (s < 86400) return `il y a ${Math.round(s / 3600)} h`;
  return new Date(t).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
}

function renderBell() {
  const l = notifs.list();
  const unread = l.filter((n) => !n.read).length;
  const bell = $('#btn-bell');
  bell.classList.toggle('has-new', unread > 0);
  bell.setAttribute('aria-label', unread ? `Notifications (${unread} nouvelle${unread > 1 ? 's' : ''})` : 'Notifications');
  $('#bell-count').textContent = unread > 9 ? '9+' : unread || '';
  const box = $('#notif-list');
  if (!l.length) { box.innerHTML = '<p class="notif-empty">Rien de nouveau. Tu seras prévenu ici quand une transcription, une traduction ou une synchronisation se termine.</p>'; return; }
  box.innerHTML = l.map((n) => `<button type="button" class="notif ${n.read ? '' : 'unread'} n-${n.kind}" data-id="${n.id}"><i></i><span><b>${esc2(n.title)}</b><small>${esc2(n.text)}</small></span><time>${ago(n.at)}</time></button>`).join('');
  const sysOk = 'Notification' in window;
  $('#notif-system').hidden = !sysOk;
  $('#notif-system-input').checked = sysOk && store.get('notifs.system') === '1' && Notification.permission === 'granted';
}

async function openNotif(n) {
  $('#notif-panel').hidden = true;
  if (n.action === 'account') return setView('settings');
  if (typeof n.action === 'string' && n.action.startsWith('space:')) return openSpace(n.action.slice(6));
  if (!n.docId) return;
  const d = await History.get(n.docId).catch(() => null);
  if (!d || !isMine(d)) return toast('Cette transcription n’existe plus.', 'warn', 3000);
  openDoc(d);
}

export function bindBell() {
  const panel = $('#notif-panel');
  $('#btn-bell').onclick = (e) => {
    e.stopPropagation();
    panel.hidden = !panel.hidden;
    if (!panel.hidden) {
      renderBell();
      // Ouvrir le panneau = tout est vu (la pastille disparaît, les nouveautés restent surlignées)
      setTimeout(() => { notifs.save(notifs.list().map((n) => ({ ...n, read: true }))); $('#btn-bell').classList.remove('has-new'); $('#bell-count').textContent = ''; }, 300);
    }
  };
  document.addEventListener('click', (e) => { if (!e.target.closest('#notif-panel, #btn-bell')) panel.hidden = true; });
  $('#notif-list').addEventListener('click', (e) => {
    const b = e.target.closest('.notif');
    if (!b) return;
    const n = notifs.list().find((x) => x.id === b.dataset.id);
    if (n) openNotif(n);
  });
  $('#notif-clear').onclick = () => { notifs.save([]); renderBell(); };
  $('#notif-system-input').onchange = async (e) => {
    if (!e.target.checked) { store.set('notifs.system', '0'); return; }
    const perm = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission().catch(() => 'denied');
    if (perm === 'granted') {
      store.set('notifs.system', '1');
      toast('Tu seras prévenu par Windows quand une transcription se termine en arrière-plan.', 'ok', 4000);
    } else {
      e.target.checked = false;
      toast('Notifications refusées par le navigateur : autorise-les dans la barre d’adresse (icône cadenas) pour activer l’option.', 'warn', 7000);
    }
  };
  setInterval(() => { if (!panel.hidden) renderBell(); }, 60 * 1000);
  renderBell();
}
