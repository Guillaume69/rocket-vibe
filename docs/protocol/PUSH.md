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

Les modèles GTK / SwiftUI retrouvent le seul compte correspondant à la clé OS.
Un clic attend connexion et salons, puis relit message et racine par HTTP privé,
avec gardes de compte, requête, génération et réponses tardives.

Une réponse entre dans l'outbox avant reprise du compte ou appel HTTP : texte,
ID d'envoi, reçu par notification / empreinte de texte et destination capturée
sont inscrits ensemble. Les captures à froid utilisent une transaction SQLite
`IMMEDIATE` pour sérialiser des connexions indépendantes ; deux callbacks
concurrents ou rejoués retrouvent le même ID. Le texte utilise le stockage normal
des messages en attente, sans nouvelle copie ni bearer. Au plus 256 réponses
non résolues sont acceptées ; le dépassement est refusé, sans éviction silencieuse.

Le rejeu ordinaire exclut ces réponses, y compris après « Réessayer ». Le moteur
rattrape le journal, vérifie l'époque et l'adhésion d'origine, puis relit message
et vraie racine avec les credentials actuels avant envoi. Une racine non encore
en cache n'empêche pas la capture hors ligne. Un refus permanent conserve le
texte dans le message en échec existant ; retry / abandon gardent leur parcours.
Une lecture ou préférence retire le toast sans perdre une réponse déjà capturée ;
retrait / réadhésion, déconnexion avec purge et nouvelle époque effacent ses données
avec le reste de la projection.

Avant soumission HTTP, un marqueur de tentative est persisté. Après perte de la
confirmation, la lecture privée de l'ID d'envoi peut confirmer le message du même
compte / salon / fil sans répondre de nouveau à une notification entre-temps
supprimée. Les gardes de projection et d'adhésion restent appliquées autour de
ce fetch. GTK et SwiftUI délèguent cette reprise au même cœur et aux écrans actuels.

GNOME dispose de l'action `(clé, message)` dès le startup GApplication. Les
installations Linux créent aussi le service D-Bus du même ID et l'entrée desktop
annonce `DBusActivatable` / `X-GNOME-UsesNotifications`, suivant le
[contrat GNotification](https://docs.gtk.org/gio/class.Notification.html).
Le clic
Windows utilise `rocketvibe://notification?key=…&msg=…`, sans texte ou bearer,
via le protocole déjà enregistré par l'installeur ; le parser refuse doublons,
identifiants malformés et paramètres inattendus. SwiftUI traite le callback
`UNUserNotificationCenter` dans le modèle, même avant reprise du compte.
La réponse inline Windows passe maintenant par un serveur COM local
`INotificationActivationCallback`, enregistré par utilisateur avec le même CLSID
stable dans l'installeur, les raccourcis et le processus. Windows lance le binaire
avec `-ToastActivated` ; GTK retire ce switch avant parsing, puis le callback
transmet arguments et texte à son handler existant. Un processus déjà actif
utilise le même callback, sans second handler WinRT qui doublerait l'envoi.
L'AUMID, la forme des arguments et les entrées UTF-16 bornées sont vérifiés ;
la validation privée de compte / adhésion / époque reste dans le cœur natif.
L'enregistrement suit le [serveur COM de référence Microsoft](https://github.com/CommunityToolkit/WindowsCommunityToolkit/blob/main/Microsoft.Toolkit.Uwp.Notifications/Toasts/Compat/ToastNotificationManagerCompat.cs)
et l'[ABI du callback](https://learn.microsoft.com/en-us/windows/win32/api/notificationactivationcallback/nf-notificationactivationcallback-inotificationactivationcallback-activate) ;
les raccourcis utilisent le [CLSID prévu par Inno Setup](https://jrsoftware.org/ishelp/topic_iconssection.htm).
Le signal KDE / freedesktop historique `NotificationReplied` est adressé au
processus qui a envoyé `Notify` ; une fois celui-ci sorti, son ancienne adresse
D-Bus ne peut pas être récupérée. La remise à froid passe désormais par le
[portail XDG Notification v2](https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.Notification.html)
quand `SupportedOptions.button-purpose` annonce `im.reply-with-text`, avec
GLib ≥ 2.86 pour le marshalling de plusieurs arguments. Les actions exportées
`app.open-message` et `app.reply-native-notification` sont enregistrées dès le
startup. Le portail garde la cible `(clé, message)` et transmet le texte saisi
comme second argument de `org.freedesktop.Application.ActivateAction` ; GTK
reçoit le tuple `((ss)s)` et suit la même capture durable / validation privée.
Aucun texte de réponse ne passe par l'URL ou la ligne de commande.

La capacité est sondée avant de choisir ce chemin, uniquement pour le fournisseur
natif. Les environnements qui ne l'annoncent pas conservent leurs notifications
existantes ; la réponse inline freedesktop y exige encore un processus actif.
Le [backend Plasma consulté](https://github.com/KDE/plasma-workspace/blob/a82e8a200a37328ff6cd5cbac68ebd609fed306a/libnotificationmanager/portal_p.cpp)
expose un portail v1 : sa présence ne suffit donc pas à activer ce parcours v2.
Une application installée sur un système qui annonce v2 reste à qualifier.
Les affichages / retraits du portail sont sérialisés par portée : un retrait
pendant un `AddNotification` finit par `RemoveNotification`, un remplacement
finit par le message le plus récent. Retirer une notification n'active pas un
portail absent. Le diagnostic des paramètres indique le backend sélectionné.
Une navigation par clic reçue hors ligne est maintenant conservée dans
`notification-navigation.sqlite`, dans la configuration bureau partagée par GTK
et SwiftUI. Une seule destination explicite est gardée, sans texte, auteur ou
bearer : clé de portée, message / salon / racine, adhésion et position d'origine.
Une réservation est écrite avant d'attendre le trousseau ; une capture tardive
ne peut modifier qu'elle-même. Au redémarrage, le compte exact est sélectionné
avant le compte par défaut. Le retrait du toast ou une fenêtre de snapshot bornée
ne perdent pas un clic déjà capturé. Le message et la racine sont relus en privé,
avec les gardes d'adhésion / époque / projection ; seules les erreurs temporaires
conservent la destination pour reprise. L'ouverture dans les écrans existants
acquitte l'ID exact, sans effacer un clic plus récent. Un nouveau lien, un changement
explicite de salon / fil / compte ou la déconnexion annulent la navigation en attente.
Les parcours système installés restent à qualifier sur Linux,
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

Les réponses hors ligne sont exercées sur SQLite disque fermé puis rouvert et
véritables échanges HTTP : zéro requête à la capture, racine absente du cache,
deux connexions concurrentes, retrait du registre OS après capture, retry gardé,
cible / racine supprimée, adhésion remplacée, époque restaurée et réponse HTTP
perdue après commit. La confirmation privée au redémarrage produit un seul POST,
même si la cible originale a été supprimée. Les tests vérifient aussi la purge
des intentions retirées et la conservation du texte des refus permanents.
Les clics hors ligne passent aussi par SQLite disque et HTTP réel : capture sans
réseau, racine hors cache, registre OS retiré, redémarrage après un 503, refus des
cibles / racines supprimées, adhésion remplacée et époque restaurée. Réservation,
capture lente, annulation et acquittement tardif ne peuvent écraser un nouveau
clic ; les métadonnées malformées / trop volumineuses sont refusées.
Les modèles Swift compilent avec leurs bindings régénérés ; les notifications
OS installées restent une qualification distincte de ces tests.

Le pont Windows passe neuf tests, dont un callback COM réellement invoqué depuis
un second processus avec le texte saisi ; la classe du banc est temporaire et
n'écrit pas de registre utilisateur. Le helper est exécuté par ce test, pas
silencieusement ignoré. Des entrées étrangères / répétées / malformées sont
refusées. Les sept tests portables et Clippy Windows / Linux passent. Ce banc
prouve le dispatch COM entre processus, mais pas encore le lancement par le
centre de notifications d'une application installée et arrêtée.

Le portail v2 possède deux tests de capacités / payload et un vrai serveur D-Bus
jetable qui retarde `AddNotification` pour exercer remplacement et retrait en
vol. Ce test est marqué conditionnel à une session bus et exécuté explicitement
par le script de qualification, sans faux succès à zéro test. Le même script
ferme le premier GTK, vérifie la disparition du nom D-Bus, puis réactive un
second vrai processus par `ActivateAction` avec cible et réponse Unicode ; les
paramètres malformés sont refusés. Cette cible étrangère n'a pas de credentials :
elle prouve l'ABI et le démarrage, pas un envoi privé ni un portail Plasma réel.
