// Page « Mes projets » : dossiers à gauche, chronologie à droite.
import { test, expect, boot, nav, seedMeetings } from './helpers.js';

test('Mes projets : chronologie, dossiers en couleur, ranger, filtrer, supprimer, ouvrir', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await boot(page);
  await seedMeetings(page);
  await nav(page, 'projects');
  const rows = page.locator('.proj-row');
  await expect(rows).toHaveCount(2);
  // Regroupement par période, temps de parole, actions à faire
  await expect(page.locator('.proj-group').first()).toContainText(/Cette semaine|Aujourd/);
  await expect(rows.first().locator('.pr-share i')).toHaveCount(3);
  await expect(page.locator('#hist-count')).toContainText('2 réunions');
  await expect(page.locator('#hist-count')).toContainText('à faire');
  await expect(rows.first().locator('.pr-chip.act')).toBeVisible();

  // Nouveau dossier, puis ranger la 1re réunion dedans (menu « Dossier » de la ligne)
  await page.locator('.proj-side [data-folder-new]').click();
  await page.locator('.modal input.text-input').fill('Ledona');
  await page.locator('.modal [data-ok]').click();
  await expect(page.locator('.proj-side .fchip.active')).toContainText('Ledona');
  await expect(page.locator('#folder-tools')).toBeVisible();
  await page.locator('.proj-side [data-folder="all"]').click();
  const fid = await page.evaluate(() => window.__app.Folders.list()[0].id);
  await rows.first().locator('.hist-move').selectOption(fid);
  await expect(page.locator(`.proj-side [data-folder="${fid}"] small`)).toHaveText('1');
  // La ligne prend la couleur du dossier et affiche son nom
  await expect(rows.first().locator('.pr-txt small')).toContainText('Ledona');
  const c = await rows.first().evaluate((e) => e.style.getPropertyValue('--fc'));
  expect(c).not.toBe('148 163 184');
  // Filtre par dossier
  await page.locator(`.proj-side [data-folder="${fid}"]`).click();
  await expect(rows).toHaveCount(1);
  await page.locator('.proj-side [data-folder="all"]').click();

  // Supprimer la 2e réunion
  await rows.nth(1).hover();
  await rows.nth(1).locator('.pc-del').click();
  await page.locator('#modal-ok').click();
  await expect(rows).toHaveCount(1);

  // Ouvrir la réunion restante
  await rows.first().click();
  await expect(page.locator('body')).toHaveAttribute('data-page', 'doc');
  // « Nouvelle transcription » depuis la page
  await nav(page, 'projects');
  await page.locator('#proj-new').click();
  await expect(page.locator('body')).toHaveAttribute('data-page', 'record');
});

test('Historique : même liste, sans la colonne des dossiers', async ({ page }) => {
  await boot(page);
  await seedMeetings(page);
  await nav(page, 'history');
  await expect(page.locator('.proj-row')).toHaveCount(2);
  await expect(page.locator('.proj-side')).toBeHidden();
});
