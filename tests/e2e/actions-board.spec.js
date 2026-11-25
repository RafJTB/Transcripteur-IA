// Page « Suivi des actions ».
import { test, expect, boot, nav, seedMeetings } from './helpers.js';

test('suivi des actions : compteurs, responsables, cocher (repris dans la réunion), regrouper, copier', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.setViewportSize({ width: 1600, height: 1000 });
  await boot(page);
  await seedMeetings(page);
  await nav(page, 'actions');
  const rows = page.locator('.ab-row');
  await expect(rows.first()).toBeVisible();
  const n = await rows.count();
  await expect(page.locator('[data-ab-status="todo"] b')).toHaveText(String(n));
  // Responsables : Julie (« tu peux t’en charger ? ») et Marc (« va relancer le BET »)
  await expect(page.locator('#ab-people')).toContainText('Julie');
  await expect(page.locator('#ab-people')).toContainText('Marc');
  await page.locator('#ab-people [data-ab-who="Marc"]').click();
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText('relancer le BET');
  // Cocher : l'action passe dans « Faites » et l'état est enregistré dans la réunion
  await rows.first().locator('[data-ab-done]').click();
  await expect(rows).toHaveCount(0);
  await expect(page.locator('[data-ab-status="done"] b')).toHaveText('1');
  const st = await page.evaluate(async () => Object.values((await window.__app.History.get('d1')).actionState || {}));
  expect(st).toContain('done');
  await page.locator('[data-ab-status="done"]').click();
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toHaveClass(/done/);
  // Tout le monde, toutes les actions à faire, regroupées par réunion
  await page.locator('#ab-people [data-ab-who="*"]').click();
  await page.locator('[data-ab-status="todo"]').click();
  await page.locator('#ab-by [data-ab-by="meeting"]').click();
  await expect(page.locator('.ab-group').first()).toContainText(/Ledona|Lot Gros/);
  // Copier la liste (par responsable)
  await page.locator('#ab-copy').click();
  const txt = await page.evaluate(() => navigator.clipboard.readText());
  expect(txt).toMatch(/Julie :\n- \[ \]/);
  // Ouvrir la réunion d'une action : onglet Actions
  await rows.first().locator('[data-ab-open]').click();
  await expect(page.locator('body')).toHaveAttribute('data-page', 'doc');
  await expect(page.locator('[data-dtab="actions"]')).toHaveAttribute('aria-selected', 'true');
  // Recherche
  await nav(page, 'actions');
  await page.locator('#ab-q').fill('grue');
  await expect(rows).toHaveCount(1);
});
