// Vérification (seconde écoute), avec une seconde écoute simulée : bandeau, corrections, doutes, annulation.
import { test, expect, boot } from './helpers.js';

/** Réunion avec audio (WAV de 30 s) et des phrases plus ou moins sûres. */
async function seed(page, extra = {}) {
  await page.evaluate(async (extra) => {
    const sr = 16000, n = sr * 30, ab = new ArrayBuffer(44 + n * 2), v = new DataView(ab);
    const w = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
    w(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); w(8, 'WAVEfmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, sr, true); v.setUint32(28, sr * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, n * 2, true);
    for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, Math.sin(i / 9) * 6000, true);
    await window.__app.Audios.put({ id: 'aud-v', blob: new Blob([ab], { type: 'audio/wav' }), name: 'reunion.wav', durationS: 30, createdAt: Date.now() });
    const d = {
      id: 'dv', title: 'Point Ledona', createdAt: Date.now(), durationS: 30, status: 'done', audioId: 'aud-v', modelId: 'base', model: 'Whisper Base', language: 'fr',
      segments: [
        { text: 'Bonjour à tous.', start: 0, end: 3, conf: 0.95, spk: 0 },
        { text: 'Il faut intégré le scanne dans revite.', start: 3, end: 8, conf: 0.42, spk: 0 }, // sera corrigée
        { text: 'Julie s’en occupe.', start: 8, end: 11, conf: 0.9, spk: 1 },
        { text: 'Le budget est valider.', start: 12, end: 16, conf: 0.5, spk: 1 }, // les deux écoutes concordent
        { text: 'On en reparle demain.', start: 16, end: 18, conf: 0.92, spk: 1 },
        { text: 'La grue arrive mardi.', start: 18, end: 23, conf: 0.4, spk: 0 }, // désaccord
        { text: 'Merci à tous.', start: 24, end: 27, conf: 0.93, spk: 0 },
      ],
      speakers: [{ name: 'Raf' }, { name: 'Julie' }],
      ...extra,
    };
    await window.__app.History.put(d);
    await window.__app.showDoc(d);
  }, extra);
}

/** Seconde écoute simulée : réponses selon le passage réécouté. */
async function fakeSecondListen(page) {
  await page.evaluate(() => {
    window.__heard = [];
    window.__verifyTranscribe = async ({ start, end, text }) => {
      window.__heard.push([start, end]);
      await new Promise((r) => setTimeout(r, 60));
      if (/scan/i.test(text)) return { segments: [{ text: 'Il faut intégrer le scan dans Revit.', start: 3.1, end: 7.9, conf: 0.88 }] };
      if (/budget/.test(text)) return { segments: [{ text: 'Le budget est validé.', start: 12, end: 16, conf: 0.55 }] };
      if (/grue/.test(text)) return { segments: [{ text: 'La grue arrive jeudi.', start: 18, end: 23, conf: 0.43 }] };
      return { segments: [] };
    };
  });
}

test('vérifier : passages douteux réécoutés, corrigé / à vérifier / validé, bandeau et marques', async ({ page }) => {
  await boot(page);
  await seed(page);
  await fakeSecondListen(page);
  const bar = page.locator('#verify-bar');
  await expect(bar).toContainText('passages douteux');
  await bar.locator('[data-v="quick"]').click();
  await expect(bar).toContainText('Vérifiée');
  await expect(bar).toContainText('1 corrigé');
  await expect(bar).toContainText('1 à vérifier');
  // Seuls les passages douteux ont été réécoutés (élargis à ≥ 4 s)
  const heard = await page.evaluate(() => window.__heard);
  expect(heard.length).toBe(3);
  expect(heard.every(([a, b]) => b - a >= 4)).toBe(true);
  // Texte : correction appliquée (même intervenant), phrase d'accord validée, désaccord gardé
  const d = await page.evaluate(() => window.__app.History.get('dv'));
  expect(d.segments.map((s) => s.text)).toContain('Il faut intégrer le scan dans Revit.');
  expect(d.segments.find((s) => /Revit/.test(s.text)).spk).toBe(0);
  expect(d.segments.find((s) => /budget/.test(s.text)).text).toBe('Le budget est valider.'); // accord : inchangé
  expect(d.segments.find((s) => /grue/.test(s.text)).text).toBe('La grue arrive mardi.');
  await expect(page.locator('.segment.vfix .vmark')).toHaveText('corrigé');
  await expect(page.locator('.segment.vcheck .vmark')).toHaveText('à vérifier');
  await expect(page.locator('.segment.vok')).not.toHaveCount(0);
  // En-tête : seuls les passages encore douteux sont comptés
  await expect(page.locator('#result-meta')).toContainText('1 à vérifier');
});

test('annuler une correction, prendre la seconde écoute, garder', async ({ page }) => {
  await boot(page);
  await seed(page);
  await fakeSecondListen(page);
  await page.locator('#verify-bar [data-v="quick"]').click();
  await expect(page.locator('#verify-bar')).toContainText('Vérifiée');
  // Correction : avant / après, puis annulation
  await page.locator('.segment.vfix .vmark').click();
  const pop = page.locator('#v-pop');
  await expect(pop).toContainText('Il faut intégré le scanne dans revite.');
  await expect(pop).toContainText('Confiance : 42 % → 88 %');
  await pop.locator('[data-vp="undo"]').click();
  await expect(page.locator('#transcript')).toContainText('Il faut intégré le scanne dans revite.');
  await expect(page.locator('.segment.vfix')).toHaveCount(0);
  // Désaccord : prendre la seconde écoute
  await page.locator('.segment.vcheck .vmark').click();
  await expect(page.locator('#v-pop')).toContainText('La grue arrive jeudi.');
  await page.locator('#v-pop [data-vp="take"]').click();
  await expect(page.locator('#transcript')).toContainText('La grue arrive jeudi.');
  await expect(page.locator('#verify-bar')).toContainText('1 corrigé');
  await expect(page.locator('#verify-bar')).toContainText('0 à vérifier');
  const d = await page.evaluate(() => window.__app.History.get('dv'));
  expect(d.segments.find((s) => /grue/.test(s.text)).text).toBe('La grue arrive jeudi.');
  expect(d.verify.changes).toHaveLength(1);
  expect(d.verify.doubts).toHaveLength(0);
});

test('tout réécouter, phrases corrigées à la main intouchables, arrêt possible', async ({ page }) => {
  await boot(page);
  await seed(page);
  await page.evaluate(async () => {
    const d = await window.__app.History.get('dv');
    d.segments[1].edited = true; // corrigée à la main
    await window.__app.History.put(d);
    await window.__app.showDoc(d);
  });
  await fakeSecondListen(page);
  await page.locator('#verify-bar [data-v="full"]').click();
  await expect(page.locator('#verify-bar')).toContainText('tout le texte');
  const heard = await page.evaluate(() => window.__heard);
  expect(heard.some(([a, b]) => a <= 4 && b >= 7)).toBe(false); // la phrase corrigée à la main n'est pas réécoutée
  const d = await page.evaluate(() => window.__app.History.get('dv'));
  expect(d.segments[1].text).toBe('Il faut intégré le scanne dans revite.');
});

test('vérification automatique à la fin d’une transcription (modèle déjà téléchargé)', async ({ page }) => {
  await boot(page);
  await expect(page.locator('#toggle-verify')).toBeChecked();
  // Le choix du modèle de vérification dépend du matériel détecté (plus lent sur les serveurs d'intégration)
  await page.waitForFunction(() => window.__app.state.caps, null, { timeout: 60_000 });
  await seed(page, { status: 'running', job: { modelId: 'base', language: 'fr', fromS: 0, baseSegments: [], seqs: [], total: null } });
  await fakeSecondListen(page);
  await page.evaluate(async () => {
    const st = window.__app.state;
    const m = ['small', 'turbo', 'base'].find(Boolean);
    st.cache = { ...(st.cache || {}), small: true, turbo: true };
    const d = await window.__app.History.get('dv');
    d.job.baseSegments = d.segments;
    window.__app.finalizeDoc(d, []);
    void m;
  });
  await expect(page.locator('#verify-bar')).toContainText('Vérifiée', { timeout: 15_000 });
  await expect(page.locator('#verify-bar')).toContainText('1 corrigé');
});
