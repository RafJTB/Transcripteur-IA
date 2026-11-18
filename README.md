<img src="logo.svg" width="72" alt="" align="left" />

# Transcripteur IA by RJB

<br clear="left" />

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
js/monitor.js       Graphique volume / compréhension en temps réel
js/calibration.js   Diagnostic de la pièce et score de dictée (fonctions pures)
js/live.js          Transcription en direct (Whisper par fenêtres, Voxtral en flux continu)
js/voxtral-engine.js Moteur Voxtral Realtime : flux continu, sessions de ~2 min, phrases horodatées
js/pcm-worklet.js   Capture de l'audio brut du micro (AudioWorklet) pour le direct
js/audio.js         Décodage (mp3, wav, m4a, webm, mp4…) en mono 16 kHz, enregistreur micro
js/lexicon.js       Lexique de corrections (localStorage)
js/exporters.js     .txt, .md, .srt
js/claude-export.js consigne de résumé et lien vers Claude
js/player.js        lecteur du résultat : forme d'onde, réécoute au clic, vitesse
js/translate.js     traduction locale : traducteur de Chrome, sinon modèle Opus-MT / NLLB
js/translate-worker.js  modèle de traduction (Transformers.js) dans son propre worker
js/history.js       Stockage local (IndexedDB) : transcriptions, audios, morceaux d'enregistrement
```

| Modèle | Dépôt Hugging Face | WebGPU | WASM (CPU) |
|---|---|---|---|
| Rapide | `onnx-community/whisper-base` | 206 Mo | 77 Mo |
| Équilibré | `onnx-community/whisper-small` | 586 Mo | 249 Mo |
| Précis | `onnx-community/whisper-large-v3-turbo` | 1,61 Go (759 Mo sans fp16) | 1,09 Go |
| Temps réel | `onnx-community/Voxtral-Mini-4B-Realtime-2602-ONNX` (Mistral, Apache 2.0) | 2,83 Go (3,18 Go sans fp16) | indisponible |

Les modèles sont téléchargés une seule fois puis gardés dans le cache du navigateur (Cache API).

## Transcription en direct

Toujours active quand on enregistre au micro (plus d'interrupteur). Toutes les ~3 s, la partie non validée est retranscrite ;
les phrases terminées sont validées, la dernière reste provisoire (en italique). À l'arrêt, la fin est
retranscrite normalement pour une qualité maximale. Décalage typique : 3 à 6 s avec le modèle Rapide.

## Vrai temps réel avec Voxtral

Modèle « Temps réel » (Voxtral Realtime de Mistral) : modèle conçu pour le flux continu, le texte suit
la parole avec ~0,5 s de décalage, sans re-transcription à l'arrêt. Taux d'erreur publié en français :
6,4 % (FLEURS, 480 ms de décalage). Langue détectée automatiquement.

- Carte graphique (WebGPU) obligatoire ; grisé sinon.
- 2,8 Go à télécharger une fois.
- Le cache du modèle grossit avec la durée : la transcription est découpée en sessions de ~2 min
  coupées sur un silence, pour ne pas saturer la mémoire d'une carte graphique intégrée.
- Sur une carte graphique d'entrée de gamme (Intel intégrée), il peut ne pas suivre le rythme de la
  parole : l'indicateur « retard » le signale, et le texte est complété à l'arrêt.

## Moniteur (volume et compréhension)

Panneau à droite (en haut à droite sur écran moyen) qui défile sur les 30 dernières secondes :
- **Volume** du micro en dBFS, avec la zone idéale en vert et les saturations en rouge.
  Diagnostic sur 6 s : Bon niveau / Un peu faible / Trop faible / Trop fort / Aucune voix (après 8 s).
- **Compréhension du modèle** (mode direct) : probabilité moyenne que le modèle accorde aux mots
  qu'il écrit. ≥ 80 % bonne, 60–80 % moyenne, < 60 % faible.
- Dans le résultat, les passages sous 60 % sont soulignés « à vérifier » ; le soulignement disparaît
  quand tu corriges le passage. La confiance moyenne est affichée sous le titre.

Limite : c'est la confiance du modèle, pas une garantie. Il peut se tromper avec assurance
(noms propres, sigles), d'où le lexique.

## Réglages du son (sous le graphique)

- **Tester le micro** : affiche le niveau sur le graphique sans rien enregistrer.
- **Micro** : choix du périphérique (les noms apparaissent après la première autorisation).
  Un appareil éteint reste choisi (« non connecté ») ; alerte s'il manque ou se déconnecte.
  Micro Bluetooth (AirPods) : le casque passe en mode « mains libres », qualité moindre.
- **Sortie** : où écouter la relecture (casque, haut-parleurs), avec bouton « Tester » (Chrome, Edge).
- **Gain** de −12 à +24 dB, modifiable pendant l'enregistrement, appliqué au son enregistré et transcrit.
- **Ajuster automatiquement** : règle le gain pour que la voix soit vers −20 dBFS (crêtes plafonnées à −3 dBFS).
- **Gain automatique**, **réduction du bruit**, **annulation d'écho** (traitements du navigateur) :
  changent au prochain démarrage du micro.
- **Filtre des basses** : coupe les grondements sous 90 Hz, modifiable à tout moment.
- Réglages mémorisés dans le navigateur ; bouton « Réglages par défaut ».

## Enregistrer une visio (Teams, Meet, Zoom)

Au-dessus du bouton d'enregistrement :

- **Ma voix** : le micro seul (réunion en salle, dictée).
- **Voix + visio** : le micro et le son des autres participants, mélangés.
- **Visio seule** : uniquement le son partagé (webinaire, vidéo, visio où l'on ne parle pas).

Au démarrage, Chrome ouvre la fenêtre de partage :

- **visio dans le navigateur** : choisir l'onglet et cocher « Partager l'audio de l'onglet » ;
- **application Teams ou Zoom** : choisir « Écran entier » et cocher « Partager l'audio du système » (Windows).

L'image n'est pas gardée, seul le son l'est. Avec un casque, pas d'écho ; avec des haut-parleurs,
le micro capte aussi la visio (voix en double). Chrome et Edge sur ordinateur uniquement.

## Optimiser la qualité (micro du PC portable)

Dans les réglages du son :
- **Optimiser pour le micro du PC** : réduction du bruit, annulation d'écho, gain automatique et filtre
  des basses activés en un clic.
- **Diagnostic de la pièce** (~15 s) : 3 s de silence puis une phrase lue, avec le micro brut. Mesure le
  bruit de fond, l'écart voix / bruit et estime l'écho (vitesse à laquelle le son retombe après chaque mot),
  avec verdict et conseils.
- **Calibrer par dictée** (~1 min) : 3 phrases lues, chacune avec un réglage différent ; chaque lecture
  est transcrite et comparée à la phrase (pourcentage de mots justes, mots mal compris surlignés).
  À moins de 3 points d'écart, le réglage recommandé est conservé.

Limites : l'écho est une estimation indicative ; deux lectures ne sont jamais identiques, seuls des écarts
nets entre réglages sont significatifs.

## Interface

Deux apparences : **claire** et **sombre** (bouton soleil/lune en haut ; par défaut, celle de Windows). Bleu « ingénierie » comme couleur de marque.

Trois colonnes qui tiennent dans l'écran (une seule colonne sur petit écran) :

- **Gauche** : source (micro ou fichier), choix du modèle et de la langue (replié sur une ligne, s'ouvre au clic),
  et l'**historique** toujours visible, avec une recherche dans les titres et le texte.
- **Centre** : le texte, en grand. Barre d'outils : recherche dans le texte (surligne tous les résultats,
  Entrée pour passer au suivant), lexique, copier, menu Exporter (.txt, .md, .srt), Résumer avec Claude.
  En bas, le **lecteur** : forme d'onde cliquable, repères orange sur les passages à vérifier, vitesse 0,75× à 2×.
  Clic sur un horodatage : l'audio repart à cette phrase, et la phrase lue est surlignée pendant la lecture.
- **Droite** : le moniteur, puis les réglages repliés (son, optimisation, raccourcis), avec un résumé de ce qui est actif.

Raccourcis : `Espace` pause de l'enregistrement ou lecture/pause ; `Ctrl + Espace` lecture/pause même pendant
la correction du texte ; `Ctrl + Entrée` transcrire ; `Ctrl + F` rechercher ; `Échap` fermer ou effacer la recherche.

## Langue détectée et traduction automatique en français

Par défaut, la langue est **détectée automatiquement** (choix « Détection automatique de la langue » sous le modèle)
et l'option **« Traduire en français automatiquement »** est activée :

- Whisper détecte la langue de chaque bloc de 30 s (limitée aux 14 langues de l'application ; le français l'emporte
  en cas de doute). Une réunion qui mélange français et anglais est gérée ; chaque phrase garde sa langue (étiquette « EN »…).
  Avec Voxtral, la langue est devinée à partir du texte.
- Les phrases dans une autre langue sont **traduites toutes seules** : à la fin d'une transcription, et **en direct**
  pendant l'enregistrement. Les phrases en français ne sont pas touchées ; une transcription 100 % française reste identique.
- Affichage : **langue d'origine / Français / Les deux**. Copier, exporter et Résumer avec Claude utilisent le texte affiché.
- Moteur : traducteur intégré de Chrome s'il répond, sinon modèle local (Opus-MT ≈ 107 Mo pour en/es/de/it/nl/ro/ru ;
  NLLB-200 ≈ 900 Mo pour les autres langues, téléchargé seulement après accord). Rien n'est envoyé sur Internet.
- Le bouton **Traduire** reste disponible pour traduire à la main (ex. si l'option automatique est coupée).
- Limites : au changement de langue, une phrase à cheval sur deux blocs peut être mal transcrite ; les petits modèles
  traduisent mal le jargon technique (« clashes » → « affrontements »).

## Résumer avec Claude

Le bouton **Résumer avec Claude** (barre du résultat) ouvre claude.ai avec la transcription et une consigne prête :
compte rendu de réunion (décisions, actions avec responsable et échéance, points en suspens), résumé court,
points clés ou résumé détaillé, plus des consignes libres. Il n'y a plus qu'à envoyer.

- Transcription courte : le message est pré-rempli dans Claude.
- Transcription longue (lien trop long) : Claude s'ouvre et la consigne est copiée, il suffit de coller (Ctrl + V).
- Dans tous les cas la consigne est aussi copiée dans le presse-papiers.
- Confidentialité : c'est le seul moment où du texte quitte le PC (vers ton compte claude.ai). L'audio reste local.

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
- **Voix lointaines** : la détection de voix s'adapte au bruit de fond de la pièce (6 dB au-dessus), les
  passages oubliés par Whisper (il s'arrête parfois après la 1re phrase d'un bloc bruité) sont retranscrits,
  et pour Voxtral les voix faibles sont amplifiées (sans saturation). La qualité baisse quand même avec la
  distance : rapproche le PC des personnes qui parlent.
- **Hallucinations** : sur les silences, Whisper peut inventer des phrases (« Sous-titres réalisés par… ») ou boucler (« j’aime, j’aime, j’aime… »). Parades en place : blocs silencieux ignorés, formules connues filtrées, plafond de tokens, nouvel essai par échantillonnage si boucle détectée, fusion des répétitions. Une relecture reste nécessaire.
- **GPU logiciel** : si Chrome n’expose qu’un GPU émulé (SwiftShader, WARP — fréquent en bureau à distance/VM), il est ignoré car plus lent que le processeur.

## Si le réseau de l’entreprise bloque Hugging Face

Piste possible (non implémentée) : copier les fichiers du modèle dans le dépôt et pointer Transformers.js dessus (`env.allowLocalModels = true`, `env.localModelPath`). GitHub Pages refuse les fichiers de plus de 100 Mo : seul **Whisper Base en q8** (encodeur 23 Mo + décodeur 54 Mo) passe cette limite.
