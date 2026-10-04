# Livraison des messages MLS natifs

État au 4 octobre 2026 : serveur opaque, journal ordonné et transports Rust /
TypeScript expérimentaux. `capabilities.e2ee` reste désactivé. Le [worker HTTP privé](../../crates/rv-crypto/GROUP_HTTP.md)
raccorde envoi / reprise et [pages protégées du journal](../../crates/rv-crypto/JOURNAL.md),
avec checkpoint commun aux messages / transitions et rattrapage sur la même
admission, avec authentification historique distincte de la validité actuelle
des certificats. Les POSTs serveur conservent leurs contrôles de date / roster
courants. Raccordement aux interfaces, réadmission après retrait,
archives et fichiers restent ouverts.
Ce lot ne ferme pas J4 et ne permet pas la bascule J5.

## Routes

Routes sous `/api/v1/e2ee/rooms/{room}`, session HTTP obligatoire et
`Cache-Control: no-store` sur les succès comme sur les refus :

| Route | Contrat |
|---|---|
| `POST /messages` | `ApplicationSubmission` : portée, opération, preuve canonique et ciphertext MLS en base64url sans padding ; reçu durable |
| `GET /message-operations/{operation}` | Reçu personnel d'une opération acceptée dans ce salon, sans ciphertext |
| `GET /delivery?after={position}&through={position}` | `DeliveryPage` : transitions et messages opaques dans un ordre commun, Welcome ciblé sur cet appareil |

Un nouvel envoi exige la session / l'appareil certifié de l'auteur, l'adhésion
courante, le droit d'écrire et une tête de groupe exacte. Tous les membres,
nonces d'activation, appareils, certificats et versions de politique du plan
accepté sont revalidés avant le commit. Un retrait, une désactivation ou une
politique devenue obsolète exige d'abord la transition MLS correspondante.
Les membres ordinaires d'un salon en lecture seule ne peuvent pas publier.

Une opération déjà acceptée renvoie le même reçu pour la même intention, même
après retrait du salon ou expiration du certificat. Le GET de reçu appartient
à l'utilisateur ; une autre session active de ce compte peut le lire sans être
admise en crypto. Il ne donne aucun ciphertext et n'accorde aucun droit d'envoi.
La portée de données courante reste obligatoire. Un autre utilisateur ou salon
ne retrouve pas ce reçu. Une intention divergente retourne `operation_conflict`.

La limite persistante est de 600 nouveaux messages par minute et appareil.
Les confirmations et retries exacts restent disponibles pendant cette limite.
L'identité d'opération est partagée avec les envois ordinaires, créations,
actions, commandes de salon et uploads : aucune réutilisation divergente entre
ces espaces n'est admise.

## Preuve publique et données conservées

[`rv-crypto-public::messages`](../../crates/rv-crypto-public/src/messages.rs)
définit Header, Proof et Receipt. La preuve lie portée et incarnation du groupe,
opération, tête acceptée, époque MLS, auteur / appareil / incarnation / certificat,
type de contenu et racine de fil facultative. La feuille certifiée signe le
routage et le SHA-256 du ciphertext. Les octets canoniques restent opaques en JS.

Le serveur vérifie le certificat, sa signature, l'appareil autorisé, les digests
et l'enveloppe TLS PrivateMessage / Application avec ID et époque attendus.
**Il ne déchiffre pas le document et ne valide pas l'auteur interne MLS ni l'AAD
authentifié** : ces contrôles restent obligatoires dans le coffre client avant
projection. Un reçu HTTP seul ne prouve pas qu'un pair peut ouvrir le contenu.

PostgreSQL conserve uniquement preuve, ciphertext, métadonnées de routage et
reçu. Le reçu comporte le Header canonique en base64url, l'empreinte de la
preuve, l'ID serveur et une position décimale exacte. Le document riche reste
dans le checkpoint privé. Les tables ordinaires ne reçoivent pas son texte.
Les métadonnées de routage, notamment la racine de fil, sont visibles au serveur.

Une réponse doit référencer une racine opaque existante du même salon, accessible
pendant l'admission de l'appareil auteur. Une réponse ne peut pas servir de
nouvelle racine. Les éditions, réactions, suppressions, cartes, compteurs,
notifications et projections chiffrées ne sont pas encore raccordés à ces routes.

## Ordre, pagination et admissions

La transaction d'une transition ou d'un message alloue une position au séquenceur
natif de l'instance et écrit sa trame dans `e2ee_delivery`. Une confirmation et
sa trame sont donc atomiques ; un retry exact n'alloue aucune nouvelle position.
Le journal ordinaire peut produire des positions intermédiaires : les trous
numériques ne constituent pas des messages manquants.

Toutes les positions HTTP sont des chaînes décimales canoniques comprises entre
zéro et `i64::MAX`. Elles ne doivent pas être converties en nombres JavaScript.
La première page fixe `through` à la dernière position crypto du salon. Les
pages suivantes conservent ce watermark et transmettent `next` comme `after`.
`next: null` clôt la plage ; les arrivées ultérieures attendent la plage suivante.
Chaque page comporte au plus 16 trames et environ 2 Mio d'octets opaques avant
base64 / JSON. Les deux transports bornent les réponses crypto à 4 Mio avant
décodage JSON. Une preuve de message est bornée à 16 Kio, le ciphertext à 128 Kio
et la requête POST à 256 Kio.

La visibilité d'une trame exige un témoin d'admission exact pour l'appareil :
portée, utilisateur, appareil, incarnation, racine, index de feuille, KeyPackage
d'admission, nonce d'adhésion et nonce d'activation. Les transitions qui
conservent cette admission préservent l'accès aux trames précédentes ; un
renouvellement de certificat seul ne change pas ce témoin. Un nouvel appareil,
départ / retour ou réadmission après retrait exclut les anciennes trames. Le
Welcome livré appartient uniquement à cette admission de cet appareil.

La migration 0040 reconstruit ces témoins à partir des transitions signées
existantes et ajoute les transitions au journal dans leur ordre par salon,
avant le premier message opaque. Les anciens endpoints de groupes restent
disponibles ; un client de messages doit utiliser l'ordre commun de delivery.

La réponse conserve une lease sur session, appareil et accès personnel jusqu'à
soumission du corps. Une révocation attend sa soumission ; un corps non soumis
expire au plus en cinq secondes et avant le délai réel de session / certificat.
Les publications gardent aussi les nonces d'activation des pairs jusqu'au commit,
avant de verrouiller le salon, pour éviter une course ou un cycle avec une
désactivation de compte.

## Vérification et travail restant

Les tests PostgreSQL exercent le vrai MLS, HTTP et le SDK Rust : confirmation
concurrente / reprise après recréation, un seul ciphertext et reçu, déchiffrement
effectif par le pair, positions au-delà de `2^53`, transitions et messages
intercalés, watermark fixe, retrait / réadhésion avec nouveau Welcome, fils,
quotas durables, conflits d'opération, refus de preuves / têtes / portées,
leases et expiration, publications concurrentes et désactivation de pair.
Le backfill exact de la migration est exercé sur de vraies transitions.
Les fixtures communes et le transport TypeScript contrôlent types, retries,
watermarks, absence de champs privés / clairs et limites avant JSON.

Ce journal ne résout pas à lui seul la validation historique dans le coffre :
transitions intermédiaires manquées, certificats anciens, retrait propre,
confirmation de messages concurrents à une rotation et progression d'un préfixe
complet restent à intégrer au worker. Une dernière position de message déchiffré
ne vaut pas preuve d'une plage complète. Stockage public opaque, récupération
privée de la projection, ponts desktop / Android, interfaces de confiance,
archives, fichiers et revue crypto indépendante restent des critères de J4.
