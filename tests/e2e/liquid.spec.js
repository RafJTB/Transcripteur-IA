// Onglets en verre liquide : une pastille sous l'onglet choisi, qui suit la sélection.
import { test, expect, boot, nav, seedMeetings } from './helpers.js';

const pillOn = async (page, host, item) => page.evaluate(([h, i]) => {
  const host = document.querySelector(h), pill = host.querySelector(':scope > .lg-pill'), on = host.querySelector(i);
  if (!pill || !on) return 'absente';
  const p = pill.getBoundingClientRect(), b = on.getBoundingClientRect();
  return pill.classList.contains('on') && Math.abs(p.x - b.x) < 2 && Math.abs(p.y - b.y) < 2 && Math.abs(p.width - b.width) < 2 ? 'ok' : `décalée ${p.x},${p.y},${p.width} / ${b.x},${b.y},${b.width}`;
}, [host, item]);

test('verre liquide : la pastille suit l’onglet choisi (menu, document, dossiers reconstruits)', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await boot(page);
  await seedMeetings(page);
  // Menu latéral
  await expect.poll(() => pillOn(page, '#nav', '[data-nav="home"]')).toBe('ok');
  await page.locator('.sidebar [data-nav="calendar"]').click();
  await expect.poll(() => pillOn(page, '#nav', '[data-nav="calendar"]')).toBe('ok');
  // L'onglet choisi laisse voir le verre (son fond propre est retiré)
  await expect(page.locator('#nav [data-nav="calendar"]')).toHaveAttribute('data-lg-on', '');
  // Dossiers : la liste est reconstruite, la pastille revient
  await nav(page, 'projects');
  await expect.poll(() => pillOn(page, '.proj-side .folder-bar', '.fchip.active')).toBe('ok');
  // Onglets d'une réunion
  await page.locator('.proj-row').first().click();
  await page.locator('[data-dtab="actions"]').click();
  await expect.poll(() => pillOn(page, '.dtabs', '[data-dtab="actions"]')).toBe('ok');
});

const mid = async (loc) => { const b = await loc.boundingBox(); return [b.x + b.width / 2, b.y + b.height / 2, b]; };

test('verre liquide : rester appuyé et glisser, la pastille suit la souris ; au relâchement, l’onglet est ouvert', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await boot(page);
  await seedMeetings(page);
  const pill = page.locator('#nav > .lg-pill');
  const [hx, hy] = await mid(page.locator('#nav [data-nav="home"]'));
  const [, ay] = await mid(page.locator('#nav [data-nav="analytics"]'));
  await page.mouse.move(hx, hy);
  await page.mouse.down();
  // À mi-chemin : la pastille est sous la souris (pas encore sur un onglet), en mode « glisser »
  const midY = (hy + ay) / 2;
  await page.mouse.move(hx, midY, { steps: 8 });
  await expect(pill).toHaveClass(/drag/);
  const pb = await pill.boundingBox();
  expect(Math.abs(pb.y + pb.height / 2 - midY)).toBeLessThan(pb.height * 0.6);
  // Sur « Analyses » : il s'éclaire ; au relâchement, la page s'ouvre
  await page.mouse.move(hx, ay, { steps: 8 });
  await expect(page.locator('#nav [data-nav="analytics"]')).toHaveAttribute('data-lg-on', '');
  await page.mouse.up();
  await expect(page.locator('body')).toHaveAttribute('data-page', 'analytics');
  await expect(pill).not.toHaveClass(/drag/);
  await expect.poll(() => pillOn(page, '#nav', '[data-nav="analytics"]')).toBe('ok');

  // Revenir sur l'onglet de départ : rien ne change
  const [sx, sy] = await mid(page.locator('#nav [data-nav="analytics"]'));
  await page.mouse.move(sx, sy);
  await page.mouse.down();
  await page.mouse.move(sx, sy - 120, { steps: 6 });
  await page.mouse.move(sx, sy, { steps: 6 });
  await page.mouse.up();
  await expect(page.locator('body')).toHaveAttribute('data-page', 'analytics');

  // Onglets horizontaux d'une réunion
  await nav(page, 'projects');
  await page.locator('.proj-row').first().click();
  const [tx, ty] = await mid(page.locator('[data-dtab="tr"]'));
  const [ax2] = await mid(page.locator('[data-dtab="actions"]'));
  await page.mouse.move(tx, ty);
  await page.mouse.down();
  await page.mouse.move(ax2, ty, { steps: 10 });
  await page.mouse.up();
  await expect(page.locator('[data-dtab="actions"]')).toHaveAttribute('aria-selected', 'true');
  // Un simple clic marche toujours
  await page.locator('[data-dtab="analysis"]').click();
  await expect(page.locator('[data-dtab="analysis"]')).toHaveAttribute('aria-selected', 'true');
});

test('verre liquide : prend la couleur du bloc choisi, sinon reste neutre (couleur du fond)', async ({ page }) => {
  await boot(page);
  await page.evaluate(() => { for (const n of ['Chantier A', 'Chantier B']) window.__app.Folders.add(n); });
  await nav(page, 'projects');
  const chip = page.locator('.proj-side .fchip[data-folder]').nth(2);
  await expect(chip).toBeVisible();
  const fc = await chip.evaluate((e) => getComputedStyle(e).getPropertyValue('--fc').trim().replace(/\s+/g, ' '));
  expect(fc).toMatch(/^\d+ \d+ \d+$/);
  await chip.click();
  const pill = page.locator('.proj-side .folder-bar > .lg-pill');
  await expect.poll(() => pill.evaluate((p) => p.style.getPropertyValue('--lg-a'))).toBe(fc);
  await expect(pill).not.toHaveClass(/neutral/);
  // Barre latérale : icônes sans couleur propre → verre neutre, plus la couleur d'accent
  await expect(page.locator('#nav > .lg-pill')).toHaveClass(/neutral/);
  // Paramètres : la couleur de la catégorie
  await nav(page, 'settings');
  await page.locator('[data-set="voix"]').click();
  await expect.poll(() => page.locator('#set-nav > .lg-pill').evaluate((p) => p.style.getPropertyValue('--lg-a'))).toBe('16 185 129');
});
