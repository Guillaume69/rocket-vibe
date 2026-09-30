# Protocole natif RocketVibe — premier incrément

Le serveur est expérimental. La [RFC 0001](../rfcs/0001-serveur-rocketvibe-rust.md)
décrit la destination ; ce contrat ne couvre que le socle livré, pas toute la parité.

`crates/rv-protocol` est la source des DTO. Son binaire `export-schema` produit
`v1.schema.json`. `scripts/generate-native-protocol.mjs` génère les bindings et la
validation à l'exécution dans le pilote TypeScript mobile. Ces fichiers générés
sont versionnés et vérifiés sans diff en CI.

## Transport et identité

- Découverte : `GET /.well-known/rocketvibe`, produit `rocketvibe`, protocole `1`,
  identité et génération persistantes, capacités effectives.
- Base HTTP : `/api/v1`, JSON UTF-8, credentials `Authorization: Bearer <token>`.
- Le développement écoute sur loopback. Utiliser HTTPS via un proxy pour un appareil.
- Les versions, types et capacités inconnus ne sont pas assimilés à Rocket.Chat.
- Dates RFC 3339 UTC ; IDs opaques ; positions / révisions en chaînes décimales.
- Erreurs métier : `{ code, request_id }`. Aucun texte SQL ou secret dans la réponse.

## Routes disponibles

| Méthode | Route | Usage |
|---|---|---|
| GET | `/health/live`, `/health/ready` | État du processus et de la base |
| POST | `/auth/login` | `{ username, password }` → session, expiration, utilisateur |
| POST | `/auth/logout` | Révoquer cette session et ses tickets WebSocket |
| GET | `/me`, `/users` | Compte courant ; annuaire de l'instance limité à 100 entrées |
| GET / POST | `/rooms` | Salons dont je suis membre ; créer `{ name, private }` |
| POST | `/direct-messages` | `{ user_id }` → DM unique pour cette paire |
| POST / DELETE | `/rooms/{room}/members/{user}` | Ajouter / retirer, propriétaire du salon uniquement |
| GET | `/rooms/{room}/messages?before=…&limit=…` | Historique décroissant, keyset, limite 1–100 |
| POST | `/rooms/{room}/messages` | `{ operation_id, text }` → message committé |
| GET | `/sync/snapshot` | Vue cohérente des salons, 50 messages récents par salon, curseur |
| GET | `/sync/changes?cursor=…` | Lot ordonné, curseur opaque suivant, `has_more` |
| POST | `/sync/ticket` | Ticket WebSocket à usage unique, valable 30 secondes |
| GET / upgrade | `/sync/socket?ticket=…&cursor=…` | Même format `SyncBatch`, replay puis suivi |

La création de compte est une commande locale, pas une inscription HTTP publique.
Les capacités `threads`, `reactions`, `uploads`, `push`, `e2ee`, `calls` sont fausses.
Les salons publics existent mais leur découverte / adhésion libre restent à livrer.
Les droits d'administration ne donnent pas accès aux conversations privées.

## Garanties de l'incrément

Une intention d'envoi garde `operation_id`. Même intention → même message ; même
ID avec un autre texte / salon → `409 operation_conflict`. La confirmation HTTP et
l'événement viennent de la même transaction. Les opérations d'envoi sont conservées
avec les messages ; pas de purge tant que la réservation durable des IDs supprimés
n'est pas implémentée.

Le séquenceur est transactionnel. La diffusion relit le journal PostgreSQL ; elle
peut rejouer les lots. L'intégrateur client doit appliquer le lot et son curseur
dans une même transaction locale avant de reprendre à ce curseur.

Les curseurs sont aléatoires et liés au compte / génération. Un curseur d'un autre
compte ou d'une autre génération produit `409 sync_reset_required`. Ils ne révèlent
pas les positions globales des événements inaccessibles. Une suppression d'adhésion
produit `room_removed` pour son ancien membre ; replay et historique filtrent les
messages avec les droits présents. Après logout la socket est fermée au prochain tick.

## Limites connues

- Le raccordement aux écrans, au stockage sécurisé et aux transactions SQLite des
  apps reste à faire. Les transports TypeScript et Rust sont des pilotes indépendants,
  non activés dans le registre des fournisseurs des apps.
- Snapshot non paginé, maximum 100 salons (refus explicite au-delà) et 50 messages
  récents par salon ; les autres messages se chargent par l'historique.
- Tickets et curseurs n'ont pas encore de politique de nettoyage. Le journal est
  conservé entièrement ; la rétention / reset automatique restent à livrer.
- Sessions valables 30 jours ; renouvellement et 2FA non livrés. La concurrence des
  calculs Argon2 est bornée, mais la limitation d'essais par compte / IP reste à faire.
- Le suivi WebSocket interroge le journal toutes les 250 ms et ferme les clients
  dont un envoi dépasse 5 s. Heartbeats, limites globales et charge restent à qualifier.
- Les réponses historiques / snapshots utilisent des transactions cohérentes,
  mais la garantie stricte de retrait en cours de diffusion exige encore un test
  et un ordonnancement de révocation avec les sockets. Ne pas annoncer cette
  version comme prête pour des données sensibles ou pour remplacer Rocket.Chat.
- Modifications / suppressions de messages, compteurs de non-lus et reste de la
  matrice sont absents. Une création de salon n'a pas encore de clé d'idempotence.

Ces limites délimitent le pilote ; elles ne réduisent pas le périmètre de la RFC.
