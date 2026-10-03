# Livraison des transitions MLS natives

État au 3 octobre 2026 : protocole serveur expérimental, SDK Rust / TypeScript et
preuves PostgreSQL / MLS. `capabilities.e2ee` reste désactivé. Le coffre client
et les interfaces existantes ne sont pas encore raccordés à ces routes.
Spécification d'ensemble : [RFC 0002](../rfcs/0002-e2ee-native.md).

## Routes

Toutes exigent une session HTTP et l'adhésion courante au salon ; réponses et
refus portent `Cache-Control: no-store`.

| Route sous `/api/v1/e2ee/rooms/{room}` | Usage |
|---|---|
| `POST /transitions` | Transition signée, commit opaque, arbre public et Welcomes nominatifs, dans une transaction |
| `GET /state` | Dernier reçu, preuve signée, arbre courant et indication `needs_rekey` |
| `GET /events?after={revision}` | Au plus 16 transitions après une révision décimale canonique ; Welcome de l'appareil appelant seulement |
| `GET /operations/{operation}` | Reçu durable de cet utilisateur / appareil et de ce salon |
| `GET /key-packages/{user}/{device}` | Observation d'un KeyPackage publié, actif et disponible d'un membre du salon |

L'observation d'un package ne le réserve pas. Deux auteurs peuvent observer la
même référence ; seule une transition acceptée la consomme. Une observation
devenue périmée provoque un refus, sans changer de groupe ni de clé silencieusement.
Les révisions / époques des DTO HTTP restent des chaînes décimales exactes.

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

## Coordinateur client : genèse persistante

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

La jointure et réception dans ce coordinateur, les transitions suivantes et
le raccordement HTTP / fournisseurs sont encore ouverts. Le test de Welcome
utilise directement OpenMLS dans un second coffre protégé ; ce n'est pas encore
un parcours utilisateur connecté. Aucune capacité E2EE n'est activée.

## Limites et preuves exécutées

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

Restent ouverts : suite du coordinateur de groupe dans le coffre, cérémonie de
consentement et politique vérifiées dans les apps, outbox de messages / réception persistantes, journal et
livraison des messages chiffrés, pont Android, écrans existants, archives /
fichiers / historique importé et revue crypto indépendante. Ce lot ne ferme
pas J4 et n'autorise pas la bascule J5.
