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
  await page.evaluate(() => { localStorage.removeItem('transcripteur.onboarded.local'); });
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

test('premier lancement : une fois par compte, après avoir regardé le Drive', async ({ page, context, browser }) => {
  const { fakeDrive } = await import('./mocks/drive.js');
  const files = await fakeDrive(context);
  await context.addInitScript(() => {
    localStorage.setItem('transcripteur.onboard.force', '1');
    localStorage.setItem('transcripteur.onboarded.local', '1'); // déjà vue hors connexion, ou avec un autre compte
    localStorage.setItem('transcripteur.onboarded.autre@exemple.fr', '1');
    localStorage.setItem('transcripteur.cloud.user', JSON.stringify({ email: 'neuf@exemple.fr', name: 'Neuf', picture: '' }));
    sessionStorage.setItem('transcripteur.cloud.token', JSON.stringify({ value: 'faux', exp: Date.now() + 3600e3 }));
  });
  // Compte neuf, Drive vide : présentée
  await boot(page);
  await expect(page.locator('.ob')).toBeVisible();
  await page.locator('.ob [data-ob="skip"]').click();
  expect(await page.evaluate(() => localStorage.getItem('transcripteur.onboarded.neuf@exemple.fr'))).toBe('1');
  // Ce compte a maintenant des réunions dans son Drive…
  await seedMeetings(page);
  await page.evaluate(async () => {
    for (const id of ['d1', 'd2']) { const d = await window.__app.History.get(id); d.owner = 'neuf@exemple.fr'; await window.__app.History.put(d); }
    await window.__app.syncNow();
  });
  await expect.poll(() => [...files.values()].filter((f) => f.appProperties.kind === 'doc').length).toBe(2);
  // … et l'ouvre dans un autre navigateur (rien en local) : pas de présentation
  const other = await browser.newContext({ permissions: ['microphone'] });
  await fakeDrive(other, files);
  await other.addInitScript(() => {
    localStorage.setItem('transcripteur.theme', 'dark');
    localStorage.setItem('transcripteur.onboard.force', '1');
    localStorage.setItem('transcripteur.cloud.user', JSON.stringify({ email: 'neuf@exemple.fr', name: 'Neuf', picture: '' }));
    sessionStorage.setItem('transcripteur.cloud.token', JSON.stringify({ value: 'faux', exp: Date.now() + 3600e3 }));
  });
  const p2 = await other.newPage();
  await boot(p2);
  await expect.poll(() => p2.evaluate(() => localStorage.getItem('transcripteur.onboarded.neuf@exemple.fr')), { timeout: 15_000 }).toBe('1');
  await expect(p2.locator('.ob')).toHaveCount(0);
  await other.close();
});
