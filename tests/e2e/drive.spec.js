// Synchronisation Google Drive, avec un faux Drive (en mémoire, côté test).
import { test, expect, boot, seedMeetings } from './helpers.js';
import { fakeDrive } from './mocks/drive.js';

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
  // (la synchro du démarrage peut déjà l'avoir récupérée : on ne suppose pas l'historique vide)
  await p2.evaluate(() => window.__app.syncNow());
  await expect.poll(() => p2.evaluate(() => window.__app.History.get('d1').then((d) => d?.title))).toContain('Ledona');
  await other.close();
});
