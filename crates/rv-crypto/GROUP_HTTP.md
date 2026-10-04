# Frontière HTTP des groupes MLS

Le module `groups::wire` convertit les DTOs publics de `rv-protocol::e2ee` vers
le coordinateur protégé. Une conversion n'approuve aucune racine, aucun appareil
et aucune époque MLS. Le réseau et les callbacks UI restent hors du verrou du
coffre ; les validations / décisions et mutations privées restent dans le
worker possédé du coordinateur.

## Observations et préparation

`Genesis::from_wire` prend le roster courant sans groupe, une nouvelle incarnation
de salon non nulle, l'opération et les réponses de packages disponibles.
`Change::from_wire` prend le roster avec sa tête, les retraits explicites et les
packages frais. Ces objets passent ensuite par les previews / confirmations
et préparations décrits dans [GROUP_COMMITS.md](GROUP_COMMITS.md).

Les en-têtes doivent désigner la même instance, génération et salle. Le roster
est complet, borné à 128 utilisateurs, trié et sans doublons ; IDs et nonces
sont canoniques. Chaque réponse de package est bornée avant décodage. Son vrai
KeyPackage TLS est validé : suite, signature, certificat public, identité / UID /
appareil / incarnation et référence RFC 9420 correspondent aux métadonnées.
Ni les métadonnées serveur ni cette validation ne remplacent les pins du coffre
ou la vérification des certificats au moment de la préparation.

`Submission::to_wire` conserve les octets publics originaux. Il vérifie signature
historique et correspondance exacte entre preuve, opération, portée, arbre,
commit et tous les Welcomes ciblés avant d'encoder. Il ne recrée aucun commit.
Le retry du coffre reste chargé de vérifier confiance / expiration courantes.
Les clés privées, état OpenMLS, ratchets et signers ne figurent pas dans le DTO.

Les références de package sont en base64url sans padding ; incarnations et
empreintes de reçu sont en hexadécimal minuscule. Les révisions / époques HTTP
restent des chaînes décimales canoniques dans l'intervalle PostgreSQL `i64`.
L'époque zéro est permise, la révision zéro ne l'est pas. Aucun passage par
un nombre JavaScript ni normalisation d'une forme ambiguë n'est effectué.

## Réception et reprise

`Receipt::from_wire` décode le reçu exact pour `Coordinator::confirm` ; ses
champs restent tous vérifiés contre l'outbox privée. `Receipt::from_state`
contrôle aussi la preuve publique et le digest de l'arbre d'une réponse de
tête. Le drapeau `needs_rekey = false` n'est pas une permission de chiffrer.

`Admission::from_wire` exige le Welcome ciblé de l'événement et le roster
indépendamment observé. `Commit::from_wire` concerne un successeur sans nouveau
Welcome local. Preuve, reçu et digests doivent correspondre. Leur acceptation
reste soumise à la validation MLS réelle, aux approbations et aux nonces dans
le coffre. Un ancien Welcome n'est pas rejeté uniquement parce qu'une tête plus
récente existe si les versions observées correspondent encore à son plan.

`wire::validate_page` borne la page à 16 événements, vérifie portée, révisions
consécutives à partir du curseur, parent / époque entre événements et curseur
suivant exact. Les payloads cumulés respectent la borne de 2 Mio, avec la même
exception que le serveur pour un seul événement complet. Ce contrôle ne
remplace pas la politique de rattrapage à travers les changements d'adhésion.
Un premier parent doit encore correspondre à l'état local avant fusion.

Le SDK Rust borne également les réponses `/api/v1/e2ee/` à **4 Mio avant Serde**,
via longueur annoncée puis somme des chunks, pour les succès et erreurs. Cette
borne couvre le plus gros événement permis après encodage JSON / base64. Les
reçus, lectures et règles de `Retry-After` conservent leur comportement ; une
réponse incorrecte retourne `InvalidCrypto` sans contenu privé dans l'erreur.

## Vérifications et suite

Six scénarios du coffre traversent les vrais DTOs avec commits et bases privées :
genèse / jointure / rotation et mêmes secrets d'époque, retry HTTP exact,
révisions supérieures à la précision JavaScript, métadonnées de package
substituées, roster / portée / nonces périmés, payloads / Welcomes modifiés et
pages avec événement réellement manquant. La suite privée complète compte
96 tests réussis, plus l'enfant de crash exécuté par son parent ; les six
scénarios ciblés sont vérifiés à nouveau après renforcement du chaînage.

Quatre tests réseau du SDK couvrent `Content-Length` excessif sans corps,
chunks excessifs sur succès et erreur, JSON / grands entiers préservés et
`Retry-After` sans bloquer les GET. Les 14 tests de routes de groupe contre
PostgreSQL, dont le vrai SDK sur HTTP, passent également. Ces bancs restent
distincts : le coordinateur privé n'est pas encore un worker connecté aux apps.

Ordonnanceur réseau, réconciliation des refus, rattrapage complet des adhésions,
retrait local / réadmission, messages et inbox / outbox, fichiers / archives /
import, pont Android et interfaces existantes restent ouverts. Les qualifications
sur appareils / trousseaux et la revue indépendante demeurent nécessaires.
Aucune capacité E2EE n'est activée.
