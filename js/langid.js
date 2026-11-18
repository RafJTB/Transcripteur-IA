// Devine la langue d'une phrase à partir du texte (pour Voxtral, qui ne la donne pas).
// Écriture (arabe, chinois, japonais, cyrillique) puis mots très fréquents.
// Renvoie null si la phrase est trop courte ou ambiguë.

const STOP = {
  fr: 'le la les des une un est et en que qui pour dans pas sur avec il elle nous vous on au aux du ce cette sont mais ou donc je tu très bien faut être avoir fait plus',
  en: 'the and is are of to in that it for on with as was we you they this be have not but at from or will can our your there what which would should must',
  es: 'el la los las de que y en un una es por con para no se lo al del como pero más muy este esta son está hay también nosotros',
  de: 'der die das und ist nicht ein eine zu den mit von sich des auf für im dem auch es wir sie ich aber oder wird werden sind haben',
  it: 'il la di che e un una per non sono con del della gli le si come anche ma questo questa è al nel siamo hanno molto',
  pt: 'o a os as de que e um uma do da em para com não se por mais como mas são está também nós isso muito',
  nl: 'de het een en van is dat niet op te in voor met zijn er maar ook wij jullie dit die wordt worden hebben',
  pl: 'i w na nie z się że to jest do jak ale o co tak po za od jego są być może już bardzo',
  tr: 've bir bu da de için ile çok ne o ama gibi daha var olan olarak sonra şu ben biz siz',
  ro: 'și în de la nu că este un o pe cu se pentru mai din care sunt dar ce am fost acest această',
};
const SETS = Object.fromEntries(Object.entries(STOP).map(([k, v]) => [k, new Set(v.split(' '))]));

export function guessLang(text) {
  const t = (text || '').trim();
  if (!t) return null;
  const letters = t.replace(/[^\p{L}]/gu, '');
  if (!letters.length) return null;
  const share = (re) => (letters.match(re) || []).length / letters.length;
  if (share(/\p{Script=Arabic}/gu) > 0.5) return 'ar';
  if (share(/[\p{Script=Hiragana}\p{Script=Katakana}]/gu) > 0.15) return 'ja';
  if (share(/\p{Script=Han}/gu) > 0.5) return 'zh';
  if (share(/\p{Script=Cyrillic}/gu) > 0.5) return 'ru';
  const words = t.toLowerCase().replace(/[’']/g, ' ').match(/\p{L}+/gu) || [];
  if (words.length < 3) return null;
  let best = null;
  let bestN = 0;
  let second = 0;
  for (const [lang, set] of Object.entries(SETS)) {
    const n = words.reduce((a, w) => a + (set.has(w) ? 1 : 0), 0);
    if (n > bestN) { second = bestN; bestN = n; best = lang; } else if (n > second) second = n;
  }
  // Il faut un vrai écart : au moins 2 mots outils et nettement plus que la 2e langue
  if (bestN < 2 || bestN < second * 1.5) return null;
  return best;
}
