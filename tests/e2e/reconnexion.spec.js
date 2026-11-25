// Reconnexion à Google quand l'autorisation a expiré, avec un faux Google.
import { test, expect, boot } from './helpers.js';
import { fakeDrive } from './mocks/drive.js';

test('reconnexion : si Google demande une action, le clic sur la carte ouvre vraiment Google (pas une nouvelle tentative silencieuse)', async ({ page, context }) => {
  await fakeDrive(context);
  const prompts = [];
  // Session Google à confirmer : la tentative silencieuse échoue, la vraie connexion réussit
  await context.route('https://accounts.google.com/**', (route) => {
    const u = new URL(route.request().url());
    const p = u.searchParams.get('prompt');
    prompts.push(p);
    expect(u.searchParams.get('login_hint')).toBe('raf@exemple.fr');
    const back = `${u.searchParams.get('redirect_uri')}#state=${u.searchParams.get('state')}&`
      + (p === 'none' ? 'error=interaction_required' : `access_token=neuf&expires_in=3599&scope=${encodeURIComponent('https://www.googleapis.com/auth/drive.file openid email')}`);
    return route.fulfill({ status: 302, headers: { location: back } });
  });
  await context.addInitScript(() => {
    if (!localStorage.getItem('transcripteur.cloud.user')) localStorage.setItem('transcripteur.cloud.user', JSON.stringify({ email: 'raf@exemple.fr', name: 'Raf', picture: '' }));
  });
  await boot(page);
  // Au lancement : une tentative silencieuse, refusée → « Reconnexion nécessaire »
  await expect(page.locator('#user-card')).toContainText('Reconnexion');
  expect(prompts).toEqual(['none']);
  // Clic sur la carte : vraie connexion (le compte est proposé d'office), et c'est réglé
  await page.locator('#user-card').click();
  await expect(page.locator('#user-card')).toContainText('Synchronisé', { timeout: 10_000 });
  expect(prompts).toEqual(['none', null]);
});
