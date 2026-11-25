// Premier lancement et pages vides illustrées.
import { test, expect, boot, nav, seedMeetings } from './helpers.js';

test.use({ launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] }, permissions: ['microphone'] });

test('premier lancement : 3 étapes, micro avec niveau, réunion d’exemple ; une seule fois', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('transcripteur.onboard.force', '1'));
  await boot(page);
  const ob = page.locator('.ob');
  await expect(ob).toBeVisible();
  await expect(ob.locator('h2')).toHaveText('Bienvenue dans Transcripteur IA');
  await ob.locator('[data-ob="next"]').click();
  await expect(ob.locator('h2')).toHaveText('Ton micro');
  await ob.locator('[data-ob="allow"]').click();
  // Faux micro de Chromium : un bip régulier, la barre de niveau bouge
  await expect.poll(() => ob.locator('#ob-level').evaluate((e) => e.style.transform), { timeout: 10_000 }).toMatch(/scaleX\(0\.[1-9]|scaleX\(1/);
  await ob.locator('[data-ob="next"]').click();
  await expect(ob.locator('h2')).toHaveText('Par où commencer ?');
  await ob.locator('[data-ob="demo"]').click();
  await expect(ob).toHaveCount(0);
  await expect(page.locator('body')).toHaveAttribute('data-page', 'doc');
  await expect(page.locator('#result-title')).toHaveValue(/Exemple/);
  // La réunion d'exemple a des actions et des intervenants
  await page.locator('[data-dtab="actions"]').click();
  await expect(page.locator('#actions')).toContainText('maquette fluides');
  // Plus jamais montré ensuite
  await page.reload();
  await page.waitForFunction(() => window.__appBoot && window.__app);
  await page.waitForTimeout(500);
  await expect(page.locator('.ob')).toHaveCount(0);
  // … sauf depuis l'Aide
  await nav(page, 'help');
  await page.locator('#help-tour').click();
  await expect(page.locator('.ob')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.ob')).toHaveCount(0);
});

test('premier lancement : pas montré à qui a déjà des réunions', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('transcripteur.onboard.force', '1'));
  await boot(page);
  await page.locator('.ob [data-ob="skip"]').click();
  await page.evaluate(() => { localStorage.removeItem('transcripteur.onboarded'); });
  await seedMeetings(page);
  await page.reload();
  await page.waitForFunction(() => window.__appBoot && window.__app);
  await page.waitForTimeout(500);
  await expect(page.locator('.ob')).toHaveCount(0);
});

test('pages vides illustrées, avec le bon bouton', async ({ page }) => {
  await boot(page);
  await expect(page.locator('#dash-recent .em')).toContainText('Ta première réunion t’attend');
  await page.locator('#dash-recent [data-em="record"]').click();
  await expect(page.locator('body')).toHaveAttribute('data-page', 'record');
  await nav(page, 'projects');
  await expect(page.locator('#hist-list .em svg')).toBeVisible();
  await nav(page, 'actions');
  await expect(page.locator('#ab-list .em')).toContainText('Aucune action pour l’instant');
  // Recherche sans résultat
  await seedMeetings(page);
  await nav(page, 'projects');
  await page.locator('#hist-search').fill('xyzzy');
  await expect(page.locator('#hist-list .em')).toContainText('Rien trouvé pour « xyzzy »');
});
