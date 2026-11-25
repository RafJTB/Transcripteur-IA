// Recherche par intervenant (Mes projets).
import { test, expect, boot, nav, seedMeetings } from './helpers.js';

test('intervenant : ses réunions, ce qu’il a dit sur un sujet, et ouverture au bon passage', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await boot(page);
  await seedMeetings(page);
  await nav(page, 'projects');
  const rows = page.locator('.proj-row');
  await expect(rows).toHaveCount(2);
  // Julie n'intervient que dans la réunion Ledona
  await expect(page.locator('#proj-speaker option')).toContainText(['Tous les intervenants', 'Raf (2)', 'Marc (2)', 'Julie (1)']);
  await page.locator('#proj-speaker').selectOption('Julie');
  await expect(rows).toHaveCount(1);
  await expect(rows.first().locator('.pr-txt small')).toContainText('Julie : «');
  // Avec la recherche du haut : seulement ce que la personne a dit (sans accents ni majuscules)
  await page.locator('#proj-speaker').selectOption('Marc');
  await page.locator('#hist-search').fill('GRUE');
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText('Lot Gros');
  await expect(rows.first().locator('.pr-txt small')).toContainText('Marc : « Il faut vérifier la livraison de la grue');
  // Raf ne parle pas de la grue
  await page.locator('#proj-speaker').selectOption('Raf');
  await expect(page.locator('#hist-list')).toContainText('Aucune réunion où Raf parle de « GRUE »');
  // Ouverture au passage de Marc
  await page.locator('#proj-speaker').selectOption('Marc');
  await rows.first().click();
  await expect(page.locator('body')).toHaveAttribute('data-page', 'doc');
  await expect(page.locator('#transcript .segment.flash')).toContainText('grue');
});
