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
- `429` conserve cette enveloppe et ajoute `Retry-After` en secondes entières.
  Les transports natifs gardent le délai (borné à 5 min) par famille login / ticket,
  sans révoquer la session ni bloquer la consultation ou le logout.

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
compte, d'une autre génération, expiré (7 jours sans renouvellement) ou élagué
(512 curseurs maximum par compte) produit `409 sync_reset_required`. Ils ne révèlent
pas les positions globales des événements inaccessibles. Une suppression d'adhésion
produit `room_removed` pour son ancien membre ; replay et historique filtrent les
messages avec les droits présents. Après logout la socket est fermée au prochain tick.

Une socket inactive reçoit au moins toutes les 15 secondes un `SyncBatch` vide,
avec son curseur courant et `has_more: false`. Le pilote mobile ferme et reprend
une connexion n'ayant reçu aucune trame pendant plus de 45 secondes.

## Limites connues

- Le [mobile](../NATIVE_MOBILE_PILOT.md) et les clients [GTK / SwiftUI](../NATIVE_DESKTOP_PILOT.md)
  utilisent leurs écrans existants pour les deux fournisseurs. Les essais manuels
  sur appareils restent ouverts.
- Snapshot non paginé, maximum 100 salons (refus explicite au-delà) et 50 messages
  récents par salon ; taille JSON maximum 8 Mio, refus `409 snapshot_limit` sans
  création de curseur ni réponse partielle. Les autres messages se chargent par
  l'historique. La pagination de snapshots matérialisés reste à livrer.
- Lots HTTP / WebSocket : maximum 100 événements scannés et 1 Mio de JSON. Le
  curseur n'avance pas au-delà d'un événement livré dans le lot suivant.
- Tickets valables 30 s, maximum 4 non consommés par session. Le démarrage et un
  passage chaque minute nettoient par lots de 1 000 les sessions, tickets, curseurs
  et quotas périmés, sans attendre les lignes verrouillées. Le journal reste conservé.
- Sessions valables 30 jours ; renouvellement et 2FA non livrés. La concurrence des
  calculs Argon2 reste bornée à 4 par processus après annulation HTTP. Connexion :
  10 essais par pseudo, 30 par IP TCP et 120 au total par fenêtre de 60 s, en base
  et conservés après redémarrage ; `429 auth_busy` / `auth_rate_limited` avec délai.
  Aucun en-tête de proxy n'est accepté comme preuve d'IP ; derrière un proxy,
  ses clients partagent le quota. La configuration de proxies approuvés reste ouverte.
- Le suivi WebSocket interroge le journal toutes les 250 ms et ferme les clients
  dont un envoi / une fermeture dépasse 5 s. Limite de 128 sockets par processus,
  4 par session ; `429 socket_limit` avec délai dès la demande de ticket, puis
  nouveau contrôle à l'upgrade pour les courses concurrentes. Les heartbeats sont
  présents ; la charge et les déploiements multiprocessus restent à qualifier.
- Les réponses historiques / snapshots utilisent des transactions cohérentes,
  mais la garantie stricte de retrait en cours de diffusion exige encore un test
  et un ordonnancement de révocation avec les sockets. Ne pas annoncer cette
  version comme prête pour des données sensibles ou pour remplacer Rocket.Chat.
- Modifications / suppressions de messages, compteurs de non-lus et reste de la
  matrice sont absents. Une création de salon n'a pas encore de clé d'idempotence.

Ces limites délimitent le pilote ; elles ne réduisent pas le périmètre de la RFC.
