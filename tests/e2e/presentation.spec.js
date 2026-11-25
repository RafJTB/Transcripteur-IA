// Présentation retrouvée sur un autre navigateur (via le Google Drive de l'utilisateur).
import { test, expect, boot, nav } from './helpers.js';
import { fakeDrive } from './mocks/drive.js';

const signedIn = () => {
  localStorage.setItem('transcripteur.cloud.user', JSON.stringify({ email: 'raf@exemple.fr', name: 'Raf', picture: '' }));
  sessionStorage.setItem('transcripteur.cloud.token', JSON.stringify({ value: 'faux', exp: Date.now() + 3600e3 }));
};
const looks = (files) => [...files.values()].filter((f) => f.appProperties.kind === 'look');

test('présentation : réglée sur un navigateur, retrouvée sur un autre (fond, accent, thème, image)', async ({ page, context, browser }) => {
  const files = await fakeDrive(context);
  await context.addInitScript(signedIn);
  await boot(page);
  await nav(page, 'custom');
  await expect(page.locator('#look-sync')).toBeChecked();
  await expect(page.locator('#look-sync-info')).toContainText('raf@exemple.fr');
  // Réglages faits ici : fond « plan d'architecte », accent vert, image personnelle, thème clair
  await page.locator('#bg-cats [data-cat="archi"]').click();
  await page.locator('#bg-grid [data-bg="plan-architecte"]').click();
  await page.locator('#accent-row [data-accent="#059669"]').click();
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEklEQVR4nGP4z8CAFWEXHbQSACj/P8Fu7N9hAAAAAElFTkSuQmCC', 'base64');
  await page.locator('#bg-file').setInputFiles({ name: 'mon-fond.png', mimeType: 'image/png', buffer: png });
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('transcripteur.perso')).bg)).toBe('custom');
  await page.locator('#bg-cats [data-cat="archi"]').click();
  await page.locator('#bg-grid [data-bg="plan-architecte"]').click();
  await page.locator('#btn-theme').click();
  const theme = await page.evaluate(() => document.documentElement.dataset.theme);
  await page.evaluate(() => window.__app.syncNow());
  await expect.poll(() => looks(files).length).toBeGreaterThan(0);
  expect([...files.values()].some((f) => f.appProperties.kind === 'lookimg')).toBe(true);

  // Autre navigateur, même compte Google : tout est importé au démarrage
  const other = await browser.newContext();
  await fakeDrive(other, files);
  await other.addInitScript(signedIn);
  const p2 = await other.newPage();
  await boot(p2);
  await p2.evaluate(() => window.__app.syncNow());
  await expect.poll(() => p2.evaluate(() => document.documentElement.style.getPropertyValue('--bg-image'))).toContain('plan-architecte');
  expect(await p2.evaluate(() => document.documentElement.dataset.theme)).toBe(theme);
  expect(await p2.evaluate(() => JSON.parse(localStorage.getItem('transcripteur.perso')).accent)).toBe('#059669');
  expect(await p2.evaluate(() => (localStorage.getItem('transcripteur.perso.image') || '').startsWith('data:image/'))).toBe(true);
  await expect(p2.locator('.toast').filter({ hasText: 'présentation' })).toBeVisible();
  // Pas de va-et-vient : le second navigateur ne renvoie rien tant qu'on ne change rien
  const n = looks(files).length;
  await p2.evaluate(() => window.__app.syncNow());
  await page.evaluate(() => window.__app.syncNow());
  expect(looks(files).length).toBe(n);
  await other.close();
});

test('présentation : synchronisation désactivable', async ({ page, context }) => {
  const files = await fakeDrive(context);
  await context.addInitScript(signedIn);
  await boot(page);
  await nav(page, 'custom');
  await page.locator('.look-row').click();
  await expect(page.locator('#look-sync')).not.toBeChecked();
  await expect(page.locator('#look-sync-info')).toContainText('Désactivé');
  await page.evaluate(() => window.__app.syncNow());
  const before = JSON.stringify(looks(files).map((f) => f.appProperties.u));
  await page.locator('#bg-grid [data-bg="dunes"]').click();
  await page.evaluate(() => window.__app.syncNow());
  expect(JSON.stringify(looks(files).map((f) => f.appProperties.u))).toBe(before); // rien d'envoyé après la désactivation
});

test('présentation choisie avant cette fonction (sans date) : envoyée au 1er passage, retrouvée ailleurs', async ({ browser }) => {
  const files = new Map();
  const a = await browser.newContext();
  await fakeDrive(a, files);
  await a.addInitScript(signedIn);
  await a.addInitScript(() => {
    if (localStorage.getItem('seeded')) return;
    localStorage.setItem('seeded', '1');
    localStorage.setItem('transcripteur.perso', JSON.stringify({ bg: 'dunes', blur: 4, veil: 100, panel: 100, accent: '#059669' }));
    localStorage.setItem('transcripteur.theme', 'dark');
  });
  const pa = await a.newPage();
  await boot(pa);
  await pa.evaluate(() => window.__app.syncNow());
  await expect.poll(() => looks(files).length).toBe(1);
  // Autre navigateur qui avait ses propres réglages (eux aussi sans date) : il reçoit ceux du Drive
  const b = await browser.newContext();
  await fakeDrive(b, files);
  await b.addInitScript(signedIn);
  await b.addInitScript(() => { if (!localStorage.getItem('seeded')) { localStorage.setItem('seeded', '1'); localStorage.setItem('transcripteur.perso', JSON.stringify({ bg: 'soie' })); localStorage.setItem('transcripteur.theme', 'light'); } });
  const pb = await b.newPage();
  await boot(pb);
  await pb.evaluate(() => window.__app.syncNow());
  await expect.poll(() => pb.evaluate(() => document.documentElement.style.getPropertyValue('--bg-image'))).toContain('dunes');
  expect(await pb.evaluate(() => document.documentElement.dataset.theme)).toBe('dark');
  expect(looks(files)).toHaveLength(1); // B n'a rien renvoyé
  await a.close();
  await b.close();
});
