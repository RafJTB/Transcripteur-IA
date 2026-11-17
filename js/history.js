// Stockage local (IndexedDB). Rien n'est envoyé ailleurs.
//  - transcriptions : textes + état d'avancement (pour la reprise)
//  - audios         : fichiers audio d'origine (pour reprendre, réécouter, retranscrire)
//  - recchunks      : morceaux d'un enregistrement micro en cours (sauvés chaque seconde)
const DB_NAME = 'transcripteur';
const DB_VERSION = 2;
const T = 'transcriptions';
const A = 'audios';
const C = 'recchunks';

let dbPromise;
function open() {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(T)) db.createObjectStore(T, { keyPath: 'id' }).createIndex('createdAt', 'createdAt');
      if (!db.objectStoreNames.contains(A)) db.createObjectStore(A, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(C)) db.createObjectStore(C, { autoIncrement: true }).createIndex('recId', 'recId');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => { dbPromise = null; reject(req.error); };
  });
  return dbPromise;
}

async function tx(stores, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(stores, mode);
    const res = fn(...[].concat(stores).map((s) => t.objectStore(s)));
    t.oncomplete = () => resolve(res instanceof IDBRequest ? res.result : res);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

export const History = {
  async list() {
    const all = await tx(T, 'readonly', (st) => st.getAll());
    return all.sort((a, b) => b.createdAt - a.createdAt);
  },
  get: (id) => tx(T, 'readonly', (st) => st.get(id)),
  put: (item) => tx(T, 'readwrite', (st) => st.put(item)),
  remove: (id) => tx(T, 'readwrite', (st) => st.delete(id)),
};

export const Audios = {
  get: (id) => tx(A, 'readonly', (st) => st.get(id)),
  put: (item) => tx(A, 'readwrite', (st) => st.put(item)),
  remove: (id) => tx(A, 'readwrite', (st) => st.delete(id)),
  /** Retrouve un audio déjà stocké (même fichier : nom, taille, date) pour ne pas le dupliquer. */
  async findByKey(key) {
    let found = null;
    await tx(A, 'readonly', (st) => {
      const req = st.openCursor();
      req.onsuccess = () => {
        const c = req.result;
        if (!c || found) return;
        if (c.value.key === key) found = c.value.id;
        else c.continue();
      };
    });
    return found;
  },
  /** Métadonnées sans charger les blobs en mémoire inutilement. */
  async sizes() {
    const out = {};
    await tx(A, 'readonly', (st) => {
      const req = st.openCursor();
      req.onsuccess = () => {
        const c = req.result;
        if (!c) return;
        out[c.value.id] = c.value.blob?.size || 0;
        c.continue();
      };
    });
    return out;
  },
};

export const RecChunks = {
  add: (recId, idx, blob) => tx(C, 'readwrite', (st) => st.add({ recId, idx, blob })),
  async blob(recId, type) {
    const rows = await tx(C, 'readonly', (st) => st.index('recId').getAll(recId));
    if (!rows?.length) return null;
    rows.sort((a, b) => a.idx - b.idx);
    return new Blob(rows.map((r) => r.blob), { type: type || rows[0].blob.type || 'audio/webm' });
  },
  async remove(recId) {
    await tx(C, 'readwrite', (st) => {
      const req = st.index('recId').openKeyCursor(IDBKeyRange.only(recId));
      req.onsuccess = () => {
        const c = req.result;
        if (!c) return;
        st.delete(c.primaryKey);
        c.continue();
      };
    });
  },
};

/** Efface absolument tout : textes, audios, enregistrements en cours. */
export const clearAll = () => tx([T, A, C], 'readwrite', (t, a, c) => { t.clear(); a.clear(); c.clear(); });

export const newId = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2));
