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
Le second facteur e-mail est livré côté serveur et SDK, avec inscription
explicite, retrait et livraison sur un défi déjà établi. Les défis de connexion et
de confirmation d'identité sont raccordés au mobile et aux formulaires GTK / SwiftUI
existants. Les coffres partagés du cœur Rust bureau conservent leurs livraisons.
Les coffres Rust bureau / mobile conservent aussi les intentions d'inscription
et de retrait du facteur, sous le verrou commun des opérations de sécurité.
Ils épinglent le contact et les profils affichés, reprennent le même reçu après
réponse perdue et présentent les dix secours communs jusqu'à confirmation de
leur sauvegarde. Le retrait sans SMTP conserve les autres profils ; la
régénération des secours fonctionne également avec un profil e-mail seul.
Six tests Rust et neuf tests TypeScript dédiés couvrent ce coordinateur. Les
boutons d'inscription / retrait rejoignent les paramètres existants des trois
clients, avec confirmations liées au contact et aux profils affichés. Les
formulaires d'adresse vérifiée ne l'activent pas automatiquement. La récupération
du mot de passe par e-mail utilise la route anonyme de la migration 0021 et les
formulaires de connexion existants GTK / SwiftUI / mobile décrits ci-dessous.

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
du lot `b06487b` est confirmée : la CI macOS `36944950019` compile, package et
démarre l'application. La CI native `36944950072` passe serveur / mobile, GTK
et cœur Windows mais échoue dans le banc Swift sur une soumission qui précédait
la fin de reconnexion après régénération. Le banc corrigé exige une vue fraîche
et vérifie les pertes effectives de réponse via le proxy jetable. Compilation,
six tests locaux, trois processus connectés et invariants PostgreSQL passent
avec le serveur reconstruit. Le correctif et le budget SMTP du commit `fab08e0`
passent les quatre jobs natifs `36947405591` ainsi que macOS `36947405670`.

## Facteur e-mail explicite

Ce parcours est disponible sur le serveur et dans les paramètres existants des
trois clients. Une adresse vérifiée ne l'active pas implicitement : une inscription
distincte permet e-mail seul ou coexistence avec TOTP, avec codes de secours
communs. Le statut distingue l'inscription effective de la capacité d'envoi du
runtime. Une panne de SMTP ne permet pas une session avec le seul mot de passe.
Une clé opérateur absente ou incorrecte ferme le parcours protégé, y compris
son repli vers les secours.

Le facteur est lié à la version du contact vérifié. Un contact utilisé comme
facteur doit d'abord être désactivé explicitement avant remplacement ou retrait.
L'inscription / désactivation exige la preuve récente du compte et sa version
actuelle ; ses reçus, changements d'autorité et révocations des autres appareils
suivent les garanties déjà appliquées à TOTP. Toute émission de nouveaux secours
est présentée et conservée comme un reçu privé, jamais remplacée silencieusement.

Le socle 0019 implémente déjà les profils indépendants et les secours communs.
Un profil inscrit exige une clé opérateur validée par un marqueur authentifié
sur la version exacte du contact, y compris avant consommation d'un secours.
Les routes refusent de retirer / remplacer ce contact tant que le facteur reste
installé ; les contraintes SQL refusent son retrait ou le changement de sa
version. Huit tests PostgreSQL couvrent e-mail seul,
coexistence, changement de provenance de preuve, régénération, erreurs de clé,
dernier facteur retiré et vraie migration depuis 0018 avec données TOTP intactes.
Ce socle de profils est utilisé par les routes explicites de la migration 0020
décrites ci-dessous ; une adresse vérifiée seule ne protège pas le compte.

L'envoi est demandé explicitement sur le défi de connexion ou de confirmation
d'identité déjà établi. Le client doit conserver son candidat de livraison avant
HTTP et reprendre la même opération après réponse perdue ; le code reste seulement
en mémoire. Le serveur lie la livraison au compte, défi, finalité, contact,
autorité et génération ; le contexte de l'appareil s'ajoute pour la confirmation
d'identité. Renvoi, retries SMTP et reprise du reçu ne prolongent pas l'échéance
initiale. Un code ne valide pas un autre défi ou une autre finalité.

### Routes du facteur e-mail

Chemins relatifs à `/api/v1`, corps stricts et réponses `no-store`, refus inclus :

| POST | Corps | Portée / résultat |
|---|---|---|
| `/me/factors/email/enable` | `ChangeEmailFactor` | Compte actif avec preuve complète récente ; `EmailFactorChange` avec dix nouveaux secours communs |
| `/me/factors/email/disable` | `ChangeEmailFactor` | Même preuve ; reçu sans codes, disponible sans SMTP |
| `/auth/factors/email/start` | `RequestFactorEmail` | Défi de connexion anonyme ; `FactorEmailDelivery` |
| `/auth/factors/email/resume` | `RequestFactorEmail` | Lecture du même candidat de livraison, sans renvoi |
| `/me/reauth/email/start` | `RequestFactorEmail` | Défi de confirmation d'identité de la famille active |
| `/me/reauth/email/resume` | `RequestFactorEmail` | Lecture du même candidat et de la même famille |

`ChangeEmailFactor` épingle le contexte utilisateur / appareil / instance /
génération, la version du contact affiché, la version des facteurs (ou `null`
s'ils sont absents) et une opération initiale. Le reçu privé chiffré dure cinq
minutes. Sa reprise restitue les mêmes codes et versions, sans nouvelle preuve
ni rotation, uniquement tant que l'état committé est toujours actuel. Une autre
inscription, un contact remplacé ou une ancienne génération ferment cette reprise.
Six changements réussis par compte et quinze minutes sont admis. L'inscription
remplace la liste commune, révoque les autres familles et conserve la famille
initiatrice. Le retrait conserve TOTP et les secours s'il reste installé ; le
dernier facteur retiré efface les secours. La clé opérateur reste nécessaire.

`RequestFactorEmail` contient seulement défi, candidat de livraison aléatoire de
256 bits et opération. L'adresse et la finalité viennent du serveur. Les retries
du même candidat lisent leur reçu, même sans SMTP et sans nouveau débit de quota.
Un nouveau candidat représente un renvoi explicite : au plus trois livraisons par
défi, espacées de soixante secondes. Elles reprennent le même code décimal de huit
chiffres et la même échéance. Le hash du code est lié au défi brut privé et à la
finalité ; les charges chiffrées authentifient toutes leurs versions et leur portée.

La file durable et les leases du worker clôturent leurs résultats sur l'identité
de la réclamation. Les transmissions SMTP se déroulent sans verrou de compte,
d'appareil ou de défi. Une confirmation SMTP perdue peut entraîner une seconde
transmission du même code ; elle ne crée pas une nouvelle preuve. La consommation
efface les charges et la file du défi dans la transaction qui accepte la preuve.
Les expirations sont relues après les derniers verrous SQL, y compris ceux de la
file. Sans SMTP, les secours restent utilisables ; aucune session par mot de passe
seul n'est créée pour un compte protégé.

La découverte distingue `email_factors` (clé configurée, gestion du profil) et
`email_factor_delivery` (clé et SMTP, nouvelle livraison). Les clients doivent
les intersecter avec les parcours effectivement implémentés. Neuf tests PostgreSQL
couvrent HTTP typé, inscription concurrente et reprise, coexistence TOTP, perte
d'ACK SMTP, renvois bornés, absence de SMTP, reçus périmés, erreurs de clé / charge /
génération et expiration sous verrou réel. Trois tests de transport TypeScript
couvrent l'isolement du bearer et les reprises pendant le cooldown commun.

### Défis dans les écrans mobiles existants

Les coffres de connexion et de confirmation d'identité conservent le candidat
de livraison, l'opération initiale et l'état reçu dans leur entrée SecureStore
privée déjà existante. Ils lisent les anciens formats sans métadonnée de mail.
Les codes restent hors du coffre, de SQLite et des sessions. La file locale
commune retient HTTP et les écritures ; une réponse perdue conserve la commande
initiale. Recréer le coffre puis reprendre lit son reçu, sans mail supplémentaire.
Un appel interrompu avant insertion peut reprendre cette même commande sur un
geste explicite. Le chargement d'un écran n'envoie pas de mail.

Un renvoi explicite exige un état précédent confirmé, relit le délai du serveur
et sauvegarde le nouveau candidat avant start. Une ancienne vue ne peut le
remplacer. Le défi et sa date initiale restent identiques. Une nouvelle preuve
de mot de passe conserve une livraison en attente jusqu'à la barrière d'expiration
du défi précédent. SMTP absent après livraison conserve la lecture du reçu et
la vérification du code déjà reçu. Les gardes de focus, de compte, de famille et
de génération refusent les callbacks retardés ; quitter le formulaire efface
la saisie du code.

Onze tests des coffres couvrent stockage indisponible, ACK perdu, concurrence,
renvoi, portée et expiration. Le pilote `scripts/native-factor-email-mobile-pilot.ts`
traverse HTTP, PostgreSQL, SMTP loopback, le fournisseur mobile et SQLite : les
réponses de livraison et de validation disparaissent volontairement, deux codes
sont transmis, deux preuves sont consommées, aucune répétition ne produit un
envoi ou une session supplémentaire. Il recrée les coffres avec un adaptateur
portable ; il ne qualifie pas le Keystore installé, ni le rendu sur appareil.

### Coffres des défis bureau

`rv-core::native::factor_email` reprend la commande de livraison sous le verrou
OS du coffre de connexion ou de la preuve de la famille active. Le candidat est
conservé avant HTTP ; une réponse perdue ne crée pas de nouveau mail. Un renvoi
exige un reçu connu, le délai relu du serveur et la même vue du candidat précédent.
Les statuts sont limités à leur échéance d'origine et aux métadonnées affichables ;
les codes et mots de passe n'entrent pas dans le trousseau. Les anciens formats
sans livraison restent lisibles. Les gardes empêchent une écriture tardive après
fermeture ; une livraison ambiguë reste récupérable dans le même coffre.

Les lectures restent disponibles sans SMTP. Pour une preuve existante, le code
déjà envoyé reste proposé pour le même défi après disparition de SMTP ; un
nouveau défi ne l'annonce pas. Dix tests Rust dédiés couvrent ACK perdu,
concurrence de coffres recréés, reprise du candidat non envoyé, stockage refusé,
renvoi explicite, vue obsolète, fermeture, statut privé malformé et échéance.
Les contrôles du fournisseur vérifient aussi le bearer de la famille et les
barrières de génération / capacité. GTK raccorde ces coffres au formulaire de
connexion et à la confirmation d'identité des paramètres existants. Les boutons
proposent l'envoi, la reprise d'une livraison ambiguë et un renvoi explicite
borné. Leur sélection et leurs statuts ne déclenchent jamais un envoi automatique.
Fermeture et retour annulent la garde ; les champs de code restent transitoires.
SwiftUI utilise les mêmes coffres par `NativeLoginAttempt` et `NativeSecurity`.
Les seuls champs exposés sont statut / échéance de livraison, délai de renvoi,
capacité et révision affichée. Les candidats, nonces, IDs de défi et bearers
restent privés. Le vrai job Tokio conserve le verrou d'envoi après annulation
de l'appel foreign ; fermer le formulaire annule sa garde. Une révision obsolète
ne peut lancer ni reprendre / renvoyer une livraison. Après réponse ambiguë,
le modèle recharge ce candidat ; cette lecture n'envoie pas de mail. Les boutons
et les codes restent dans les écrans SwiftUI existants.

Le banc `compose.native-email-otp-pilot.yml` ajoute un compte avec facteur e-mail
explicite, un relais TLS local et un proxy qui perd les réponses de start / finish.
Il utilise les vrais widgets GTK et Secret Service sur trois processus. Le contrôle
PostgreSQL exige deux livraisons OTP consommées, une seule famille / credential,
une preuve complète d'âge inchangé, trois admissions SMTP avec la vérification
initiale du contact, aucune charge OTP résiduelle et les dix secours d'origine.
Le clic de renvoi pendant le cooldown ne crée pas une nouvelle admission.
Le banc Swift ajoute l'overlay `compose.native-swift-email-otp-pilot.yml`, dans
un autre projet PostgreSQL / proxy. Il passe trois processus avec Secret Service,
les vrais modèles et handles FFI, les mêmes invariants SQL et le refus des
handles fermés / révisions obsolètes. Cette preuve portable ne qualifie pas le
trousseau macOS ni le rendu SwiftUI installé.

Le banc `compose.native-email-settings-pilot.yml` utilise un contact vérifié
sans activer son facteur dans le seeder. Les vrais widgets GTK, modèles / FFI
Swift et fournisseur mobile activent le profil puis retrouvent les mêmes dix
secours dans un nouveau processus après réponse perdue. Ils effectuent ensuite
une preuve complète par secours, avec réponses de preuve perdues, acquittent
la sauvegarde des codes, retirent le profil et reprennent ce retrait dans un
troisième processus. Chaque client utilise un PostgreSQL / proxy distinct.
SQL exige une seule famille et credential, deux opérations originales, l'adresse
conservée et un seul mail de contact ; aucun OTP n'est demandé par ce scénario.
GTK et Swift utilisent Secret Service réel ; le mobile utilise un adaptateur
privé portable sur disque et sa projection SQLite réelle. Les révisions Swift
obsolètes et handles fermés sont refusés avant HTTP. La capture GTK finale à
435 × 760 contient seulement les paramètres et l'adresse synthétique.
Ce banc ne remplace pas les confirmations ni trousseaux d'une app installée.

Le composant commun d'admission SMTP est extrait : il conserve les clés des
vérifications déjà admises et partage les budgets persistants global, compte,
adresse et IP entre producteurs. Cinq tests PostgreSQL couvrent concurrence,
reprise pendant le cooldown, expiration, annulation sous verrou et absence de
clés privées en clair. Le producteur OTP partage ces budgets et la limite de
mille charges actives avec les vérifications et la récupération du mot de passe,
qui ajoute sa propre liaison sans les contourner. Le quota de
transport et le verrou du compte restent distincts, et aucun de ces verrous
ne couvre une transmission SMTP.

## Récupération du mot de passe : serveur et SDK

La migration 0021 ajoute `POST /api/v1/auth/recovery/email/start`, annoncé par
`email_recovery` lorsque SMTP et la clé opérateur sont configurés. La demande
anonyme contient un `operation_id` aléatoire de 256 bits, le pseudo, `instance_id`
et `data_epoch`. Le client doit conserver cette intention avant HTTP et la
répéter après une réponse perdue. Les transports Rust et TypeScript exposent
l'appel public ; les coffres privés décrits ci-dessous sont disponibles et les
boutons des trois clients restent à raccorder. Aucun envoi automatique n'est
déclenché par la connexion.

Une demande valide rend `202`, `Cache-Control: no-store` et `{"accepted":true}`.
Cette réponse reste identique pour un compte connu, inconnu, désactivé, sans
contact vérifié ou limité par les budgets SMTP / compte / outbox. Elle ne confirme
ni existence, ni adresse, ni envoi. La borne globale de mille demandes actives
rend `429 email_recovery_limit` pour tous les pseudos, avec `Retry-After` ; une
génération différente rend `409`, et SMTP / clé absents `email_unavailable`.
L'admission publique partage aussi le budget d'authentification persistant :
120 appels / minute au total, 10 par pseudo et par opération, 30 par IP TCP.
Son refus rend `429 auth_rate_limited` avant de créer un reçu, pour borner aussi
les demandes qui n'enverront aucun mail. Une réservation refusée est annulée
sans prolonger sa fenêtre. Ces limites publiques s'appliquent aux retries.
Ces garanties portent sur le statut et le corps, sans garantie de temps constant.

Le serveur génère un code aléatoire de 256 bits, valable une heure, adressé
uniquement au contact déjà vérifié. Son hash est conservé dans la récupération
existante et sa charge d'envoi est chiffrée sous la clé opérateur. La liaison
authentifiée inclut demande, compte, autorité, contact, instance, génération et
échéance. Une reprise répète le même mail et n'étend pas l'échéance. Une demande
supprimée ou refusée reste un reçu opaque sans nouveau mail ; après suppression
du compte, les coordonnées et charges sont effacées tout en gardant ce reçu
jusqu'à son nettoyage. Réutiliser le pseudo ne réactive pas une ancienne demande.

Les trois producteurs partagent les admissions persistantes SMTP et le verrou
de capacité de mille charges actives. La récupération respecte aussi les bornes
existantes de trois codes valides par compte / mille pour l'instance. Le worker
relit les versions avant SMTP, réclame quatre jobs par lot, avec bail de deux
minutes et au plus huit tentatives. Aucun verrou métier ne couvre SMTP. Un mail
déjà en cours lors d'un retrait peut arriver, mais son code devenu obsolète est
refusé à la confirmation. Les charges obsolètes sont nettoyées sans les envoyer.

La confirmation utilise `/api/v1/auth/recovery` et ses limites Argon2 / compte /
IP. Elle change seulement le mot de passe, révoque les anciennes familles et
codes concurrents, et conserve UID, conversations, TOTP, profil e-mail, secours
et données E2EE. Elle ne crée pas de session et ne récupère pas les clés E2EE ;
la connexion suivante demande les facteurs toujours installés. Le même code et
mot de passe peuvent retrouver le reçu pendant cinq minutes sans révoquer une
nouvelle connexion. Contact, autorité, instance, génération et échéance sont
revérifiés sous verrou du compte. Un code déjà reçu reste utilisable sans SMTP
ni clé opérateur, comme la récupération opérateur historique.

## Coffres de demande anonyme

Le coordinateur Rust `native::email_recovery` est commun à GTK et SwiftUI.
Le module mobile `EmailRecoveryVault` suit les mêmes règles et dispose de son
adaptateur SecureStore dans `nativeAuthenticationStore`. La clé privée utilise
le domaine `native-recovery-email-v1`, l'URL canonique et le pseudo, séparément
des comptes actifs, preuves de connexion et clés E2EE. Le bureau retient un
verrou OS sur toute l'opération ; l'adaptateur de trousseau doit le conserver
jusqu'à la fin réelle de ses lectures / écritures après annulation de l'appelant.
Seuls des fichiers de verrou vides existent hors du trousseau. La file mobile
est partagée entre instances du coffre et couvre HTTP et stockage.

Une demande explicitement lancée conserve avant HTTP son opération aléatoire,
pseudo, instance, génération, date locale et délai conservateur d'une heure.
Un `Retry-After` reçu est conservé dans cette intention : sa reprise attend
ce délai même après recréation du coffre, sans requête réseau précoce ni
changement du candidat / de son échéance. Le SDK Rust partage aussi le cooldown
de ce endpoint entre ses clones, tout en laissant disponible la découverte.
Le coffre ne stocke ni adresse, ni mot de passe, ni code reçu, ni bearer.
L'acquittement reste générique : il ne confirme pas l'envoi d'un mail. Une lecture
ne fait aucun appel réseau ; une reprise utilise l'intention d'origine, et un
reçu déjà acquitté n'est pas envoyé à nouveau. Les versions sont vérifiées autour
de l'appel. Une capacité absente bloque une nouvelle émission ; sa disparition
après un acquittement n'efface pas ce reçu ni ne prétend qualifier sa livraison.

L'expiration ou un nouveau formulaire ne remplace pas silencieusement la demande.
Une nouvelle demande exige sa fermeture locale explicite. Cette fermeture ne
révoque pas un mail déjà en file côté serveur et ne peut effacer une intention
plus récente. Une garde fermée pendant une écriture ou une réponse ambiguë
conserve le candidat original sans lancer de mutation tardive. Des coordonnées
de scope, champs privés ou échéances malformés ferment le coffre sans nouvel
envoi ; les erreurs de parsing n'exposent pas leur contenu.

Douze tests Rust sur HTTP TCP et douze tests mobile couvrent clés, concurrence,
recréation, ACK perdu, stockage refusé, génération / capacité modifiées, TTL,
corruption, cooldown persistant, fermeture et suppression locale tardive. Un test retient réellement
un verrou de fichier pendant une écriture `spawn_blocking` après annulation,
puis prouve que le coffre recréé attend et reprend le même candidat. Le mobile
annule une garde pendant une vraie promesse de stockage / réponse en cours.
Le coordinateur Rust `Form` conserve l'intention derrière une vue publique sans
nonce. GTK et UniFFI / SwiftUI utilisent cette même vue et ses révisions ; les
actions tardives et la fermeture pendant une écriture réelle sont testées sur
HTTP TCP. Les trois formulaires existants proposent la demande par e-mail
uniquement sur RocketVibe annonçant `email_recovery`. Leur ouverture lit le
coffre local sans découverte ni envoi. Un bouton distinct reprend une réponse
non confirmée ; l'acquittement affiché reste générique. L'expiration, le changement
de génération ou un reçu accepté exigent un effacement local explicite avant une
nouvelle demande. Le countdown lit uniquement l'état conservé et bloque un retry
avant son échéance. Code reçu et nouveau mot de passe restent dans le formulaire
de récupération existant ; la connexion suivante demande toujours les facteurs
installés.

Le vrai formulaire GTK / Secret Service est exécuté deux fois sous Xvfb à 435
pixels contre une fixture HTTP : aucune émission à l'ouverture, une demande
anonyme conforme après le bouton et aucun compte actif. Cette fixture ne qualifie
pas SMTP ou PostgreSQL. Les tests serveur dédiés les exercent séparément ; les
parcours installés Android / Windows / macOS restent ouverts.

Il reste à qualifier les parcours installés et le relais réel avec accès
opérateur. Un test SMTP / TLS loopback ne valide pas la délivrabilité d'un
fournisseur extérieur. P02 reste ouvert pour les fonctionnalités listées dans
l'état réel et la qualification sur appareils.
