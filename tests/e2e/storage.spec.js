// Où garder l'audio : question à chaque audio, choix par défaut, effacement, Google Drive (faux).
import { test, expect, boot, nav } from './helpers.js';
import { fakeDrive } from './mocks/drive.js';

test.use({
  launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] },
  permissions: ['microphone'],
});

const signedIn = () => {
  localStorage.setItem('transcripteur.cloud.user', JSON.stringify({ email: 'raf@exemple.fr', name: 'Raf', picture: '' }));
  sessionStorage.setItem('transcripteur.cloud.token', JSON.stringify({ value: 'faux', exp: Date.now() + 3600e3 }));
};

async function record(page) {
  await page.route(/huggingface\.co|hf\.co/, (r) => r.abort());
  await page.addInitScript(() => { localStorage.setItem('transcripteur.auto', '0'); localStorage.setItem('transcripteur.capture', 'mic'); });
  await boot(page);
  await page.locator('#dash-new').click();
  await page.locator('#rec-main').click();
  await expect.poll(() => page.evaluate(() => window.__app.recorderState())).toBe('recording');
  await page.waitForTimeout(1500);
  await page.locator('#rb-stop').click();
}

/** Réunion terminée avec son audio (pour tester sans transcription réelle). */
async function seedDoc(page, id, extra = {}) {
  await page.evaluate(async ({ id, extra }) => {
    await window.__app.Audios.put({ id: `aud-${id}`, blob: new Blob([new Uint8Array(4000)], { type: 'audio/webm' }), name: `audio ${id}`, durationS: 60, createdAt: Date.now() });
    await window.__app.History.put({ id, title: `Réunion ${id}`, createdAt: Date.now(), durationS: 60, status: 'done', audioId: `aud-${id}`, owner: 'raf@exemple.fr', segments: [{ text: 'Bonjour.', start: 0, end: 1 }], ...extra });
  }, { id, extra });
}

test('à l’arrêt d’un enregistrement : la question est posée, « Sur ce PC » est gardé', async ({ page }) => {
  await record(page);
  const box = page.locator('.store-box');
  await expect(box).toBeVisible();
  await expect(box.locator('[data-where]')).toHaveCount(3);
  await expect(box.locator('[data-where="drive"]')).toBeDisabled(); // pas connecté à Google
  await expect(box).toContainText('Connecte-toi d’abord avec Google');
  await box.locator('[data-where="local"]').click();
  await expect(box).toBeHidden();
  await expect.poll(() => page.evaluate(async () => (await window.__app.History.list())[0]?.audioWhere)).toBe('local');
  await expect(page.locator('#result-meta .store-chip')).toHaveText('Audio sur ce PC');
});

test('choix par défaut « ne jamais garder » : pas de question, audio effacé à la fin de la transcription', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('transcripteur.audio.where', 'none'));
  await boot(page);
  await expect(page.locator('#audio-policy')).toHaveValue('none');
  await seedDoc(page, 'n1', { status: 'running', job: { modelId: 'base', language: 'fr', fromS: 0, baseSegments: [{ text: 'Bonjour.', start: 0, end: 1 }], seqs: [], total: null }, audioWhere: 'none' });
  await page.evaluate(async () => {
    const d = await window.__app.History.get('n1');
    window.__app.state.autoSpk = false;
    window.__app.finalizeDoc(d, []);
  });
  await expect.poll(() => page.evaluate(() => window.__app.Audios.get('aud-n1').then((a) => !!a))).toBe(false);
  const d = await page.evaluate(() => window.__app.History.get('n1'));
  expect(d.audioId).toBeNull();
  expect(d.segments.length).toBe(1); // le texte reste
  await expect(page.locator('#result-meta .store-chip')).toHaveText('Audio non gardé');
});

test('fichier importé : question avant la transcription, Échap = sur ce PC', async ({ page }) => {
  await page.route(/huggingface\.co|hf\.co/, (r) => r.abort());
  await boot(page);
  await page.locator('#dash-new').click();
  await page.locator('[data-tab="file"]').click();
  const sr = 16000, n = sr * 2, ab = Buffer.alloc(44 + n * 2);
  ab.write('RIFF', 0); ab.writeUInt32LE(36 + n * 2, 4); ab.write('WAVEfmt ', 8); ab.writeUInt32LE(16, 16); ab.writeUInt16LE(1, 20); ab.writeUInt16LE(1, 22); ab.writeUInt32LE(sr, 24); ab.writeUInt32LE(sr * 2, 28); ab.writeUInt16LE(2, 32); ab.writeUInt16LE(16, 34); ab.write('data', 36); ab.writeUInt32LE(n * 2, 40);
  await page.setInputFiles('#file-input', { name: 'client.wav', mimeType: 'audio/wav', buffer: ab });
  await expect.poll(() => page.evaluate(() => !!window.__app.state.audio)).toBe(true);
  await page.locator('#btn-transcribe').click();
  await expect(page.locator('.store-box')).toContainText('« client.wav »');
  await page.keyboard.press('Escape');
  await expect.poll(() => page.evaluate(async () => (await window.__app.History.list())[0]?.audioWhere), { timeout: 20_000 }).toBe('local');
});

test('Google Drive : seuls les audios choisis partent, copie du PC retirée ; changement d’avis par réunion', async ({ page, context }) => {
  const files = await fakeDrive(context);
  await context.addInitScript(signedIn);
  await boot(page);
  await seedDoc(page, 'loc', { audioWhere: 'local' });
  await seedDoc(page, 'drv', { audioWhere: 'drive' });
  await seedDoc(page, 'old'); // avant cette option : comme avant, envoyé
  await page.evaluate(() => window.__app.syncNow());
  const audiosOnDrive = () => [...files.values()].filter((f) => f.appProperties.kind === 'audio').map((f) => f.appProperties.aid).sort();
  await expect.poll(audiosOnDrive).toEqual(['aud-drv', 'aud-old']);
  const local = () => page.evaluate(async () => Promise.all(['aud-loc', 'aud-drv', 'aud-old'].map((id) => window.__app.Audios.get(id).then((a) => !!a))));
  expect(await local()).toEqual([true, false, true]); // « Drive » : plus sur ce PC

  // « Sur ce PC » → « Google Drive » depuis la pastille
  await page.evaluate(() => window.__app.History.get('loc').then((d) => window.__app.showDoc(d)));
  await page.locator('#result-meta .store-chip').click();
  await page.locator('#store-pop [data-pick="drive"]').click();
  await page.evaluate(() => window.__app.syncNow());
  await expect.poll(audiosOnDrive).toEqual(['aud-drv', 'aud-loc', 'aud-old']);
  expect((await local())[0]).toBe(false);

  // « Google Drive » → « Sur ce PC » : rapatrié, puis retiré du Drive
  await page.evaluate(() => window.__app.History.get('drv').then((d) => window.__app.showDoc(d)));
  await expect(page.locator('#result-meta .store-chip')).toHaveText('Audio sur Google Drive');
  await page.locator('#result-meta .store-chip').click();
  await page.locator('#store-pop [data-pick="local"]').click();
  await expect(page.locator('#result-meta .store-chip')).toHaveText('Audio sur ce PC');
  await page.evaluate(() => window.__app.syncNow());
  await expect.poll(audiosOnDrive).toEqual(['aud-loc', 'aud-old']);
  expect((await local())[1]).toBe(true);

  // « Ne pas garder » : effacé ici et dans le Drive
  await page.evaluate(() => window.__app.History.get('old').then((d) => window.__app.showDoc(d)));
  await page.locator('#result-meta .store-chip').click();
  await page.locator('#store-pop [data-pick="none"]').click();
  await page.locator('#modal-ok').click();
  await expect(page.locator('#result-meta .store-chip')).toHaveText('Audio non gardé');
  await page.evaluate(() => window.__app.syncNow());
  await expect.poll(audiosOnDrive).toEqual(['aud-loc']);
  expect((await local())[2]).toBe(false);
});

test('connecté à Google : « Sur mon Google Drive » proposé, et « Toujours ce choix » retenu', async ({ page, context }) => {
  await fakeDrive(context);
  await context.addInitScript(signedIn);
  await record(page);
  const box = page.locator('.store-box');
  await expect(box.locator('[data-where="drive"]')).toBeEnabled();
  await box.locator('#st-remember').check();
  await box.locator('[data-where="drive"]').click();
  await expect.poll(() => page.evaluate(async () => (await window.__app.History.list())[0]?.audioWhere)).toBe('drive');
  await nav(page, 'settings');
  await expect(page.locator('#audio-policy')).toHaveValue('drive');
});
