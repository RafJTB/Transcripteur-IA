// Faux Google Drive (en mémoire, côté test) : fichiers envoyés par l'appli.
/** Faux Google Drive : fichiers envoyés (nom, type, taille). */
export async function fakeDrive(context, files = new Map()) {
  let n = files.size;
  await context.route('https://www.googleapis.com/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const json = (o, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(o) });
    if (url.pathname.endsWith('/oauth2/v3/userinfo')) return json({ email: 'raf@exemple.fr', name: 'Raf' });
    if (url.pathname.startsWith('/upload/drive/v3/files')) {
      const body = req.postDataBuffer() || Buffer.from('');
      const txt = body.toString('latin1');
      const meta = JSON.parse(txt.match(/\{"name"[^\n]*\}/)?.[0] || '{}');
      const id = `f${++n}`;
      const start = txt.indexOf('\r\n\r\n', txt.indexOf('Content-Type', txt.indexOf('}'))) + 4;
      const end = txt.lastIndexOf('\r\n--');
      files.set(id, { id, name: meta.name, appProperties: meta.appProperties || {}, data: body.subarray(start, end) });
      return json({ id });
    }
    if (url.pathname === '/drive/v3/files' && req.method() === 'POST') return json({ id: 'folder' });
    if (url.pathname === '/drive/v3/files') {
      const q = url.searchParams.get('q') || '';
      if (q.includes('application/vnd.google-apps.folder')) return json({ files: [{ id: 'folder' }] });
      return json({ files: [...files.values()].map(({ data, ...f }) => f) });
    }
    const m = url.pathname.match(/\/drive\/v3\/files\/([^/]+)$/);
    if (m && url.searchParams.get('alt') === 'media') { const f = files.get(m[1]); return f ? route.fulfill({ status: 200, body: f.data }) : json({}, 404); }
    if (m && req.method() === 'DELETE') { files.delete(m[1]); return route.fulfill({ status: 204, body: '' }); }
    return json({});
  });
  return files;
}

