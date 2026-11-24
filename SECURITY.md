# Sécurité de Transcripteur IA

Audit du 24/11/2026 : code de l'appli (`js/`, `index.html`, `sw.js`), règles d'accès Supabase (`supabase/schema.sql`), connexions Google, Microsoft et Supabase.

## Modèle de menace

| Ce qui entre dans l'appli | D'où | Confiance |
|---|---|---|
| Audio, transcriptions, réglages | l'utilisateur, son navigateur | élevée |
| Transcriptions de son propre Google Drive | l'utilisateur | élevée |
| **Réunions et messages d'un espace partagé** | **d'autres membres**, qui peuvent écrire directement dans Supabase sans passer par l'appli | **faible** |
| Événements de calendrier (Outlook, fichier .ics) | invitations envoyées par des tiers | faible |
| Réponses des IA (modèle local, Claude) | contenu généré | faible |
| Bibliothèques chargées depuis jsDelivr | tiers (versions figées) | moyenne |

## Points vérifiés et sains

- **Affichage** : sur environ 200 insertions de contenu dans la page, tout ce qui vient de l'extérieur est échappé (`esc`) ou posé avec `textContent`. Le Markdown des résumés et les réponses des IA sont échappés avant mise en forme. Les liens des messages sont limités à `http(s)`.
- **Connexions** :
  - Google : jeton anti-falsification `state` vérifié, jeton retiré de l'adresse aussitôt, gardé dans `sessionStorage` (pas après la fermeture du navigateur).
  - Microsoft : code + PKCE, `state` vérifié, droits en lecture seule (`Calendars.Read`).
  - Supabase : PKCE.
- **Pas de secret dans le dépôt** (code et historique). La clé Supabase `sb_publishable_` est publique par nature : ce sont les règles d'accès qui protègent.
- **Pas de `eval`, pas de `new Function`** dans le code de l'appli.
- **Suppressions dans le Drive** : définitives (`DELETE`, sans corbeille).
- **Intégration continue** : droits en lecture seule (`permissions: contents: read`).

## Failles corrigées

| # | Gravité | Faille | Correction |
|---|---|---|---|
| 1 | Élevée | **Usurpation dans les espaces** : un membre pouvait publier une réunion ou un message au nom et à l'adresse d'un autre, et antidater (champs fournis par l'appli). | Déclencheur serveur `stamp_author` : auteur, adresse, nom et date sont fixés par Supabase à partir du jeton de connexion. Le propriétaire et la date d'un espace aussi. |
| 2 | Élevée (si la confirmation d'e-mail est désactivée dans Supabase) | **Faux compte** : un compte « e-mail + mot de passe » créé avec l'adresse d'un membre donnait accès à ses espaces. | `my_email()` ne reconnaît que les adresses vérifiées par Google. |
| 3 | Moyenne | **Réunion partagée forgée** : son contenu était copié tel quel dans l'historique local (état interne, identifiants, types inattendus). | `sanitizeSharedDoc` : liste blanche de champs, types et tailles vérifiés, sans pollution de prototype. |
| 4 | Moyenne | **Pas de politique de sécurité du contenu (CSP)** : une injection de script aurait pu tout lire et tout envoyer n'importe où. | CSP stricte : scripts de l'appli et de jsDelivr seulement, aucun script intégré (les trois scripts de `index.html` sont passés dans `js/boot.js`), pas d'`eval`, envois limités aux services utilisés, `object-src 'none'`, `base-uri 'self'`. Tous les tests échouent si la CSP bloque quoi que ce soit ; la vraie transcription (Whisper) a été vérifiée sous CSP. |
| 5 | Moyenne | **Affichage dans le cadre d'un autre site** (« clickjacking »). | Refus au démarrage (`js/boot.js`), plus en-têtes `X-Frame-Options` et `frame-ancestors` ajoutés par le service worker. |
| 6 | Faible | **Lien de réunion Outlook** non vérifié (un `javascript:` aurait été cliquable). | `safeUrl` : `https://` uniquement. |
| 7 | Faible | **Cession d'un espace** : le propriétaire pouvait mettre n'importe qui comme propriétaire. | `with check (owner = auth.uid())`. |
| 8 | Faible | **Réunion jointe d'un autre espace** dans un message. | La réunion jointe doit appartenir au même espace. |
| 9 | Faible | **Tailles et types non limités** côté serveur. | Réunion partagée ≤ 20 Mo, titre ≤ 300 caractères ; seau audio privé limité aux fichiers audio de 50 Mo au plus. |
| 10 | Faible | **Référent** : l'adresse (avec un code de connexion temporaire) pouvait partir vers les services appelés. | `Referrer-Policy: no-referrer`, plus `X-Content-Type-Options: nosniff` et `Permissions-Policy` (micro et capture d'écran : l'appli seulement ; caméra, position : aucun). |
| 11 | Faible | La saisie manuelle de la clé Supabase refusait `service_role` mais pas `sb_secret_`. | Les deux refusées, y compris dans un jeton JWT. |

Les corrections 1, 2, 7, 8 et 9 sont dans `supabase/schema.sql` et ont été vérifiées sur un vrai PostgreSQL : deux passages du script, puis chaque attaque rejouée et bloquée.

## Risques résiduels (acceptés, à connaître)

- **Clé API Claude et jetons Microsoft** gardés dans le navigateur (`localStorage`). Quelqu'un qui accède à la session Windows ou à un script injecté pourrait les lire. La CSP limite l'envoi vers l'extérieur ; la session Microsoft d'une appli web expire au bout de 24 h. Pour plus de sûreté, effacer la clé Claude après usage.
- **Bibliothèques jsDelivr** (Transformers.js, supabase-js, docx, SDK Anthropic) : versions figées, mais sans empreinte d'intégrité (impossible avec un `import()` dynamique). Une version compromise sur le CDN aurait accès à la page. Solution future : héberger ces fichiers dans le dépôt.
- **Connexion Google en « flux implicite »** (jeton dans l'adresse) : courant pour une appli sans serveur, atténué (jeton retiré aussitôt, pas de référent, `sessionStorage`). Le passage au flux « code » demanderait un serveur, car Google exige un secret client.
- **Données locales en clair** (IndexedDB) : protégées par la session Windows, pas chiffrées par l'appli.
- **Pas de limite de fréquence** sur Supabase (un membre pourrait inonder un espace de messages).
- **Copies déjà téléchargées** : un membre retiré d'un espace garde les réunions qu'il a ouvertes.

## À faire de ton côté

1. **Supabase → SQL Editor** : réexécuter `supabase/schema.sql` (sans danger, ne touche pas aux données) pour appliquer les corrections serveur.
2. **Supabase → Authentication → Providers** : désactiver **Email** (seul Google est utilisé). La correction 2 protège déjà, mais autant fermer la porte.
3. **Double authentification** sur les comptes GitHub (qui peut modifier le code publie l'appli), Google, Supabase et Microsoft.
4. Garder le dépôt **sans secret** : jamais de clé `service_role`, `sb_secret_` ou de clé API Claude dans le code.

## Signaler une faille

Ouvrir une *issue* privée (*Security advisory*) sur le dépôt GitHub, sans détail technique dans une issue publique.
