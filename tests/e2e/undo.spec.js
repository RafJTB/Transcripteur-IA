// Suppression avec « Annuler » (réunion, dossier), y compris avec la synchronisation Google Drive.
import { test, expect, boot, nav, seedMeetings } from './helpers.js';
import { fakeDrive } from './mocks/drive.js';

const signedIn = () => {
  localStorage.setItem('transcripteur.cloud.user', JSON.stringify({ email: 'raf@exemple.fr', name: 'Raf', picture: '' }));
  sessionStorage.setItem('transcripteur.cloud.token', JSON.stringify({ value: 'faux', exp: Date.now() + 3600e3 }));
};
const docsOnDrive = (files) => [...files.values()].filter((f) => f.appProperties.kind === 'doc').length;

test('réunion supprimée : « Annuler » la fait revenir, même après une synchronisation', async ({ page, context }) => {
  const files = await fakeDrive(context);
  await context.addInitScript(signedIn);
  await boot(page);
  await seedMeetings(page);
  await page.evaluate(async () => { for (const id of ['d1', 'd2']) { const d = await window.__app.History.get(id); d.owner = 'raf@exemple.fr'; await window.__app.History.put(d); } await window.__app.syncNow(); });
  await expect.poll(() => docsOnDrive(files)).toBe(2);
  await nav(page, 'projects');
  const rows = page.locator('.proj-row');
  await rows.first().hover();
  await rows.first().locator('.pc-del').click();
  await expect(rows).toHaveCount(1);
  const t = page.locator('.toast.has-action');
  await expect(t).toContainText('supprimée');
  // Une synchronisation pendant le délai ne la fait pas revenir, et ne l'efface pas du Drive
  await page.evaluate(() => window.__app.syncNow());
  await expect(rows).toHaveCount(1);
  expect(docsOnDrive(files)).toBe(2);
  // Annuler : elle revient
  await t.locator('.t-act').click();
  await expect(rows).toHaveCount(2);
  await page.evaluate(() => window.__app.syncNow());
  expect(docsOnDrive(files)).toBe(2);
});

test('réunion supprimée sans annuler : effacée du Drive après le délai ; onglet fermé : au lancement suivant', async ({ page, context }) => {
  const files = await fakeDrive(context);
  await context.addInitScript(signedIn);
  await page.clock.install();
  await boot(page);
  await seedMeetings(page);
  await page.evaluate(async () => { for (const id of ['d1', 'd2']) { const d = await window.__app.History.get(id); d.owner = 'raf@exemple.fr'; await window.__app.History.put(d); } await window.__app.syncNow(); });
  await expect.poll(() => docsOnDrive(files)).toBe(2);
  await nav(page, 'projects');
  await page.locator('.proj-row').first().hover();
  await page.locator('.proj-row').first().locator('.pc-del').click();
  await page.clock.runFor(8000);
  await expect(page.locator('.toast.has-action')).toHaveCount(0);
  await page.evaluate(() => window.__app.syncNow());
  await expect.poll(() => docsOnDrive(files)).toBe(1);
  // Suppression en attente, onglet fermé avant la fin : terminée au lancement suivant
  await page.evaluate(() => localStorage.setItem('transcripteur.undo.pending', JSON.stringify([{ docId: 'd2', audioId: null, at: Date.now() - 60_000 }])));
  await page.evaluate(() => window.__app.History.remove('d2'));
  await page.reload();
  await page.waitForFunction(() => window.__appBoot && window.__app);
  await page.evaluate(() => window.__app.syncNow());
  await expect.poll(() => docsOnDrive(files)).toBe(0);
});

test('dossier supprimé : « Annuler » le rétablit avec ses réunions', async ({ page }) => {
  await boot(page);
  await seedMeetings(page);
  await page.evaluate(async () => { const f = window.__app.Folders.add('Ledona'); const d = await window.__app.History.get('d1'); d.folderId = f.id; await window.__app.History.put(d); });
  await nav(page, 'projects');
  await page.locator('.proj-side .fchip', { hasText: 'Ledona' }).click();
  await page.locator('#folder-delete').click();
  await expect(page.locator('.proj-side')).not.toContainText('Ledona');
  await page.locator('.toast.has-action .t-act').click();
  await expect(page.locator('.proj-side .fchip.active')).toContainText('Ledona');
  await expect(page.locator('.proj-row')).toHaveCount(1);
});
