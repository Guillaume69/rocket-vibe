# Contrat de parité et backlog J0

Référence : [RFC 0001](../rfcs/0001-serveur-rocketvibe-rust.md), notamment §4,
§7–14 et §17. Les identifiants P01–P23 couvrent **chaque** ligne de sa matrice.
Ce document fixe les décisions de construction du 1er octobre 2026. Il ne
déclare pas les fonctions prévues disponibles ni une instance apte à la bascule.

## Inventaire vérifiable

[Inventaire généré](rocketchat-inventory.md), [version JSON](rocketchat-inventory.json).
`node scripts/inventory-rocketchat.mjs --check` fait échouer la CI si les sources
et le relevé divergent. Le scan porte sur les fichiers de production mobile,
drivers, modules natifs générés, cœur Rust, GTK, bindings et SwiftUI. Il exclut
tests, dépendances, sorties de build et types générés du protocole natif.
Les littéraux, déclarations de streams, ressources et sites d'appel sont relevés
séparément ; leur nombre n'est pas un nombre de requêtes distinctes.

Le parseur TypeScript lit aussi les appels génériques et multi-lignes. Pour Rust
et Swift, le scan lexical est complété par la revue des transports et paramètres
dynamiques ci-dessous. Les templates Kotlin du plugin sont inclus ; certaines
références de leurs commentaires sont également présentes. La chaîne de rendu
Swift n'effectue aucun appel REST propre : elle passe par `rv-ffi` ; ses chemins
d'avatars restent cependant recensés.

| Argument dynamique / transport | Résolution revue | Lot |
|---|---|---|
| Mobile `cheminHistorique(type)` / Rust `history_endpoint(kind)` | `channels.history`, `groups.history`, `im.history` | P06 |
| Mobile `ActionsRC.marques(chemin)` / Rust `actions::marked(endpoint)` | `chat.getPinnedMessages`, `chat.getStarredMessages` | P10 |
| Choix d'étoile | `chat.starMessage`, `chat.unStarMessage` | P10 |
| Upload d'une ligne d'outbox | `rooms.media/{rid}`, `rooms.mediaConfirm/{rid}/{fileId}` | P14 |
| Avatar multipart / retrait | `users.setAvatar`, `users.resetAvatar` | P16 |
| Mobile `transportExpo`, Rust `RestClient::upload` | Deux transports multipart ; leurs appelants fournissent les chemins ci-dessus | P14 / P16 |
| Mobile `urlFichierProtege`, Rust `fetch_protected` / `MediaClient::fetch` | Ressources `title_link`, `image_url`, `audio_url`, `video_url` ; origine vérifiée avant credentials | P14 |
| DDP `souscrire(nom, cle)` | `stream-room-messages`, `stream-notify-user`, `stream-notify-room`, `stream-notify-logged` ; clés fabriquées dans le driver | P06 / P12 / P16 |
| DDP handshake | `connect`, `login` avec reprise, `sub`, `unsub`, ping/pong ; aucune méthode métier | P01 / P06 |
| Push Android Kotlin | `GET push.get` et `POST chat.sendMessage`, session lue du SecureStore ; indépendant du JS | P17 |
| Extension iOS actuelle | `GET push.get` ; conservée côté RC, iOS natif hors périmètre RFC | P17 |
| Liens / citations | `channel`, `group`, `direct` avec `?msg=`, liens app `rocketvibe://salon/…` | P07 / P21 |

Les lectures secondaires restent dans certains écrans RC. Leur déplacement est
obligatoire dans les lots concernés. Le transport RC de garde refuse déjà les
requêtes d'une session native ; aucune route compatible RC n'est ajoutée au serveur.

## Schémas et disponibilité

Les DTO de [rv-protocol/parity.rs](../../crates/rv-protocol/src/parity.rs) font
partie du [schéma v1](v1.schema.json). Rust et le décodeur TypeScript exécutent
la même [fixture](v1.fixture.json), notamment avec des positions supérieures à
`2^53`. La racine `Contract.parity` sert à exporter les schémas et tester les
fixtures : aucun endpoint HTTP ne retourne cette racine artificielle.

Les champs de capacité ajoutés sont additifs. Un champ absent vaut faux. Le
mobile et le cœur bureau intersectent annonce serveur et fonctions effectivement
implémentées dans le client ; SwiftUI reçoit la liste stable par UniFFI, GTK
consulte le même cœur. Les droits restent une décision serveur par transaction.
Une capacité vraie ne suffit pas à autoriser un compte à inviter, modifier ou lire.

`Fournisseur.identite` mobile expose genre, origine, compte et, pour RocketVibe,
instance / génération. Le bureau conserve ces mêmes données dans `SessionInfo`.
Les diagnostics mobiles neutres gardent code, request ID natif, statut et délai ;
seul un refus compris d'une requête authentifiée indique une session rejetée.
Un défi 2FA reste distinct. Le cœur bureau conserve ses erreurs structurées ;
`request_id` et le délai serveur traversent aussi les diagnostics et erreurs
bureau / UniFFI ; un retry différé conserve l'identité du refus serveur.

### Droits et lectures

Rôles de salon : propriétaire, modérateur, membre. Les permissions sont des
booléens précis associés au salon / message et à sa révision. Elles servent au
rendu, ne sont jamais acceptées dans une commande cliente. L'administration de
l'instance ne donne aucun accès implicite à un salon privé ou à une clé E2EE.
Inviter, retirer, épingler, modifier les réglages et éditer autrui sont distincts.
Choix initial : création de salon par compte authentifié, invitation privée par
propriétaire. Le premier lot J2 expose les lectures de droits, les rôles
propriétaire / modérateur / membre et l'application transactionnelle de la lecture
seule et des restrictions de création. Les commandes de réglage, de rôles et de
départ sont disponibles côté serveur / transports : [contrat P04](ROOMS.md).
Les lectures et commandes durables sont raccordées aux fiches existantes des
trois clients. Les composeurs utilisent le droit effectif de rédaction, mis
en cache par génération / version du salon et toujours imposé par le serveur.

`ReadState` sépare positions racines / réponses et compteurs. Seuls les nouveaux
messages visibles d'autres auteurs augmentent les non-lus ; édition, réaction,
message système et envoi propre ne les augmentent pas. Une réponse augmente le
compteur du fil et `unread_replies`, sans ajouter une racine fictive. Les badges
existants affichent racines + réponses ; mention nominative et `@all` / `@here`
sont séparées et comptées une fois par message. Une lecture avance par maximum
transactionnel de positions sur deux appareils ; suppression ou retrait diminue
les compteurs sans changer la position de lecture. Le favori est personnel.

Le premier lot [P05](READ_STATE.md) livre les états personnels des racines,
lectures monotones et favoris avec reçus côté serveur / transports. Les mentions
nominatives et `@all` sont résolues à l'envoi ; les queues SQLite et reprises
réseau des deux clients sont livrées. Les favoris sont raccordés aux fiches / menus
existants GTK, SwiftUI et mobile, avec état confirmé et reprise de la demande
originale. Badges confirmés, séparateurs de position capturée et minuteries
recevant l'ID visible / l'adhésion d'ouverture sont raccordés dans les trois
interfaces. `read_markers` est activée, sans lecture d'un dernier message du
cache lors d'un retry. Les essais sur applications installées restent ouverts ;
les réponses sont réservées à P11 et `@here` aux baux P12.

Par défaut, une adhésion donne accès à l'historique entier du salon. Ce choix est
annoncé au propriétaire lors d'une invitation ; un réglage "depuis l'adhésion"
nécessite ensuite sa borne durable et ses tests sur toutes les lectures. Ni ce
réglage ni l'adhésion ne distribuent automatiquement les clés E2EE historiques.

Édition : révision attendue et opération persistante ; délai initial proposé de
15 minutes pour l'auteur, configurable. Suppression : tombstone et réservation
durable d'ID. Réactions / favoris / épingles sont des états explicites
`present`, jamais des toggles. Les favoris de messages ne sont diffusés qu'à
leur propriétaire. Les commandes refusent champs inconnus et droits forgés.

Les réactions sont implémentées côté serveur, GTK, SwiftUI et mobile dans les
interfaces existantes. Les aliases sont partagés et les opérations conservées
dans SQLite avant l'envoi ; une reprise garde son identité même après réception
du journal. Une action différente attend la résolution de l'intention en cours
pour ce message. Des tests PostgreSQL / WebSocket et SQLite sur disque couvrent
réponse perdue, alias, retrait, ancien reçu, quotas, droits, suppression et reprise.
Le parcours GTK sous Xvfb vérifie les pastilles ; les modèles Swift consomment
les bindings et le stockage sécurisé réels. Les essais sur appareils restent ouverts.

### Épingles et étoiles

Les épingles et étoiles sont raccordées aux menus et listes marquées existants
des trois clients. Les opérations gardent leur identité après un redémarrage.
Les épingles exigent un propriétaire ou modérateur ; une étoile reste personnelle,
y compris en lecture seule. Sa révision indépendante empêche un événement public
de l'effacer et un ancien événement privé de rétablir un message supprimé.
Les listes sont paginées par position de création ; une page incohérente ne modifie
pas le cache. Les parcours PostgreSQL / SQLite et modèles Swift sont vérifiables
sur le banc jetable ; les essais sur appareils restent une condition externe.

### Contenu, fichiers et clés

`MessageContent` distingue Markdown clair et enveloppe chiffrée. Mentions et
citations sont des références typées ; une citation ne contourne pas les droits
du salon source. Les autorisations / extraits sont calculés à la lecture.
Une citation chiffrée reste dans le ciphertext ; aucun extrait clair n'est
accepté à côté. `FileDescriptor` contient ID protégé, taille décimale, empreinte
et type ; aucun URL tiers à authentifier. Le nom d'un fichier chiffré est absent.

Préparation et confirmation d'upload portent une identité persistante. La même
confirmation donne le même message ; un résultat perdu se consulte. Les octets
sont finalisés avant commit SQL, puis réconciliés avec les orphelins. Le
[cycle clair](FILES.md) est livré côté serveur / SDK ; outboxes et lecteurs
des apps restent à raccorder avant leur activation.

Les contrats de clés ne contiennent que clés publiques, sauvegardes chiffrées et
enveloppes pour destinataires nommés. Leur `format` est opaque en J0. Le sel /
UID historique et les paramètres KDF ont leurs champs propres. **Le protocole
crypto et ses garanties ne sont pas définis par ces DTO** : J4 exige une
spécification séparée et une revue, avant d'annoncer E2EE. Aucun format de fixture
n'est utilisable pour chiffrer. Aucun secret / ciphertext n'implémente `Debug`.

### Routes figées pour les lots suivants

Toutes sont relatives à `/api/v1` ; seules celles du [README](README.md) sont
disponibles. Entrées conditionnelles et quotas seront validés par le domaine.

| Lot | Routes réservées |
|---|---|
| Auth | `POST /auth/challenges/{id}/verify`, `/auth/challenges/{id}/email`, `/auth/refresh`, `/auth/recovery`; `GET/DELETE /sessions/{id}` |
| Droits / profils | `GET /me/permissions`, `/rooms/{id}/permissions`, `/users/{id}` ; `PATCH /me`, `/me/preferences`, `/rooms/{id}` |
| Salons | `GET /rooms/discover`, `POST /rooms/{id}/join`, `GET /rooms/{id}/members` ; `PUT/DELETE /rooms/{id}/favorite` |
| Messages | `GET/PATCH/DELETE /messages/{id}`, `GET/POST /messages/{id}/replies`, `GET /rooms/{id}/search` |
| Actions | `PUT/DELETE /messages/{id}/reactions/{emoji}`, `/messages/{id}/pin`, `/messages/{id}/star` ; `GET /rooms/{id}/pins`, `/rooms/{id}/stars` |
| Lecture / états | `PUT /rooms/{id}/read`, `/rooms/{id}/typing`, `/me/presence` |
| Fichiers | `POST /uploads`, `PUT /uploads/{id}/bytes`, `POST /uploads/{id}/complete`, `DELETE /uploads/{id}`, `GET /files/{id}` |
| Push / rendu | `PUT/DELETE /devices/{id}`, `GET /notifications/{id}`, `/emoji` |
| Clés / appels | Préfixes `/e2ee` et `/calls`, détails dans leurs spécifications dédiées |

Les erreurs ont code stable et request ID. `401 session_rejected` révoque une
session authentifiée ; refus métier `403`, révision divergente `409 revision_conflict`,
identité divergente `409 operation_conflict`, curseur périmé `409 sync_reset_required`,
quota `429` avec `Retry-After`. Un événement obligatoire inconnu bloque l'avance
du curseur. Les détails structurés bornés de conflits seront ajoutés avec J2.

## Corpus de rendu

[Fixture commune](rendering.fixture.json) : Unicode, styles imbriqués, code,
citations, listes, titre, mentions, liens, emojis standard / custom, HTML littéral,
permalien masqué et photos / documents / vocaux / vidéos / fichiers cités.
Elle traverse le parseur / aperçu mobile, le renderer GTK et la projection UniFFI
en runs stylés utilisée par SwiftUI. Un JSON `md` corrompu doit conserver le texte.
L'aperçu de citation peut prendre la vignette ; la visionneuse prend le fichier
image complet. Ces deux références sont explicitement testées dans la fixture.
Les manifests de fichiers natifs sont traduits vers ces modèles de présentation.
Ces tests de rendu ne remplacent pas les essais visuels sur appareils (§17).

## Backlog complet

"Socle" signifie une partie livrée, pas la sortie du jalon. Chaque case reste
ouverte tant que serveur, clients concernés et scénario de parité manquent.

| ID / RFC §4 | Lot | État et prochaine condition de sortie |
|---|---|---|
| P01 Découverte / comptes / sessions | J1–J2 | Rotation / reprise sécurisée, appareils, inscription sur invitation, récupération opérateur / email dans les trois clients existants livrés ; qualification des appareils / trousseaux à poursuivre |
| P02 2FA | J2 | TOTP / secours, réauthentification, adresse vérifiée / retrait, défis OTP, facteur email et récupération email dans les 3 clients livrés ; qualification sur appareils et SMTP externe à poursuivre |
| P03 Multi-serveurs | J1 | Isolation livrée ; validation appareils / liens et générations après restauration |
| P04 Salons / DM | J1–J2 | DM / membres, création idempotente, découverte / join, détails et commandes durables de réglages / rôles / départ dans les 3 fiches existantes, droits effectifs de rédaction dans les composeurs livrés ; qualification des applications installées ouverte |
| P05 Favoris / non-lus / mentions | J2 | États personnels, lectures monotones, mentions nominatives / @all et favoris avec reçus livrés ; queues SQLite, reprises et buffers ouverts liés à l'adhésion livrés ; favoris, badges confirmés, séparateurs et timers d'ID visibles raccordés dans les 3 interfaces ; qualification des applications installées ouverte ; réponses P11 et @here P12 |
| P06 Historique / temps réel | J1–J2 | Socle, snapshots matérialisés et barrière de révocation livrés ; tombstones / actions J2 |
| P07 Markdown / emojis / citations | J2–J3 | Documents natifs et corpus commun adaptés aux renderers existants ; références, extraits et fichiers autorisés raccordés aux cartes, caches et contrôles de réponse des 3 clients ; libellé indisponible, purge d'aperçu et intentions durables livrés ; citations sur deux niveaux avec accès indépendant à chaque source, parcours GTK / modèles Swift et fournisseur mobile contre PostgreSQL vérifiés ; activités de salon structurées et traduites livrées ; catalogue custom et qualification installée ouverts |
| P08 Envoi / brouillons | J1 | Socle livré ; crash réel après commit / réponse perdue, Android ↔ Windows |
| P09 Édition / suppression | J2 | API, droits / délais, tombstones, intentions SQLite et menus / éditeurs des 3 clients livrés ; parcours appareils à qualifier |
| P10 Réactions / épingles / étoiles | J2 | API idempotente, alias, épingles, étoiles privées, intentions SQLite et menus / listes existants des 3 clients livrés ; qualification appareils à poursuivre |
| P11 Fils | J2 | API, racines / réponses séparées, compteurs, lectures par fil et brouillons / outbox durables raccordés aux écrans de fil GTK / SwiftUI / mobile existants ; citations dans un fil, rejeu après suppression de racine et purge d'adhésion couverts ; [contrat](THREADS.md), qualification installée ouverte |
| P12 Présence / saisie | J2 | Baux par appareil, photos WebSocket séparées du journal, expiration et émission / écoute raccordées aux composeurs et indicateurs existants ; @here résolu à l'envoi ; [contrat](LIVE.md), qualification installée ouverte |
| P13 Recherche | J2 / J4 | Recherche PG autorisée, pages bornées, édition / suppression et résultats temporaires raccordés aux écrans existants ; [contrat](SEARCH.md). Index local du chiffré et purge au verrouillage encore ouverts avec J4 ; qualification installée ouverte |
| P14 Photos / documents / vidéos / vocaux | J3 | Cycle serveur / SDK livré ; intentions persistantes, reprise / abandon, cache privé, fichiers cités et composants mobile / GTK / SwiftUI existants raccordés ; [contrat](FILES.md). Banc du cœur et composeur GTK / modèles Swift contre PostgreSQL ; module mobile à reconstruire, codecs et qualification installée ouverts, chiffré J4 |
| P15 Liens / cartes | J3 | DTO, métadonnées bornées et refus SSRF ; lecteurs existants |
| P16 Profils / réglages | J2–J3 | API, volume durable, reçus, fiches publiques et formulaires personnels des trois interfaces existantes raccordés ; statut, bio, langue, notifications, avatars protégés, intentions persistantes, preuve / abandon et DM par UID ; noms / photos des listes et en-têtes bureau raccordés ; [contrat](PROFILES.md). Compilation macOS validée en CI ; qualification installée à compléter |
| P17 Push / notifications | J3 | Tâches durables, FCM et Kotlin, navigation / réponse idempotente ; téléphone app arrêtée |
| P18 E2EE existant | J4–J5 | Import opaque / paramètres historiques, lecture / envoi depuis cache vierge |
| P19 E2EE autonome | J4 | Spécification / revue, identités, sauvegardes / nouveaux appareils, rotation / clé perdue |
| P20 Jitsi | J4 | Réunions autorisées, JWT courts, démarrer / rejoindre ; essai service / révocation |
| P21 Partage / liens profonds | J3 / J5 | Instance / compte explicites, résolution import, pas de session choisie par un lien tiers |
| P22 Langues / ergonomie / mises à jour | Transversal | UI conservée ; traductions des nouveaux codes et non-régression des 3 plateformes |
| P23 Administration | J2 / J5 | Bootstrap, invitations / récupération, CLI de comptes / droits / désactivation, salons / membres / réglages, reçus, audit et diagnostic raccordés ; création / adhésion dans les apps P04 ; [contrat](ADMINISTRATION.md). Import / restauration et exploitation J5, qualification installée ouverts |

Ordre d'exécution : garanties restantes J1, puis P01/P02/P04/P05/P09–P13/P16/P23
pour J2, J3, J4, J5. Les validations exigeant une ressource externe sont consignées
et n'empêchent pas le travail indépendant sur les lots suivants. La matrice reste
obligatoire avant de déclarer la RFC achevée.

## Hypothèses de construction et validations externes

Sans solliciter l'utilisateur pendant le chantier, on adopte un **banc initial**
de 100 comptes, 50 appareils connectés simultanément, 100 salons par compte et
1 million de messages clairs ; hôte de référence proposé : 2 vCPU / 4 Gio,
PostgreSQL et fichiers locaux. Ce sont des cibles de mesure à publier, pas des
capacités promises. Limites actuelles : snapshot matérialisé 64 Mio / pages 1 Mio,
ancienne route 8 Mio, lots 1 Mio, 128 sockets
par processus. Fichiers proposés : 100 Mio par objet, quota initial 50 Gio à
configurer ; ne pas annoncer ces limites avant leur application effective.

Inscription publique désactivée, invitation opérateur, profils de base accessibles
aux comptes authentifiés, email privé. Ancienneté de session / 2FA exigée pour
changements sensibles. Maintien du driver Rocket.Chat pendant tous les jalons et
aucune suppression automatique à la bascule ; protocole v1 évolue de façon additive.
La capture en maintenance est le premier backup cohérent ; objectif de répétition
proposé RPO 24 h / RTO 1 h, à mesurer avant engagement d'exploitation.

Les faits suivants ne peuvent pas être déduits du dépôt : droits et format exact
d'export source, clés historiques disponibles, machine d'hébergement, credentials
SMTP / Firebase / Jitsi, responsable d'exploitation, période réelle d'archive,
acceptation de la perte / durée de restauration. Ils restent conditions de J4/J5,
sans bloquer l'implémentation. Aucun import privé ni gel de la source ne sera fait
sur la base d'une hypothèse. La revue crypto indépendante et le téléphone Android
physique sont également des validations externes, pas des tests simulables en CI.
