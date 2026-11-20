// Assistant : recherche simple, Claude (serveur simulé), périmètre (dossier ou réunion).
import { test, expect, boot, seedMeetings } from './helpers.js';

async function ask(page, q) {
  const n = await page.locator('#chat .msg.bot').count();
  await page.fill('#chat-input', q);
  await page.press('#chat-input', 'Enter');
  await expect(page.locator('#chat .msg.bot')).toHaveCount(n + 1);
  await expect(page.locator('#chat-form')).not.toHaveClass(/busy/);
  return page.locator('#chat .msg.bot .bubble').last();
}

/** Faux serveur Claude : répond en flux (SSE) et garde les requêtes reçues. */
async function fakeClaude(page, replies) {
  const bodies = [];
  await page.route('https://api.anthropic.com/**', (route) => {
    const body = JSON.parse(route.request().postData());
    bodies.push(body);
    const text = replies[Math.min(bodies.length - 1, replies.length - 1)];
    const ev = (t, d) => `event: ${t}\ndata: ${JSON.stringify(d)}\n\n`;
    route.fulfill({
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
      body: ev('message_start', { type: 'message_start', message: { id: `m${bodies.length}`, type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 0 } } })
        + ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
        + ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })
        + ev('content_block_stop', { type: 'content_block_stop', index: 0 })
        + ev('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 20 } })
        + ev('message_stop', { type: 'message_stop' }),
    });
  });
  return bodies;
}

test('recherche simple : trouve l’action et ouvre le passage', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('assistant.engine', 'search'));
  await boot(page);
  await seedMeetings(page);
  const b = await ask(page, 'Qui doit intégrer le scan dans Revit ?');
  await expect(b).toContainText('Revit');
  await b.locator('[data-open="d1"]').first().click();
  await expect.poll(() => page.evaluate(() => window.__app.state.doc?.id)).toBe('d1');
});

test('recherche simple : une demande de quiz renvoie les décisions récentes et explique pourquoi', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('assistant.engine', 'search'));
  await boot(page);
  await seedMeetings(page);
  const b = await ask(page, 'Questionne-moi sur ces réunions');
  await expect(b).toContainText('demande un modèle de langage');
  await expect(b.locator('.chat-hits li').first()).toBeVisible();
  await expect(b).not.toContainText('${', { useInnerText: true });
});

test('Claude : quiz en deux tours, extraits en cache, historique transmis', async ({ page }) => {
  await page.addInitScript(() => { localStorage.setItem('assistant.engine', 'claude'); localStorage.setItem('assistant.key', 'sk-ant-test'); });
  const bodies = await fakeClaude(page, [
    'Question 1 : qui doit intégrer les données du scan dans Revit, et pour quand ?',
    'Juste ! C’est Julie, avant vendredi [R3]. Score : 1/1. Question 2 : quelle solution pour les menuiseries ?',
  ]);
  await boot(page);
  await seedMeetings(page);
  const b1 = await ask(page, 'Questionne-moi sur ces réunions');
  await expect(b1).toContainText('Question 1');
  await expect(b1.locator('.chat-src')).toHaveCount(0); // pas de source qui donnerait la réponse
  const b2 = await ask(page, 'C’est Julie, avant vendredi');
  await expect(b2).toContainText('Score : 1/1');
  await expect(b2.locator('.src')).toHaveCount(1);

  expect(bodies).toHaveLength(2);
  const [r1, r2] = bodies;
  expect(r1.model).toBe('claude-opus-5-5');
  expect(r1.output_config).toEqual({ effort: 'medium' });
  expect(r1.cache_control).toEqual({ type: 'ephemeral' });
  expect(r1.system).toContain('<extraits>');
  expect(r1.system).toContain('scan 3D');
  expect(r2.system).toBe(r1.system); // mêmes extraits : le cache sert au 2e tour
  expect(r2.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
  expect(r2.messages.at(-1).content).toContain('C’est Julie');
});

test('Claude : clé refusée → message clair', async ({ page }) => {
  await page.addInitScript(() => { localStorage.setItem('assistant.engine', 'claude'); localStorage.setItem('assistant.key', 'sk-ant-mauvaise'); });
  await page.route('https://api.anthropic.com/**', (r) => r.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }) }));
  await boot(page);
  await seedMeetings(page);
  const b = await ask(page, 'Qui gère Revit ?');
  await expect(b.locator('.chat-err')).toContainText('Clé API Claude refusée');
});

test('périmètre : choisir une réunion limite les extraits à celle-ci', async ({ page }) => {
  await page.addInitScript(() => { localStorage.setItem('assistant.engine', 'claude'); localStorage.setItem('assistant.key', 'sk-ant-test'); });
  const bodies = await fakeClaude(page, ['Réponse.']);
  await boot(page);
  await seedMeetings(page);
  await page.locator('#asst-scope').click();
  await page.locator('#sp-search').fill('chantier');
  await page.locator('#sp-list [data-scope="doc"]').first().click();
  await expect(page.locator('#asst-scope')).toContainText('Gros Œuvre');
  await ask(page, 'Résume cette réunion');
  expect(bodies[0].system).toContain('« Réunion chantier – Lot Gros Œuvre » (1 réunion)');
  expect(bodies[0].system).toContain('dalle du R+2');
  expect(bodies[0].system).not.toContain('scan 3D');
});
