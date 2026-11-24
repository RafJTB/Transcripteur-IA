// Outils communs aux tests navigateur.
import { test as base, expect } from '@playwright/test';

// Messages sans rapport avec l'appli (moteur ONNX, bibliothèques externes)
const NOISE = /onnxruntime|ort-wasm|Some nodes were not assigned/;

/**
 * Page de test : thème fixé, erreurs JavaScript relevées (le test échoue s'il y en a).
 * `boot(page)` ouvre l'appli et attend qu'elle soit prête.
 */
export const test = base.extend({
  page: async ({ page }, use) => {
    const errors = [];
    page.on('pageerror', (e) => { if (!NOISE.test(e.message)) errors.push(e.message); });
    await page.addInitScript(() => {
      if (!localStorage.getItem('transcripteur.theme')) localStorage.setItem('transcripteur.theme', 'dark');
      localStorage.setItem('transcripteur.autospk', '0');
    });
    // Politique de sécurité du contenu : toute ressource bloquée fait échouer le test
    const csp = [];
    page.on('console', (m) => { if (/Content Security Policy|Refused to (load|connect|execute|apply|frame)/i.test(m.text())) csp.push(m.text().slice(0, 300)); });
    page.errors = errors;
    await use(page);
    expect(errors, 'erreurs JavaScript dans la page').toEqual([]);
    expect(csp, 'ressources bloquées par la politique de sécurité (CSP)').toEqual([]);
  },
});
export { expect };

export async function boot(page, path = '/') {
  await page.goto(path);
  await page.waitForFunction(() => window.__appBoot && window.__app, null, { timeout: 30_000 });
}

/** Va sur une page de l'appli (bouton de navigation). */
export async function nav(page, name) {
  await page.evaluate((n) => document.querySelector(`[data-nav="${n}"]`).click(), name);
  const PAGE_OF = { projects: 'history' };
  await expect(page.locator('body')).toHaveAttribute('data-page', PAGE_OF[name] || name);
}

const DAY = 86400000;
/** Réunions d'exemple, enregistrées dans l'historique de l'appli. */
export async function seedMeetings(page) {
  await page.evaluate(async (DAY) => {
    const now = Date.now();
    const mk = (id, title, ago, names, texts, extra = {}) => ({
      id, title, createdAt: now - ago * DAY, durationS: texts.length * 60, status: 'done',
      segments: texts.map((text, i) => ({ text, start: i * 60, end: i * 60 + 55, spk: i % names.length, conf: 0.9 })),
      speakers: names.map((name) => ({ name })), ...extra,
    });
    const docs = [
      mk('d1', 'Point équipe projet Ledona', 1, ['Raf', 'Julie', 'Marc'], [
        'Bonjour, on fait le point sur Ledona.',
        'Pour Ledona, on valide le scan 3D intérieur, il est complet.',
        'Il faut intégrer les données du scan dans Revit avant vendredi.',
        'Julie, tu peux t’en charger ?',
        'Oui, je m’en occupe.',
        'On part sur des familles BIM génériques pour les menuiseries.',
        'Marc va relancer le BET fluides pour les diamètres des réseaux.',
      ]),
      mk('d2', 'Réunion chantier – Lot Gros Œuvre', 3, ['Raf', 'Marc'], [
        'Le coulage de la dalle du R+2 est prévu lundi.',
        'Il faut vérifier la livraison de la grue.',
        'C’est validé pour le planning du chantier.',
      ]),
    ];
    for (const d of docs) await window.__app.History.put(d);
  }, DAY);
}
