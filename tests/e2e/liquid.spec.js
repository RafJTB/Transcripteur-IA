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
