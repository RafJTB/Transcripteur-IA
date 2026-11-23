// Vérification : passages à réécouter, comparaison des deux écoutes, intervenants.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normWords, similarity, wordDistance, blockConf, planBlocks, compareBlock, carrySpeakers } from '../../js/verify.js';

const seg = (start, end, text, conf, extra = {}) => ({ start, end, text, conf, ...extra });

test('mots comparables et ressemblance', () => {
  assert.deepEqual(normWords('L’intégration, dans Revit !'), ['l', 'integration', 'dans', 'revit']);
  assert.equal(wordDistance(['a', 'b', 'c'], ['a', 'x', 'c']), 1);
  assert.equal(wordDistance(['budget', 'valider'], ['budget', 'valide']), 0.25, 'une lettre de différence : presque pareil');
  assert.ok(similarity('Le budget est valider.', 'Le budget est validé.') >= 0.85, 'homophones : d’accord');
  assert.equal(similarity('On valide le scan.', 'on valide le scan'), 1);
  assert.ok(similarity('Il faut intégrer le scan dans Revit', 'Il faut intégrer le scan dans revite') > 0.8);
  assert.ok(similarity('Le budget est validé', 'La grue arrive lundi') < 0.3);
});

test('confiance moyenne pondérée par la durée', () => {
  assert.equal(blockConf([seg(0, 1, 'a', 0.4), seg(1, 4, 'b', 0.8)]), (0.4 * 1 + 0.8 * 3) / 4);
  assert.equal(blockConf([seg(0, 1, 'a', null)]), null);
});

test('planBlocks rapide : phrases douteuses, élargies, regroupées ; les corrections à la main sont intouchables', () => {
  const segs = [
    seg(0, 3, 'Bonjour à tous.', 0.9),
    seg(3, 4, 'euh le scan', 0.4), // douteuse, courte → élargie
    seg(4, 6, 'est complet.', 0.85),
    seg(6, 9, 'On valide.', 0.95),
    seg(9, 12, 'la grue arrive', 0.5), // douteuses qui se suivent
    seg(12, 15, 'lundi matin', 0.45),
    seg(15, 18, 'Julie s’en occupe.', 0.3, { edited: true }), // corrigée à la main
    seg(18, 21, 'Merci.', 0.9),
  ];
  const b = planBlocks(segs, { mode: 'quick' });
  assert.equal(b.length, 2);
  assert.ok(b[0].from <= 1 && b[0].to >= 1 && b[0].end - b[0].start >= 4, 'phrase courte élargie à ≥ 4 s');
  assert.deepEqual([b[1].from, b[1].to], [4, 5], 'douteuses voisines regroupées');
  assert.ok(!b.some((x) => x.from <= 6 && x.to >= 6), 'phrase corrigée exclue');
});

test('planBlocks complet : passages de 25 s au plus, coupés aux silences et aux corrections', () => {
  const segs = Array.from({ length: 20 }, (_, i) => seg(i * 4, i * 4 + 3.5, `phrase ${i}`, 0.9));
  segs[10].edited = true;
  segs[15] = { ...segs[15], start: 70, end: 73 }; // silence de 6 s avant
  const b = planBlocks(segs, { mode: 'full' });
  assert.ok(b.every((x) => x.end - x.start <= 25.5));
  assert.ok(!b.some((x) => x.from <= 10 && x.to >= 10));
  assert.ok(b.some((x) => x.from === 15));
  const covered = b.flatMap((x) => Array.from({ length: x.to - x.from + 1 }, (_, k) => x.from + k));
  assert.equal(covered.length, 19);
});

test('compareBlock : accord, correction, doute', () => {
  const o = [seg(0, 3, 'il faut intégré le scanne dans revite', 0.45)];
  assert.equal(compareBlock(o, [seg(0, 3, 'Il faut intégré le scanne dans revite.', 0.5)]).verdict, 'ok');
  const fixed = compareBlock(o, [seg(0, 3, 'Il faut intégrer le scan dans Revit avant vendredi.', 0.82)]);
  assert.equal(fixed.verdict, 'fixed');
  assert.ok(fixed.after > fixed.before);
  assert.equal(compareBlock(o, [seg(0, 3, 'Il faut intégrer les cartes dans Excel.', 0.47)]).verdict, 'doubt', 'pas plus sûre : à vérifier');
  assert.equal(compareBlock(o, []).verdict, 'doubt', 'rien entendu : à vérifier');
  const day = [seg(0, 5, 'La grue arrive mardi pour le coulage de la dalle', 0.4)];
  assert.equal(compareBlock(day, [seg(0, 5, 'La grue arrive jeudi pour le coulage de la dalle', 0.45)]).verdict, 'doubt', 'un mot de sens différent : jamais un accord');
  const ctx = [seg(0, 3, 'il faut intégré le scanne dans revite', 0.35), seg(3, 5, 'merci', 0.95)];
  assert.ok(compareBlock(ctx, [seg(0, 5, 'Il faut intégrer les cartes dans Excel. Merci.', 0.62)], { focus: true }).before < 0.4, 'confiance « avant » = phrases douteuses');
  assert.equal(compareBlock(o, [seg(0, 3, 'Il faut intégrer le scan dans Revit', 0.47)]).verdict, 'ok', 'presque pareil sans être plus sûre : on ne touche pas');
  assert.equal(compareBlock(o, [seg(0, 3, 'Il faut intégrer le scan dans Revit', 0.8)]).verdict, 'fixed', 'presque pareil et plus sûre : meilleure orthographe');
});

test('carrySpeakers : intervenant repris d’après le temps', () => {
  const orig = [seg(0, 5, 'a', 0.5, { spk: 0 }), seg(5, 10, 'b', 0.5, { spk: 1 })];
  const c = carrySpeakers([seg(0.2, 4.6, 'A', 0.9), seg(6, 9, 'B', 0.9), seg(12, 13, 'C', 0.9)], orig);
  assert.deepEqual(c.map((x) => x.spk), [0, 1, 1]);
});
