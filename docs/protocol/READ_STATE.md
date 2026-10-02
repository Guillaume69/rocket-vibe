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

## Caches clients

Le mobile et le cœur bureau gardent l'état personnel dans une table SQLite
séparée des métadonnées du salon. Une réponse personnelle ancienne ne rétablit
pas un favori ; une ancienne révision de salon n'écrase pas son nom actuel.
Une mise à jour personnelle conserve les droits effectifs tant que la révision
des métadonnées reste la même. Les réponses HTTP identiques ne réécrivent pas
l'état et ne réarment pas les minuteries de lecture.

Un snapshot ou événement autorisé portant une nouvelle `membership_version`
purge les anciennes données privées, brouillons et intentions du salon, puis
invalide les réponses d'historique / commandes en vol. Le changement de rôle
conserve cette durée d'adhésion et les intentions courantes. Une réponse HTTP
ne peut changer elle-même la durée d'adhésion du cache. Les caches sans témoin
d'adhésion ne peuvent prouver que leurs anciennes intentions ont survécu à un
retrait manqué : leur premier snapshot portant ce témoin les purge également.
Le bureau récupère les témoins déjà présents dans ses anciens payloads de salon.

Le composeur capture aussi cette durée d'adhésion à son ouverture. Lecture,
sauvegarde et effacement de brouillon, ainsi qu'ajout à l'outbox, vérifient
ce témoin dans la même transaction SQLite que l'écriture. Un flush de démontage
ou une sauvegarde différée de l'ancien écran ne peut donc réintroduire son texte
après la purge, ni effacer le nouveau brouillon. Les buffers et formulaires ouverts
sont remis à zéro quand le témoin change ; une mise à jour de rôle les conserve.
Le mobile attend la première lecture du témoin avant de monter le composeur.

Les deux clients conservent maintenant leurs intentions dans des tables privées
`native_read_intents` / `native_favorite_intents`. Le renderer fournit l'ID du
message réellement observé ; seul un message confirmé du même salon peut être
enregistré. Les positions observées se regroupent par maximum exact, sans prendre
le dernier message du cache au moment du retry. Une réponse antérieure n'efface
pas une observation plus récente, et l'enregistrement seul ne réarme aucun timer.

Le favori enregistre une fois son ID, sa durée d'adhésion, sa révision attendue et
sa valeur explicite. Une autre valeur ne remplace pas une tentative non résolue.
Le runner relit le reçu original ; seul `404 not_found` autorise le PUT original.
Un reçu sauvegardé devient une borne de version : la commande reste confirmée
jusqu'à un état actuel dont `favorite_revision` couvre cette borne. Après crash,
une lecture d'état reprend cette confirmation sans second PUT. Un refus permanent
reste conservé et exige l'effacement explicite de son ID exact avant remplacement.

Les lectures relisent d'abord l'état pour récupérer un acquittement perdu, puis
renvoient seulement la position observée sauvegardée. Les délais de lecture et de
favori sont séparés ; un quota de lecture laisse le journal, les envois et favoris
disponibles. Identité, génération, projection et durée d'adhésion sont revérifiées
autour des requêtes. Une connexion modernise un cache sans témoin d'adhésion par
snapshot avant de rejouer ses intentions.

Les capacités clientes restent masquées jusqu'au raccordement et à la qualification
des badges, boutons et minuteries des interfaces existantes.
