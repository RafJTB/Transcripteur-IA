// Page Paramètres : sommaire à gauche, une catégorie à droite.
import { test, expect, boot, nav } from './helpers.js';

test('Paramètres : catégories, état, lexique en aperçu, choix retenu, réglages qui marchent', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('transcripteur.lexique.v1', JSON.stringify([{ from: 'BET', to: 'B.E.T.' }, { from: 'revite', to: 'Revit' }, { from: 'off', to: 'non', enabled: false }])));
  await boot(page);
  await nav(page, 'settings');
  // Une seule catégorie visible : Compte par défaut
  await expect(page.locator('.set-sec:not([hidden])')).toHaveCount(1);
  await expect(page.locator('[data-sec="compte"]')).toBeVisible();
  await expect(page.locator('#acc-login')).toBeVisible();
  // Pastilles d'état : pas connecté
  await expect(page.locator('[data-dot="compte"]')).toHaveClass(/off/);

  // Lexique : aperçu des mots actifs seulement
  await page.locator('#set-nav [data-set="lexique"]').click();
  await expect(page.locator('[data-sec="lexique"]')).toBeVisible();
  await expect(page.locator('#lex-count')).toHaveText('2 mots');
  await expect(page.locator('#lex-preview')).toContainText('BET');
  await expect(page.locator('#lex-preview')).not.toContainText('non');

  // Voix : l'interrupteur marche toujours (enregistré)
  await page.locator('#set-nav [data-set="voix"]').click();
  const was = await page.locator('#toggle-voiceid').isChecked();
  await page.locator('[data-sec="voix"] label.set-row').click();
  await expect(page.locator('#toggle-voiceid')).toBeChecked({ checked: !was });

  // Stockage : la liste « où garder les audios » marche toujours
  await page.locator('#set-nav [data-set="stockage"]').click();
  await page.locator('#audio-policy').selectOption('local');
  expect(await page.evaluate(() => Object.entries(localStorage).some(([k, v]) => /audio/i.test(k) && v === 'local'))).toBe(true);

  // Flèche bas : catégorie suivante ; choix retenu après rechargement
  await page.locator('#set-nav [data-set="stockage"]').focus();
  await page.keyboard.press('ArrowDown');
  await expect(page.locator('[data-sec="apropos"]')).toBeVisible();
  await page.reload();
  await page.waitForFunction(() => window.__appBoot && window.__app);
  await nav(page, 'settings');
  await expect(page.locator('[data-sec="apropos"]')).toBeVisible();
  // Moteur : pastille selon le matériel détecté
  await page.locator('#set-nav [data-set="moteur"]').click();
  await expect(page.locator('#pill-engine')).toBeVisible();
  await expect(page.locator('[data-dot="moteur"]')).toHaveClass(/ok|warn/);
});
