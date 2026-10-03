# Stockage privé du moteur E2EE natif

Fondation Rust de [RFC 0002](../../docs/rfcs/0002-e2ee-native.md), distincte du
[prototype MLS](../rv-crypto-spike/README.md). Workspace et lock propres : aucun
serveur ni client ne dépend du coffre. Les formats / vérificateurs publics sont
partagés via [`rv-crypto-public`](../rv-crypto-public/README.md), consommé par le
serveur et réexporté ici sans changement de format. Aucune capacité E2EE activée.

## Format et transaction

`vault::Vault` stocke le fournisseur OpenMLS RustCrypto 0.6.0 et les enregistrements
privés d'opération dans **une seule ligne SQLite chiffrée**. Le fournisseur est
reconstruit à chaque opération ; aucune instance MLS modifiée n'est réutilisée
après un refus. `transact` persiste dans un même commit la consommation des clés,
le ciphertext original d'outbox et les éventuels reçus / données privées de
réception. `inspect` ne persiste aucune mutation ; groupes et fournisseurs ne
doivent pas sortir de ces callbacks. Cette API Rust est interne au futur moteur,
pas une surface FFI permettant à l'UI de modifier directement les clés.

- XChaCha20Poly1305, clé de 32 octets, nonce aléatoire OS de 24 octets par commit.
  Le domaine `rocketvibe-mls-vault-v1`, la portée instance / génération / compte /
  appareil / incarnation et la révision sont les données associées authentifiées.
  [Implémentation RustCrypto épinglée](https://docs.rs/chacha20poly1305/0.10.1/chacha20poly1305/).
- Un document JSON authentifié contient les entrées du stockage OpenMLS, les
  enregistrements privés et le checkpoint précédent. Le document sérialisé est
  borné à 16 Mio ; nombre d'entrées et allocations de la lecture SQL sont bornés.
  Ce stockage complet n'est pas une base d'historique à grande échelle.
- SQLite : WAL, `synchronous=FULL`, transaction immédiate, fichiers temporaires
  en mémoire. SQL ne reçoit que la révision publique, le nonce et le ciphertext.
  Un refus crypto, un dépassement de limite ou un échec SQL annulent l'opération.
- Le fichier est créé exclusivement, jamais remplacé. Sur Unix : mode 0600,
  refus des liens et permissions de groupe / tiers, synchronisation du parent à
  la création. Le parent privé appartenant à l'utilisateur OS reste une
  précondition du futur adaptateur. ACL Windows et persistance OS sont à qualifier.

Les buffers privés possédés sont effacés au mieux à la libération ; aucune
garantie d'effacement de toutes les copies des bibliothèques, de la RAM, du swap
ou d'un dump système n'est annoncée. Clé, document, fournisseur et coffre
n'implémentent pas `Debug` ; les erreurs ne contiennent aucun contenu privé.

## Checkpoint protégé et reprise

Le checkpoint `(revision, SHA-256(AAD || nonce || ciphertext))` est conservé
**hors de SQLite dans le stockage protégé**, avec la clé. Son digest est public ;
sa protection contre remplacement provient du trousseau, pas d'un secret dans
SHA-256. Le copier à côté de la base annulerait la détection d'une restauration.

1. Sauver la clé dans le trousseau avant `create`. Le coffre neuf est bloqué.
   Sauver son checkpoint initial, puis appeler `checkpoint_persisted`.
2. À chaque `transact`, sauver le checkpoint retourné avant publication du
   résultat réseau / UI. Lecture et transaction suivantes restent bloquées jusque
   là. `checkpoint_persisted` exige la valeur exacte ; il ne constitue pas la
   preuve de l'écriture OS, qui incombe à l'adaptateur.
3. `open` exige la tête exacte protégée et un document authentifié. Une base
   ancienne, un autre compte / appareil ou une tête altérée sont refusés.
4. Après crash **entre commit SQLite et écriture au trousseau**, seule la tête
   exactement une révision plus loin est récupérable par `recover_committed`.
   Elle doit contenir le prédécesseur protégé dans son document authentifié.
   Le nouveau checkpoint doit ensuite être protégé avant tout usage.

L'adaptateur doit conserver un verrou OS par portée pendant lecture du trousseau,
transaction, écriture et vérification du checkpoint. Des écritures de trousseau
hors ordre pourraient restaurer un ancien marqueur. Une lecture indisponible ne
vaut jamais absence ; fichier incomplet, clé absente ou tête incompatible exigent
un arrêt explicite, jamais une recréation silencieuse du même état d'envoi.

`protected::Manager` enveloppe ce cycle dans un worker synchrone possédé : verrou
OS, lecture du trousseau, commit, écriture conditionnée au prédécesseur, relecture
de confirmation, puis retour du résultat. Si l'appelant abandonne le worker,
l'opération OS conserve le verrou jusqu'à son terme. Le verrou est explicitement
libéré à la fin, même si un lancement de processus a brièvement hérité du descripteur.
Une concurrence retourne `crypto_storage_busy`, sans seconde opération crypto.
La portée et le répertoire canonique sont liés à l'entrée protégée : une copie
de la base sous un autre répertoire / verrou ne peut pas forker le même appareil.

L'initialisation est explicite et sauvegarde d'abord la clé. Un crash avant le
checkpoint initial ne permet de reprendre qu'une genèse authentifiée vide de
clés MLS / enregistrements. Un fichier incomplet est refusé ; le rétablissement
exige retrait explicite et nouvelle incarnation, sans remplacement implicite.
`retire` sauvegarde un tombstone **sans clé**, puis retire uniquement les fichiers
SQLite de cette portée. Tombstone et fichier de verrou restent en place :
restaurer une ancienne copie ne réactive pas l'incarnation retirée.

Le backend optionnel `system-keystore` utilise keyring 3.6.3 avec les features
explicites Secret Service synchrone / transfert chiffré Linux, Keychain macOS et
Credential Store Windows, dans le service `me.barrut.RocketVibe.crypto.v1`, hors
des sessions Rocket.Chat. [Contrat de la bibliothèque](https://docs.rs/keyring/3.6.3/keyring/).
Les plateformes non prises en charge n'obtiennent pas un backend mock de repli.
Android exigera son propre pont Keystore. Les widgets, retrait de compte et
verrouillage des apps ne sont pas encore reliés à ce coordinateur.

## Limite de confidentialité des anciennes copies

Le WAL et les sauvegardes contiennent des **anciens documents chiffrés**. Avec
une clé de coffre durable, ils redeviennent lisibles si cette clé est compromise.
Le checkpoint empêche leur réutilisation par le moteur ; il ne les efface pas et
n'assure pas la forward secrecy du stockage. `secure_delete` ne suffit pas à
effacer les copies d'un SSD, du WAL ou d'une sauvegarde. La politique de clés
éphémères / rotation et la revue de leur destruction restent des conditions de
J4. [Exigences du stockage OpenMLS](https://book.openmls.tech/user_manual/persistence.html).

MLS n'est pas l'archive récupérable demandée par la RFC. Cette crate ne fournit
encore ni raccordement HTTP, ni archive / fichiers, ni pont Android. Le module
[`identity`](IDENTITY.md) fournit racines Ed25519, certificats, pins / confirmations
explicites et révocations ; la cérémonie de nouvel appareil, la récupération
et la politique d'admission de salon restent à intégrer. Le parcours interne
[`enrollment`](ENROLLMENT.md) persiste la demande signée et son Grant exact,
avec confirmation opaque et rejeu durable. La [récupération de racine](RECOVERY.md)
fournit une sauvegarde AEAD par code aléatoire distinct et une restauration
transactionnelle neuve / reçu exact, sans importer l'ancien état MLS.
Trousseaux Windows / macOS, ACL Windows,
restauration des sauvegardes du trousseau et coupure électrique sont à qualifier.

## Préparation de groupe et reçu

`groups::Coordinator` prépare la genèse dans le coffre protégé. Le preview lie
portée / incarnation du salon, politique, nonces d'adhésion, packages, pins et
certificat local à une confirmation opaque valable cinq minutes au maximum.
Chaque appareil distant exige une racine observée et une approbation persistante.
`LocalDevice::create_bound` lie aussi l'incarnation de la feuille au coffre choisi
avant sa création ; les clés privées restent générées dans la transaction.

Le vrai commit MLS reste **en attente** jusqu'au reçu exact : portée, opération,
révision, époque et empreinte de transition doivent toutes correspondre. L'arbre
signé utilise les indices réels de feuilles d'un `PublicGroup` validé, sans
fusionner prématurément le commit. Commit, Welcome, preuve et état MLS sont
persistés ensemble ; aucun octet n'est remis au transport avant confirmation
du checkpoint protégé. Après arrêt ou réponse perdue, `retry` retrouve les
octets d'origine, sans générer une nouvelle genèse.

Un changement de pins ou une expiration interdit la retransmission. La recherche
du reçu reste disponible : un reçu déjà accepté peut finaliser l'état historique,
sans réautoriser un nouvel envoi. `ready_epoch` est uniquement un diagnostic.

`preview_admission` valide un vrai Welcome dans une copie temporaire du fournisseur :
aucune consommation de package n'est persistée. La confirmation lie aussi les
adhésions / activations actuelles observées indépendamment. `accept_admission`
revérifie le vrai package consommé, son certificat / incarnation, l'auteur MLS
du Welcome, chaque feuille et pin, l'ID / contexte / arbre / époque. Consommation,
groupe rejoint et reçu sont sauvegardés ensemble avant tout succès remis aux apps.
Un refus tardif annule les écritures MLS ; un checkpoint perdu reprend seulement
l'acceptation exacte historique. Ni une racine ni un appareil inconnu ne sont
approuvés automatiquement par une signature valide de transition.

Réception des commits / messages, transitions suivantes, politique de
chaque envoi, transport et ponts vers les apps restent ouverts ; E2EE demeure
désactivé. Voir le [contrat de livraison](../../docs/protocol/E2EE_GROUPS.md).

## Vérifications

Le [coordinateur de publication](PACKAGES.md) conserve aussi les véritables
KeyPackages privés avec leur demande HTTP publique exacte avant émission.
Réouverture / checkpoint perdu reprennent le lot original ; ACK substitué,
expiration, révocation et package déjà consommé sont refusés. Un reçu passé
peut être réconcilié sans autoriser de nouvel envoi. Les packages sont retirés
de l'index seulement après consommation MLS, avec une borne de rétention de 64.
Le module utilise les DTOs partagés ; transport / abandon confirmé / nettoyage
des expirés et raccordement aux apps restent à intégrer.

```sh
cargo fmt --manifest-path crates/rv-crypto/Cargo.toml -- --check
cargo clippy --locked --manifest-path crates/rv-crypto/Cargo.toml --target-dir target --all-targets -- -D warnings
cargo test --locked --manifest-path crates/rv-crypto/Cargo.toml --target-dir target
cargo test --locked --manifest-path crates/rv-crypto/Cargo.toml --features system-keystore --target-dir target
node crates/rv-crypto/scripts/verify-identity-vector.mjs
```

Soixante-huit scénarios Linux passent, dont l'échange OpenMLS entre deux véritables bases
rouvertes : consommation / ciphertext original conservés, réception altérée
annulée puis original accepté, et rejeu refusé. Les autres preuves couvrent AEAD,
portées, tête ancienne restaurée, auteur concurrent, échec SQL, limites, fichier
incomplet et permissions / liens Unix. Deux arrêts forcés de processus encadrent
le commit SQLite : avant commit, état original ; après commit, reprise du seul
successeur authentifié. Le test enfant marqué `ignored` est exécuté par ce test
parent et tué à la frontière ; ce n'est pas un scénario omis.

Les preuves du coordinateur couvrent aussi erreurs / réponses perdues du stockage
protégé, checkpoint initial interrompu, purge répétable, base copiée, permissions
du parent et verrou conservé pendant une écriture retardée. Les fixtures MLS du
coffre utilisent des BasicCredentials non certifiés. Neuf tests d'identité
supplémentaires vérifient les vrais KeyPackages / certificats, substitution de
clé / racine, expiration / portée, refus sans approbation, confirmation ancienne,
révocation persistante et racine sauvegardée dans le coffre. Le vecteur signé
public passe aussi le vérificateur indépendant Node. Onze scénarios d'ajout
d'appareil couvrent la preuve de possession, limites / expiration / retour
d'horloge, confirmation ancienne, Grant substitué, KeyPackage réel, refus
transactionnel et reçu original retrouvé après checkpoint perdu. Le vecteur
public de demande / Grant est également vérifié sous Node / OpenSSL.
Huit scénarios de récupération vérifient code / checksum, AEAD / portée / bornes,
clé privée cohérente, refus de coffre actif, refus transactionnel, réouverture et
rejeu après checkpoint perdu sans effacer la nouvelle feuille.
Neuf scénarios de groupe vérifient vraie jointure par Welcome et mêmes secrets
d'époque, commit non fusionné avant reçu, réouverture / retry identique, chaque
champ du reçu altéré, checkpoint perdu, consentement périmé, pins / révocation,
certificat expiré, portée / incarnation, genèse solitaire et bornes d'observation.
Huit scénarios de jointure couvrent preview sans consommation, vrai groupe
persistant / mêmes secrets, package à usage unique, métadonnées valablement
signées mais fausses, auteur MLS différent, Welcome corrompu, adhésions / époque
de salon, approbation de chaque destinataire, refus applicatif après crypto et
reprise historique après checkpoint perdu.
Neuf scénarios de publication vérifient le DTO HTTP, références / dates réelles,
chaînes décimales exactes, chaque champ du reçu, reprise de checkpoint,
interdiction de renvoyer après consommation / révocation, jointure avec le
package retrouvé et libération de la borne de rétention après vraie admission.

[`scripts/keystore-smoke.sh`](scripts/keystore-smoke.sh) utilise un **vrai Secret
Service Linux**, ses répertoires XDG jetables et plusieurs processus CLI. Un
processus est tué après commit SQLite, avant l'écriture protégée ; un concurrent
est refusé pendant le verrou. Un nouveau bus / daemon retrouve la clé, confirme
le successeur et les octets d'outbox originaux, puis retire l'incarnation.
Ce banc passe sous Fedora dans le conteneur existant, avec `--cap-add IPC_LOCK`.
Aucun profil utilisateur de l'hôte n'est connecté.

La CI a une matrice crypto Linux / Windows / macOS : formatage, Clippy, tests et
compilation du backend natif ; Linux exécute aussi le vrai banc de trousseau.
Les validations serveur / mobile et longs pilotes clients restent obligatoires pour changements clients / serveur,
workflow, base inconnue, ou moteur crypto consommé par une app. Seuls les lots
crypto encore isolés et Markdown peuvent les éviter. La détection vise la
dépendance privée exacte, y compris renommée / indirecte ; `rv-crypto-public`
seul n'ajoute pas de coffre au serveur. Les tests ne qualifient pas
la coupure électrique, les trousseaux installés ou une revue crypto indépendante.
J4 reste ouvert jusqu'à l'intégration et la revue.
