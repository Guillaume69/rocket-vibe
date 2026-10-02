# P02 — e-mail vérifié, SMTP et récupération

## État réel

Le transport `apps/server/src/mail.rs` est livré : relais SMTP avec STARTTLS
obligatoire ou TLS implicite, configuration privée montée, modèles de message
texte bornés, quatre envois simultanés au plus et échéance totale de 30 secondes.
La migration 0016 et les routes privées permettent au compte actif de vérifier
une adresse. Le défi et sa charge chiffrée sont enregistrés ensemble dans
PostgreSQL ; le worker reprend leur livraison après restart. Les SDK Rust et
TypeScript exposent le parcours. La capacité additive `email_verification` est
annoncée seulement avec transport SMTP et clé opérateur configurés.

Les formulaires mobile, GTK et SwiftUI rejoignent leurs paramètres de sécurité
existants, avec SecureStore ou trousseau système privé et reprise de l'intention
initiale. La migration 0018 et les SDK permettent aussi le retrait conditionnel
du contact, même sans SMTP ; les coffres et boutons mobile / GTK / SwiftUI sont
raccordés à ces trois routes.
Le second facteur e-mail et la récupération par e-mail restent à implémenter. La présence
de `SecondFactor::Email` dans les types et de `FactorStatus.email=false` ne
signifie pas que ces deux dernières opérations soient disponibles.

Le fournisseur mobile vérifie identité, génération du runner et visibilité
avant et après chaque appel. Le coffre partage la file locale des opérations
de sécurité, épingle les cinq champs de portée et sauvegarde le candidat avant
start. Une autre adresse ne peut pas remplacer une vérification en attente.
La saisie du code reste en mémoire et disparaît à la fermeture / suspension.
L'annulation de la vérification est conditionnelle et reprend d'abord un reçu qui aurait gagné la
course ; un ancien bouton ne peut effacer la tentative suivante. Le reçu
accepté reste privé jusqu'à Terminer. L'horloge du serveur décide l'expiration,
même si l'appareil corrige son horloge.

Les trois clients conservent vérification ou retrait dans une seule entrée privée ; le
format des vérifications déjà enregistrées reste lisible. Le retrait ne stocke
pas l'ancienne adresse, seulement la portée, l'opération, les versions initiales
et son reçu éventuel. La confirmation native épingle la révision et le contact
affichés. Suspension, fermeture, changement de compte ou nouvelle vue invalident
son callback. Une réponse perdue expose un retrait non confirmé, reprenable ou
annulable. Une annulation ne renvoie jamais le start ; si le reçu a déjà gagné,
il reste affiché jusqu'à Terminer. Un reçu serveur nettoyé sans acceptation
enregistrée devient périmé ; l'absence de contact ne suffit pas à annoncer le
succès. Une acceptation connue reste affichable seulement avec ses versions et
le contact toujours absent. L'ancienne intention ne retire jamais un contact
remplacé depuis.

GTK et Swift partagent `rv-core::native::security::email`. Le verrou OS reste
commun aux preuves, facteurs, vérifications et retraits e-mail, y compris pendant le
travail réel d'une écriture de trousseau dont l'appelant a été annulé. Le handle
UniFFI conserve candidats, reçus, portée et versions : Swift reçoit seulement
les valeurs d'affichage, et chaque action e-mail porte la révision affichée.
Une adresse refusée conserve un reçu périmé explicitement annulable ; aucun
client ne remplace ou efface silencieusement cette intention. Les bancs GTK et
Swift utilisent trois processus et le vrai Secret Service Linux, avec perte des
réponses de vérification start / confirm et de retrait, puis reprise après un
nouveau redémarrage. Le relais SMTP utilise TLS loopback. Les trousseaux Windows /
macOS et SecureStore sur appareil installé restent à qualifier.

## Configuration du transport

`RV_SMTP_CONFIG_FILE` désigne un fichier JSON régulier de 16 Kio au plus. Sous
Unix il doit être privé, par exemple mode 600 ; les liens symboliques sont
refusés. Le chargement échoue avec un message fixe si un champ est invalide,
sans afficher le contenu ou les identifiants. Exemple sans secret réel :
[`docker/smtp.example.json`](../../docker/smtp.example.json). La copie locale
`docker/smtp.json` est exclue de Git et du contexte de construction Docker.
Monter le fichier en lecture seule et fournir son chemin dans le conteneur.

`tls` accepte `starttls` ou `implicit_tls`. Choisir le port de ce service
(habituellement 587 / 465) ; aucune option de TLS opportuniste ou de suppression
de validation des certificats n'est proposée. `username` et `password` sont
présents ensemble ou absents ensemble pour un relais ne nécessitant pas de login.
`from` est une adresse seule, sans nom affiché ni en-tête additionnel.
Le champ facultatif `ca_file` permet d'ajouter un certificat d'autorité PEM
monté en lecture seule : fichier régulier sans symlink, de 1 Mio au plus.
Le certificat du relais doit toujours correspondre au nom configuré ; aucune
option ne désactive cette validation. Sans ce champ, les autorités usuelles
du transport sont utilisées.

Le transport utilise [lettre 0.11.23](https://docs.rs/lettre/0.11.23/lettre/transport/smtp/struct.AsyncSmtpTransport.html)
avec Tokio / rustls et sans traces SMTP. Les diagnostics bruts du relais ne sont
jamais propagés : ils peuvent inclure destinataire ou contenu privé. Le travail
réel possède son permis même si l'appel HTTP qui l'attend est annulé. Une erreur
ou échéance rend `mail_delivery_unconfirmed` : la livraison peut déjà avoir eu
lieu. Il faudra reprendre le même contenu depuis la file, sans créer un nouveau code.

## Adresse vérifiée et livraison durable

Les réponses privées portent `Cache-Control: no-store`. Le GET conserve aussi
la barrière de livraison d'autorisation du serveur. L'adresse n'est pas ajoutée
au DTO `User`, à l'annuaire, au journal de conversation ou au cache public.

| Route `/api/v1` | Fonction |
| --- | --- |
| `GET /me/email` | Adresse vérifiée éventuelle, version de contact, tête de vérification et contexte de compte / appareil / instance / génération |
| `POST /me/email/verification/start` | Admission bornée puis création atomique du défi et de la livraison |
| `POST /me/email/verification/resume` | Relecture du candidat original ou du reçu déjà accepté |
| `POST /me/email/verification/confirm` | Validation du code, changement de contact et reçu de cinq minutes |
| `POST /me/email/verification/retire` | Rotation conditionnelle de la tête de vérification de cet appareil |
| `POST /me/email/removal/start` | Retrait du contact affiché, avec preuve récente et versions initiales |
| `POST /me/email/removal/resume` | Relecture du reçu original, sans renouveler la preuve |
| `POST /me/email/removal/retire` | Annulation conditionnelle de l'intention de retrait avant sa réception |

Le client prépare un candidat privé de 64 caractères hexadécimaux, une opération
et les versions initiales avant start. Tous les appels épinglent UID, appareil,
instance et génération. Start et la première confirmation exigent une preuve
complète récente sur la famille actuelle. L'acceptation change la version du
contact et la tête de vérification ; elle ne renouvelle ni bearer, appareil,
facteur, mot de passe, ni âge de la preuve.

La migration 0017 réserve durablement la tête de l'appareil dès la création.
Le nettoyage du défi expiré ne rouvre pas cette tête : les starts anciens et
les nouveaux candidats sous cette même tête restent refusés jusqu'au retrait
explicite. Une confirmation acceptée ouvre aussi une nouvelle tête.

Le code comporte huit chiffres, expire après quinze minutes et tolère cinq
essais erronés au plus. Une réponse perdue reprend le même candidat / opération
et le reçu accepté sans consommer une nouvelle preuve ou prolonger son échéance.
Un contact changé depuis un autre appareil, un changement de facteur,
d'autorité ou de génération rend le candidat ancien inutilisable. Le retrait
peut annuler ce candidat même après un changement de contact sur un autre
appareil ; un retrait ancien ne peut pas annuler une nouvelle tête.

Les admissions persistent indépendamment de la transaction HTTP : trois par
compte et par adresse en quinze minutes, dix par IP en quinze minutes et 120
globalement par minute. Un rejeu identique ne facture pas une deuxième admission.
La file contient au plus 1 000 messages non livrés encore valides. Une admission
refusée rend `email_delivery_limit` avec `Retry-After` ; ce délai ne bloque pas
statut, reprise, confirmation ou retrait dans les SDK.

La charge contient l'adresse et le code, chiffrés avec la clé opérateur hors
PostgreSQL. Son authentification inclut le job et toute la portée / les versions
initiales. Chaque worker revendique au plus quatre jobs, avec lease de deux
minutes et vérification de l'autorité / d'une session valide avant SMTP.
L'expiration de la session ou de la preuve pendant l'attente du budget de file
est relue avant création du message. Les verrous métier ne couvrent pas l'envoi.
Huit tentatives au plus reprennent exactement cette charge avant
l'échéance originale, avec délai de cinq secondes par tentative, plafonné à une
minute. Un ACK SMTP perdu peut entraîner plusieurs messages portant le même
code. La confirmation ou l'acceptation du relais efface la charge chiffrée.

La reprise expose `queued`, `sending`, `deferred`, `accepted` ou `exhausted`.
`accepted` signifie que le relais a accepté SMTP, pas que la boîte finale a reçu
le message. Aucun diagnostic SMTP brut, code ou contenu privé n'est journalisé.

## Retrait du contact

La capacité additive `email_removal` est indépendante de SMTP et de la clé de
livraison : un compte peut lire et retirer son contact même si le relais est
désactivé. Les SDK n'appliquent pas le cooldown SMTP à ces trois routes. Le
premier retrait exige une preuve récente sur la famille actuelle, l'opération
originale, la version du contact affiché et la tête de cet appareil. Il conserve
mot de passe, facteurs, bearer, famille et âge de la preuve.

La transaction verrouille le compte, l'appareil, les vérifications et leurs jobs
dans l'ordre des producteurs. Elle relit les échéances réelles de session et de
preuve après toute attente sur ces lignes. Elle supprime le contact ainsi que
toutes les vérifications du compte et leurs charges SMTP, puis change la version
du contact et la tête de l'appareil. Les anciens codes ne peuvent plus rétablir
l'adresse. Un mail déjà en vol peut néanmoins arriver ; son code reste refusé.

Le reçu contient seulement les versions résultantes et le contexte. PostgreSQL
ne conserve ni l'ancienne adresse ni l'opération en clair dans `email_removals`.
Ce reçu expire après cinq minutes et se reprend uniquement sur la famille,
l'autorité, les versions et la génération d'origine. Le rejeu ne retire rien
de nouveau et ne prolonge aucune échéance. Après nettoyage, les anciennes
versions empêchent de recréer le retrait, y compris si un autre appareil a
confirmé une nouvelle adresse.

L'annulation compare à la fois la version du contact et la tête de l'appareil.
Si elles sont toujours celles affichées, elle ouvre une nouvelle tête et bloque
le start ancien, sans retirer le contact. Après remplacement du contact, elle
préserve une nouvelle vérification même si cet appareil a encore la même tête.
Si le retrait a déjà gagné, l'annulation ne l'inverse pas : le client devra
reprendre son reçu avant de conclure ou d'effacer l'intention locale. Les coffres
et formulaires mobile / GTK / SwiftUI implémentent ces règles, avec lecture / retrait sans
SMTP ou configuration TOTP. Une vérification non reçue devenue indisponible
reste explicitement fermable. Les parcours installés restent à qualifier.

## Contrat de la suite du chantier

1. **Adresse privée vérifiée.** Le compte actif confirme son identité sur la
   famille existante avant d'ajouter / changer une adresse. Un défi confirme
   l'accès à la nouvelle boîte. L'adresse n'entre pas dans l'annuaire public.
   Les tokens restent liés à UID, instance, génération, version d'autorité et
   opération initiale. Une réponse perdue reprend le reçu original. Changement
   d'adresse ou d'autorité rend les anciens défis inutilisables.
2. **File SMTP durable.** Enregistrer un défi et son message dans la même
   transaction. Chiffrer les codes et charges de livraison avec la clé opérateur
   hors PostgreSQL. Les workers revendiquent des lots bornés avec un lease,
   vérifient expiration / autorité, puis font SMTP hors des verrous métier.
   Les retries renvoient le même code jusqu'à son échéance ; pas de transaction
   de conversation suspendue en attendant SMTP. Le journal d'exploitation ne
   contient ni code, corps, adresse complète ni credentials.
3. **Défi e-mail explicite.** Le serveur propose cette méthode seulement avec
   adresse vérifiée et configuration adéquate. L'utilisateur la choisit ; pas
   de repli implicite depuis TOTP. Bornes d'envoi / essais / durée persistent
   après restart et s'appliquent par compte, défi, adresse et IP. Le candidat
   privé et la preuve commitée suivent les mêmes règles que TOTP / secours.
4. **Récupération du mot de passe.** La demande anonyme fournit une réponse
   uniforme et des quotas, sans révéler l'existence du compte ou de sa boîte.
   Seule une adresse déjà vérifiée reçoit le code. La confirmation conserve UID,
   conversations et clés E2EE, révoque les anciennes familles et garde les
   facteurs existants. Elle reprend le mécanisme de récupération actuel ; elle
   ne crée pas de session et ne dispense pas du second facteur au login suivant.
5. **Clients existants.** Ajouter ces actions aux paramètres et formulaires
   actuels mobile / GTK / SwiftUI avec capacités additives. Coffres privés par
   portée, saisies transitoires, sortie / suspension / changement de compte
   bloquant les callbacks, reprise originale après ACK perdu. Les écrans
   Rocket.Chat continuent leur propre parcours.

## Qualification

Les tests du transport couvrent la configuration et les injections d'en-tête,
fichier privé / symlink / taille, refus d'un relais sans STARTTLS avant tout
credential / destinataire / contenu, un vrai échange SMTP sur loopback et
annulation conservant le permis du travail réel. Le relais en clair n'existe
que dans la construction privée de ces tests.

Un vrai échange rustls sur loopback valide STARTTLS obligatoire et TLS implicite
avec certificat de test. Les relais non approuvés et les certificats pour un
autre nom sont refusés avant credential ou code. Les fixtures publiques ne
constituent pas une autorité à installer en production.

Les tests PostgreSQL / HTTP avec le SDK Rust couvrent reçu idempotent, session
inchangée, reprise après ACK SMTP perdu et nouveau runtime, retrait avant start
ou confirmation retardés, appareils concurrents, changement d'autorité,
expirations, quotas persistants, essais erronés et confidentialité de l'annuaire.
Les tests TypeScript couvrent portée HTTP, candidat original, validation des
états et accès aux lectures / reprises pendant un cooldown de livraison.

Les tests du retrait couvrent aussi l'absence de SMTP, la suppression des anciens
codes sur plusieurs appareils, confirmation concurrente, délais de session /
preuve expirant pendant une attente réelle de verrou, reçu nettoyé, contact
remplacé, annulation avant réception et course annulation / retrait. Le SDK Rust
teste les vraies routes HTTP, leur confidentialité et l'annulation conditionnelle.

Le banc `scripts/native-email-mobile-pilot.ts`, lancé par un test SQLx privé,
fait tourner le vrai `NativeChat` avec SQLite, HTTP et WebSocket contre
PostgreSQL. Il perd les réponses start / confirm, simule une écriture de reçu
refusée, reprend avec un nouveau coffre et conserve une seule famille et une
admission. Il reprend ensuite le même bearer contre un runtime sans SMTP ni
clé de facteurs : annulation avant réception, start ancien refusé, réponse de
retrait perdue, écriture de reçu refusée puis reprise acceptée jusqu'à Terminer.
PostgreSQL exige une famille et un reçu de retrait, sans contact, défi ni job
SMTP restant. Sa boîte SMTP et sa route de lecture de code
existent uniquement dans le serveur de test ; aucun envoi extérieur ne part.
Le stockage privé de ce banc est simulé. Typecheck, lint, tests mobiles et
export du bundle Android passent ; ils ne prouvent pas le SecureStore ou les
widgets d'une app installée. ADB ne signale actuellement aucun appareil connecté.

Le coffre commun bureau passe 22 tests de contact, dont 12 scénarios de retrait :
réponse perdue, échec de stockage du reçu, reprise du même candidat, nettoyage,
contact remplacé, concurrence, preuve expirée, fermeture et verrou OS conservé
par une écriture réelle dont l'appelant est annulé. Les gardes HTTP vérifient le
retrait sans capacités de vérification / TOTP et refusent une génération ou un
fournisseur fermé avant mutation. Le workspace Fedora passe ses 275 tests et
Clippy ; les bindings UniFFI sont réellement générés et les modèles Swift compilés.
Les deux bancs PostgreSQL / Secret Service passent chacun les trois processus.
GTK exerce aussi une ancienne confirmation native après Actualiser et attend sa
fermeture effective avant d'ouvrir la suivante ; Swift refuse les anciennes
révisions de retrait / acknowledgement. SQL exige une seule famille, une preuve
complète conservant son âge, une admission et un reçu de retrait, sans ancien
contact, vérification ni job. Le second facteur reste actif pendant le retrait,
puis sa désactivation explicite est testée séparément. La compilation SwiftUI
du nouveau lot doit encore être confirmée par la CI macOS.

Il reste à qualifier les parcours installés et le relais réel avec accès
opérateur. Un test SMTP / TLS loopback ne valide pas la délivrabilité d'un
fournisseur extérieur. P02 reste ouvert pour les fonctionnalités listées dans
l'état réel et la qualification sur appareils.
