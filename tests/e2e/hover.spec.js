// Lueur au survol des blocs : suit la souris, réglable (blocs concernés, couleur).
import { test, expect, boot, nav, seedMeetings } from './helpers.js';

const center = async (loc) => { const b = await loc.boundingBox(); return [b.x + b.width / 2, b.y + b.height / 2, b]; };

test('survol : le bord du bloc s’allume sous la souris, réglages respectés et gardés', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await boot(page);
  await seedMeetings(page);
  await nav(page, 'home');
  const glow = page.locator('.hover-glow');
  const row = page.locator('.recent-row').first();
  await expect(row).toBeVisible();

  // Tous les blocs (par défaut) : la lueur se pose sur le bloc survolé, à la position de la souris
  const [x, y, box] = await center(row);
  await page.mouse.move(x, y);
  await expect(glow).toHaveClass(/on/);
  const g = await glow.boundingBox();
  expect(Math.abs(g.x - box.x)).toBeLessThan(1.5);
  expect(Math.abs(g.width - box.width)).toBeLessThan(1.5);
  expect(await glow.evaluate((e) => parseFloat(e.style.getPropertyValue('--mx')))).toBeCloseTo(box.width / 2, 0);
  // Hors des blocs : elle s'éteint
  await page.mouse.move(5, 995);
  await expect(glow).not.toHaveClass(/on/);

  // Réglages : blocs cliquables, couleur orange
  await nav(page, 'custom');
  await page.locator('#hover-mode [data-hover="click"]').click();
  await page.locator('#hover-row [data-hcolor="#ea580c"]').click();
  await expect(page.locator('html')).toHaveAttribute('data-hover', 'click');
  expect(await page.evaluate(() => document.documentElement.style.getPropertyValue('--hover-rgb'))).toBe('234 88 12');
  // Le bloc « Survol des blocs » lui-même n'est pas cliquable : pas de lueur
  const [cx, cy] = await center(page.locator('#hover-mode').locator('xpath=ancestor::section[1]'));
  await page.mouse.move(cx + 200, cy + 30);
  await expect(glow).not.toHaveClass(/on/);
  // Une tuile de fond d'écran (cliquable) : lueur
  const [tx, ty] = await center(page.locator('.bg-tile').first());
  await page.mouse.move(tx, ty);
  await expect(glow).toHaveClass(/on/);

  // Gardé après rechargement
  await page.reload();
  await page.waitForFunction(() => window.__appBoot && window.__app);
  await expect(page.locator('html')).toHaveAttribute('data-hover', 'click');

  // Désactivé : jamais de lueur
  await nav(page, 'custom');
  await page.locator('#hover-mode [data-hover="off"]').click();
  const [ux, uy] = await center(page.locator('.bg-tile').first());
  await page.mouse.move(ux, uy);
  await page.waitForTimeout(150);
  await expect(glow).not.toHaveClass(/on/);
  // Retour à la couleur d'accent
  await page.locator('#hover-mode [data-hover="all"]').click();
  await page.locator('#hover-row [data-hcolor=""]').click();
  expect(await page.evaluate(() => document.documentElement.style.getPropertyValue('--hover-rgb'))).toBe('');
});

test('survol : la lueur marche aussi sur les pages ajoutées après coup (projets, document)', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await boot(page);
  await seedMeetings(page);
  const glow = page.locator('.hover-glow');
  // Mes projets : une ligne de réunion et la colonne des dossiers
  await nav(page, 'projects');
  const [rx, ry] = await center(page.locator('.proj-row').first());
  await page.mouse.move(rx, ry);
  await expect(glow).toHaveClass(/on/);
  const [sx, sy] = await center(page.locator('.proj-side h4'));
  await page.mouse.move(sx, sy);
  await expect(glow).toHaveClass(/on/);
  // Réunion ouverte : la barre de vérification (bloc détecté automatiquement, sans liste)
  await page.locator('.proj-row').first().click();
  await expect(page.locator('body')).toHaveAttribute('data-page', 'doc');
  const bar = page.locator('.verify-bar');
  await expect(bar).toBeVisible();
  const [vx, vy] = await center(bar);
  await page.mouse.move(vx, vy);
  await expect(glow).toHaveClass(/on/);
  // Barre latérale et barre du haut : jamais
  const [nx, ny] = await center(page.locator('.sidebar [data-nav="home"]'));
  await page.mouse.move(nx, ny);
  await expect(glow).not.toHaveClass(/on/);
});
