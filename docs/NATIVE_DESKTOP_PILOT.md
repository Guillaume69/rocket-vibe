# RocketVibe natif dans le client bureau existant

Branche : `feature/rocketvibe-server`. Le formulaire de connexion reconnaît
Rocket.Chat ou RocketVibe avant l'authentification. Les deux fournisseurs alimentent
le même `ChatPage` GTK : liste de salons, en-têtes, Markdown, liste de messages,
composeur et navigation. Il n'existe plus de page de chat native parallèle.

Les comptes des deux types cohabitent dans le stockage sécurisé. La tuile du compte
ouvre les paramètres habituels, avec ajout et changement de compte. Les anciens
comptes sans genre restent Rocket.Chat. Un changement ferme le transport précédent ;
les événements en retard ne sont pas appliqués au compte nouvellement affiché.

## Utilisation

Démarrer le [serveur local](../apps/server/README.md) et créer ses comptes par CLI.
Construire le bureau dans Fedora avec `apps/desktop/scripts/build.sh`. La connexion
à `http://127.0.0.1:3400` ouvre la même interface que celle d'un serveur Rocket.Chat.

Le bouton nouvelle conversation permet un DM ou la création d'un salon privé/public.
L'en-tête d'un salon ouvre l'invitation par pseudo ; le serveur réserve ce droit au
propriétaire. La recherche existante permet de découvrir et rejoindre les salons publics.

Le texte, l'historique, le brouillon et les envois hors ligne sont disponibles.
Réessayer / abandonner utilisent le menu d'un envoi refusé. Les fonctions natives
non prises en charge (fichiers, vocaux, fils, réactions, non-lus, recherche, push,
E2EE et appels) restent désactivées. Rocket.Chat garde ses fonctions actuelles.
Les menus et éditeurs existants permettent aussi l'édition et la suppression,
avec droits du serveur, révision capturée à l'ouverture et intention SQLite.
Une édition refusée conserve son texte pour la réouverture de l'éditeur.

## Cache et reprise

- Jetons dans le trousseau existant ; genre et `instance_id` / `data_epoch` persistés.
- Cache natif séparé `native-<sha256 URL complète + utilisateur>.sqlite`.
- Projection, curseur et acquittement d'écho dans une transaction SQLite fallible.
- Ordre des messages par position décimale exacte ; affichage des dates réelles.
- Rejeu du journal et retrait des accès avant émission de l'outbox.
- Snapshot autoritaire, purge des salons absents et rejet des historiques tardifs.
- Identité revérifiée après lecture d'un snapshot ; une autre génération ne rejoue
  pas les anciennes intentions.
- Trames consommées en série, invalidations GTK bornées, watchdog de 45 secondes.

`NativeSession.shutdown()` est appelé au changement de compte et à la fermeture.
La déconnexion révoque le jeton en ligne puis retire le compte local.

## SwiftUI / UniFFI

`Client.native_login` et `native_resume` exposent le moteur par `NativeChat` :
statut, messages, salons, brouillons, historique, outbox, DM et gestion des salons.
L'API historique refuse d'envoyer des identifiants natifs aux routes Rocket.Chat.
`ChatProvider` raccorde les deux transports aux modèles `AppModel` et `RoomModel` :
les vues SwiftUI de connexion, salons, messages, recherche de personnes, DM,
composeur et comptes restent communes. Le rendu Markdown, les groupes d'auteurs
et les séparateurs de jour utilisent les mêmes objets UniFFI que Rocket.Chat,
en conservant l'ordre du journal natif. Les avatars natifs restent des initiales.
Les fonctions absentes du serveur sont désactivées dans ces vues.

Le banc Swift utilise le vrai serveur PostgreSQL et un Secret Service déverrouillé,
avec un compte jetable. Après génération et compilation par
`apps/desktop/macos/scripts/check-linux.sh`, démarrer uniquement les services
`postgres bootstrap server` du Compose pilote puis lancer
`docker compose -f docker/compose.native-pilot.yml run --rm --no-deps swift`.
Il exerce les modèles Swift et les bindings Rust réels ; l'affichage AppKit /
SwiftUI complet est construit et lancé séparément par la CI macOS.

## Banc reproductible

Depuis la racine, dans Bash avec Docker :

```sh
docker build -t rocket-vibe-rs-build apps/desktop/docker
docker build -t rocketvibe-native-server -f apps/server/Dockerfile .
docker build -t rocketvibe-native-check -f apps/server/docker/Dockerfile.check .
docker run --rm -v "$PWD:/workspace" -v rv-cargo:/cargo \
  -w /workspace/apps/desktop rocket-vibe-rs-build bash -ec '
    cargo fmt --all -- --check
    cargo clippy --locked --workspace --all-targets -- -D warnings
    cargo test --locked --workspace
    cargo build --locked -p rv-core --example native-smoke
    cargo build --locked -p rocket-vibe-gtk
  '
docker compose -f docker/compose.native-pilot.yml up -d postgres bootstrap server mobile factor-seed factor-proxy
docker compose -f docker/compose.native-pilot.yml run --rm --no-deps desktop
docker compose -f docker/compose.native-pilot.yml run --rm --no-deps factor-check
docker compose -f docker/compose.native-pilot.yml run --rm --no-deps session-check
docker compose -f docker/compose.native-pilot.yml logs --no-color
docker compose -f docker/compose.native-pilot.yml down -v
```

Lancer `desktop` immédiatement après `mobile` : le pair dispose d'un délai borné.
Le banc jetable utilise PostgreSQL en tmpfs, sans port hôte ni volume de développement.
Il emploie la façade mobile réelle, ses migrations SQLite et le binaire GTK réel.
Il vérifie échange, reprise après réouverture du fichier, brouillon, unicité du DM,
création / invitation, retrait privé, révocation et widgets affichés, en large et à
435 pixels. Captures : `artifacts/native-desktop*.png`.

GTK et les modèles Swift utilisent un vrai Secret Service dans ce banc Linux.
La politique SQL jetable raccourcit le premier jeton à un jour, ce qui déclenche
son renouvellement dans les clients existants. `session-check` exige une rotation
pour les deux comptes, même si les sessions ont ensuite été déconnectées ; ses
compteurs ne contiennent aucun secret. Le pair mobile exerce la vraie façade
SQLite et la reprise portable, avec une sauvegarde en mémoire propre au banc.
La qualification SecureStore Android, le trousseau Windows / macOS et les essais
sur appareils restent ouverts dans le [suivi](NATIVE_SERVER_EXECUTION.md).

Le parcours GTK ouvre aussi les paramètres puis la liste d'appareils, développe
l'appareil courant et applique un nom par le véritable champ Adwaita. Il vérifie
la valeur serveur et que le champ tient dans la fenêtre. Les modèles Swift
renomment l'appareil courant, révoquent une seconde session et vérifient son
refus HTTP 401 ; les contrôles retenus du précédent compte restent inactifs.

Le bootstrap jetable émet des invitations dans un volume privé, monté en lecture
seule par les clients. GTK utilise le champ d'invitation de sa page de connexion,
crée un compte, efface les secrets du formulaire puis reprend ce compte depuis
Secret Service après un redémarrage. Le modèle Swift exerce le même parcours
et le logout. Le pair mobile inscrit un compte, reprend la réponse puis connecte
son fournisseur SQLite. Le volume d'invitations est supprimé avec `down -v` ;
aucun code ne rejoint les logs ou les artifacts. Ces essais ne remplacent pas
la qualification des appareils physiques.

Le banc émet aussi des codes opérateur liés à trois comptes de récupération.
GTK passe par sa variante « Mot de passe oublié » puis reprend la nouvelle session
après redémarrage. Swift vérifie en plus le rejet HTTP 401 de l'ancien bearer.
Le pair mobile conserve l'UID et une conversation réellement écrite avant reset,
revérifie son contenu dans SQLite et rejoue la confirmation sans révoquer sa
session récente. Codes d'invitation et de récupération partagent le volume
privé jetable, jamais les artifacts.

Le bootstrap génère aussi une clé opérateur aléatoire privée pour les facteurs,
lisible uniquement par le serveur, puis provisionne deux comptes de test avec
TOTP et dix secours. Un proxy privé jette chaque réponse de validation réussie.
GTK utilise son formulaire et Secret Service : mauvais secours refusé, compte
encore inactif après réponse perdue, récupération du candidat sans nouveau code,
écriture de session puis effacement de la preuve. Un redémarrage sous un nouveau
D-Bus / daemon de trousseau reprend ce compte. `factor-check` exige une seule
famille d'appareil et exactement un secours consommé pour `gtk-factor`.
Les secrets de ce banc restent dans le volume privé supprimé par `down -v` ;
ils ne sont ni journalisés ni ajoutés aux captures. Ce parcours Linux ne qualifie
pas le trousseau macOS / Windows ni un appareil Android physique.

Le service `swift` reçoit un compte distinct et le même proxy de réponse perdue.
Ses modèles conservent le compte précédent pendant le défi ; une preuve privée
reste absente de l'index des sessions. Le modèle et le client sont recréés avant
confirmation, une requête est quittée en cours, puis la session se récupère sans
code et se reprend depuis le vrai trousseau. Il s'agit d'une recréation des
modèles, pas d'un processus macOS tué. Un compte `swift-replay` couvre aussi le
rejeu d'un handle opaque après la rotation forcée de son premier bearer.

Le job Swift démarre `factor-seed` / `factor-proxy`, lance `swift`, puis vérifie
ses compteurs propres avec :

```sh
docker compose -f docker/compose.native-pilot.yml run --rm --no-deps \
  -e 'PGOPTIONS=-c rocketvibe.pilot_factor_user=swift-factor' factor-check
```
