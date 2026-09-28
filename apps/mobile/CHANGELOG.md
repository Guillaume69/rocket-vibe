# Journal des modifications

Les changements notables de l'app mobile. Format [Keep a Changelog](https://keepachangelog.com/fr/1.1.0/),
versions selon le [versionnage sémantique](https://semver.org/lang/fr/). La version vit dans
`app.json` (avec `package.json` et `android.versionCode`) ; un tag `mobile-vX.Y.Z` publie la
release, et ses notes sont la section de la version ici.

## [Non publié]

### Corrigé

- Un partage vers l’app alors qu’elle n’était pas lancée ouvre bien l’écran de partage, du
  premier coup ; et un partage n’est plus rejoué à chaque ouverture suivante de l’app.

## [0.1.0] - 2026-09-27

Première version publiée : Android, pour Rocket.Chat 8 ou plus récent.

### Ajouté

- Connexion par mot de passe avec double authentification (TOTP, e-mail, mot de passe),
  session gardée dans le stockage sécurisé.
- Hors-ligne d'abord : une base SQLite par serveur et par compte, que l'interface observe ;
  REST pour agir, DDP pour écouter, reconnexion et rattrapage automatiques.
- Liste des salons par activité, en sections (non lus, salons, messages privés), avec
  présence, aperçus, badges de non-lus et recherche de personnes et de salons.
- Fil de messages : markdown natif, emojis (dont personnalisés), mentions, citations,
  fils de discussion, réactions, épinglage, édition et suppression, brouillons par salon.
- Envoi de fichiers en deux temps (photos, vidéos réduites, documents, messages vocaux),
  avec progression, reprise et abandon.
- Lecture audio et vidéo intégrée, aperçus de liens et cartes YouTube / Dailymotion / Vimeo.
- Indicateur de saisie, barre « nouveaux messages », recherche dans un salon.
- Notifications push FCM au contenu masqué, récupéré à la réception ; réponse depuis la
  notification ; ouverture du salon par lien `rocketvibe://`.
- Lecture des salons chiffrés de bout en bout après déverrouillage.
- Appels vidéo Jitsi.
- Partage depuis d'autres apps vers un salon.
- Profils, informations de salon, mon profil (statut, photo, informations).
- Interface en français et en anglais.

[Non publié]: https://github.com/Guillaume69/rocket-vibe/compare/mobile-v0.1.0...HEAD
[0.1.0]: https://github.com/Guillaume69/rocket-vibe/releases/tag/mobile-v0.1.0
