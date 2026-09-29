# Journal des modifications

Les changements notables de l'app mobile. Format [Keep a Changelog](https://keepachangelog.com/fr/1.1.0/),
versions selon le [versionnage sémantique](https://semver.org/lang/fr/). La version vit dans
`app.json` (avec `package.json` et `android.versionCode`) ; un tag `mobile-vX.Y.Z` publie la
release, et ses notes sont la section de la version ici.

## [Non publié]

### Ajouté

- Liste des salons : un appui sur le titre d'une section (Non lus, Salons, Messages privés) la
  replie ou la déplie ; repliée, elle affiche son nombre de conversations, et l'état est retenu
  d'un lancement à l'autre.
- Salon : remonté de plus d'un écran dans l'historique, un bouton rond en bas à droite ramène
  d'un geste aux derniers messages.
- Messages : épingler et désépingler, ajouter aux favoris et en retirer, depuis les actions
  d'un message. Un bouton 📌 dans l'en-tête du salon ouvre ses messages épinglés et vos
  favoris ; toucher l'un d'eux ramène la conversation jusqu'à lui et le surligne, en chargeant
  l'historique plus ancien au besoin.
- Composer : les pièces jointes attendent l'envoi en pastilles (vignette ou icône, nom, format et
  poids, ✕ pour retirer) ; on peut en joindre plusieurs à la fois, les prévisualiser d'un toucher,
  et le texte tapé part en légende de la première.

### Modifié

- Un fichier refusé par le serveur (taille, type) l'est dès qu'on le joint, et non plus au
  moment d'envoyer.

### Corrigé

- Les actions d’un message suivent vos droits réels sur le serveur : plus d’« Épingler » sans
  la permission, et un modérateur peut modifier ou supprimer les messages des autres.
- Un fichier envoyé garde son nom d’origine ; une copie faite par le sélecteur partait sous un
  nom de cache aléatoire.
- Un partage vers l’app alors qu’elle n’était pas lancée ouvre bien l’écran de partage, du
  premier coup ; et un partage n’est plus rejoué à chaque ouverture suivante de l’app.
- Un salon chiffré créé par un ancien client web (clé de salon AES-128) se lit de nouveau une
  fois déverrouillé, au lieu de n’afficher que des messages « chiffrés, non pris en charge ».

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
