// Catalogue de fonds d'écran (Personnalisation).
import { test, expect, boot, nav } from './helpers.js';

test('catalogue de fonds : familles, choix appliqué, image chargée, gardé après rechargement', async ({ page }) => {
  const loaded = [];
  page.on('response', (r) => { if (/assets\/fonds\//.test(r.url())) loaded.push([r.url().split('/').pop(), r.status()]); });
  await boot(page);
  await nav(page, 'custom');
  // Toutes les familles, et un nombre de fonds cohérent
  await expect(page.locator('#bg-cats [data-cat]')).toHaveText([/Tous/, /Photo/, /Architecture/, /Nature/, /Abstrait/, /Dégradés/, /Ton image/]);
  const total = await page.locator('#bg-grid .bg-tile').count();
  expect(total).toBeGreaterThanOrEqual(19);
  // Filtre Architecture
  await page.locator('#bg-cats [data-cat="archi"]').click();
  await expect(page.locator('#bg-grid .bg-tile')).toHaveCount(4);
  await expect(page.locator('#bg-grid')).toContainText('Plan d’architecte');
  // Choisir le plan d'architecte : appliqué, et l'image grand format est bien servie
  await page.locator('#bg-grid [data-bg="plan-architecte"]').click();
  await expect(page.locator('#bg-grid [data-bg="plan-architecte"]')).toHaveClass(/active/);
  expect(await page.evaluate(() => document.documentElement.style.getPropertyValue('--bg-image'))).toContain('assets/fonds/plan-architecte.webp');
  await expect.poll(() => page.evaluate(async () => (await fetch('assets/fonds/plan-architecte.webp')).status)).toBe(200);
  // Les vignettes de toutes les familles existent
  await page.locator('#bg-cats [data-cat="all"]').click();
  await expect.poll(() => loaded.filter(([f]) => f.endsWith('-mini.webp')).length).toBeGreaterThanOrEqual(12);
  expect(loaded.filter(([, s]) => s !== 200)).toEqual([]);
  // Gardé après rechargement (appliqué dès le démarrage)
  await page.reload();
  await page.waitForFunction(() => window.__appBoot && window.__app);
  expect(await page.evaluate(() => document.documentElement.style.getPropertyValue('--bg-image'))).toContain('plan-architecte');
});
