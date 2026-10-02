# Informations, membres et paramètres des salons — P04

Le serveur et les transports Rust / TypeScript exposent ces routes v1. Les fiches
de salon mobile, GTK et SwiftUI existantes lisent leurs informations depuis le
fournisseur choisi. Les contrôleurs Rust et mobile sauvegardent les commandes
avant HTTP et reprennent leur reçu personnel après coupure. Les contrôles de
paramètres, de rôles et de départ restent à raccorder dans les trois fiches ;
l'annonce serveur ne les active pas seule dans l'UI.

## Lectures

`GET /rooms/{id}` retourne `RoomDetails` : salon de base, révision opaque des
détails, sujet, description, annonce, lecture seule, nombre de membres et droits
effectifs du lecteur. `GET /rooms/{id}/members` retourne `RoomMemberPage` : comptes
publics, rôle et indicateur de désactivation. Aucun email ni secret n'est exposé.
Les deux lectures exigent une adhésion actuelle, y compris pour l'administrateur
de l'instance ; un salon absent ou inaccessible renvoie `404 not_found`.

La liste des membres est ordonnée par ID, par pages de 50. `next` devient le
paramètre `after` de la page suivante, accompagné de la même `revision`. Un
changement de paramètres ou d'adhésion produit `409 revision_conflict` : le
client recommence la liste au lieu d'assembler deux versions. Une sortie puis
réadhésion, ou un rôle modifié puis rétabli, changent aussi la révision.

Cette révision suit les paramètres et la composition / les rôles du salon ;
elle ne fige pas les fiches publiques des utilisateurs. Les messages ne la
modifient pas. La révision de journal `Room.revision` reste une position décimale
et est publiée dans `room_upsert` après un changement, y compris invitation,
retrait et adhésion publique. Les clients peuvent alors invalider leurs détails.

Les lectures revérifient identité, session, adhésion, autorité et révision des
détails avant de livrer le corps HTTP. Les verrous PostgreSQL restent détenus
jusqu'à sa soumission, avec la limite temporelle des autres lectures. Un payload
préparé avant une révocation ou un changement de révision n'est pas livré.

## Commandes

| Route | Corps | Droit |
|---|---|---|
| `PATCH /rooms/{id}` | `UpdateRoom` | Propriétaire, hors DM |
| `PUT /rooms/{id}/members/{user}/role` | `ChangeRoomRole` | Propriétaire, cible membre active, hors DM |
| `POST /rooms/{id}/leave` | `LeaveRoom` | Membre actuel, hors DM |
| `GET /rooms/{id}/commands/{operation}` | Aucun | Auteur authentifié du reçu |

Chaque commande contient une `operation_id` originale et `expected_revision`,
la révision de détails lue par le formulaire. Les champs inconnus, identités
d'acteur et droits fournis par le client sont refusés. Les droits sont recalculés
sous verrou : une UI obsolète n'accorde rien.

`UpdateRoom` fournit tous les paramètres : `name`, `private`, `topic`,
`description`, `announcement`, `read_only`. Le nom est normalisé par `trim`,
non vide, sans caractères de contrôle et limité à 128 octets UTF-8. Le sujet est
limité à 1 024 octets ; description et annonce à 4 096 chacune. NUL est refusé.
Une conversion public / privé conserve les membres actuels. La lecture seule
autorise encore les propriétaires / modérateurs à écrire. Un DM ne peut être
converti, réglé, quitté ni recevoir un transfert de rôle par ces routes.

Plusieurs propriétaires sont possibles. Pour transférer la responsabilité,
promouvoir un membre en propriétaire, relire les détails, puis rétrograder
l'ancien propriétaire ou le faire partir. La dernière propriété ne peut être
retirée : `409 last_room_owner`. Les commandes concurrentes sont sérialisées
sur le salon et refusent les révisions devenues obsolètes.

## Réponses perdues et limites

SQLite conserve au plus une intention non résolue par salon : corps fermé,
identifiant original, révision du formulaire et état en attente / échec définitif.
Un formulaire identique réutilise le candidat original, même après réception
d'une révision plus récente. Un formulaire différent reste bloqué ; seul un
échec définitif peut être effacé explicitement puis remplacé. Une coupure ou
une limite de débit conserve le candidat pour la reprise avec backoff.

Chaque tentative relit d'abord le reçu personnel. Seul `404 not_found` autorise
l'envoi du corps sauvegardé ; une autre réponse n'est pas interprétée comme une
absence de commande. Un reçu valide efface exactement son intention, sans
projeter d'anciens réglages. Les commandes partagent la file de mutations de la
session. Identité / génération et durée de vie sont revérifiées ; un retrait
du salon purge ses formes privées et une réadhésion ne les ressuscite pas.

Une commande réussie retourne `RoomCommandReceipt`, limité à `operation_id`,
`room_id`, `applied_revision`. Le reçu PostgreSQL est lié au compte et conserve
une empreinte de commande, sans texte des réglages ni liste des membres.
Le même ID / corps retourne le reçu original, même après départ ou rétrogradation
de l'auteur. Cela ne restaure jamais une adhésion, un rôle ou un ancien paramètre.
Un corps ou salon différent pour cet ID produit `409 operation_conflict`.
Le reçu privé reste consultable après perte du droit sur le salon. Il ne donne
aucun accès aux détails actuels ni au reçu d'un autre compte.

Les IDs partagent l'espace existant des envois, créations de salons et actions
de messages. Un ID déjà employé dans un autre domaine est refusé. Une modification
annule les snapshots matérialisés ou en construction concernés et publie le
salon mis à jour. Un départ ajoute aussi `room_removed` pour son auteur.

La limite est de 30 nouvelles commandes réussies par minute et par compte.
Un `429 room_command_limit` inclut `Retry-After`. Les lectures et les reçus
restent accessibles ; un reçu déjà enregistré ne consomme pas ce quota.
Les deux transports appliquent le même budget `room_command` aux nouvelles
mutations et laissent passer les lectures / reçus durant le délai.

Une UI doit sauvegarder son intention, son ID et sa révision avant HTTP, puis
consulter le reçu après une réponse perdue. Ce raccordement durable dans les
trois clients fait partie du lot P04 suivant ; ce document ne déclare pas P04 fini.
