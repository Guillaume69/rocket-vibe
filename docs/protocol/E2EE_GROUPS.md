# Livraison des transitions MLS natives

État au 4 octobre 2026 : protocole serveur expérimental, SDK Rust / TypeScript et
preuves PostgreSQL / MLS. `capabilities.e2ee` reste désactivé. Le worker privé
expérimental utilise ces routes ; son intégration aux fournisseurs des
interfaces existantes reste ouverte.
Spécification d'ensemble : [RFC 0002](../rfcs/0002-e2ee-native.md).

## Routes

Toutes exigent une session HTTP active ; les observations et nouvelles
transitions exigent l'adhésion courante au salon. Les reçus personnels et
l'abandon d'une intention propre restent accessibles après retrait. Réponses
et refus portent `Cache-Control: no-store`.

| Route sous `/api/v1/e2ee/rooms/{room}` | Usage |
|---|---|
| `GET /roster` | Politique et versions d'adhésion / activation des membres actifs, avec métadonnées publiques de tête éventuelle |
| `POST /transitions` | Transition signée, commit opaque, arbre public et Welcomes nominatifs, dans une transaction |
| `GET /state` | Dernier reçu, preuve signée, arbre courant et indication `needs_rekey` |
| `GET /events?after={revision}` | Au plus 16 transitions après une révision décimale canonique ; Welcome de l'appareil appelant seulement |
| `GET /operations/{operation}` | Reçu durable de cet utilisateur / appareil et de ce salon |
| `POST /operations/{operation}/cancel` | Décision terminale contre les octets originaux de `GroupSubmission` |
| `GET /key-packages/{user}/{device}` | Observation d'un KeyPackage publié, actif et disponible d'un membre du salon |

L'observation d'un package ne le réserve pas. Deux auteurs peuvent observer la
même référence ; seule une transition acceptée la consomme. Une observation
devenue périmée provoque un refus, sans changer de groupe ni de clé silencieusement.
Les révisions / époques des DTO HTTP restent des chaînes décimales exactes.

## Intention interrompue et abandon

Le reçu personnel se consulte avec l'appareil de la session HTTP, même après
retrait du salon ou expiration du certificat crypto. Il ne contient ni arbre,
commit, Welcome ni permission de lecture. Les routes d'observation conservent
leurs contrôles courants. Le rejeu strict d'un POST déjà accepté retrouve aussi
son reçu avant la vérification d'adhésion.

L'abandon transmet le **GroupSubmission original complet**, avec une limite
HTTP de 4 MiB. Le certificat signé désigne l'appareil de l'intention : une autre
session active du même utilisateur peut demander la décision exacte. Sans
décision connue, le serveur authentifie signature, portée et digests opaques ;
un certificat expiré reste utilisable pour ce seul règlement, un certificat
émis dans le futur est refusé. Il ne réautorise aucune feuille ou admission.

`GroupSettlement` contient soit `accepted` avec le `GroupReceipt original`,
soit `cancelled` avec portée, salon, incarnation de groupe, opération, appareil
et empreinte de transition. L'abandon ne réserve aucune révision, époque ou
position ; il n'enregistre aucun commit / arbre / Welcome et ne consomme aucun
KeyPackage. Son empreinte d'intention SQL lie les octets originaux complets.

Acceptation et abandon prennent le même verrou exclusif de l'auteur. Une
acceptation déjà durable gagne ; sinon le marqueur persistant interdit tout
POST tardif de cette intention. Un autre corps sous la même opération est
refusé. Un GET personnel abandonné retourne `409 crypto_group_cancelled` ; le
client récupère la décision typée contre son original protégé avant de libérer
le commit. Un code d'erreur seul ne suffit pas.

Les nouveaux abandons sont limités à 256 par jour et compte. Les décisions
exactes déjà connues restent rejouables au-delà du quota. Une restauration
changeant l'époque des données refuse l'ancienne portée. Cette décision repose
sur le serveur HTTP authentifié ; elle n'est pas une preuve cryptographique
d'absence d'acceptation. [Politique du coffre privé](../../crates/rv-crypto/GROUP_SETTLEMENT.md).

`GroupRoster` donne la portée d'instance / époque des données, le salon,
`authority_version`, les membres triés par UID (`user_id`, `access_version`,
`activation_version`) et `group`, reçu public de tête ou `null` avant genèse.
Une session membre peut l'observer avant inscription / admission crypto ;
cela n'accorde ni Welcome, ni accès au groupe, ni approbation d'identité.
Les administrateurs sans adhésion privée n'y accèdent pas.

La liste provient de la même requête que la validation des plans. Elle est
complète jusqu'à 128 membres actifs ; un dépassement retourne
`409 crypto_group_limit`, sans publier une page partielle. Un client peut
construire le plan avec ces versions, puis présenter sa confirmation locale.
Une observation n'est pas une réservation : changement de politique, départ /
retour ou réactivation rendent le plan ancien obsolète. Les versions sont
revérifiées lors du commit avant toute consommation de package.

L'autorisation propre, l'adhésion et la portée sont gardées jusqu'à soumission
du corps HTTP. Retrait et changement d'époque attendent la réponse ; sa lease
expire au plus après cinq secondes et avant l'expiration réelle de session.
L'activation d'un autre compte peut évoluer après la vue SQL ; sa version est
une observation, toujours revalidée à la soumission du plan. Les métadonnées
d'une tête d'une ancienne époque sont refusées, sans remappage implicite.

## Preuve publique et vérification client

[`rv-crypto-public::groups`](../../crates/rv-crypto-public/src/groups.rs) définit
le `Plan` et la `Transition`. La feuille de l'auteur signe
`rocketvibe-group-transition-v1\0` suivi du JSON UTF-8 du `Plan` typé : ordre des
champs de la structure Rust, sans espaces, tableaux de membres triés par UID,
participants triés par index de feuille et Welcomes par ID d'appareil. Les
entiers internes sont des `u64` vérifiés côté Rust ; les transports JavaScript
conservent cette preuve comme octets opaques et ne la reconstruisent pas.

La preuve lie :

- instance, époque des données, salon et incarnation aléatoire du groupe ;
- opération, révision / époque attendues et empreinte de la transition précédente ;
- version de politique du salon, nonces d'adhésion et d'activation de chaque membre ;
- utilisateur / appareil / incarnation, racine, certificat, index de feuille et
  référence d'admission de chaque destinataire ;
- SHA-256 des octets TLS du GroupContext, du commit, de l'arbre et des Welcomes.

L'ID MLS est le SHA-256 du Scope typé cadré par `rocketvibe-group-id-v1\0`.
L'empreinte d'une transition couvre certificat, plan et signature, avec le
domaine distinct `rocketvibe-group-transition-fingerprint-v1\0`.
Le [vecteur public](../../crates/rv-crypto-public/fixtures/group-transition-v1.json)
et son [vérificateur Node/OpenSSL](../../crates/rv-crypto-public/scripts/verify-group-vector.mjs)
contrôlent ce cadrage indépendamment. Les digests TLS de ce vecteur sont
synthétiques ; les tests PostgreSQL utilisent aussi de vrais groupes MLS.

Le serveur vérifie possession de la feuille certifiée, identité / session,
liste des destinataires autorisés, références et digests. Il valide réellement
les KeyPackages MLS. **Il ne vérifie pas le contenu cryptographique du commit,
du Welcome ni le transcript MLS**, qui restent opaques.

Avant toute acceptation locale, le moteur client devra vérifier la signature,
les pins / consentements, la politique de groupe, le véritable ID / contexte /
époque / arbre MLS et chaque identité de feuille. Un reçu HTTP ou `needs_rekey`
ne remplace aucune de ces vérifications. Une réception refusée doit aussi
restaurer les ratchets et les écritures MLS, comme le prévoit le coffre privé.
Ce raccordement et ses limites réseau sont encore une condition d'activation.

## Admission et ordre

Une genèse utilise `expected_revision=0`, sans parent ni époque attendue. Le
créateur est propriétaire du salon, ou membre d'un DM. Le salon doit être vide
de messages ordinaires et de réservations de fichiers clairs encore actives.
Les messages structurés d'activité ne constituent pas un historique ordinaire.

Une genèse à une feuille est à l'époque MLS 0, sans commit ni Welcome. Une
genèse ajoutant d'autres feuilles publie son commit de l'époque 1 avec leurs
Welcomes. La feuille initiale du créateur est à l'index 0 et n'a pas de package
d'admission. Chaque autre nouvelle feuille exige un package et un Welcome exact.

Pour les transitions suivantes, la révision, l'époque, l'incarnation et
l'empreinte du parent doivent correspondre à la tête serveur. Chaque transition
avance la révision et l'époque de un. L'auteur doit avoir conservé son admission
dans le groupe précédent ; un appareil nouvellement inscrit ne peut reprendre
seul le contrôle du groupe.

Une admission conservée garde utilisateur, appareil, incarnation, racine, index
MLS, référence de package et nonces d'adhésion / activation. Renouveler un
certificat n'autorise pas à changer ces identités ; son contenu MLS reste à
mettre à jour et vérifier dans le moteur. Partir puis revenir, ou désactiver
puis réactiver le compte, exige une nouvelle admission et un nouveau Welcome,
même si la liste apparente des utilisateurs est identique.

Chaque membre actif doit avoir au moins une feuille certifiée dans le plan.
Un nouveau membre sans appareil prêt bloque la transition. Les changements
d'adhésion, de politique, de certificat ou de session rendent l'ancienne liste
obsolète. `needs_rekey` est une indication recalculée à la lecture ; le futur
chemin d'envoi chiffré devra revalider cette liste pour chaque nouvel envoi.

Tête, événement, Welcomes ciblés, consommation des packages et reçu sont
committés ensemble. Les octets des packages consommés sont supprimés, leurs
références restent retirées. Une erreur de preuve, de destinataire, de durée ou
de CAS annule l'ensemble. Un retry strictement identique retrouve le reçu
avant de revérifier un certificat désormais expiré ; il ne réactive rien.
Réutiliser l'ID avec d'autres octets échoue. Les reçus restent privés à l'auteur.

Après la genèse, les nouveaux messages ordinaires et préparations de fichiers
clairs sont refusés avec `crypto_required`. Une conversion inverse n'est pas
exposée. L'envoi de messages et fichiers chiffrés reste à intégrer avant que
les apps proposent la genèse d'un salon.

## Révocation et livraison

Des verrous persistants par appareil / incarnation séparent validation de groupe
et mutation des certificats. Les écritures / suppressions de l'annuaire prennent
ces verrous en modification ; une transition prend en partage tous les verrous
anciens et nouveaux, dans un ordre stable, avant de lire les têtes et de
consommer les packages. La feuille initiale sans package est aussi protégée.
Une mutation terminée avant cette acquisition est visible et refuse l'admission
périmée. Une mutation ultérieure attend le commit puis impose la prochaine rotation.

Les lecteurs gardent l'autorisation de leur session, le salon et leur propre
incarnation jusqu'à soumission du corps HTTP. Aucun Welcome n'est remis à un
autre appareil, une ancienne incarnation ou une ancienne adhésion. Les verrous
de lecture expirent au plus après cinq secondes, raccourcis par les échéances
de session / certificat. L'échéance monotone est conservée pendant les requêtes
et la sérialisation ; le poll du corps la vérifie même si le worker d'expiration
n'a pas encore pu s'exécuter.

Ces barrières ne peuvent retirer des octets déjà reçus. Les tables de destinataires
ne prennent pas de clé étrangère vers les têtes ou utilisateurs distants pendant
le commit, pour éviter un cycle avec la désactivation d'un compte qui attend son
verrou d'incarnation. Les expirations des participants et packages sont revérifiées
avant commit, après la publication transactionnelle du fanout.

## Coordinateur client : genèse et admission persistantes

Le module privé `rv-crypto::groups` prépare une genèse réelle dans le coffre
protégé. La confirmation locale lie la liste, les nonces, la politique, les
packages, les pins, le certificat auteur et la portée. L'arbre et les indices
proviennent d'un `PublicGroup` validé sur le véritable GroupInfo et l'arbre
préparé. L'appareil local est lié à l'incarnation du coffre.

État MLS préparé et demande originale sont committés ensemble avant émission.
Le commit privé reste en attente jusqu'à un reçu exactement lié à la preuve.
Un checkpoint échoué ne remet aucun octet ; une réouverture récupère la demande
originale. Une modification de confiance / expiration bloque son retry, mais
la recherche du reçu permet de réconcilier une acceptation déjà survenue.
Finaliser ce reçu historique ne vaut pas permission d'un nouvel envoi.

La jointure utilise maintenant ce coordinateur : preview sur un fournisseur
temporaire, confirmation opaque puis acceptation dans la transaction protégée.
Elle compare le package réellement consommé, le certificat / incarnation local,
l'auteur MLS du Welcome, chaque feuille certifiée / pin et l'ID / contexte /
arbre / époque avec la preuve. La liste et les nonces doivent correspondre à
l'état autorisé courant observé séparément. Une preuve signée peut être valide
et néanmoins refusée si ses déclarations ne décrivent pas le vrai groupe.

Un échec, même après création MLS du groupe, annule consommation et écritures.
Un succès sauvegarde le reçu et le groupe ensemble avant retour. Le retry
historique exact après checkpoint perdu ne réaccorde aucun droit d'envoi.
Les tests utilisent de vraies bases privées rouvertes et prouvent les mêmes
secrets d'époque. La [réception protégée de commits](../../crates/rv-crypto/GROUP_COMMITS.md)
valide maintenant vrai auteur MLS, AAD de routage, propositions Add et références,
contexte / arbre / feuilles, puis sauvegarde successeur et reçu. Un commit local
concurrent n'est remplacé qu'après succès ; refus tardif / checkpoint interrompu
ne perdent pas l'ancienne outbox. Les références déjà observées restent mémorisées
après retrait. Onze scénarios supplémentaires passent, avec 79 tests du coffre
au total pour ce lot de réception. Le coordinateur prépare également les
successeurs publics : tête observée exacte, retraits explicites / ajouts frais,
nonces courants, véritable renouvellement de certificat de feuille et outbox
originale protégée jusqu'au reçu. Onze scénarios supplémentaires exercent ce
parcours, y compris rotation d'un singleton à l'époque zéro puis admission.
Suite privée complète : 90 tests réussis. Rattrapage complet,
messages et ordonnanceur connecté / fournisseurs restent ouverts ; ce n'est pas encore un
parcours utilisateur connecté. Aucune capacité E2EE n'est activée.

## Limites et preuves exécutées

La [frontière cliente HTTP](../../crates/rv-crypto/GROUP_HTTP.md) convertit les
observations, packages, préparations, reçus et événements vers le coordinateur
privé sans exporter ses clés. Métadonnées de packages comparées au vrai TLS,
hex / base64url / décimaux canoniques, digests et révisions / parents consécutifs
de pages sont contrôlés. Le vrai MLS et les pins restent vérifiés dans le coffre.
Le SDK Rust refuse également succès et erreurs crypto dépassant 4 Mio, avant
JSON et même en chunks. Six tests de conversion, quatre tests réseau de limite
et les 14 scénarios de routes PostgreSQL passent. Suite privée : 96 réussis.

La feature privée `native-http` ajoute un worker asynchrone au-dessus du SDK :
identité / génération / session courante vérifiées, crypto dans des tâches
possédées, reçu recherché avant POST original et cooldown durable. Réception
de page puis preview / confirmation restent distinctes avec roster courant.
Cinq scénarios HTTP à fixture déterministe exercent le vrai MLS / coffre, dont
réponses de genèse / rotation perdues, mêmes nouveaux secrets chez le pair,
reçu divergent, changement d'activation, recréation après 429 et arrêt partagé.
Suite complète initiale : 100 succès ; les cinq scénarios sont revérifiés
après ajout de la rotation.

Le banc combiné worker privé / serveur Rust / PostgreSQL passe aussi : vrais
appareils enregistrés et packages publiés par HTTP, genèse / admission ciblée,
rotations par chaque pair. Après réponses coupées suite aux commits serveur,
des Managers / SDK neufs réconcilient les reçus sans nouveau POST. SQL compte
exactement deux publications, trois transitions, un Welcome et un package
consommé ; les secrets d'époque des deux coffres concordent. Le checkpoint
externe du processus privé est simulé en mémoire ; aucune qualification de
trousseau ou destruction du processus privé n'en découle. Le test explicitement
ignoré par défaut est obligatoire dans le job dédié `native-crypto-http`.
Le banc actuel ajoute messages sur trois époques et abandon d'une rotation
préparée : réponse terminale perdue, reprise sans republication, POST tardif
interdit et mêmes secrets de groupe conservés. Trois transitions sont acceptées
et une tentative tardive est refusée ; un marqueur d'abandon de groupe est
enregistré sans nouvelle révision. Planification dans les fournisseurs,
projection des messages et qualification restent ouvertes.
Aucune capacité E2EE n'est activée.

Les limites se cumulent : 128 membres, 256 appareils, index MLS ≤ 4 095,
preuve ≤ 256 Kio, arbre / commit / Welcome individuel ≤ 1 Mio, charges opaques
cumulées ≤ 2 Mio et requête HTTP ≤ 4 Mio. Une page comporte au plus 16 événements
et borne les octets opaques remis à environ 2 Mio avant encodage base64 / JSON.
Les nouvelles transitions sont limitées à 256 par jour et appareil. Les SDK
respectent le délai crypto tout en laissant les lectures / reçus disponibles.

Les tests exercent : vrai commit d'ajout puis jointure MLS par le Welcome
effectivement livré, mêmes contexte / arbre, échange local de ciphertext,
commit de retrait, package consommé une seule fois, rejeu / restart, parent
concurrent, genèse / refus du clair et des uploads antérieurs, départ / retour,
autre appareil du même compte, attente de révocation et expiration du corps.
Les routes HTTP sont exercées par le vrai SDK Rust ; fixtures / transport TS
préservent des révisions supérieures à la précision entière de JavaScript.
Six scénarios d'observation ajoutent : liste privée complète / triée, session
non inscrite en crypto, membre désactivé, plan ancien après départ / retour et
réactivation, limite sans page partielle, véritables attentes de verrous dans
PostgreSQL, expiration du corps et tête périmée après changement d'époque.
Le parcours SDK construit sa preuve avec les versions réellement obtenues par
HTTP ; refus anonymes et succès portent aussi `no-store`.

Le [lot privé messages](../../crates/rv-crypto/MESSAGES.md) ajoute ratchets
applicatifs, outbox originale, réception / écho persistants et reçu exact dans
le checkpoint protégé. Preuve de routage externe et auteur / AAD MLS sont
vérifiés séparément, avec document riche borné. Un résultat conservé est repris
après réouverture ; un refus tardif ne consomme ni génération ni position.
La dernière position reçue ne vaut pas validation d'une page complète du journal.
Le noyau privé reste distinct des [routes de messages opaques](E2EE_MESSAGES.md)
et de leur journal ordonné ; leur raccordement au worker reste ouvert et aucune
capacité n'est activée.

Restent ouverts : suite du coordinateur de groupe dans le coffre, cérémonie de
consentement et politique vérifiées dans les apps, validation historique et
raccordement de la livraison des messages au coffre, pont Android, écrans existants, archives /
fichiers / historique importé et revue crypto indépendante. Ce lot ne ferme
pas J4 et n'autorise pas la bascule J5.
