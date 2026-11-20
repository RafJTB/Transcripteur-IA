// Démarrage, navigation, téléphone, thème et personnalisation.
import { test, expect, boot, nav, seedMeetings } from './helpers.js';

const PAGES = ['home', 'projects', 'analytics', 'models', 'help', 'settings', 'custom', 'spaces'];

test('l’appli démarre sur l’Accueil, sans erreur', async ({ page }) => {
  await boot(page);
  await expect(page.locator('body')).toHaveAttribute('data-page', 'home');
  await expect(page).toHaveTitle(/Transcripteur/);
});

test('chaque page s’ouvre sans erreur', async ({ page }) => {
  await boot(page);
  await seedMeetings(page);
  for (const p of PAGES) await nav(page, p);
});

test('Accueil : réunions récentes et ouverture d’un projet', async ({ page }) => {
  await boot(page);
  await seedMeetings(page);
  await nav(page, 'projects');
  await nav(page, 'home');
  const rows = page.locator('#dash-recent .recent-row');
  await expect(rows).toHaveCount(2);
  await expect(rows.first()).toContainText('Ledona');
  await rows.first().click();
  await expect.poll(() => page.evaluate(() => window.__app.state.doc?.id)).toBe('d1');
});

test('téléphone : aucune page ne déborde en largeur', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await boot(page);
  await seedMeetings(page);
  // Police normale, puis police plus large (comme un téléphone avec un texte agrandi)
  for (const font of [null, 'DejaVu Sans']) {
    if (font) await page.addStyleTag({ content: `*{font-family:"${font}" !important}` });
    for (const p of ['home', 'projects', 'settings', 'spaces', 'help']) {
      await page.evaluate((n) => document.querySelector(`[data-nav="${n}"]`).click(), p);
      await page.waitForTimeout(150);
      const r = await page.evaluate(() => {
        const W = document.documentElement.clientWidth;
        const out = [...document.querySelectorAll('body *')].filter((e) => e.getBoundingClientRect().right > W + 0.5 && e.offsetParent)
          .map((e) => `${e.tagName.toLowerCase()}.${[...e.classList].join('.')}`).slice(0, 5);
        return { over: document.documentElement.scrollWidth - W, out };
      });
      expect(r.over, `débordement sur « ${p} »${font ? ` (police ${font})` : ''} : ${r.out.join(', ')}`).toBeLessThanOrEqual(0);
    }
  }
  expect(errors).toEqual([]);
  await ctx.close();
});

test('personnalisation : couleur d’accent et opacité gardées après rechargement', async ({ page }) => {
  await boot(page);
  await nav(page, 'custom');
  await page.locator('[data-accent="#059669"]').click();
  await page.locator('#perso-panel').fill('250');
  await page.locator('#perso-panel').dispatchEvent('input');
  await page.reload();
  await page.waitForFunction(() => window.__appBoot);
  const css = await page.evaluate(() => {
    const s = getComputedStyle(document.documentElement);
    return { sel: s.getPropertyValue('--sel-b').trim(), panel: s.getPropertyValue('--panel-k').trim() };
  });
  expect(css.sel).toBe('5 150 105');
  expect(Number(css.panel)).toBeCloseTo(2.5, 1);
});
