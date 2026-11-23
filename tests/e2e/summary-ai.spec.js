// « Résumer avec une IA » : Claude ou Copilot (consigne copiée), transcription longue jointe en fichier.
import { test, expect, boot, seedMeetings } from './helpers.js';

async function open(page, longText = false) {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await boot(page);
  await seedMeetings(page);
  await page.evaluate(async (longText) => {
    const d = await window.__app.History.get('d1');
    if (longText) d.segments = Array.from({ length: 400 }, (_, i) => ({ text: `Phrase numéro ${i} de la réunion sur le chantier Ledona, avec quelques détails techniques.`, start: i * 5, end: i * 5 + 4 }));
    await window.__app.History.put(d);
    await window.__app.showDoc(d);
    window.__opened = [];
    window.open = (u) => { window.__opened.push(u); return {}; };
  }, longText);
  await page.locator('#export-btn').click();
  await page.locator('#btn-claude').click();
  await expect(page.locator('.ai-pick')).toBeVisible();
}

test('Copilot Microsoft 365 : consigne copiée, Copilot ouvert, choix mémorisé', async ({ page }) => {
  await open(page);
  await page.locator('.ai-opt', { hasText: 'Copilot Microsoft 365' }).click();
  await expect(page.locator('#ai-privacy')).toContainText('Microsoft 365 Copilot');
  await page.locator('#tool-actions button.primary').click();
  await expect(page.locator('#tool-actions button.primary')).toHaveText('Ouvrir Copilot Microsoft 365');
  await page.locator('#tool-actions button.primary').click();
  expect(await page.evaluate(() => window.__opened)).toEqual(['https://m365.cloud.microsoft/chat']);
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  expect(clip).toContain('<transcription>');
  expect(clip).toContain('scan 3D intérieur');
  // Mémorisé pour la prochaine fois
  await page.locator('#export-btn').click();
  await page.locator('#btn-claude').click();
  await expect(page.locator('.ai-opt input[value="m365"]')).toBeChecked();
});

test('transcription trop longue pour Copilot Microsoft 365 : fichier téléchargé, consigne seule copiée', async ({ page }) => {
  await open(page, true);
  await page.locator('.ai-opt', { hasText: 'Copilot Microsoft 365' }).click();
  await page.evaluate(() => {
    window.__names = [];
    const click = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () { if (this.download) window.__names.push(this.download); return click.call(this); };
  });
  const [dl] = await Promise.all([page.waitForEvent('download'), page.locator('#tool-actions button.primary').click()]);
  const txt = Buffer.concat(await (await dl.createReadStream()).toArray()).toString('utf8');
  expect(txt).toContain('Phrase numéro 399');
  expect(await page.evaluate(() => window.__names)).toEqual(['Point_équipe_projet_Ledona.txt']);
  await expect(page.locator('#tool-body')).toContainText('trop longue');
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  expect(clip).toContain('fichier joint « Point_équipe_projet_Ledona.txt »');
  expect(clip).not.toContain('<transcription>');
  expect(clip.length).toBeLessThan(3000);
  await page.locator('#tool-actions button.primary').click();
  expect(await page.evaluate(() => window.__opened)).toEqual(['https://m365.cloud.microsoft/chat']);
});

test('Claude reste disponible (lien pré-rempli si la consigne est courte)', async ({ page }) => {
  await open(page);
  await page.locator('.ai-opt', { hasText: 'claude.ai' }).click();
  await page.locator('#tool-actions button.primary').click();
  await page.locator('#tool-actions button.primary').click();
  const [u] = await page.evaluate(() => window.__opened);
  expect(u).toMatch(/^https:\/\/claude\.ai\/new\?q=/);
});

test('ChatGPT et Gemini : consigne complète copiée, bonne adresse ; plus de Copilot perso ni de logo de marque', async ({ page }) => {
  await open(page);
  await expect(page.locator('.ai-opt')).toHaveText([/Claude/, /Copilot Microsoft 365/, /ChatGPT/, /Gemini/]);
  await expect(page.locator('.ai-pick')).not.toContainText('copilot.microsoft.com');
  await expect(page.locator('.ai-pick svg')).toHaveCount(0);
  for (const [name, url] of [['ChatGPT', 'https://chatgpt.com/'], ['Gemini', 'https://gemini.google.com/app']]) {
    if (name === 'Gemini') { await page.locator('#export-btn').click(); await page.locator('#btn-claude').click(); }
    await page.locator('.ai-opt', { hasText: name }).click();
    await expect(page.locator('#ai-privacy')).toContainText(name === 'ChatGPT' ? 'OpenAI' : 'Google');
    await page.locator('#tool-actions button.primary').click();
    await page.locator('#tool-actions button.primary').click();
    expect((await page.evaluate(() => window.__opened)).at(-1)).toBe(url);
    expect(await page.evaluate(() => navigator.clipboard.readText())).toContain('<transcription>');
  }
  // Aucun logo Claude dans les menus et boutons
  expect(await page.evaluate(() => document.body.innerHTML.includes('M11.47 9.25'))).toBe(false);
  await expect(page.locator('#act-claude')).toContainText('Affiner avec une IA');
});
