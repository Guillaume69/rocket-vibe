# Fils natifs — P11

Le serveur Rust et les fournisseurs mobile / bureau utilisent les écrans de fil,
listes de messages, menus et composeurs existants. Le fournisseur Rocket.Chat
conserve ses routes et son modèle `tmid` ; RocketVibe annonce `threads` et utilise
`reply_to` / `root_id`. La qualification des applications installées reste ouverte.

## Racines et réponses

`POST /api/v1/rooms/{room}/messages` accepte un `SendMessage.reply_to` optionnel.
Son absence conserve l'envoi d'une racine et l'empreinte idempotente antérieure.
Une réponse conserve le même ID d'opération, texte, citations et racine lors
d'un retry ou d'un redémarrage. Changer de racine sous le même ID donne un conflit.

La racine doit appartenir au même salon, être un message confirmé non supprimé,
sans parent ni activité système. Une racine inconnue / d'un autre salon retourne
`404`, une réponse utilisée comme racine `422 invalid_thread_root`, et une racine
supprimée `410 thread_root_deleted`. Le reçu d'une réponse déjà committée reste
rejouable après suppression de sa racine, pour un adhérent actuel du salon.

`Message.reply_to` identifie les réponses. Une racine reçoit `Message.thread`
avec `replies` en décimal exact et `last_reply_at`. Le nombre compte uniquement
les réponses non supprimées. Création et suppression d'une réponse publient
aussi une nouvelle révision de la racine sans changer sa position de création.
L'historique du salon et sa liste principale ne contiennent que les racines.

`GET /api/v1/messages/{root}/thread?before=…&limit=…` retourne `ThreadPage` :
racine, réponses par position décroissante, `has_more` et état personnel.
La limite vaut 50 par défaut, entre 1 et 100. La vue transactionnelle et les
barrières de livraison comprennent également les sources des citations.
Une racine supprimée reste consultable comme tombstone avec ses anciennes réponses.
L'administration de l'instance ne donne aucun accès implicite à un fil privé.

Les snapshots gardent au plus 50 racines **et** 50 réponses récentes par salon.
Un afflux de réponses ne chasse donc pas toutes les racines de la fenêtre.
L'ouverture d'un fil complète ensuite son historique par pages. Les projections
mobiles et bureau vérifient le salon, la racine, les positions exactes et la durée
d'adhésion avant le commit SQLite ; un échec ne confirme aucune intention.

## Lectures indépendantes

`POST /api/v1/messages/{root}/thread/read` reçoit `{ position }`, capturée depuis
une réponse confirmée effectivement affichée. `ThreadReadState` contient
`root_id`, `room_id`, `membership_version`, `position`, `revision` et `unread`.
Positions, révisions et compteurs restent des chaînes canoniques, y compris
au-delà de `2^53`.

La lecture avance par maximum, sans revenir en arrière après un ancien reçu.
Elle n'efface ni les non-lus des racines ni ceux des autres fils. Les lectures
globales de salon acceptent désormais `reply_position` ; une lecture de réponse
effective prend le maximum de cette position et de celle du fil. Les compteurs
et mentions de salon utilisent la même règle. Les envois propres, éditions,
réactions et activités système n'ajoutent pas de non-lus.

Les caches persistants conservent une intention par fil. Un reçu couvrant une
ancienne observation n'efface pas une observation plus récente. Nouvelle
adhésion : positions initialisées au maximum du salon sans arriéré historique.
Retrait, changement de génération ou de durée d'adhésion : suppression des
brouillons, intentions et messages privés du fil, puis refus des callbacks anciens.

## Composeurs et qualification

Chaque fil possède son propre brouillon, distinct du salon. GTK et SwiftUI
réutilisent leurs panneaux ; le mobile utilise `/fil/[id]`. Le droit du salon et
la disponibilité de la racine contrôlent l'envoi. Une racine supprimée conserve
le brouillon et rend le fil consultable sans accepter de nouvelle réponse.
Les citations utilisent les cartes et contrôles existants, y compris dans un fil.

Les tests PostgreSQL couvrent pagination, lectures monotones / indépendantes,
mentions, droits, suppression, rejeu et retrait. Les caches SQLite couvrent
redémarrage sur disque, positions exactes, rollback et anciennes adhésions.
Le fournisseur mobile réel vérifie une confirmation perdue et un rejeu après
suppression de racine. Les parcours GTK et modèles Swift utilisent leur interface
et trousseau existants contre PostgreSQL. Android physique, Windows installé et
application macOS restent des validations externes explicitement ouvertes.
