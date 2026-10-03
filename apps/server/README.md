# Serveur RocketVibe natif — chantier RFC 0001

Serveur Rust expérimental, développé sur `feature/rocketvibe-server`. Le socle est
indépendant de Rocket.Chat : Axum / Tokio, PostgreSQL, contrats `rv-protocol` et
transport Rust réutilisable `rv-client`. Le workspace natif à la racine exclut le
workspace bureau existant.

Disponible : comptes créés par CLI, connexion par mot de passe, sessions révocables,
salons privés / publics avec création idempotente et adhésions contrôlées,
annuaire paginé des salons publics et adhésion personnelle, DM uniques, messages idempotents,
historique paginé, snapshot cohérent et reprise du journal par HTTP / WebSocket.
Les actions natives comprennent édition, suppression, réactions, épingles et
étoiles privées, avec reçus idempotents, droits et intentions persistées par les
clients. Les listes marquées utilisent les écrans existants des trois clients.
L'API fournit aussi la rotation des sessions et la liste / révocation des
appareils du compte. Les clients renouvellent leur session via SecureStore ou
le trousseau système, avec reprise d'un successeur durable après réponse perdue.
Les paramètres existants des trois clients exposent les noms, dates et la
révocation d'un autre appareil après connexion récente. La qualification sur
appareils et la récupération email restent suivies dans P01/P02. Les écrans de
connexion existants proposent inscription sur invitation et récupération par code
opérateur, avec conservation de l'identité et révocation des anciennes sessions.

Les [écrans mobiles existants](../../docs/NATIVE_MOBILE_PILOT.md) et les interfaces
[GTK / SwiftUI existantes](../../docs/NATIVE_DESKTOP_PILOT.md) accueillent les deux
fournisseurs, avec stockage sécurisé, SQLite, brouillons et outbox. Les transports
Rust et TypeScript sont testés contre le serveur réel. Le socle 2FA TOTP / secours
et ses SDK sont décrits dans [l'authentification native](../../docs/protocol/AUTHENTICATION.md) ;
ses formulaires clients et paramètres sont raccordés. Le
[parcours d'adresse e-mail vérifiée](../../docs/protocol/EMAIL.md) dispose de routes
privées, SDK et file SMTP chiffrée durable. Les formulaires mobile, GTK et SwiftUI
sont raccordés. Le retrait conditionnel du contact est disponible côté serveur
et SDK, même sans SMTP ; les trois clients sont raccordés. Le second facteur
e-mail dispose de routes serveur et SDK pour inscription, retrait, livraison et
reprise des défis de connexion / réauthentification. Le mobile propose ces défis
dans ses écrans existants. Les parcours bureau, l'inscription du facteur et la
récupération e-mail sont raccordés aux trois clients. Présence, fils, recherche,
profils, réglages et avatars protégés utilisent leurs écrans existants.
Les [notifications Android](../../docs/protocol/PUSH.md) utilisent une file durable,
FCM HTTP v1 et la récupération privée du contenu dans le plugin mobile existant.
Le compte de service opérateur se configure avec `RV_FCM_CONFIG_FILE` ; sans ce
fichier, le push reste désactivé. Qualification Firebase / téléphone encore ouverte.
L'[administration opérateur](../../docs/protocol/ADMINISTRATION.md) fournit
comptes / droits / désactivation, salons / membres / réglages, reçus de commande,
audit transactionnel et diagnostic (`health`). Le [cycle de fichiers](../../docs/protocol/FILES.md)
propose préparation, transfert streamé, confirmation idempotente et téléchargement
protégé / Range. Outboxes et lecteurs sont raccordés aux clients existants.
Notifications bureau, appels,
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

Pour laisser la personne choisir ses identifiants dans l'app, émettre une invitation :

```sh
docker compose --env-file docker/.env.native -f docker/compose.rocketvibe.yml run --rm server invite --hours 168
docker compose --env-file docker/.env.native -f docker/compose.rocketvibe.yml run --rm server list-invitations
docker compose --env-file docker/.env.native -f docker/compose.rocketvibe.yml run --rm server revoke-invitation IDENTIFIANT
```

`invite` affiche une seule fois un JSON contenant le code secret `token` et les
métadonnées ; transmettre le code au destinataire par le canal choisi par l'opérateur.
La liste (les 1 000 dernières invitations) et la révocation utilisent l'identifiant
public, sans redonner le code. Durée : 1–168 heures, par défaut 7 jours ; au plus
1 000 invitations actives par génération. Le compte créé n'a pas de droit admin.
Le code crée un seul compte et ne fournit pas de session ; la connexion normale
suit. Une réponse d'inscription perdue peut être reprise, avant expiration, avec
le même identifiant et le mot de passe du compte créé. Révocation, désactivation,
suppression du compte ou changement de génération ferment cette reprise.
Aucun email n'est envoyé automatiquement.

Pour un propriétaire de compte vérifié par l'opérateur, émettre un code de
récupération de mot de passe ; sa valeur ne passe jamais dans les arguments :

```sh
docker compose --env-file docker/.env.native -f docker/compose.rocketvibe.yml run --rm server recover-user alice --hours 24
docker compose --env-file docker/.env.native -f docker/compose.rocketvibe.yml run --rm server list-recovery-codes
docker compose --env-file docker/.env.native -f docker/compose.rocketvibe.yml run --rm server revoke-recovery-code IDENTIFIANT
```

Le JSON de `recover-user` affiche le code secret une seule fois. Durée : 1–24 h,
au plus 3 codes actifs par compte et 1 000 par génération. Dans le formulaire
existant, choisir « Mot de passe oublié », entrer le code et un nouveau mot de
passe. Ce parcours conserve UID, rôles et conversations, révoque toutes les
familles d'appareils puis passe par le login normal. La récupération ne crée pas
de session par elle-même, ne retire pas de facteur 2FA et ne restaure aucune clé
E2EE. Une confirmation perdue se reprend avec le nouveau mot de passe pendant
cinq minutes, sans révoquer les sessions créées depuis. Le changement invalide
les autres codes de récupération ; les codes sont liés à l'autorité du compte
et à la génération des données. Pas d'envoi email implicite ni d'énumération
publique pour demander un code.

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

La demande anonyme de récupération par e-mail est exposée par le serveur et les
SDK natifs lorsque SMTP et `RV_AUTH_KEY_FILE` sont configurés. Elle utilise
uniquement le contact vérifié, garde une réponse publique générique et conserve
le même code après retry. La confirmation reprend la récupération existante,
sans créer de session ni retirer les facteurs installés. Voir le
[contrat e-mail](../../docs/protocol/EMAIL.md#récupération-du-mot-de-passe--serveur-et-sdk)
pour les bornes, versions et parcours clients restant à raccorder.

```sh
# Dans l'image check, depuis /src :
cargo run --locked -p rv-protocol --bin export-schema > docs/protocol/v1.schema.json
node scripts/generate-native-protocol.mjs
```

La source du contrat est `crates/rv-protocol/src/lib.rs`. Les dates sont des chaînes
UTC et les positions longues restent des chaînes, y compris au-delà de la précision
des nombres JavaScript. Ne pas modifier à la main les fichiers générés.

## État et suite

Les limites du pilote sont fixées dans `src/limits.rs` : connexion 10 essais par
pseudo, 30 par IP du pair TCP et 120 au total par fenêtre de 60 secondes, budgets
partagés en PostgreSQL ; 4 vérifications Argon2 simultanées par processus. Même une
requête annulée conserve sa place jusqu'à la fin du calcul. Un refus rend `429`
avec `Retry-After` ; les transports natifs empêchent les retries précoces.

Les en-têtes `Forwarded` / `X-Forwarded-For` ne sont pas utilisés comme identité
du pair : derrière un proxy, ses clients partagent le quota de son IP. La gestion
de proxies explicitement approuvés reste à définir avant une exposition publique.

Maximum 4 tickets non consommés par session, 128 sockets par processus et 4 par
session. Les sockets restent vérifiées toutes les 250 ms, avec heartbeat à 15 s et
délai d'envoi / fermeture de 5 s. Snapshot historique : 100 salons, 50 messages par salon et
8 Mio de JSON ; refus `409 snapshot_limit` sans vue partielle au-delà. Le snapshot
matérialisé permet 1 000 salons, 1 Mio par page / 64 Mio au total ; sa vue immuable
expire après 5 minutes, avec 4 vues par compte / 16 pour l'instance. Le dernier
curseur n'est rendu qu'après téléchargement complet. Les lots de
journal sont limités à 100 événements et 1 Mio, sans sauter l'événement qui ne tient
pas dans le lot. Voir le [contrat de pagination](../../docs/protocol/README.md#snapshots-matérialisés).

Les réponses et trames revérifient la version de leurs autorisations juste avant
remise, puis retiennent des verrous PostgreSQL jusqu'à cette remise. Retrait,
réadhésion, rôle, session ou génération ne valident pas une ancienne réponse.
Un corps HTTP abandonné / bloqué libère sa barrière au plus tard après 5 s.
Les mutations retiennent leur session jusqu'au commit, avec attente de verrou
limitée à 6 s, instruction à 8 s et transaction inactive à 10 s.
Voir les [garanties de révocation](../../docs/protocol/README.md#révocation-pendant-une-livraison).

Un curseur expire après 7 jours sans renouvellement ; 512 curseurs au maximum par
compte. Un curseur expiré / élagué exige un nouveau snapshot via
`409 sync_reset_required`, sans effacer les intentions locales encore autorisées.
Au démarrage puis chaque minute, le serveur supprime jusqu'à 1 000 entrées périmées
par famille (sessions, tickets, curseurs, quotas), en sautant les lignes verrouillées.
Il ne purge ni journal ni messages. Ces bornes ne remplacent pas un essai de charge.

Le [suivi du chantier](../../docs/NATIVE_SERVER_EXECUTION.md) détaille ce qui est
livré et ce qui reste à faire pour fermer J0 et J1. La
[RFC](../../docs/rfcs/0001-serveur-rocketvibe-rust.md) reste la destination de parité.
Cette version est un banc local, pas un serveur destiné à remplacer une instance
Rocket.Chat contenant des données réelles.
