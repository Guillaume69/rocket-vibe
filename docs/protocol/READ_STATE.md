# Lectures, non-lus et favoris de salons — P05

Serveur et transports Rust / TypeScript. Les contrôleurs durables et leur
raccordement aux interfaces existantes restent à livrer.
Les capacités clientes `read_markers` et `favorites` restent donc masquées.

## État personnel

`GET /api/v1/rooms/{id}/read` retourne `ReadState` pour le compte authentifié,
avec adhésion actuelle obligatoire, y compris pour un administrateur. Le même
état optionnel est attaché à `Room.read_state` dans les listes, snapshots et
événements `room_upsert`. Un ancien serveur v1 peut omettre ce champ.
Il est ajouté après filtrage des destinataires et des adhésions, dans la même
vue transactionnelle que la lecture. Le journal partagé ne stocke jamais ces
données personnelles ; les limites de taille incluent les champs ajoutés.
La remise HTTP / WebSocket conserve les barrières de révocation existantes.

Trois versions ont des usages distincts :

- `revision`, position décimale globale, ordonne l'ensemble de l'état personnel ;
- `favorite_revision`, version décimale du favori, sert au contrôle concurrent
  de cette préférence. Messages et lectures ne rendent pas un formulaire de
  favori obsolète ;
- `membership_version`, nonce opaque de la durée d'adhésion, change après
  retrait / réadhésion. Un changement de rôle ne le modifie pas.

La révision des métadonnées `Room.revision` reste indépendante. Un événement
personnel ne doit pas invalider les droits ou les détails du salon. Les clients
doivent comparer séparément les versions des métadonnées et de l'état personnel,
ainsi que leur identité / génération et la durée d'adhésion.

## Lecture monotone

`POST /api/v1/rooms/{id}/read` accepte uniquement `MarkRead` :
`root_position` et `reply_position`, chaînes décimales canoniques non négatives.
Le serveur avance par maximum transactionnel. Un ancien appareil ne ramène
jamais la lecture en arrière ; un retry identique ne consomme pas de quota et
ne publie pas un second événement. Une position supérieure au dernier message
du salon produit `409 invalid_read_position`. Les nouveaux avancements sont
limités à 60 par minute et compte, indépendamment des autres commandes.

Les non-lus comptent les nouveaux messages racines d'autres auteurs après la
position de lecture. Édition et réaction ne les augmentent pas ; supprimer un
message non lu les diminue sans avancer cette position. Envoi propre exclu.
Les compteurs et positions restent des chaînes, même au-delà de `2^53`.
Une nouvelle adhésion initialise sa lecture au dernier message existant ;
l'historique antérieur reste accessible, sans ajouter un arriéré de badges.
La migration adopte la même règle pour les adhésions existantes.

`reply_position` et `unread_replies` valent actuellement `"0"`. Une position de réponse non nulle produit
`422 unsupported_feature` jusqu'au lot P11. Les réponses restent un incrément distinct.

## Mentions

À l'envoi original, le serveur dérive les destinataires depuis le Markdown.
Les pseudos natifs sont exacts et sensibles à la casse. Ils doivent correspondre
à un membre actif du salon ; l'auteur et les personnes extérieures sont exclus.
Les répétitions ne comptent qu'une fois par message. `@all` vise les autres
adhérents actifs au moment de l'envoi. Un message qui
mentionne directement un destinataire et contient aussi `@all` compte dans
`mentions`, avec priorité sur `group_mentions` : aucun double badge.

Le parseur [pulldown-cmark](https://docs.rs/pulldown-cmark/0.13.4/pulldown_cmark/)
identifie la structure Markdown ; ses offsets source conservent les échappements.
Code en ligne / blocs, citations, liens et labels d'images ne déclenchent pas de
mention. Les adresses email et URL brutes sont également exclues. Les noms
formatés en gras / italique restent reconnus. Aucun ID de destinataire fourni
par le client n'est accepté. La limite de texte reste 32 768 octets.

Les compteurs ne concernent que les messages non lus et non supprimés. Une
édition peut retirer une mention originale en supprimant son token ; elle ne
peut ajouter de destinataire ni rétablir une mention retirée auparavant. Lire
ou supprimer le message retire le badge. Une nouvelle adhésion ne récupère pas
de notification historique, tout en gardant accès à l'historique.

`@here` attend les baux de présence P12 : il reste du texte sans notification
dans ce lot. Il ne signifie jamais `@all`. Le catalogue / rendu complet des
mentions dans les trois clients sera qualifié avec P07 / P12.

## Favori explicite et reçu

`PUT /api/v1/rooms/{id}/favorite` accepte `SetRoomFavorite` :
`operation_id`, `expected_revision` égal à la `favorite_revision` observée,
et `present`. Le favori est privé, exige une adhésion et utilise le quota
des commandes de salon : 30 nouvelles commandes par minute et compte.
Les champs inconnus et une identité de destinataire forgée sont refusés.
Un conflit de version produit `409 revision_conflict`.

La réponse est un `RoomCommandReceipt` personnel minimal. Le client peut le
relire via `GET /api/v1/rooms/{id}/commands/{operation}` après une réponse
perdue, sans seconde écriture et même après le départ du salon. Le reçu ne
projette pas une valeur de favori : le client relit l'état actuel. Rejouer
l'opération originale rend le même reçu sans rétablir une ancienne préférence,
même après retrait / réadhésion. Réutiliser son ID avec un autre corps ou dans
un autre domaine de commande produit un conflit.

Le retrait supprime l'état personnel serveur. À la réadhésion, la préférence
repart à faux avec une nouvelle durée d'adhésion et une nouvelle version.
Les lectures d'état et de reçu restent possibles pendant `Retry-After` ;
aucun secret ou ancienne préférence n'est rendu à un autre compte.

## Vérification

Six cas Markdown et dix scénarios PostgreSQL / HTTP couvrent deux appareils concurrents, envois
propres et suppressions, confidentialité du journal, retrait / réadhésion,
versions indépendantes des rôles, conflits et champs forgés. Le transport
mobile réel simule une réponse de favori perdue et retrouve le reçu sans
seconde écriture ; son ancien rejeu ne rétablit pas le favori supprimé. Il
vérifie aussi mentions dédupliquées, retrait par édition et lecture du message.
Le quota réel de lecture garde disponibles l'état, les reçus et les favoris ;
un retry ancien reçu par le serveur ne consomme aucun avancement.
