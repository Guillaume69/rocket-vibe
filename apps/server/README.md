# Serveur RocketVibe natif — chantier J0/J1

Serveur Rust expérimental, développé sur `feature/rocketvibe-server`. Le socle est
indépendant de Rocket.Chat : Axum / Tokio, PostgreSQL, contrats `rv-protocol` et
transport Rust réutilisable `rv-client`. Le workspace natif à la racine exclut le
workspace bureau existant.

Disponible : comptes créés par CLI, connexion par mot de passe, sessions révocables,
salons privés / publics avec adhésions contrôlées, DM uniques, messages idempotents,
historique paginé, snapshot cohérent et reprise du journal par HTTP / WebSocket.

Un [parcours mobile pilote](../../docs/NATIVE_MOBILE_PILOT.md) est raccordé à la
connexion, au Keystore et à SQLite. Les interfaces GTK / SwiftUI et les écrans
partagés du mobile restent à raccorder. Les transports Rust et TypeScript sont
testés contre le serveur réel. Fichiers, push, appels, 2FA,
chiffrement et parité complète restent au backlog. Les limites sont explicites dans
le [contrat du pilote](../../docs/protocol/README.md).

## Démarrage local

Depuis la racine du dépôt, avec Docker Desktop / Docker Engine actif :

1. Copier `docker/.env.native.example` vers `docker/.env.native`.
2. Renseigner `RV_DATABASE_PASSWORD` avec un mot de passe aléatoire. Utiliser des
   caractères compatibles URL, par exemple des octets aléatoires encodés en hexadécimal.
3. Démarrer :

```sh
docker compose --env-file docker/.env.native -f docker/compose.rocketvibe.yml up --build -d
```

Le serveur écoute sur `http://127.0.0.1:3400`. PostgreSQL n'a aucun port publié sur
l'hôte. Ce Compose et ses volumes sont distincts du banc Rocket.Chat.

Créer un compte avec un mot de passe d'au moins 12 octets fourni par la variable
d'environnement `RV_USER_PASSWORD` ; la valeur ne passe pas dans les arguments :

```sh
# Définir RV_USER_PASSWORD dans le shell avant cette commande.
docker compose --env-file docker/.env.native -f docker/compose.rocketvibe.yml run --rm -e RV_USER_PASSWORD server create-user alice --admin
```

Le flag administrateur est stocké pour la suite du chantier ; il ne permet pas
de lire les salons privés ni de contourner leurs droits. La CLI exige un accès
opérateur à la base. Aucune inscription publique n'est ouverte.

Découverte et état :

```sh
curl http://127.0.0.1:3400/.well-known/rocketvibe
curl -f http://127.0.0.1:3400/health/ready
```

## Vérifications reproductibles

Depuis la racine, lancer :

```sh
docker compose --env-file docker/.env.native -f docker/compose.rocketvibe.yml build check
docker compose --env-file docker/.env.native -f docker/compose.rocketvibe.yml run --rm check bash apps/server/scripts/check.sh
```

L'image de vérification contient Rust, rustfmt, clippy et Node 24. Les tests SQLx
créent des bases temporaires séparées ; aucune donnée de l'instance de développement
n'est effacée. Ils vérifient HTTP réel, WebSocket, concurrence, refus de droits,
redémarrage applicatif et échanges par les transports Rust et TypeScript.

Le script vérifie aussi les fixtures et l'absence de divergence du schéma / des
types générés. La CI native exécute les mêmes checks, avec le typecheck, les tests
mobiles et l'export du bundle JavaScript Android. Cet export n'est ni un APK ni une
validation visuelle sur appareil.

## Contrat et génération

```sh
# Dans l'image check, depuis /src :
cargo run --locked -p rv-protocol --bin export-schema > docs/protocol/v1.schema.json
node scripts/generate-native-protocol.mjs
```

La source du contrat est `crates/rv-protocol/src/lib.rs`. Les dates sont des chaînes
UTC et les positions longues restent des chaînes, y compris au-delà de la précision
des nombres JavaScript. Ne pas modifier à la main les fichiers générés.

## État et suite

Le [suivi du chantier](../../docs/NATIVE_SERVER_EXECUTION.md) détaille ce qui est
livré et ce qui reste à faire pour fermer J0 et J1. La
[RFC](../../docs/rfcs/0001-serveur-rocketvibe-rust.md) reste la destination de parité.
Cette version est un banc local, pas un serveur destiné à remplacer une instance
Rocket.Chat contenant des données réelles.
