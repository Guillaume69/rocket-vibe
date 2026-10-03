# Notifications natives — P17 / J3

RocketVibe réutilise le service FCM Android, les notifications `MessagingStyle`,
les liens vers les salons et `RemoteInput` du client existant. Le fournisseur
Rocket.Chat conserve son parcours `push.token` / `push.get` / `chat.sendMessage`.
Le push RocketVibe Android est annoncé côté client uniquement lorsque son
récepteur natif est raccordé ; iOS natif reste hors du périmètre de cette RFC.

## Configuration opérateur

`RV_FCM_CONFIG_FILE` (ou `--fcm-config-file`) désigne le JSON du compte de service
Firebase, conservé hors Git et lisible seulement par le processus serveur.
Son `project_id` désigne le projet Firebase utilisé pour construire l'app Android.
L'opérateur active l'API Firebase Cloud Messaging et autorise ce compte à envoyer
des messages. Le serveur utilise OAuth et la portée
`https://www.googleapis.com/auth/firebase.messaging`, avec renouvellement des
jetons par `gcp_auth`, puis l'API HTTP v1 de Google. Aucun jeton OAuth ne va aux clients.
Sans configuration, la découverte annonce `push:false` et le worker reste inactif.
Le registre et les droits restent accessibles pour retirer une inscription.

Dans un conteneur, monter le fichier en lecture seule puis définir
`RV_FCM_CONFIG_FILE=/run/secrets/firebase-service-account.json` ; ce fichier ne
doit jamais être copié dans l'image. La configuration de compilation Android
fictive utilisée localement n'autorise aucun envoi Firebase réel.

Références primaires : [FCM HTTP v1](https://firebase.google.com/docs/cloud-messaging/send/v1-api),
[messages de données](https://firebase.google.com/docs/cloud-messaging/customize-messages/set-message-type),
[codes d'erreur FCM](https://firebase.google.com/docs/cloud-messaging/error-codes).

## API et identité

- `PUT /api/v1/me/push`, bearer natif, corps strict `{token}` : inscrit le jeton
  FCM Android sur la famille de la session courante. Répond
  `{device_id,instance_id,data_epoch}`. Le client confirme la découverte puis
  conserve `nativePushDeviceId` dans la session SecureStore encore active.
- `DELETE /api/v1/me/push` : désinscription idempotente de cette famille, `204`.
  Logout, révocation d'appareil et expiration effective de la famille retirent
  aussi son inscription et ses notifications. La rotation du bearer la conserve.
- `GET /api/v1/push/notifications/{id}` : lecture privée exclusivement par la
  famille destinataire. Rend `{notification_id,device_id,instance_id,data_epoch,
  room,message}` avec les règles de lecture normales des citations / fichiers.
  Un autre appareil du même utilisateur ne peut pas lire cette notification.

Les lectures personnelles et les lots HTTP / WebSocket de `Message` ajoutent `personal_mention`, un booléen
optionnel calculé depuis les destinataires capturés à l'envoi. Le journal partagé
ne le conserve jamais. Une édition n'ajoute pas de destinataire ; les lecteurs
bureau ne déduisent donc pas une mention depuis un pseudo changé ou `@here`.

FCM reçoit uniquement `product`, `instanceId`, `dataEpoch`, `userId`, `deviceId`,
`notificationId`, `rid`, `messageId`, et éventuellement `tmid`. Aucun bloc
`notification`, contenu, mot de passe, bearer ou URL de serveur n'est envoyé.
Android choisit l'URL depuis la session locale qui correspond à toutes ces
identités. Il refuse les redirections HTTP ; la release exige HTTPS, le debug
autorise HTTP pour le banc local. La découverte est vérifiée avant chaque lecture
ou réponse. Un successeur déjà persisté d'une rotation interrompue peut être
utilisé sans lancer une seconde rotation depuis le récepteur.

## File et livraison

La migration `0036_push_notifications.sql` ajoute le registre, la génération du
jeton et les tâches. L'envoi d'un message, y compris une confirmation de fichier
ou une réponse de fil, capture ses destinataires dans **la même transaction**.
Un rejeu d'envoi ne crée pas de seconde notification. Éditions, aperçus et
activités système ne créent pas de nouvel événement push.

Éligibilité : autre auteur, compte actif, adhésion courante, push activé, statut
choisi autre que « occupé », aucun bail actif « en ligne / occupé ». Le réglage
« mentions uniquement » conserve les DM et les mentions capturées à l'envoi.
Les lectures de salon et de fil utilisent la position d'origine du message.
`@here` conserve les destinataires figés par la capture des mentions.

Les workers prennent au plus quatre tâches avec des leases de 60 secondes,
`SKIP LOCKED` et un identifiant de lease distinct. Ils revérifient l'éligibilité,
l'époque, la génération du jeton, l'activation du compte et la durée de l'adhésion.
OAuth et HTTP se font après le commit, sans transaction SQL ouverte.
Six tentatives maximum, délai exponentiel avec jitter, `Retry-After` et durée
maximale de 24 heures. Les tâches expirées sont purgées par la maintenance.
Une erreur FCM explicite `UNREGISTERED` retire seulement la génération concernée ;
un `INVALID_ARGUMENT` générique ne supprime pas un jeton potentiellement valide.
Les résultats tardifs d'une lease ou d'un jeton remplacé ne modifient pas le successeur.

La réponse de lecture conserve des verrous de droits, session, notification,
génération, message et état de lecture jusqu'à soumission du corps HTTP.
Une révocation, réadhésion, suppression ou nouvelle révision invalide une réponse
préparée. Un push déjà parti ne contient que des identifiants.

## Android existant

Le service affiche un texte générique et confie le fetch privé à WorkManager.
`onNewToken` conserve le dernier jeton FCM dans le stockage privé puis planifie
son inscription pour les familles natives déjà enregistrées, même sans runtime
JS. Les tâches sont sérialisées par famille et relisent le jeton courant et la
session SecureStore ; aucun bearer n'est persisté dans WorkManager.
Le rattrapage a huit essais maximum et exige le réseau. Refus définitifs et
identité de serveur changée retirent la notification générique.
La notification complète conserve le composant de conversation actuel, groupé
par instance / époque / compte / salon. Un marqueur durable déduplique les
livraisons, y compris après un crash serveur entre envoi FCM et acquittement.
Les non-lus à zéro et le retrait d'un salon effacent la notification de conversation.
Le lien garde le serveur, son chemin de proxy, le message / fil et l'identité du compte ; un autre
compte ou une époque restaurée ne peuvent ouvrir le salon à sa place.

L'action « Répondre » sauvegarde dans WorkManager un identifiant d'opération,
l'entrée exacte et la portée avant son acquittement. Chaque tentative utilise
`POST /api/v1/rooms/{rid}/messages` avec le même `operation_id` et la même racine
de fil, sans bearer dans la file. Le texte est limité à 4 KiB dans cette action
pour respecter les 10 KiB de `Data` Android ; un dépassement affiche l'échec dans
la notification. Les écrans d'envoi conservent leur limite habituelle.
La famille, l'époque et l'utilisateur sont revérifiés à chaque reprise.

## Bureau existant

Seuls les lots reçus sur le WebSocket connecté produisent des candidats, dans
la transaction SQLite qui applique leur curseur. Snapshot, rattrapage HTTP,
histoire déjà chargée, auteur courant, éditions, suppressions et activités
système restent silencieux. Une création exige `position == revision` et une
adhésion déjà connue. Après projection, lectures de salon / fil, suppression et
durée de l'adhésion sont revérifiées avant toute alerte.

Les préférences bureau sont chargées au raccord, actualisées par les réglages
locaux et relues toutes les 60 secondes. Une préférence initiale indisponible
garde les notifications silencieuses ; elle ne coupe pas la messagerie.
`all`, `nothing` et DM / mentions réutilisent la règle du client existant.
Un salon déjà visible dans la fenêtre active ne produit pas de notification.

GTK réutilise D-Bus pour la réponse inline KDE, GApplication pour les notifications
natives sans réponse inline, et les toasts Windows ; SwiftUI conserve
`UNUserNotificationCenter`. Les références OS portent une clé calculée depuis
serveur / compte / instance / époque / salon, sans credential. Un clic ou une
réponse vérifie l'adhésion d'origine et la présence du message. La réponse prend
le chemin d'envoi persistant habituel, avec la racine du fil si nécessaire.
Lectures, retrait du salon et préférence désactivée retirent les notifications.

Les références d'action sont bornées à 256 et persistées avant remise à l'OS
dans le SQLite du compte : message, salon, racine, adhésion, position et éligibilité.
Le registre ne duplique aucun texte, nom, credential ou corps de notification.
Une préférence encore inconnue au démarrage ne l'efface pas. Une nouvelle époque
le purge avec la projection ; une adhésion remplacée invalide ses callbacks.

Les modèles GTK / SwiftUI retrouvent le seul compte correspondant à la clé OS,
attendent connexion et salons, puis relisent message et racine par HTTP privé.
Le contrôle conserve l'adhésion capturée avant fermeture, avec gardes de compte,
requête, génération et réponses tardives. La réponse validée entre dans la même
transaction que son ID d'envoi et son reçu local par notification / empreinte de
texte ; un callback identique après réouverture ne crée pas une seconde outbox.

GNOME dispose de l'action `(clé, message)` dès le startup GApplication. Les
installations Linux créent aussi le service D-Bus du même ID et l'entrée desktop
annonce `DBusActivatable` / `X-GNOME-UsesNotifications`, suivant le
[contrat GNotification](https://docs.gtk.org/gio/class.Notification.html).
Le clic
Windows utilise `rocketvibe://notification?key=…&msg=…`, sans texte ou bearer,
via le protocole déjà enregistré par l'installeur ; le parser refuse doublons,
identifiants malformés et paramètres inattendus. SwiftUI traite le callback
`UNUserNotificationCenter` dans le modèle, même avant reprise du compte.
La réponse inline Windows à processus arrêté exige encore son activateur natif ;
la remise des anciens callbacks KDE à un nouveau processus reste ouverte.
Un callback reçu hors ligne attend encore en mémoire sa validation réseau avant
création de l'outbox. Les parcours système installés restent à qualifier sur Linux,
Windows et macOS ; P21 reste ouvert pour ces chemins et les anciens liens importés.
Les permaliens natifs et leur routage au démarrage utilisent le [contrat P21](ROOM_LINKS.md).

## Preuves et qualification encore ouverte

Tests PostgreSQL / HTTP : capture atomique, rejeu, concurrence, récupération de
lease, dernier essai en vol, backoff, rotation du bearer / FCM, purge de jeton,
logout, mentions / DM / présence / préférences, lectures de fils, retrait puis
réadhésion, époque restaurée, mauvaise famille, suppression et verrous de réponse.
Un serveur HTTP FCM simulé exerce les payloads et les réponses, avec vrais appels HTTP.
Tests TypeScript : inscription épinglée, refus de reçus tardifs ou étrangers,
API privée, navigation et identifiants de notification par compte.

Le passage par Firebase réel et le parcours sur **Android physique app arrêtée**
restent ouverts : réception, réveil WorkManager, langue, tap, réponse après perte
de confirmation, refus de permission et révocation. Une compilation ou un banc
HTTP simulé ne ferme pas ce critère. Les bancs bureau vérifient les créations sur
un vrai WebSocket, le rejeu, la transaction / rollback, les lectures, les préférences,
les réponses de fils, la suppression et la réadhésion. Une base sur disque est
fermée puis rouverte : résolution HTTP authentifiée, compte / époque, racine,
réponse identique et purge de restauration sont exercés. Un vrai binaire GTK est
démarré à la demande par D-Bus dans un XDG jetable, avec description et dispatch
de l'action avant activation normale ; il utilise une portée étrangère sans
compte, et ne prouve donc ni un clic sur un toast réel ni la navigation privée.
Ils ne prouvent pas les
interactions avec les notifications système installées. P17 / J3 ne sont pas
déclarés terminés.
