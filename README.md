# Transcripteur local

Transcription audio → texte **100 % dans le navigateur** avec Whisper (Transformers.js 4.3.2).
Aucun serveur, aucune clé API, aucune installation : l’audio ne quitte jamais le PC.

## Lancer

Le site doit être servi en HTTP(S) (pas en `file://` : le cache des modèles et le service worker ne fonctionnent pas en local brut).

- **En ligne (recommandé)** : GitHub Pages, voir plus bas.
- **En local pour développer** : `python -m http.server 8080` dans ce dossier, puis http://localhost:8080

Navigateur conseillé : Chrome ou Edge récent (WebGPU activé par défaut sous Windows 11).

## Héberger gratuitement sur GitHub Pages

1. Crée un dépôt GitHub (public, ou privé avec un compte qui autorise Pages).
2. Envoie le contenu de ce dossier à la racine du dépôt (glisser-déposer dans l’interface web « Add file → Upload files » suffit).
3. *Settings → Pages → Build and deployment* : Source = « Deploy from a branch », branche `main`, dossier `/ (root)`.
4. Après 1 à 2 minutes, l’app est disponible sur `https://<ton-compte>.github.io/<depot>/`.

Le fichier `.nojekyll` évite tout traitement Jekyll.

## Architecture

```
index.html          Interface (3 zones : source → transcription → résultat)
styles.css          Design sombre
sw.js               Service worker : en-têtes COOP/COEP → WASM multithread sur GitHub Pages
js/config.js        Modèles, variantes WebGPU/WASM, langues, découpage, réglages V2
js/asr-worker.js    Web Worker : chargement Whisper, découpage 30 s / chevauchement 5 s, fusion, progression
js/app.js           Orchestration UI ↔ worker, reprise et repli automatiques, exports, historique
js/live.js          Transcription en direct pendant l'enregistrement
js/pcm-worklet.js   Capture de l'audio brut du micro (AudioWorklet) pour le direct
js/audio.js         Décodage (mp3, wav, m4a, webm, mp4…) en mono 16 kHz, enregistreur micro
js/lexicon.js       Lexique de corrections (localStorage)
js/exporters.js     .txt, .md, .srt
js/history.js       Stockage local (IndexedDB) : transcriptions, audios, morceaux d'enregistrement
```

| Modèle | Dépôt Hugging Face | WebGPU | WASM (CPU) |
|---|---|---|---|
| Rapide | `onnx-community/whisper-base` | 206 Mo | 77 Mo |
| Équilibré | `onnx-community/whisper-small` | 586 Mo | 249 Mo |
| Précis | `onnx-community/whisper-large-v3-turbo` | 1,61 Go (759 Mo sans fp16) | 1,09 Go |

Les modèles sont téléchargés une seule fois puis gardés dans le cache du navigateur (Cache API).

## Transcription en direct

Interrupteur « Transcrire en direct » sous le micro. Toutes les ~3 s, la partie non validée est retranscrite ;
les phrases terminées sont validées, la dernière reste provisoire (en italique). À l'arrêt, la fin est
retranscrite normalement pour une qualité maximale. Décalage typique : 3 à 6 s avec le modèle Rapide.

## Reprise automatique

- Chaque bloc de 30 s transcrit est sauvegardé immédiatement, avec l'audio d'origine.
- Si le moteur plante ou ne répond plus : redémarrage et reprise au bloc suivant, sans intervention (2 fois max).
- Si l'onglet est fermé ou planté : à la réouverture, compte à rebours de 8 s puis reprise (bouton pour ignorer).
- Si tu arrêtes toi-même : bouton « Reprendre ».
- Pendant un enregistrement, l'audio est sauvegardé chaque seconde : un enregistrement interrompu est récupéré à la réouverture.

## Suppression

- Pendant l'enregistrement : bouton « Supprimer » (rien n'est conservé, ni audio ni texte).
- Après : icône corbeille sur l'audio (avec option « supprimer aussi la transcription »), ou dans l'historique.
- « Tout supprimer » dans l'historique efface toutes les transcriptions et tous les audios.

## Limites connues

- **Premier lancement** : il faut accéder à `cdn.jsdelivr.net` (moteur) et `huggingface.co` (modèles). Si le proxy de l’entreprise les bloque, voir « Hébergement des modèles » ci-dessous.
- **Vitesse** : avec WebGPU, compter environ 5 à 20× le temps réel pour Small selon la carte graphique ; en WASM (CPU seul, mesuré ici sur 2 threads) : ~5× le temps réel pour Base, ~1 à 2× pour Small ; un PC récent à 8 cœurs ira environ 2× plus vite. Large v3 Turbo n’est réaliste qu’avec WebGPU.
- **Durée conseillée** : jusqu’à ~1 h par fichier. Au-delà, ça fonctionne mais la mémoire (audio décodé ≈ 230 Mo/heure) et le temps deviennent contraignants : découpe en plusieurs fichiers.
- **Précision** : Whisper est bon en français sur une voix claire ; il se trompe sur les sigles et noms propres (d’où le lexique), sur la parole superposée et les mauvais micros. Pas d’identification des locuteurs.
- **Stockage** : l'audio d'origine est conservé avec chaque transcription (nécessaire pour reprendre et réécouter). Un enregistrement micro pèse environ 0,5 Mo/min ; un fichier importé garde sa taille. Supprime ce dont tu n'as plus besoin.
- **Direct** : sans carte graphique, seul le modèle Rapide suit le rythme de la parole ; les autres prennent du retard (le texte est complété à l'arrêt).
- **Langue** : Transformers.js ne détecte pas la langue automatiquement ; elle doit être choisie.
- **Hallucinations** : sur les silences, Whisper peut inventer des phrases (« Sous-titres réalisés par… ») ou boucler (« j’aime, j’aime, j’aime… »). Parades en place : blocs silencieux ignorés, formules connues filtrées, plafond de tokens, nouvel essai par échantillonnage si boucle détectée, fusion des répétitions. Une relecture reste nécessaire.
- **GPU logiciel** : si Chrome n’expose qu’un GPU émulé (SwiftShader, WARP — fréquent en bureau à distance/VM), il est ignoré car plus lent que le processeur.

## Si le réseau de l’entreprise bloque Hugging Face

Piste possible (non implémentée) : copier les fichiers du modèle dans le dépôt et pointer Transformers.js dessus (`env.allowLocalModels = true`, `env.localModelPath`). GitHub Pages refuse les fichiers de plus de 100 Mo : seul **Whisper Base en q8** (encodeur 23 Mo + décodeur 54 Mo) passe cette limite.
