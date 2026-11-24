// Enregistrement au micro (faux micro de Chromium) et import d'un fichier audio.
// Le téléchargement des modèles est bloqué : on vérifie que l'audio est gardé et que l'appli reste utilisable.
import { test, expect, boot } from './helpers.js';

test.use({
  launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] },
  permissions: ['microphone'],
});

const blockModels = (page) => page.route(/huggingface\.co|hf\.co/, (r) => r.abort());

/** Petit fichier WAV (bip de 3 s), créé dans la page. */
const makeWav = () => {
  const sr = 16000, n = sr * 3, ab = new ArrayBuffer(44 + n * 2), v = new DataView(ab);
  const w = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  w(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); w(8, 'WAVEfmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sr, true); v.setUint32(28, sr * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, Math.sin(i / 8) * 8000, true);
  return Buffer.from(ab);
};

test('micro : enregistrer puis arrêter garde l’audio dans un projet', async ({ page }) => {
  await page.addInitScript(() => { localStorage.setItem('transcripteur.auto', '0'); localStorage.setItem('transcripteur.capture', 'mic'); localStorage.setItem('transcripteur.live', '0'); });
  await blockModels(page);
  await boot(page);
  await page.locator('#dash-new').click();
  await expect(page.locator('body')).toHaveAttribute('data-page', 'record');
  // Au repos : seul l'orbe est proposé, pas de Pause / Arrêter grisés
  await expect(page.locator('#rec-actions')).toBeHidden();
  await page.locator('#rec-main').click();
  await expect.poll(() => page.evaluate(() => window.__app.recorderState())).toBe('recording');
  await expect(page.locator('#rec-actions')).toHaveJSProperty('hidden', false); // (la vue peut être passée au texte en direct)
  await expect(page.locator('#rec-hero')).toHaveClass(/live/);
  await expect(page.locator('#rec-main')).toHaveClass(/recording/);
  await expect.poll(() => page.evaluate(() => document.querySelector('#rec-hero').style.getPropertyValue('--lvl'))).not.toBe('');
  await page.waitForTimeout(2500);
  // Enregistrement en direct : on passe sur la page de la réunion, avec la barre d'enregistrement
  await expect(page.locator('#rb-time')).not.toHaveText('00:00');
  await page.locator('#rb-stop').click();
  await expect.poll(() => page.evaluate(() => window.__app.recorderState()), { timeout: 15_000 }).toBe('idle');
  // Un projet avec son audio (même si la transcription ne peut pas se faire ici)
  // (l'audio est rangé juste après l'arrêt : on attend qu'il y soit)
  await expect.poll(() => page.evaluate(async () => {
    const docs = await window.__app.History.list();
    const a = docs[0]?.audioId ? await window.__app.Audios.get(docs[0].audioId) : null;
    return `${docs.length} projet, ${a?.blob?.size > 1000 ? 'audio gardé' : 'pas d’audio'}`;
  })).toBe('1 projet, audio gardé');
});

test('fichier : un audio importé est décodé et rangé dans un projet', async ({ page }) => {
  await blockModels(page);
  await boot(page);
  await page.locator('#dash-new').click();
  await page.locator('[data-tab="file"]').click();
  await page.setInputFiles('#file-input', { name: 'reunion-test.wav', mimeType: 'audio/wav', buffer: makeWav() });
  await expect.poll(async () => page.evaluate(() => window.__app.state.audio?.duration ?? window.__app.state.audio?.durationS ?? (window.__app.state.audio ? 1 : 0)), { timeout: 20_000 }).toBeGreaterThan(0);
});

test('page « Nouvelle transcription » : fond d’écran visible, et pas l’audio d’une réunion déjà transcrite', async ({ page }) => {
  await blockModels(page);
  await boot(page);
  await page.locator('#dash-new').click();
  // Fond d'écran : le <body> (qui porte aussi data-page="record") ne doit pas devenir un « conteneur »,
  // sinon le fond n'est plus dessiné derrière la page
  expect(await page.evaluate(() => getComputedStyle(document.body).containerType)).toBe('normal');
  expect(await page.evaluate(() => getComputedStyle(document.querySelector('section[data-page="record"]')).containerType)).toBe('inline-size');

  // Audio importé, pas encore transcrit : il reste là pour cliquer sur « Transcrire »
  await page.locator('[data-tab="file"]').click();
  await page.setInputFiles('#file-input', { name: 'reunion-test.wav', mimeType: 'audio/wav', buffer: makeWav() });
  await expect(page.locator('#audio-card')).toBeVisible();
  await page.locator('[data-tab="mic"]').click();
  await page.locator('section[data-page="record"] .back').click();
  await page.locator('#dash-new').click();
  await expect(page.locator('#audio-card')).toBeVisible();

  // Audio d'une réunion déjà transcrite (ouverte depuis les projets) : page vide
  await page.evaluate(() => { window.__app.state.audio.docId = 'd-deja-transcrite'; });
  await page.locator('section[data-page="record"] .back').click();
  await page.locator('#dash-new').click();
  await expect(page.locator('#audio-card')).toBeHidden();
  expect(await page.evaluate(() => window.__app.state.audio)).toBeNull();
});

test('une seule action à la fois : bouton rouge pour enregistrer, « Transcrire » seulement pour un fichier chargé', async ({ page }) => {
  await blockModels(page);
  await boot(page);
  await page.locator('#dash-new').click();
  // Rien à transcrire : pas de bouton « Transcrire », une indication à la place
  await expect(page.locator('#btn-transcribe')).toBeHidden();
  await expect(page.locator('#go-idle')).toContainText('bouton rouge');
  // Onglet fichier, avant l'import
  await page.locator('[data-tab="file"]').click();
  await expect(page.locator('#go-idle')).toContainText('Importe un fichier');
  await expect(page.locator('#btn-transcribe')).toBeHidden();
  // Fichier chargé : « Transcrire » apparaît, l'indication disparaît
  await page.setInputFiles('#file-input', { name: 'reunion-test.wav', mimeType: 'audio/wav', buffer: makeWav() });
  await expect(page.locator('#btn-transcribe')).toBeVisible();
  await expect(page.locator('#go-idle')).toBeHidden();
});
