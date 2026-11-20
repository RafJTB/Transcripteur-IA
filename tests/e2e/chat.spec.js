// Conversation d'un espace, entre deux personnes (deux onglets), avec un faux Supabase et un faux « Realtime ».
import { readFileSync } from 'node:fs';
import { test, expect, boot, nav, seedMeetings } from './helpers.js';

const MOCK = readFileSync(new URL('./mocks/supabase.js', import.meta.url), 'utf8');
const as = (page, u) => page.addInitScript((u) => sessionStorage.setItem('mock.sb.user', JSON.stringify(u)), u);
const RAF = { id: 'u-raf', email: 'raf@exemple.fr', name: 'Raf' };
const JULIE = { id: 'u-julie', email: 'julie@exemple.fr', name: 'Julie' };

/** Raf crée « Projet Ledona », invite Julie et partage une réunion ; Julie ouvre l'espace. */
async function setup(page, context) {
  await context.addInitScript(MOCK);
  await as(page, RAF);
  await boot(page);
  await page.evaluate(() => localStorage.removeItem('mock.sb.db'));
  await seedMeetings(page);
  await nav(page, 'spaces');
  await page.locator('#spc-new').click();
  await page.locator('.modal input.text-input').fill('Projet Ledona');
  await page.locator('.modal [data-ok]').click();
  await page.fill('#spc-email', 'julie@exemple.fr');
  await page.locator('#spc-invite button').click();
  await page.locator('#modal-cancel').click();
  await page.locator('[data-spc="share"]').click();
  await page.locator('#tool-actions button.primary').click();
  await expect(page.locator('.spc-doc')).toHaveCount(1);
  const julie = await context.newPage();
  await as(julie, JULIE);
  await boot(julie);
  await nav(julie, 'spaces');
  await expect(julie.locator('#chat-live')).toContainText('en direct');
  return julie;
}

async function send(page, text) {
  await page.locator('#chat-text').fill(text);
  await page.locator('#chat-text').press('Enter');
}

test('messages en direct entre deux membres, avec réunion jointe', async ({ page, context }) => {
  const julie = await setup(page, context);
  await expect(page.locator('#chat-msgs')).toContainText('Aucun message');

  await send(page, 'Salut Julie, tu as vu le scan ?\nIl est complet.');
  await expect(page.locator('.cm.mine')).toHaveCount(1);
  await expect(page.locator('#chat-text')).toHaveValue('');
  // Julie le reçoit sans recharger
  const got = julie.locator('.cm:not(.mine)');
  await expect(got).toHaveCount(1);
  await expect(got).toContainText('Raf');
  await expect(got.locator('p')).toHaveText('Salut Julie, tu as vu le scan ?Il est complet.');
  await expect(got.locator('p br')).toHaveCount(1);

  // Julie répond en joignant la réunion partagée
  await julie.locator('#chat-attach').click();
  await julie.locator('#chat-pick [data-attach]').first().click();
  await expect(julie.locator('#chat-attach-chip')).toContainText('Ledona');
  await send(julie, 'Oui ! Voir https://exemple.fr/plan et la réunion');
  const reply = page.locator('.cm:not(.mine)');
  await expect(reply).toHaveCount(1);
  await expect(reply.locator('a[href="https://exemple.fr/plan"]')).toHaveCount(1);
  await reply.locator('.cm-doc').click();
  await expect.poll(() => page.evaluate(() => window.__app.state.doc?.fromSpace?.name)).toBe('Projet Ledona');
});

test('texte échappé, suppression visible chez l’autre, Maj + Entrée pour aller à la ligne', async ({ page, context }) => {
  const julie = await setup(page, context);
  await julie.locator('#chat-text').fill('<img src=x onerror="window.__pwned=1"> ligne 1');
  await julie.locator('#chat-text').press('Shift+Enter');
  await julie.locator('#chat-text').pressSequentially('ligne 2');
  await expect(julie.locator('.cm')).toHaveCount(0); // Maj + Entrée n'envoie pas
  await julie.locator('#chat-text').press('Enter');
  const msg = page.locator('.cm:not(.mine)');
  await expect(msg).toContainText('<img src=x');
  await expect(msg.locator('img')).toHaveCount(0);
  expect(await page.evaluate(() => window.__pwned)).toBeUndefined();
  await expect(msg.locator('p br')).toHaveCount(1);
  // Julie supprime son message : il disparaît aussi chez Raf
  await julie.locator('.cm.mine .cm-del').click({ force: true });
  await julie.locator('#modal-ok').click();
  await expect(page.locator('.cm')).toHaveCount(0);
});

test('non-lus : pastille dans le menu et sur l’espace, notification, remise à zéro à la lecture', async ({ page, context }) => {
  const julie = await setup(page, context);
  await nav(page, 'home'); // Raf n'est plus sur la conversation
  await send(julie, 'Point à 14 h ?');
  await send(julie, 'Je réserve la salle.');
  const navBtn = page.locator('#nav [data-nav="spaces"], .side [data-nav="spaces"]').first();
  await expect(page.locator('[data-nav="spaces"].has-unread').first()).toHaveAttribute('data-unread', '2');
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('transcripteur.notifs') || '[]').filter((n) => /Julie/.test(n.title)).length)).toBeGreaterThan(0);
  await nav(page, 'spaces');
  await expect(page.locator('.cm:not(.mine)')).toHaveCount(2);
  await expect(page.locator('[data-nav="spaces"].has-unread')).toHaveCount(0);
  await expect(navBtn).toBeAttached();
  // Rechargement : les messages lus ne reviennent pas en non-lus
  await page.reload();
  await page.waitForFunction(() => window.__appBoot);
  await page.waitForTimeout(500);
  await expect(page.locator('[data-nav="spaces"].has-unread')).toHaveCount(0);
});

test('non-lus retrouvés à l’ouverture de l’appli', async ({ page, context }) => {
  const julie = await setup(page, context);
  await page.close();
  await send(julie, 'Message pendant ton absence');
  const raf = await context.newPage();
  await as(raf, RAF);
  await boot(raf);
  await expect(raf.locator('[data-nav="spaces"].has-unread').first()).toHaveAttribute('data-unread', '1');
  await nav(raf, 'spaces');
  await expect(raf.locator('#spc-list .spc-unread')).toHaveCount(0);
  await expect(raf.locator('.cm:not(.mine)')).toContainText('pendant ton absence');
});

test('direct indisponible : statut affiché, les messages arrivent quand même', async ({ page, context }) => {
  const julie = await setup(page, context);
  // Raf perd le direct : nouvel onglet sans « Realtime »
  await page.close();
  const raf = await context.newPage();
  await raf.addInitScript(() => { window.__mockRealtime.offline = true; });
  await as(raf, RAF);
  await raf.clock.install();
  await boot(raf);
  await nav(raf, 'spaces');
  await expect(raf.locator('#chat-live')).toContainText('reconnexion');
  await expect(raf.locator('#chat-live')).not.toHaveClass(/on/);
  await send(julie, 'Tu me reçois ?');
  await raf.clock.runFor(25_000);
  await expect(raf.locator('.cm:not(.mine)')).toContainText('Tu me reçois ?');
});
