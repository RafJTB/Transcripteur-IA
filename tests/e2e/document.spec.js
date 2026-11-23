// Une réunion ouverte : onglets, relevé d'actions, export.
import { test, expect, boot, seedMeetings } from './helpers.js';

async function openLedona(page) {
  await boot(page);
  await seedMeetings(page);
  await page.evaluate(() => window.__app.History.get('d1').then((d) => window.__app.showDoc(d)));
  await expect(page.locator('body')).toHaveAttribute('data-page', 'doc');
}

test('transcription affichée avec les intervenants', async ({ page }) => {
  await openLedona(page);
  await expect(page.locator('[data-dpanel="tr"]')).toContainText('scan 3D intérieur');
  await expect(page.locator('[data-dpanel="tr"]')).toContainText('Julie');
});

test('onglets Analyse, Actions, Résumé, Traduction', async ({ page }) => {
  await openLedona(page);
  for (const t of ['analysis', 'actions', 'summary', 'translation', 'tr']) {
    await page.locator(`[data-dtab="${t}"]`).click();
    await expect(page.locator(`[data-dpanel="${t}"]`)).toBeVisible();
  }
});

test('onglet Actions : décision et action avec responsable et échéance', async ({ page }) => {
  await openLedona(page);
  await page.locator('[data-dtab="actions"]').click();
  const list = page.locator('#actions');
  await expect(list).toContainText('scan 3D');
  await expect(list).toContainText('Revit');
  await expect(list).toContainText('Julie');
  await expect(list).toContainText(/vendredi/i);
});

test('export texte et sous-titres', async ({ page }) => {
  await openLedona(page);
  // Nom de fichier lu sur le lien (Chromium sans interface remplace les noms accentués par « download »)
  await page.evaluate(() => {
    window.__names = [];
    const click = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () { if (this.download) window.__names.push(this.download); return click.call(this); };
  });
  for (const [fmt, re] of [['txt', /scan 3D intérieur/], ['srt', /00:01:00,000 --> /]]) {
    await page.locator('#export-btn').click();
    const [dl] = await Promise.all([page.waitForEvent('download'), page.locator(`[data-export="${fmt}"]`).click()]);
    const txt = await (await dl.createReadStream()).toArray().then((c) => Buffer.concat(c).toString('utf8'));
    expect(txt).toMatch(re);
  }
  expect(await page.evaluate(() => window.__names)).toEqual(['Point_équipe_projet_Ledona.txt', 'Point_équipe_projet_Ledona.srt']);
});

test('onglet Actions : « dit par », choix du responsable gardé', async ({ page }) => {
  await boot(page);
  await seedMeetings(page);
  await page.evaluate(() => window.__app.History.get('d2').then((d) => window.__app.showDoc(d)));
  await page.locator('[data-dtab="actions"]').click();
  const item = page.locator('.act-item', { hasText: 'livraison de la grue' });
  await expect(item.locator('.act-who')).toHaveText('Qui ? À préciser');
  await expect(item.locator('.act-by')).toHaveText('dit par Marc');
  await item.locator('.act-who').click();
  const pop = page.locator('#who-pop');
  await expect(pop.locator('[data-pick]').first()).toContainText('Marc');
  await expect(pop).toContainText('l’a dit');
  await pop.locator('[data-pick="Marc"]').click();
  await expect(item.locator('.act-who')).toHaveText('Marc');
  // Nom libre
  await item.locator('.act-who').click();
  await page.locator('#who-pop input').fill('Bureau de contrôle');
  await page.locator('#who-pop input').press('Enter');
  await expect(item.locator('.act-who')).toHaveText('Bureau de contrôle');
  // Gardé avec la réunion
  await expect.poll(() => page.evaluate(() => window.__app.History.get('d2').then((d) => Object.values(d.actionWho || {})))).toEqual(['Bureau de contrôle']);
  // Retour à la détection automatique
  await item.locator('.act-who').click();
  await page.locator('#who-pop [data-auto]').click();
  await expect(item.locator('.act-who')).toHaveText('Qui ? À préciser');
});
