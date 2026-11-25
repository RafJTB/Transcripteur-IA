// Accessibilité (axe-core, WCAG 2 A/AA + bonnes pratiques) sur toutes les pages, thèmes sombre et clair,
// et repère visible au clavier. Toute régression fait échouer les tests.
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { test as base, expect, boot, nav, seedMeetings } from './helpers.js';

const AXE = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');
const test = base.extend({});
test.use({ bypassCSP: true }); // le navigateur de test seulement : pour injecter axe
test.setTimeout(120_000);

const PAGES = ['home', 'record', 'projects', 'doc', 'actions', 'spaces', 'calendar', 'analytics', 'models', 'custom', 'settings', 'help'];

for (const theme of ['dark', 'light']) {
  test(`accessibilité : aucune violation WCAG (thème ${theme === 'dark' ? 'sombre' : 'clair'})`, async ({ page }) => {
    await page.addInitScript((t) => localStorage.setItem('transcripteur.theme', t), theme);
    await page.setViewportSize({ width: 1600, height: 1000 });
    await boot(page);
    await seedMeetings(page);
    const found = [];
    for (const p of PAGES) {
      if (p === 'record') { await nav(page, 'home'); await page.locator('#dash-new').click(); }
      else if (p === 'doc') { await nav(page, 'projects'); await page.locator('.proj-row').first().click(); }
      else await nav(page, p);
      await page.waitForTimeout(400);
      await page.evaluate((s) => { if (!window.axe) (0, eval)(s); }, AXE);
      const v = await page.evaluate(async () => (await window.axe.run(document, { runOnly: ['wcag2a', 'wcag2aa', 'best-practice'], resultTypes: ['violations'] }))
        .violations.map((x) => `${x.id} (${x.nodes.length}) : ${x.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}`));
      found.push(...v.map((x) => `${p} → ${x}`));
    }
    expect(found).toEqual([]);
  });
}

test('clavier : chaque élément atteint avec Tab a un repère visible', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await boot(page);
  await seedMeetings(page);
  const invisible = [];
  for (let i = 0; i < 45; i++) {
    await page.keyboard.press('Tab');
    const r = await page.evaluate(() => {
      const e = document.activeElement;
      if (!e || e === document.body) return null;
      const has = (x) => { const cs = getComputedStyle(x); return (cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0) || /rgb/.test(cs.boxShadow); };
      return { el: `${e.tagName.toLowerCase()}${e.id ? '#' + e.id : ''}`, ok: has(e) || (e.parentElement && has(e.parentElement)) || (e.parentElement?.parentElement && has(e.parentElement.parentElement)) };
    });
    if (r && !r.ok) invisible.push(r.el);
  }
  expect(invisible).toEqual([]);
});
