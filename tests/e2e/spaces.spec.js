// Espaces collaboratifs, avec un faux Supabase (en mémoire, partagé entre onglets du même navigateur).
import { readFileSync } from 'node:fs';
import { test, expect, boot, nav, seedMeetings } from './helpers.js';

const MOCK = readFileSync(new URL('./mocks/supabase.js', import.meta.url), 'utf8');
const as = (page, u) => page.addInitScript((u) => sessionStorage.setItem('mock.sb.user', JSON.stringify(u)), u);
const RAF = { id: 'u-raf', email: 'raf@exemple.fr', name: 'Raf' };
const JULIE = { id: 'u-julie', email: 'julie@exemple.fr', name: 'Julie' };

test('créer un espace, inviter, partager ; l’invitée voit la réunion, un tiers rien', async ({ page, context }) => {
  await context.addInitScript(MOCK);
  await as(page, RAF);
  await boot(page);
  await page.evaluate(() => localStorage.removeItem('mock.sb.db'));
  await seedMeetings(page);
  await nav(page, 'spaces');

  // Nouvel espace
  await page.locator('#spc-new').click();
  await page.locator('.modal input.text-input').fill('Projet Ledona');
  await page.locator('.modal [data-ok]').click();
  await expect(page.locator('.spc-item b')).toContainText(['Projet Ledona']);

  // Invitation
  await page.fill('#spc-email', 'julie@exemple.fr');
  await page.locator('#spc-invite button').click();
  await expect(page.locator('#modal-text')).toContainText('julie@exemple.fr');
  await page.locator('#modal-cancel').click();
  // Deuxième invitation de la même personne : message clair
  await page.fill('#spc-email', 'julie@exemple.fr');
  await page.locator('#spc-invite button').click();
  await expect(page.locator('body')).toContainText('déjà membre');

  // Partage d'une réunion (sans audio)
  await page.locator('[data-spc="share"]').click();
  await page.locator('#tool-actions button.primary').click();
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('mock.sb.db')).space_docs.length)).toBe(1);
  const shared = await page.evaluate(() => JSON.parse(localStorage.getItem('mock.sb.db')).space_docs[0]);
  expect(shared.author_email).toBe('raf@exemple.fr');
  expect(JSON.stringify(shared.doc.speakers)).not.toContain('emb'); // empreintes de voix jamais partagées

  // Julie
  const j = await context.newPage();
  await as(j, JULIE);
  await boot(j);
  await nav(j, 'spaces');
  await expect(j.locator('.spc-item b')).toContainText(['Projet Ledona']);
  await expect(j.locator('#spc-invite')).toBeHidden(); // seule la propriétaire invite
  await j.locator('.spc-doc').first().click();
  await expect.poll(() => j.evaluate(() => window.__app.state.doc?.fromSpace?.name)).toBe('Projet Ledona');

  // Une autre personne ne voit rien
  const x = await context.newPage();
  await as(x, { id: 'u-x', email: 'autre@exemple.fr', name: 'Autre' });
  await boot(x);
  await nav(x, 'spaces');
  await expect(x.locator('.spc-item')).toHaveCount(0);
});

test('sans configuration ni connexion : écran d’explication', async ({ page }) => {
  await page.addInitScript(() => { window.__spacesClient = { auth: { async getSession() { return { data: { session: null } }; }, async signInWithOAuth() { return { error: null }; } } }; });
  await boot(page);
  await nav(page, 'spaces');
  await expect(page.locator('#view-spaces, [data-view="spaces"], body')).toContainText(/Google/);
});
