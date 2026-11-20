// Compte rendu de réunion : fenêtre d'options, fichier Word, page PDF.
import { unzipSync, strFromU8 } from 'fflate';
import { test, expect, boot, seedMeetings } from './helpers.js';

async function openLedona(page, summary = '## Points clés\n- Scan 3D **validé**\n- Familles BIM génériques') {
  await boot(page);
  await seedMeetings(page);
  await page.evaluate(async (summary) => {
    const d = await window.__app.History.get('d1');
    if (summary) d.summary = summary;
    await window.__app.History.put(d);
    await window.__app.showDoc(d);
  }, summary);
  await expect(page.locator('body')).toHaveAttribute('data-page', 'doc');
}

async function openDialog(page) {
  await page.locator('#export-btn').click();
  await page.locator('#btn-report').click();
  const box = page.locator('.report-box');
  await expect(box).toBeVisible();
  return box;
}

test('Word : un vrai .docx avec résumé, décisions, actions et transcription', async ({ page }) => {
  await openLedona(page);
  const box = await openDialog(page);
  const [dl] = await Promise.all([page.waitForEvent('download'), box.locator('[data-fmt="docx"]').click()]);
  const buf = Buffer.concat(await (await dl.createReadStream()).toArray());
  const xml = strFromU8(unzipSync(new Uint8Array(buf))['word/document.xml']);
  for (const s of ['Point équipe projet Ledona', 'Points clés', 'validé', 'Décisions', 'scan 3D intérieur', 'Revit', 'Julie', 'Annexe · Transcription']) expect(xml).toContain(s);
  await expect(box).toBeHidden();
});

test('options gardées ; sans résumé, la case est désactivée avec un lien vers l’onglet', async ({ page }) => {
  await openLedona(page, null);
  let box = await openDialog(page);
  await expect(box.locator('[data-opt="summary"]')).toBeDisabled();
  await box.locator('[data-opt="transcript"]').uncheck();
  await expect(box.locator('[data-opt="timestamps"]')).toBeDisabled();
  const [dl] = await Promise.all([page.waitForEvent('download'), box.locator('[data-fmt="docx"]').click()]);
  const xml = strFromU8(unzipSync(new Uint8Array(Buffer.concat(await (await dl.createReadStream()).toArray())))['word/document.xml']);
  expect(xml).not.toContain('Annexe');
  expect(xml).not.toContain('Résumé');
  // Rouvert : le choix « sans transcription » est gardé
  box = await openDialog(page);
  await expect(box.locator('[data-opt="transcript"]')).not.toBeChecked();
  await box.locator('[data-go-summary]').click();
  await expect(page.locator('[data-dpanel="summary"]')).toBeVisible();
});

test('PDF : page A4 prête à imprimer, depuis l’onglet Actions', async ({ page }) => {
  await openLedona(page);
  await page.evaluate(() => { window.__printed = 0; });
  await page.locator('[data-dtab="actions"]').click();
  await page.locator('#act-report').click();
  await page.locator('.report-box [data-fmt="pdf"]').click();
  const frame = page.locator('iframe.report-frame');
  await expect(frame).toHaveCount(1);
  const html = await frame.evaluate((f) => f.srcdoc);
  expect(html).toContain('size: A4');
  for (const s of ['Compte rendu de réunion', 'Point équipe projet Ledona', '<b>validé</b>', 'Responsable', 'Julie']) expect(html).toContain(s);
});

test('Word indisponible (hors connexion) : message clair, le PDF reste possible', async ({ page }) => {
  await page.route(/cdn\.jsdelivr\.net\/npm\/docx/, (r) => r.abort());
  await openLedona(page);
  const box = await openDialog(page);
  await box.locator('[data-fmt="docx"]').click();
  await expect(page.locator('body')).toContainText('Le PDF fonctionne sans connexion');
  await expect(box.locator('[data-fmt="docx"]')).toBeEnabled();
});
