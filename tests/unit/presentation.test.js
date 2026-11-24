import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanPerso, hash } from '../../js/presentation.js';

test('présentation reçue : seuls les champs connus, bornés, jamais de CSS venu d’ailleurs', () => {
  const p = cleanPerso({ bg: 'plan-architecte', blur: 999, veil: -5, panel: '120', accent: '#05966A', hover: 'click', hoverColor: 'accent', css: "url('https://pirate.example/x.png')", accentVars: { x: 1 }, autre: 1 });
  assert.deepEqual(p, { bg: 'plan-architecte', blur: 40, veil: 0, panel: 120, accent: '#05966a', hover: 'click', hoverColor: 'accent' });
  const bad = cleanPerso({ bg: 'url(x)', accent: 'red', hover: 'tout', hoverColor: 'javascript:1' });
  assert.equal(bad.bg, 'photo');
  assert.equal(bad.accent, null);
  assert.equal(bad.hover, 'all');
  assert.equal(bad.hoverColor, null);
  assert.deepEqual(cleanPerso(null).bg, 'photo');
});

test('empreinte : stable, différente si l’image change, vide si pas d’image', () => {
  assert.equal(hash(''), '');
  assert.equal(hash('data:image/png;base64,AAAA'), hash('data:image/png;base64,AAAA'));
  assert.notEqual(hash('data:image/png;base64,AAAA'), hash('data:image/png;base64,AAAB'));
});
