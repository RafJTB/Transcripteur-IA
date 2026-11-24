// Calendrier : import .ics, connexion Outlook (faux Microsoft), enregistrement relié, rappel, noms des participants.
import { test, expect, boot, nav } from './helpers.js';

test.use({
  timezoneId: 'Europe/Paris',
  launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] },
  permissions: ['microphone'],
});

const pad = (n) => String(n).padStart(2, '0');
const icsDate = (t) => { const d = new Date(t); return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}00Z`; };
/** Calendrier .ics avec une réunion Teams qui commence dans `inMin` minutes. */
function ics(inMin = 60) {
  const s = Math.floor((Date.now() + inMin * 60000) / 60000) * 60000;
  return Buffer.from([
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:Microsoft Exchange Server 2010',
    'BEGIN:VEVENT', 'UID:ledona-1', 'SUMMARY:Point équipe projet Ledona', `DTSTART:${icsDate(s)}`, `DTEND:${icsDate(s + 3600000)}`,
    'LOCATION:Réunion Microsoft Teams', 'DESCRIPTION:Rejoindre : https://teams.microsoft.com/l/meetup-join/19%3ameeting_x%40thread.v2/0',
    'ORGANIZER;CN=Raf Jeantin:mailto:raf@exemple.fr',
    'ATTENDEE;CN=Julie Martin:mailto:julie.martin@exemple.fr', 'ATTENDEE;CN=marc.dubois@exemple.fr:mailto:marc.dubois@exemple.fr',
    'END:VEVENT',
    'BEGIN:VEVENT', 'UID:old', 'SUMMARY:Réunion passée', `DTSTART:${icsDate(s - 3 * 3600000)}`, `DTEND:${icsDate(s - 2.5 * 3600000)}`, 'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n'));
}

async function importIcs(page, inMin) {
  await nav(page, 'calendar');
  await page.setInputFiles('#cal-ics', { name: 'outlook.ics', mimeType: 'text/calendar', buffer: ics(inMin) });
  await expect(page.locator('.cal-ev')).not.toHaveCount(0);
}

test('import .ics : semaine affichée, puis « Enregistrer » relie la transcription à la réunion', async ({ page }) => {
  await page.addInitScript(() => { localStorage.setItem('transcripteur.auto', '0'); localStorage.setItem('transcripteur.capture', 'mic'); });
  await page.route(/huggingface\.co|hf\.co/, (r) => r.abort());
  await boot(page);
  await importIcs(page, 5);
  const ev = page.locator('.cal-ev', { hasText: 'Point équipe projet Ledona' });
  await expect(ev).toHaveClass(/live/); // commence dans 5 min : « en cours »
  await expect(ev.locator('.ce-tag')).toHaveText('Teams');
  await expect(ev.locator('a', { hasText: 'Rejoindre' })).toHaveAttribute('href', /teams\.microsoft\.com\/l\/meetup-join/);
  await expect(page.locator('.cal-ev', { hasText: 'Réunion passée' })).toHaveClass(/past/);
  await expect(page.locator('.cal-src')).toContainText('outlook.ics');

  // Accueil : prochaine réunion
  await nav(page, 'home');
  await expect(page.locator('#dash-next')).toContainText('Point équipe projet Ledona');

  await nav(page, 'calendar');
  await ev.locator('[data-rec-ev]').click();
  await expect(page.locator('body')).toHaveAttribute('data-page', 'record');
  await expect(page.locator('#rec-event')).toContainText('Point équipe projet Ledona');
  await expect(page.locator('#rec-event')).toContainText('2 participants');
  await page.locator('#rec-main').click();
  await expect.poll(() => page.evaluate(() => window.__app.recorderState())).toBe('recording');
  await page.waitForTimeout(1500);
  await page.locator('#rb-stop').click();
  await expect.poll(() => page.evaluate(() => window.__app.recorderState()), { timeout: 15_000 }).toBe('idle');
  // Fin de l'enregistrement (la transcription finale ne peut pas se faire ici : modèles bloqués)
  await expect.poll(() => page.evaluate(async () => (await window.__app.History.list())[0]?.status), { timeout: 20_000 }).not.toMatch(/live|running/);
  const doc = await page.evaluate(async () => (await window.__app.History.list())[0]);
  expect(doc.title).toBe('Point équipe projet Ledona');
  expect(doc.event.attendees.map((a) => a.email)).toEqual(['julie.martin@exemple.fr', 'marc.dubois@exemple.fr']);
  expect(doc.event.joinUrl).toMatch(/teams/);
  expect(doc.event).not.toHaveProperty('description'); // seul l'essentiel est gardé
  // Le calendrier propose maintenant d'ouvrir la transcription
  await nav(page, 'calendar');
  await expect(ev.locator('[data-open-doc]')).toBeVisible();
});

test('sans réunion choisie : l’enregistrement se relie à la réunion en cours', async ({ page }) => {
  await page.addInitScript(() => { localStorage.setItem('transcripteur.auto', '0'); localStorage.setItem('transcripteur.capture', 'mic'); });
  await page.route(/huggingface\.co|hf\.co/, (r) => r.abort());
  await boot(page);
  await importIcs(page, 3);
  // Le direct (et donc la vue « texte » avec son bouton Arrêter) attend la détection du matériel :
  // sous charge elle peut être lente, on l'attend pour ne pas enregistrer sans direct.
  await expect.poll(() => page.evaluate(() => !!window.__app.state.caps), { timeout: 30_000 }).toBe(true);
  await page.locator('#dash-new').evaluate((b) => b.click());
  await page.locator('#rec-main').click();
  await expect(page.locator('body')).toContainText('Enregistrement relié à « Point équipe projet Ledona »');
  await page.locator('#rb-stop').click();
  await expect.poll(() => page.evaluate(async () => (await window.__app.History.list())[0]?.event?.title), { timeout: 15_000 }).toBe('Point équipe projet Ledona');
});

test('« Ne pas relier » annule la réunion choisie', async ({ page }) => {
  await boot(page);
  await importIcs(page, 120);
  await page.locator('.cal-ev [data-rec-ev]').first().click();
  await page.locator('#rec-event [data-cancel-event]').click();
  await expect(page.locator('#rec-event')).toBeHidden();
  expect(await page.evaluate(() => window.__app.state.pendingEvent)).toBeNull();
});

test('rappel 2 minutes avant une réunion', async ({ page }) => {
  await page.clock.install();
  await boot(page);
  await importIcs(page, 2.5);
  await page.clock.runFor(70_000);
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('transcripteur.notifs') || '[]').map((n) => n.title))).toContain('Ta réunion commence : Point équipe projet Ledona');
});

/** Faux Microsoft : page de connexion (renvoie directement vers l'appli), jetons, Graph. */
async function fakeMicrosoft(page, { error = null } = {}) {
  const seen = { token: [], graph: [] };
  await page.route('https://login.microsoftonline.com/common/oauth2/v2.0/authorize**', (route) => {
    const u = new URL(route.request().url());
    const back = `${u.searchParams.get('redirect_uri')}#${error ? `error=${error.code}&error_description=${encodeURIComponent(error.desc)}` : 'code=CODE123'}&state=${u.searchParams.get('state')}`;
    seen.authorize = Object.fromEntries(u.searchParams);
    route.fulfill({ status: 200, contentType: 'text/html', body: `<script>location.replace(${JSON.stringify(back)})</script>` });
  });
  await page.route('https://login.microsoftonline.com/common/oauth2/v2.0/token', (route) => {
    const p = Object.fromEntries(new URLSearchParams(route.request().postData()));
    seen.token.push(p);
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ access_token: 'AT', refresh_token: 'RT', expires_in: 3600, token_type: 'Bearer' }) });
  });
  await page.route('https://graph.microsoft.com/**', (route) => {
    const u = new URL(route.request().url());
    seen.graph.push({ path: u.pathname, auth: route.request().headers().authorization, prefer: route.request().headers().prefer });
    if (u.pathname.endsWith('/me')) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ displayName: 'Rafael Jeantin', mail: 'Rafael@exemple.fr' }) });
    const s = new Date(Date.now() + 3600000);
    const iso = (d) => d.toISOString().replace('Z', '0000');
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ value: [
      { id: 'g1', subject: 'Revue de synthèse BIM', start: { dateTime: iso(s), timeZone: 'UTC' }, end: { dateTime: iso(new Date(+s + 5400000)), timeZone: 'UTC' }, isOnlineMeeting: true, onlineMeeting: { joinUrl: 'https://teams.microsoft.com/l/meetup-join/g1' }, attendees: [{ emailAddress: { name: 'Julie Martin', address: 'julie@exemple.fr' }, status: { response: 'accepted' } }], organizer: { emailAddress: { name: 'Rafael Jeantin', address: 'rafael@exemple.fr' } }, location: { displayName: 'Microsoft Teams Meeting' } },
      { id: 'g2', subject: 'Réunion annulée', isCancelled: true, start: { dateTime: iso(s), timeZone: 'UTC' }, end: { dateTime: iso(s), timeZone: 'UTC' } },
    ] }) });
  });
  return seen;
}

test('Outlook : identifiant de l’appli, connexion Microsoft (PKCE), agenda lu', async ({ page }) => {
  const seen = await fakeMicrosoft(page);
  await boot(page);
  await nav(page, 'calendar');
  await expect(page.locator('.cal-guide')).toHaveAttribute('open', '');
  await page.fill('#cal-client', 'pas-un-id');
  await page.locator('[data-cal="save-client"]').click();
  await expect(page.locator('body')).toContainText('ressemble à');
  await page.fill('#cal-client', '11111111-2222-3333-4444-555555555555');
  await page.locator('[data-cal="save-client"]').click();
  await page.locator('[data-cal="connect"]').click();
  // Retour dans l'appli, agenda affiché
  await page.waitForFunction(() => window.__appBoot);
  await expect(page.locator('body')).toHaveAttribute('data-page', 'calendar');
  await expect(page.locator('.cal-ev', { hasText: 'Revue de synthèse BIM' })).toBeVisible();
  await expect(page.locator('.cal-ev', { hasText: 'Réunion annulée' })).toHaveCount(0);
  await expect(page.locator('.cal-src')).toContainText('rafael@exemple.fr');
  expect(page.url()).not.toContain('code=');
  // Requêtes : PKCE, lecture seule, en UTC
  expect(seen.authorize.code_challenge_method).toBe('S256');
  expect(seen.authorize.scope).toContain('Calendars.Read');
  expect(seen.authorize.scope).not.toMatch(/ReadWrite/);
  expect(seen.token[0].code_verifier.length).toBeGreaterThan(40);
  expect(seen.token[0].code).toBe('CODE123');
  const cv = seen.graph.find((g) => g.path.endsWith('/calendarView'));
  expect(cv.auth).toBe('Bearer AT');
  expect(cv.prefer).toContain('outlook.timezone="UTC"');
  // La connexion Google (même adresse de retour) n'a pas été dérangée
  await expect(page.locator('body')).not.toContainText('Réponse de Google inattendue');
});

test('Outlook : accord de l’administrateur requis → explication et solution de secours', async ({ page }) => {
  await fakeMicrosoft(page, { error: { code: 'access_denied', desc: 'AADSTS65001: The user or administrator has not consented to use the application' } });
  await page.addInitScript(() => localStorage.setItem('transcripteur.outlook.client', '11111111-2222-3333-4444-555555555555'));
  await boot(page);
  await nav(page, 'calendar');
  await page.locator('[data-cal="connect"]').click();
  await page.waitForFunction(() => window.__appBoot);
  await expect(page.locator('body')).toContainText('service informatique');
  await expect(page.locator('body')).toContainText('importe un fichier .ics');
});

test('« Qui parle ? » propose les participants de la réunion comme noms', async ({ page }) => {
  await boot(page);
  await page.evaluate(async () => {
    const d = { id: 'ev1', title: 'Point Ledona', createdAt: Date.now(), durationS: 60, status: 'done', segments: [{ text: 'Bonjour.', start: 0, end: 2, spk: 0 }, { text: 'Salut.', start: 3, end: 5, spk: 1 }], speakers: [{ name: 'Personne 1' }, { name: 'Personne 2' }],
      event: { id: 'x', title: 'Point Ledona', start: Date.now(), end: Date.now() + 3600000, attendees: [{ name: 'Julie Martin', email: 'julie@x.fr' }, { name: 'marc.dubois@x.fr', email: 'marc.dubois@x.fr' }], organizer: { name: 'Raf Jeantin', email: 'raf@x.fr' } } };
    await window.__app.History.put(d);
    await window.__app.showDoc(d);
  });
  await expect(page.locator('#spk-names option')).toHaveCount(3);
  expect(await page.locator('#spk-names option').evaluateAll((o) => o.map((x) => x.value))).toEqual(['Julie Martin', 'Marc Dubois', 'Raf Jeantin']);
  await expect(page.locator('#spk-list input.spk-name').first()).toHaveAttribute('list', 'spk-names');
});
