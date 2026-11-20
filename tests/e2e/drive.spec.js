// Synchronisation Google Drive, avec un faux Drive (en mémoire, côté test).
import { test, expect, boot, seedMeetings } from './helpers.js';

/** Faux Google Drive : fichiers envoyés (nom, type, taille). */
async function fakeDrive(context, files = new Map()) {
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

test('les réunions sont envoyées sur Drive, et retrouvées sur un autre appareil', async ({ page, context, browser }) => {
  const files = await fakeDrive(context);
  const signedIn = () => {
    localStorage.setItem('transcripteur.cloud.user', JSON.stringify({ email: 'raf@exemple.fr', name: 'Raf', picture: '' }));
    sessionStorage.setItem('transcripteur.cloud.token', JSON.stringify({ value: 'faux', exp: Date.now() + 3600e3 }));
  };
  await context.addInitScript(signedIn);
  await boot(page);
  await seedMeetings(page);
  await page.evaluate(async () => {
    for (const id of ['d1', 'd2']) { const d = await window.__app.History.get(id); d.owner = 'raf@exemple.fr'; await window.__app.History.put(d); }
    await window.__app.syncNow();
  });
  await expect.poll(() => [...files.values()].filter((f) => f.appProperties.kind === 'doc').length).toBe(2);
  const doc = [...files.values()].find((f) => /Ledona/.test(f.name));
  expect(JSON.parse(doc.data.toString('utf8')).segments.length).toBe(7);

  // Autre appareil : même compte, historique vide → les réunions reviennent depuis Drive
  const other = await browser.newContext();
  await fakeDrive(other, files);
  await other.addInitScript(signedIn);
  await other.addInitScript(() => localStorage.setItem('transcripteur.theme', 'dark'));
  const p2 = await other.newPage();
  await boot(p2);
  expect(await p2.evaluate(() => window.__app.History.get('d1'))).toBeUndefined();
  await p2.evaluate(() => window.__app.syncNow());
  await expect.poll(() => p2.evaluate(() => window.__app.History.get('d1').then((d) => d?.title))).toContain('Ledona');
  await other.close();
});
