// Historique local des transcriptions (IndexedDB). Rien n'est envoyé ailleurs.
const DB_NAME = 'transcripteur';
const STORE = 'transcriptions';

function open() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const st = db.createObjectStore(STORE, { keyPath: 'id' });
        st.createIndex('createdAt', 'createdAt');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx(mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const st = t.objectStore(STORE);
    const res = fn(st);
    t.oncomplete = () => resolve(res?.result ?? res);
    t.onerror = () => reject(t.error);
  });
}

export const History = {
  async list() {
    const all = await tx('readonly', (st) => st.getAll());
    return all.sort((a, b) => b.createdAt - a.createdAt);
  },
  get: (id) => tx('readonly', (st) => st.get(id)),
  put: (item) => tx('readwrite', (st) => st.put(item)),
  remove: (id) => tx('readwrite', (st) => st.delete(id)),
  clear: () => tx('readwrite', (st) => st.clear()),
};

export const newId = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2));
