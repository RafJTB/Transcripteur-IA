// Faux client Supabase (en mémoire, partagé entre onglets via localStorage) pour tester l'interface.
(() => {
  const DB = 'mock.sb.db';
  const load = () => { const d = JSON.parse(localStorage.getItem(DB) || '{"spaces":[],"space_members":[],"space_docs":[],"space_messages":[],"files":{}}'); d.space_messages ||= []; return d; };
  const save = (d) => localStorage.setItem(DB, JSON.stringify(d));
  const me = () => JSON.parse(sessionStorage.getItem('mock.sb.user') || 'null');
  const isMember = (d, sid) => d.space_members.some((m) => m.space_id === sid && m.email === me()?.email);
  const uid = () => crypto.randomUUID();
  function query(table) {
    const st = { table, filters: [], cmp: [], op: 'select', payload: null, single: false, cols: '*', limit: 0 };
    const exec = async () => {
      const d = load();
      const u = me();
      if (!u) return { data: null, error: { message: 'not authenticated' } };
      if (table === 'space_messages' && localStorage.getItem('mock.sb.nomsg')) return { data: null, error: { code: 'PGRST205', message: "Could not find the table 'public.space_messages' in the schema cache" } };
      let rows = d[table];
      const visible = (r) => table === 'spaces' ? isMember(d, r.id) || r.owner === u.id : isMember(d, r.space_id);
      if (st.op === 'insert') {
        const r = { ...st.payload };
        if (table === 'spaces') { Object.assign(r, { id: uid(), owner: u.id, created_at: new Date().toISOString() }); d.spaces.push(r); d.space_members.push({ space_id: r.id, email: u.email, role: 'owner', created_at: r.created_at }); }
        if (table === 'space_members') {
          const s = d.spaces.find((x) => x.id === r.space_id);
          if (!s || s.owner !== u.id) return { data: null, error: { message: 'new row violates row-level security policy' } };
          if (d.space_members.some((m) => m.space_id === r.space_id && m.email === r.email)) return { data: null, error: { message: 'duplicate key value' } };
          Object.assign(r, { role: 'member', created_at: new Date().toISOString() }); d.space_members.push(r);
        }
        if (table === 'space_messages') {
          if (!isMember(d, r.space_id)) return { data: null, error: { message: 'new row violates row-level security policy' } };
          Object.assign(r, { id: uid(), author: u.id, created_at: new Date(Date.now() + d.space_messages.length).toISOString() }); d.space_messages.push(r);
          save(d);
          emit('INSERT', r);
          return { data: st.single ? r : [r], error: null };
        }
        if (table === 'space_docs') {
          if (!isMember(d, r.space_id)) return { data: null, error: { message: 'new row violates row-level security policy' } };
          Object.assign(r, { id: uid(), created_by: u.id, created_at: new Date().toISOString() }); d.space_docs.push(r);
        }
        save(d);
        return { data: st.single ? r : [r], error: null };
      }
      rows = rows.filter(visible).filter((r) => st.filters.every(([k, v]) => r[k] === v))
        .filter((r) => st.cmp.every(([op, k, v]) => (op === 'lt' ? r[k] < v : op === 'gt' ? r[k] > v : r[k] !== v)));
      if (st.op === 'delete') {
        const ids = new Set(rows.map((r) => JSON.stringify(r)));
        d[table] = d[table].filter((r) => !ids.has(JSON.stringify(r)));
        if (table === 'spaces') { const gone = new Set(rows.map((r) => r.id)); d.space_members = d.space_members.filter((m) => !gone.has(m.space_id)); d.space_docs = d.space_docs.filter((m) => !gone.has(m.space_id)); d.space_messages = d.space_messages.filter((m) => !gone.has(m.space_id)); }
        if (table === 'space_messages') {
          const own = (r) => r.author === u.id || d.spaces.find((x) => x.id === r.space_id)?.owner === u.id;
          if (!rows.every(own)) return { data: null, error: { message: 'permission denied' } };
          save(d); rows.forEach((r) => emit('DELETE', { id: r.id })); return { data: null, error: null };
        }
        save(d); return { data: null, error: null };
      }
      if (st.op === 'update') { rows.forEach((r) => Object.assign(r, st.payload)); save(d); return { data: null, error: null }; }
      let out = rows.map((r) => {
        const o = { ...r };
        if (table === 'spaces' && /space_members\(count\)/.test(st.cols)) { o.space_members = [{ count: d.space_members.filter((m) => m.space_id === r.id).length }]; o.space_docs = [{ count: d.space_docs.filter((m) => m.space_id === r.id).length }]; }
        return o;
      });
      if (st.order) out.sort((a, b) => (a[st.order.k] < b[st.order.k] ? -1 : 1) * (st.order.asc ? 1 : -1));
      if (st.limit) out = out.slice(0, st.limit);
      if (st.single) return out[0] ? { data: out[0], error: null } : { data: null, error: { message: 'no rows' } };
      return { data: out, error: null };
    };
    const q = {
      select(cols = '*') { if (st.op === 'select') st.cols = cols; return q; },
      insert(p) { st.op = 'insert'; st.payload = p; return q; },
      update(p) { st.op = 'update'; st.payload = p; return q; },
      delete() { st.op = 'delete'; return q; },
      eq(k, v) { st.filters.push([k, v]); return q; },
      lt(k, v) { st.cmp.push(['lt', k, v]); return q; },
      gt(k, v) { st.cmp.push(['gt', k, v]); return q; },
      neq(k, v) { st.cmp.push(['neq', k, v]); return q; },
      limit(n) { st.limit = n; return q; },
      order(k, o = {}) { st.order = { k, asc: o.ascending !== false }; return q; },
      single() { st.single = true; return q; },
      then(res, rej) { return exec().then(res, rej); },
    };
    return q;
  }
  // Faux « Realtime » : les abonnés reçoivent les messages des espaces dont ils sont membres
  const channels = new Set();
  const EV = 'mock.sb.event';
  function deliver(type, row) {
    const d = load();
    for (const ch of channels) for (const h of ch.handlers) {
      if (h.event !== type) continue;
      if (type === 'INSERT' && !isMember(d, row.space_id)) continue;
      h.cb(type === 'INSERT' ? { new: row } : { old: row });
    }
  }
  function emit(type, row) {
    deliver(type, row);
    localStorage.setItem(EV, JSON.stringify({ type, row, n: Math.random() }));
  }
  window.addEventListener('storage', (e) => { if (e.key === EV && e.newValue) { const { type, row } = JSON.parse(e.newValue); deliver(type, row); } });
  window.__mockRealtime = { offline: false };
  const toB64 = (buf) => { let s = ''; const b = new Uint8Array(buf); for (let i = 0; i < b.length; i += 8192) s += String.fromCharCode(...b.subarray(i, i + 8192)); return btoa(s); };
  window.__spacesClient = {
    auth: {
      async getSession() { const u = me(); return { data: { session: u ? { user: { id: u.id, email: u.email, user_metadata: { full_name: u.name } } } : null } }; },
      async signInWithOAuth() { return { error: null }; },
      async signOut() { sessionStorage.removeItem('mock.sb.user'); return { error: null }; },
    },
    from: query,
    channel() {
      const ch = { handlers: [], on(kind, opts, cb) { ch.handlers.push({ event: opts.event, cb }); return ch; }, subscribe(cb) { if (!window.__mockRealtime.offline) channels.add(ch); setTimeout(() => cb?.(window.__mockRealtime.offline ? 'CHANNEL_ERROR' : 'SUBSCRIBED'), 50); return ch; } };
      return ch;
    },
    removeChannel(ch) { channels.delete(ch); },
    storage: {
      from: () => ({
        async upload(path, blob) { const d = load(); d.files[path] = { type: blob.type, b64: toB64(await blob.arrayBuffer()) }; save(d); return { data: { path }, error: null }; },
        async download(path) { const f = load().files[path]; if (!f) return { data: null, error: { message: 'not found' } }; const bin = atob(f.b64); const a = new Uint8Array(bin.length); for (let i = 0; i < a.length; i++) a[i] = bin.charCodeAt(i); return { data: new Blob([a], { type: f.type }), error: null }; },
        async list(prefix) { return { data: Object.keys(load().files).filter((k) => k.startsWith(prefix + '/')).map((k) => ({ name: k.slice(prefix.length + 1) })), error: null }; },
        async remove(paths) { const d = load(); paths.forEach((p) => delete d.files[p]); save(d); return { error: null }; },
      }),
    },
  };
})();
