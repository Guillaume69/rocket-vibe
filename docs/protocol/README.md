# Protocole natif RocketVibe — premier incrément

Le serveur est expérimental. La [RFC 0001](../rfcs/0001-serveur-rocketvibe-rust.md)
décrit la destination ; ce contrat ne couvre que le socle livré, pas toute la parité.

`crates/rv-protocol` est la source des DTO. Son binaire `export-schema` produit
`v1.schema.json`. `scripts/generate-native-protocol.mjs` génère les bindings et la
validation à l'exécution dans le pilote TypeScript mobile. Ces fichiers générés
sont versionnés et vérifiés sans diff en CI.

La [recherche native en salon](SEARCH.md) utilise PostgreSQL, des résultats
temporaires et les écrans existants ; son index local chiffré reste lié à J4.

Les [documents Markdown natifs](MARKDOWN.md) sont traduits vers les renderers
existants aux frontières des fournisseurs. Le texte source reste présent ;
ce contrat ne transporte pas le format `md` Rocket.Chat.

Le [contrat de citations natives](QUOTES.md) décrit les références, la résolution
par lecteur et les protections de remise ; son raccordement aux cartes existantes
reste un lot distinct avant l'annonce de la capacité.

## Transport et identité

Le [contrat temporaire de présence et saisie](LIVE.md) définit les deux routes
PUT, `GET /api/v1/live` et les photos WebSocket négociées avec `live=true`.
Ces photos ne modifient ni le journal ni le curseur de reprise.

- Découverte : `GET /.well-known/rocketvibe`, produit `rocketvibe`, protocole `1`,
  identité et génération persistantes, capacités effectives.
- Base HTTP : `/api/v1`, JSON UTF-8, credentials `Authorization: Bearer <token>`.
- Le développement écoute sur loopback. Utiliser HTTPS via un proxy pour un appareil.
- Les versions, types et capacités inconnus ne sont pas assimilés à Rocket.Chat.
- Dates RFC 3339 UTC ; IDs opaques ; positions / révisions en chaînes décimales.
  La révision de `RoomPermissions` est un jeton opaque combinant politique et
  adhésion ; elle ne se compare pas comme une position du journal.
- Erreurs métier : `{ code, request_id }`. Aucun texte SQL ou secret dans la réponse.
- `429` conserve cette enveloppe et ajoute `Retry-After` en secondes entières.
  Les transports natifs gardent le délai (borné à 5 min) par famille login / ticket / snapshot,
  sans révoquer la session ni bloquer la consultation ou le logout.
- Le transport Rust conserve l'identité du refus et son délai dans le fournisseur,
  les erreurs bureau et UniFFI ; un retry différé localement garde le même request ID.

## Routes disponibles

Les [contrats de parité J0](PARITY.md), le [backlog complet](PARITY.md#backlog-complet)
et l'[inventaire Rocket.Chat](rocketchat-inventory.md) décrivent les lots suivants.
Les DTO `parity` du schéma sont des contrats de destination et des fixtures ; leur
présence ne déclare pas les endpoints correspondants disponibles.

| Méthode | Route | Usage |
|---|---|---|
| GET | `/health/live`, `/health/ready` | État du processus et de la base |
| POST | `/auth/login` | `{ username, password }` → session, expiration, utilisateur |
| POST | `/auth/start` | Mot de passe → `AuthenticationStep` ; aucun bearer avant facteur pour un compte protégé |
| POST | `/auth/factors/verify` | `FinishFactor` → session avec candidat durable ; reprise de la même validation |
| GET | `/me/factors` | Méthodes, version et secours restants |
| GET | `/me/email` | Contact vérifié privé, versions et contexte ; réponse `no-store` |
| POST | `/me/email/verification/start`, `/me/email/verification/resume`, `/me/email/verification/confirm`, `/me/email/verification/retire` | Vérification privée et reprise du candidat original ; [file SMTP durable et bornes](EMAIL.md) |
| POST | `/me/email/removal/start`, `/me/email/removal/resume`, `/me/email/removal/retire` | Retrait conditionnel du contact privé, reprise du reçu et annulation de l’intention originale ; disponible sans SMTP |
| POST | `/me/factors/totp/setup`, `/me/factors/totp/enable`, `/me/factors/totp/disable` | Inscription prouvée et gestion après authentification récente |
| POST | `/auth/invitations/accept` | `{ token, username, password }` → utilisateur ; anonyme, sans session ni droit admin |
| POST | `/auth/recovery` | `{ token, username, new_password }` → utilisateur conservé ; révoque les anciennes sessions, login normal ensuite |
| POST | `/auth/logout` | Révoquer cette session et ses tickets WebSocket |
| GET | `/me`, `/users` | Compte courant ; annuaire de l'instance limité à 100 entrées |
| GET | `/me/permissions` | Droits effectifs de création et d'administration |
| GET | `/rooms/{room}/permissions`, `/messages/{message}/permissions` | Droits fins pour un membre actuel ; sinon `404` |
| GET / POST | `/rooms` | Salons dont je suis membre ; créer `{ name, private, operation_id? }` |
| GET | `/rooms/discover?q=…&after=…`, `/rooms/public?q=…&after=…` | Noms des salons publics, 20 entrées, `PublicRoomPage` ; alias identiques |
| POST | `/rooms/{room}/join` | Adhérer soi-même à un salon public ; rejouable |
| POST | `/direct-messages` | `{ user_id }` → DM unique pour cette paire |
| POST / DELETE | `/rooms/{room}/members/{user}` | Ajouter / retirer, propriétaire du salon uniquement |
| GET / PATCH | `/rooms/{room}` | Détails et paramètres versionnés ; modification par le propriétaire hors DM |
| GET | `/rooms/{room}/members?after=…&revision=…` | Membres / rôles, pages de 50, adhésion actuelle obligatoire |
| PUT | `/rooms/{room}/members/{user}/role` | Rôle explicite, révision attendue et opération persistante |
| POST | `/rooms/{room}/leave` | Départ versionné hors DM ; protection du dernier propriétaire |
| GET | `/rooms/{room}/commands/{operation}` | Reçu privé de l'auteur, également après départ |
| GET | `/rooms/{room}/messages?before=…&limit=…` | Racines par position décroissante, keyset, limite 1–100 |
| POST | `/rooms/{room}/messages` | `{ operation_id, text, quotes?, reply_to? }` → message committé |
| GET | `/messages/{root}/thread?before=…&limit=…` | Racine et réponses paginées avec état personnel |
| GET / POST | `/messages/{root}/replies` | Route réservée de parité : même page de fil ; envoi avec racine implicite |
| POST | `/messages/{root}/thread/read` | Position observée, lecture monotone de ce seul fil |
| GET | `/messages/{id}` | Message courant ou tombstone, pour un membre actuel |
| PATCH | `/messages/{id}` | `EditMessage` avec opération et révision attendue ; Markdown clair |
| DELETE | `/messages/{id}` | Corps `DeleteMessage` avec opération et révision attendue ; tombstone |
| PUT | `/messages/{id}/reactions` | `{ operation_id, emoji, present }` → état courant du message |
| GET | `/sync/snapshot` | Vue cohérente des salons, 50 racines et 50 réponses récentes par salon, curseur |
| POST | `/sync/snapshots` | Matérialiser une vue immuable ; première `SnapshotPage` |
| GET | `/sync/snapshots/{token}` | Page suivante liée au compte ; curseur uniquement sur la dernière |
| GET | `/sync/changes?cursor=…` | Lot ordonné, curseur opaque suivant, `has_more` |
| POST | `/sync/ticket` | Ticket WebSocket à usage unique, valable 30 secondes |
| GET / upgrade | `/sync/socket?ticket=…&cursor=…` | Même format `SyncBatch`, replay puis suivi |

La création de compte est une commande locale, pas une inscription HTTP publique.
La capacité [`threads`](THREADS.md) est activée ; `uploads`, `push`, `e2ee`, `calls` restent fausses.
`reactions` annonce les ajouts / retraits explicites, disponibles dans les trois clients.
`room_discovery` annonce l'annuaire et l'adhésion ; `idempotent_room_creation`
annonce les reçus de création. Leurs handlers sont disponibles dans les trois clients.
Les droits d'administration ne donnent pas accès aux conversations privées.

`fine_permissions` annonce les lectures de droits. Les booléens décrivent
l'autorité du compte ; les capacités de fonctionnalité doivent également être
disponibles avant d'offrir une action. La présence de `edit: true` ne déclare donc
pas, à lui seul, une route disponible. L'auteur dispose de 15 minutes pour éditer,
le propriétaire / modérateur peut supprimer et épingler, et un salon en lecture
seule bloque les nouveaux envois de membres ordinaires. Les propriétaires seuls
invitent / retirent et règlent les salons hors DM. Chaque mutation revérifie ses
droits en transaction. Un reçu d'une création / d'un envoi déjà committé peut
toujours être consulté par son auteur membre après restriction, sans nouvelle écriture.
Les changements de rôle, politique de salon et droits du compte changent leur
version ; une réponse préparée avant eux est revalidée et leurs mises à jour
attendent la fin d'une livraison déjà autorisée. Aucune autorité cliente forgée
n'est acceptée dans les commandes.

### Inscription sur invitation

Le [contrat d'authentification P02](AUTHENTICATION.md) détaille les routes TOTP /
secours, la clé opérateur hors PostgreSQL, les quotas, la reprise après réponse
perdue et les validations restantes. `second_factors` est additive et dépend
de la configuration de clé ; les méthodes viennent du défi. Le socle serveur /
SDK ne signifie pas encore que les écrans des trois clients sont raccordés.

La capacité additive `account_invitations` autorise le formulaire des clients
natifs. Les anciens serveurs qui l'omettent et Rocket.Chat gardent leur parcours
de connexion. La CLI opérateur émet un code CSPRNG de 32 octets, valide 1–168 h
(7 jours par défaut). PostgreSQL conserve son SHA-256 et la génération des
données. Aucun chemin d'inscription publique ni droit admin saisi par le client.

`POST /auth/invitations/accept` est anonyme, strict et `no-store`. Il crée un
utilisateur sans session, puis le client utilise le login normal. Mot de passe :
au moins 12 caractères et au plus 1 024 octets ; identifiant ASCII, lettres,
chiffres, tirets ou underscore, 1–128 octets. L'invitation lie un seul UID.
Une confirmation perdue retrouve ce compte avec ses identifiants actuels tant
que le code reste valide ; elle ne crée jamais un deuxième compte. Mot de passe
vérifié avec Argon2, sans empreinte rapide de mot de passe. Une consommation
survit à la suppression du compte et ne rend pas le code réutilisable.

Le serveur revérifie génération, état du compte et expiration après les verrous.
Codes invalides, expirés, révoqués ou liés à d'autres identifiants rendent
`400 invitation_rejected` ; entrées mal formées : `400 invalid_request`.
Les quotas persistants de connexion (global / IP / identifiant) sont partagés
avec cette route, plus 10 admissions par code et minute. Argon2 partage les
quatre places de connexion, retenues pendant le calcul malgré une annulation.
Révoquer le code ne désactive pas le compte qu'il a déjà créé. Les clients
vérifient instance / génération avant et après création / login et comparent
l'UID avant de sauvegarder la session. Code et mot de passe restent transitoires.

### Récupération de mot de passe

`account_recovery` permet la variante des écrans de connexion existants. La CLI
émet un code de 32 octets pour un propriétaire de compte vérifié par l'opérateur,
conservé sous SHA-256, lié à son UID, autorité actuelle et génération. Durée
1–24 h ; 3 codes actifs par compte, 1 000 par génération. Le code d'invitation
ne peut servir de code de récupération et réciproquement.

L'entrée anonyme stricte change le hash Argon2 et l'autorité de connexion, révoque
les appareils, leurs sessions / tickets / reçus et les reprises de snapshots / journal.
Elle conserve UID, permissions, conversations et données de chiffrement. Elle
retourne `User` avec `no-store`, puis le client exécute le login normal. Aucun
facteur indépendant n'est désactivé et aucune clé E2EE n'est récupérée.

Un reçu lié à la nouvelle autorité permet le rejeu pendant cinq minutes avec
le nouveau mot de passe, sans nouvelle réinitialisation ni révocation des sessions
postérieures. Les autres codes sont révoqués. Expiration après attente de verrou,
changement d'autorité / génération, compte désactivé ou mauvais code donnent
`400 recovery_rejected`. Quotas de connexion global / IP / identifiant partagés,
plus 10 tentatives par code et minute ; même limite Argon2 avec maintien du permis
après annulation. Le login revérifie son hash sous verrou, empêchant un ancien
mot de passe vérifié avant la récupération de créer une session après elle.

### Renouvellement et appareils

`POST /auth/renew` prend `{operation_id,next_token}` avec le bearer actuel.
Le client produit le prochain secret avec un CSPRNG (32 octets, hexadécimal
minuscule) et le conserve dans le stockage sécurisé **avant** la requête. Le
serveur stocke uniquement des empreintes, conserve l'identité de l'appareil,
renouvelle l'expiration de 30 jours et invalide l'ancien bearer et ses tickets.
Les réponses de connexion / renouvellement portent `Cache-Control: no-store`.

Une confirmation perdue se reprend avec le secret suivant déjà conservé, ou
avec la même intention pendant cinq minutes. Proposer un autre successeur depuis
ce bearer consommé révoque la famille de l'appareil. Les autres appareils restent
valides. Limites : 10 nouveaux renouvellements par appareil et minute, 64 appareils
actifs par compte ; les reçus identiques ne consomment pas à nouveau le quota.

`GET /me/sessions` expose uniquement les appareils du compte, leurs noms, dates,
expiration et indicateur `current`. `PATCH /me/sessions/{id}` renomme un appareil ;
`DELETE` révoque sa famille, ses reçus et tickets. Un identifiant d'un autre compte
ne peut modifier ni révoquer sa session. Aucun bearer ni empreinte n'est exposé
dans la liste. Révoquer un autre appareil exige une connexion datant de moins
de 15 minutes ; une rotation ne renouvelle pas cette ancienneté. Les primitives
de reprise Rust / TypeScript sont raccordées aux clients existants : SecureStore
mobile, Secret Service / Credential Manager GTK et Keychain Swift. GTK et Swift
sérialisent leurs écritures avec un fichier de verrou vide commun ; aucun secret
de renouvellement ne rejoint SQLite. Les écritures déjà engagées conservent le
verrou si leur appelant est annulé. La connexion et un contrôle quotidien déclenchent
un renouvellement à moins de deux jours de l'expiration. Les paramètres existants
des trois clients listent et renomment les appareils et révoquent une autre
session après connexion récente. L'appareil courant utilise le parcours de
déconnexion existant. La date d'activité est actualisée au plus une fois toutes
les cinq minutes par trafic authentifié ; ce suivi saute un appareil verrouillé
au lieu de retarder la requête et ne prolonge pas la connexion récente.
La qualification sur systèmes / appareils réels reste dans P01.

### Réactions

Les shortcodes standard proviennent de la table emoji-toolkit utilisée par les
clients. Les alias d'un glyphe sont canonicalisés, avec ou sans `:` ; Unicode
brut et noms inconnus sont refusés. L'état est unique par message, compte et emoji.
Un reçu réutilise l'opération persistée sans réappliquer un ancien état : rejouer
un ajout après un retrait retourne le message actuel. Une opération déjà utilisée
avec un autre contenu est refusée. L'adhésion actuelle est exigée, y compris pour
consulter un reçu ; la lecture seule bloque les nouvelles réactions de membres.

Limites : 16 réactions par auteur et message, 32 groupes et 256 participations
par message ; 30 nouvelles actions de message par compte et minute, partagées
avec édition / suppression. Les reçus existants contournent ce quota ; `429`
fournit `Retry-After`. Un changement augmente la révision et émet un upsert sans
changer la position de création ni le marqueur d'édition. La suppression du
message efface les participations et remplace ses anciens événements par le tombstone.

### Épingles et étoiles personnelles

`PUT /messages/{id}/pin` et `/star` prennent `{operation_id,present}`.
Un propriétaire ou modérateur épingle ; chaque membre peut étoiler pour lui-même,
y compris en lecture seule. Les nouveaux états d'un message supprimé sont refusés.
Les reçus retournent l'état actuel sans rejouer une ancienne intention. Le quota
d'actions est partagé avec réactions, éditions et suppressions.

`pinned` appartient à la révision publique du message. `personal_star` contient
uniquement l'état du compte qui lit et sa propre révision décimale ; les événements
publics omettent ce champ. Un changement d'étoile publie un événement réservé à
son propriétaire sans changer la révision publique ni le marqueur d'édition.
La suppression efface les étoiles et épingles, ainsi que leurs anciens événements.

`GET /rooms/{id}/pins` et `/stars` utilisent `limit` (1–100) et `before`, position
de création exclusive, avec `has_more`. Les étoiles d'un autre compte sont exclues.
Les clients valident toutes les pages avant de projeter le résultat ; ils refusent
les positions non décroissantes et les messages d'un autre salon.

### Édition et suppression

L'édition accepte actuellement `MessageContent.plain` avec Markdown et listes
de mentions / citations / fichiers vides. Les autres contenus sont refusés comme
indisponibles. L'auteur édite pendant 15 minutes s'il peut envoyer ; auteur dans
ce délai ou propriétaire / modérateur supprime. L'édition d'autrui n'est pas
accordée par la propriété du salon. `409 revision_conflict` distingue un état
concurrent de `409 operation_conflict`, qui signale une identité réutilisée.

Un reçu appliqué se rejoue sans nouvelle publication et retourne l'état actuel,
y compris un tombstone après suppression. Il reste lié au compte et à la commande
complète. Création, envoi et actions ne peuvent réutiliser une identité entre eux.
L'envoi initial conserve son empreinte même après édition ; son replay ne restaure
ni l'ancien texte ni un message supprimé. Les reçus d'action gardent des empreintes,
aucun texte. Ces empreintes servent à comparer les commandes.

`Message.deleted: true` porte un texte vide ; `edited_at` marque une édition.
Ces champs sont additifs dans v1 et la diffusion garde `message_upsert`. La position
de création ne change pas, la révision avance. Les clients récents cachent le
tombstone mais conservent sa révision pour refuser les anciennes réponses. Lors
d'un reset, ils remplacent l'historique confirmé par la fenêtre du snapshot,
conservent brouillons / outbox des salons présents et rejettent les réponses
commencées avant cette projection. L'historique antérieur se recharge par pagination.
Cette étape livre transport et intégration des événements ; les commandes
persistantes et menus d'actions des trois clients sont le lot suivant.

La mutation change la version d'autorité du salon, attend ses livraisons et
invalide les vues matérialisées de ses participants. Une construction en cours
est trouvée par son compte même si ses IDs de salon ne sont pas encore publiés.
La suppression réserve le message et efface les charges antérieures du journal
actif. Le traitement de la rétention des sauvegardes appartient à J5.

### Création et découverte des salons

Les clients récents enregistrent l'identité de création dans SQLite avant la
requête. Un formulaire interrompu reprend la même identité et le même nom / genre
après réessai ou redémarrage ; ils ne lancent pas automatiquement une autre création.
Après réception du résultat, le formulaire est terminé ; une création ultérieure
est une nouvelle intention. Un serveur natif plus ancien reçoit encore `{name,private}`.

Les reçus PostgreSQL sont liés au compte et persistants. Un rejeu renvoie le même
salon sans événement supplémentaire, après vérification de son adhésion ; une
identité utilisée avec un autre nom / genre ou une opération d'envoi produit
`409 operation_conflict`. `operation_id` reste facultatif pour les anciens clients
v1, qui n'ont donc pas cette garantie de création. Le nom est normalisé par `trim`.

L'annuaire expose uniquement les métadonnées publiques, recherche une sous-chaîne
littérale sans joker et utilise l'ID du dernier résultat comme `after`. Il ne
donne accès ni aux messages ni aux adhésions des autres comptes. Chaque livraison
retient les salons publics et revérifie leur nom / révision / visibilité ; une
visibilité devenue privée invalide une réponse préparée. L'adhésion ne vise que
l'acteur, conserve un rôle existant et publie un `room_upsert` avec une nouvelle
révision pour les membres actuels. Les salons privés, DM et IDs absents renvoient
le même `404`. Les [détails / rôles et réglages P04](ROOMS.md) décrivent les
commandes versionnées, les reçus et la protection du dernier propriétaire.

## Garanties de l'incrément

Une intention d'envoi garde `operation_id`. Même intention → même message ; même
ID avec un autre texte / salon → `409 operation_conflict`. La confirmation HTTP et
l'événement viennent de la même transaction. Les opérations d'envoi sont conservées
avec les messages ; tombstones et reçus continuent de réserver leurs identifiants.

Le séquenceur est transactionnel. La diffusion relit le journal PostgreSQL ; elle
peut rejouer les lots. L'intégrateur client doit appliquer le lot et son curseur
dans une même transaction locale avant de reprendre à ce curseur.

Les curseurs sont aléatoires et liés au compte / génération. Un curseur d'un autre
compte, d'une autre génération, expiré (7 jours sans renouvellement) ou élagué
(512 curseurs maximum par compte) produit `409 sync_reset_required`. Ils ne révèlent
pas les positions globales des événements inaccessibles. Une suppression d'adhésion
produit `room_removed` pour son ancien membre ; replay et historique filtrent les
messages avec les droits présents. Après logout la socket est fermée au prochain tick.

### Révocation pendant une livraison

Une lecture capture la version opaque de chaque adhésion et la génération avant
de construire son résultat. Juste avant livraison, le serveur revérifie ces
versions, le compte et la session puis conserve des verrous PostgreSQL sur ces
lignes. Un retrait / changement de rôle, logout, compte désactivé ou restauration
attend la fin de cette livraison autorisée ; un retrait suivi de réadhésion ne
valide pas une réponse préparée avec l'ancienne autorisation.
Une activation de compte porte également une version opaque. Les transactions
d'écriture retiennent et revérifient compte / session jusqu'au commit ; un acteur
authentifié avant un logout ou une désactivation ne peut pas publier ensuite.
La gestion des curseurs possède son verrou séparé : une écriture attendant le
séquenceur ne bloque pas la lecture du dernier watermark committé.

Les réponses JSON remettent un seul corps au transport HTTP sous ce verrou ; la
socket conserve son verrou jusqu'à la fin de l'envoi de la trame. Une réponse
abandonnée libère le verrou. Un corps HTTP non consommé expire après 5 secondes
et ne peut plus produire de contenu ; l'envoi WebSocket garde son délai de 5 s.
Les verrous sont en base, y compris entre deux processus serveur. Les incréments
du séquenceur restent compatibles avec le verrou de génération.

Une course détectée avant remise HTTP donne `409 delivery_revalidate` ; le client
reprend avec ses intentions locales conservées. La socket relit le journal depuis
son dernier curseur envoyé. L'événement minimal `room_removed` passe sans exposer
le salon ; aucune charge utile ne le suit sur cette connexion tant qu'une nouvelle
adhésion n'est pas accordée. Un autre salon autorisé continue sur la même socket.
Les vues matérialisées retiennent également leur ligne de validité pendant remise.

Ces garanties portent sur l'autorisation et l'ordre d'émission serveur. Des octets
déjà remis au transport peuvent être tamponnés et arriver plus tard sur un autre
réseau / une autre connexion ; aucun mécanisme ne les efface sur un appareil.
Tout endpoint futur d'historique, recherche ou fichiers doit utiliser cette même
barrière, avec son propre transfert borné pour les objets.

Une socket inactive reçoit au moins toutes les 15 secondes un `SyncBatch` vide,
avec son curseur courant et `has_more: false`. Le pilote mobile ferme et reprend
une connexion n'ayant reçu aucune trame pendant plus de 45 secondes.

### Snapshots matérialisés

La capacité additive `snapshot_paging` annonce les deux nouvelles routes. Les
clients mobiles et bureau l'utilisent lorsqu'elle est présente et conservent la
route historique pour les serveurs v1 antérieurs. `snapshot_id` et `page_index`
identifient une vue capturée dans une unique transaction PostgreSQL repeatable read.
Les pages sont immuables : une arrivée pendant le téléchargement sera rejouée après
le curseur final. Aucun curseur n'est publié sur une page intermédiaire.

Une vue contient au plus 1 000 salons, 50 racines et 50 réponses récentes par salon, 1 Mio de JSON
par page et 64 Mio au total. Elle expire 5 minutes après réservation ; 4 vues par
compte et 16 dans l'instance, admissions concurrentes sérialisées en base. Refus
`429 snapshot_busy` avec délai de 30 s ou `409 snapshot_limit` ; un échec de
matérialisation annule ses pages et restitue sa réservation. Une construction
annulée sans résultat reste bornée par ces quotas jusqu'à expiration.

Chaque page revérifie compte, génération et adhésions. Un retrait invalide toutes
les vues du compte dans la transaction de révocation ; une nouvelle adhésion ne
réactive aucun ancien token. Expiration, restauration ou retrait donnent
`409 sync_reset_required`. Le nettoyage supprime 8 vues périmées par passage et
cascade sur leurs pages, sans purger le journal ni les messages.

Les clients vérifient identité, ordre, doublons, références, taille, tokens locaux
et présence du seul curseur final avant de remplacer atomiquement leur cache.
Ils bornent l'assemblage à 128 pages / 64 Mio / 5 minutes. Rust borne également
les octets reçus avant décodage, y compris une réponse chunked ; le fetch mobile
tamponne son corps natif puis contrôle la taille avant parsing, et interrompt dès
un Content-Length trop grand. La qualification de mémoire sur Android reste ouverte.

## Limites connues

- Le [mobile](../NATIVE_MOBILE_PILOT.md) et les clients [GTK / SwiftUI](../NATIVE_DESKTOP_PILOT.md)
  utilisent leurs écrans existants pour les deux fournisseurs. Les essais manuels
  sur appareils restent ouverts.
- Route historique de snapshot non paginé : maximum 100 salons (refus explicite au-delà) et 50 racines / 50 réponses
  récents par salon ; taille JSON maximum 8 Mio, refus `409 snapshot_limit` sans
  création de curseur ni réponse partielle. Les autres messages se chargent par
  l'historique. Les clients actuels utilisent les pages matérialisées décrites ci-dessus.
- Lots HTTP / WebSocket : maximum 100 événements scannés et 1 Mio de JSON. Le
  curseur n'avance pas au-delà d'un événement livré dans le lot suivant.
- Tickets valables 30 s, maximum 4 non consommés par session. Le démarrage et un
  passage chaque minute nettoient par lots de 1 000 les sessions, tickets, curseurs
  et quotas périmés, sans attendre les lignes verrouillées. Le journal reste conservé.
- Sessions valables 30 jours et renouvelables ; 2FA non livré. La concurrence des
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
- La barrière de livraison et les révocations HTTP / WebSocket sont testées en
  PostgreSQL ; la charge, les appareils et les fonctions restantes de la RFC
  doivent encore être qualifiés avant de remplacer une instance Rocket.Chat.
- Modifications / suppressions disponibles dans les clients existants, avec
  intentions SQLite et révisions attendues. Les compteurs de non-lus et le reste
  de la matrice restent ouverts. La création est idempotente sur les clients récents.

Ces limites délimitent le pilote ; elles ne réduisent pas le périmètre de la RFC.
