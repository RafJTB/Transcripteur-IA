// Assistant : type de demande, choix des extraits, messages pour le modèle, mise en forme de la réponse.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { taskOf, isFollowUp, buildContext, buildMessages, renderAnswer, citedRefs, SYSTEM_PROMPT, TASKS } from '../../js/assistant.js';

const DAY = 86400000;
const NOW = new Date('2026-11-20T10:00:00').getTime();

/** Réunion de test : une phrase par segment, intervenants en alternance. */
function meeting(id, title, texts, { ago = 1, names = ['Raf', 'Julie'], step = 20, summary } = {}) {
  return {
    id, title, createdAt: NOW - ago * DAY, durationS: texts.length * step,
    segments: texts.map((text, i) => ({ text, start: i * step, end: i * step + step - 1, spk: i % names.length })),
    speakers: names.map((name) => ({ name })),
    ...(summary ? { summary } : {}),
  };
}
const ledona = meeting('d1', 'Point équipe projet Ledona', [
  'Bonjour, on fait le point sur Ledona.',
  'Pour Ledona, on valide le scan 3D intérieur, il est complet.',
  'Il faut intégrer les données du scan dans Revit avant vendredi.',
  'Julie, tu peux t’en charger ?',
  'Oui, je m’en occupe.',
  'On part sur des familles BIM génériques pour les menuiseries.',
]);
const chantier = meeting('d2', 'Réunion chantier Gros Œuvre', ['Le coulage de la dalle du R+2 est prévu lundi.', 'Il faut vérifier la livraison de la grue.'], { ago: 3 });
const src = (docs) => docs.map((doc) => ({ doc, items: [] }));

test('taskOf reconnaît le type de demande', () => {
  const cases = {
    'Questionne-moi sur ce dossier': 'quiz',
    'Peux-tu me poser des questions sur la réunion Ledona ?': 'quiz',
    'pose moi 5 questions': 'quiz',
    'teste-moi': 'quiz',
    'fais moi réviser le dossier': 'quiz',
    'Résume ma dernière réunion': 'summary',
    'fais le point sur le chantier': 'summary',
    'Rédige un mail à Julie pour le planning': 'draft',
    'Quelles décisions cette semaine ?': 'list',
    'Quelles actions restent à faire ?': 'list',
    'Qui gère le lot CVC ?': 'qa',
  };
  for (const [q, t] of Object.entries(cases)) assert.equal(taskOf(q), t, q);
});

test('isFollowUp : réponses de quiz et relances', () => {
  assert.equal(isFollowUp("C'est Julie qui gère", 'quiz'), true);
  assert.equal(isFollowUp('je ne sais pas', 'quiz'), true);
  assert.equal(isFollowUp('stop', 'quiz'), false, 'arrêter le quiz');
  assert.equal(isFollowUp('Résume la réunion', 'quiz'), false, 'nouvelle demande explicite');
  assert.equal(isFollowUp('pourquoi ?', 'qa'), true);
  assert.equal(isFollowUp('développe le deuxième point', 'qa'), true);
  assert.equal(isFollowUp('quel est le budget du lot plomberie validé lundi', 'qa'), false);
});

test('buildContext : question précise → passages trouvés, cités avec la réunion', () => {
  const r = buildContext('Quand faut-il intégrer le scan dans Revit ?', src([ledona, chantier]), { now: NOW });
  assert.equal(r.task, 'qa');
  assert.ok(r.hits > 0);
  assert.ok(r.refs.some((x) => /Revit/.test(x.text)));
  assert.match(r.context, /\[R1\]/);
  assert.match(r.context, /Point équipe projet Ledona/);
  assert.match(r.context, /Périmètre : toutes les réunions/);
});

test('buildContext : quiz sur un dossier → aperçu réparti de toute la réunion + périmètre nommé', () => {
  const texts = Array.from({ length: 120 }, (_, i) => `Phrase ${i} sur le lot ${i % 5}.`);
  const long = meeting('d3', 'Synthèse Ledona', texts, { summary: 'Lancement du scan 3D.' });
  const r = buildContext('questionne-moi sur ce dossier', src([long]), { budget: 5000, scoped: true, scopeLabel: 'Ledona', now: NOW });
  assert.equal(r.task, 'quiz');
  assert.equal(r.refs[0].type, 'resume', 'le résumé écrit vient en premier');
  const starts = r.refs.filter((x) => x.type === 'extrait').map((x) => x.start);
  assert.ok(starts[0] === 0, 'début de la réunion');
  assert.ok(Math.max(...starts) > texts.length * 20 * 0.8, 'jusqu’à la fin de la réunion');
  assert.match(r.context, /Périmètre choisi par l'utilisateur : « Ledona »/);
  assert.ok(r.context.length < 5000 + 1500, 'budget respecté');
});

test('buildContext : « ma dernière réunion » vise la plus récente', () => {
  const r = buildContext('Résume ma dernière réunion', src([chantier, ledona]), { now: NOW });
  assert.ok(r.refs.length > 0);
  assert.ok(r.refs.every((x) => x.doc.id === 'd1'));
});

test('buildContext : réunion nommée dans la question', () => {
  const r = buildContext('Fais une synthèse de la réunion chantier', src([ledona, chantier]), { now: NOW });
  assert.ok(r.refs.every((x) => x.doc.id === 'd2'));
});

test('buildMessages : extraits + consigne de la tâche dans la question (modèle local)', () => {
  const m = buildMessages('Questionne-moi', 'EXTRAITS', [], { task: 'quiz' });
  assert.equal(m[0].role, 'system');
  assert.equal(m[0].content, SYSTEM_PROMPT);
  assert.equal(m.length, 2);
  assert.match(m[1].content, /^EXTRAITS/);
  assert.ok(m[1].content.includes(TASKS.quiz));
});

test('buildMessages : extraits dans la consigne système (Claude) et historique', () => {
  const hist = [{ q: 'Q1', a: 'Réponse [R1].' }, { q: 'Q2', a: 'Autre [R2, R3].' }];
  const m = buildMessages('Q3', 'EXTRAITS', hist, { contextInSystem: true, task: 'qa' });
  assert.match(m[0].content, /<extraits>\nEXTRAITS\n<\/extraits>/);
  assert.deepEqual(m.map((x) => x.role), ['system', 'user', 'assistant', 'user', 'assistant', 'user']);
  assert.equal(m.at(-1).content, 'Q3');
  assert.equal(m[2].content, 'Réponse.', 'renvois retirés quand les extraits changent');
  const kept = buildMessages('Q3', 'X', hist, { contextInSystem: true, keepRefs: true });
  assert.equal(kept[2].content, 'Réponse [R1].');
  const short = buildMessages('Q3', 'X', hist, { maxTurns: 1 });
  assert.equal(short.length, 4, 'un seul échange gardé');
});

test('renderAnswer : listes, gras et sources cliquables', () => {
  const refs = [{ n: 1, doc: { id: 'd1', title: 'Réunion' }, i: 2, start: 65, text: 't' }, { n: 2, doc: { id: 'd1', title: 'Réunion' }, i: 4, start: 90, text: 't' }];
  const html = renderAnswer('**Points** clés :\n- Scan validé [R1]\n- Revit [R1, R2]\n<script>', refs);
  assert.match(html, /<b>Points<\/b>/);
  assert.match(html, /<ul><li>/);
  assert.equal((html.match(/class="src"/g) || []).length, 3);
  assert.match(html, /title="Réunion · 01:05"/);
  assert.ok(!html.includes('<script>'), 'texte échappé');
});

test('citedRefs : sources citées, ou repli', () => {
  const refs = [1, 2, 3].map((n) => ({ n, doc: { id: 'd' }, text: String(n) }));
  assert.deepEqual(citedRefs('Voir [R3] et [Source R2]', refs).map((r) => r.n), [3, 2]);
  assert.deepEqual(citedRefs('Sans source', refs).map((r) => r.n), [1, 2]);
  assert.deepEqual(citedRefs('Sans source', refs, 4, false), [], 'quiz : pas de repli');
});
