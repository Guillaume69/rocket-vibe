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
Le lien garde le serveur, son chemin de proxy et l'identité du compte ; un autre
compte ou une époque restaurée ne peuvent ouvrir le salon à sa place.

L'action « Répondre » sauvegarde dans WorkManager un identifiant d'opération,
l'entrée exacte et la portée avant son acquittement. Chaque tentative utilise
`POST /api/v1/rooms/{rid}/messages` avec le même `operation_id` et la même racine
de fil, sans bearer dans la file. Le texte est limité à 4 KiB dans cette action
pour respecter les 10 KiB de `Data` Android ; un dépassement affiche l'échec dans
la notification. Les écrans d'envoi conservent leur limite habituelle.
La famille, l'époque et l'utilisateur sont revérifiés à chaque reprise.

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
HTTP simulé ne ferme pas ce critère. Les notifications bureau via le flux natif
restent le lot suivant de P17. P17 / J3 ne sont pas déclarés terminés.
