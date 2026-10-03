# RFC 0002 — Chiffrement natif et historique RocketVibe

| Métadonnée | Valeur |
|---|---|
| Date | 3 octobre 2026 |
| Statut | Spécification de travail J4 ; coffre client isolé, annuaire et transitions de groupe serveur, aucune capacité activée |
| Référence | RFC 0001 §13, P18 / P19 |
| Clients | Fournisseurs des apps mobile, GTK et SwiftUI actuelles |

## Décision de travail

Évaluer MLS 1.0, [RFC 9420](https://www.rfc-editor.org/rfc/rfc9420.html),
avec OpenMLS en Rust pour les nouveaux groupes chiffrés. Les formats `rc.v1` et
`rc.v2` gardent leur lecteur de compatibilité pour Rocket.Chat et les imports.
Un salon possède un format explicite ; aucun ciphertext n'est deviné d'après
son contenu et aucun envoi ne retombe en clair si une clé manque.

Le premier prototype utilise OpenMLS 0.9.0 et son fournisseur RustCrypto 0.6.0,
versions stables vérifiées sur crates.io. Suite unique :
`MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519` (0x0001). Le moteur déléguera les
opérations MLS à cette bibliothèque ; pas de ratchet ou d'échange de groupe
réimplémenté dans l'API. Le prototype reste distinct du serveur et des apps.
L'existence d'une bibliothèque ne vaut pas audit de notre intégration.

Un moteur Rust partagé évite deux implémentations crypto natives divergentes.
Il devra être accessible depuis le cœur bureau et un pont natif mobile limité
aux opérations de clé / message. Les écrans actuels de verrouillage, salon et
profil restent les points d'entrée. Le pont Android / Hermes est une preuve à
obtenir avant de retenir définitivement ce choix. OpenMLS annonce des tests sur
Linux / Windows / macOS et des builds Android ; cela ne qualifie pas notre app.
[Source du projet](https://github.com/openmls/openmls).

## Identités et appareils

Un compte possède une identité de signature E2EE générée par le client. Chaque
appareil possède sa clé MLS et un certificat signé par cette identité, lié aux
identifiants immuables compte / appareil / instance. Une session HTTP renouvelée
conserve l'identité d'appareil ; un login sur une autre installation en crée une
nouvelle. Le mot de passe de connexion n'est pas une clé E2EE.

Un appareil neuf exige l'approbation d'un appareil déjà autorisé ou un secret de
récupération E2EE distinct. Un bearer volé ou un administrateur ne peuvent signer
un certificat. Les KeyPackages sont signés, bornés en durée, consommés une fois
et liés à l'appareil ; leur publication n'accorde pas l'accès à un groupe.

L'identité d'un correspondant est épinglée localement et vérifiable par empreinte
hors bande. Le premier contact non vérifié demeure vulnérable à une substitution
du service d'identité ; l'UI doit l'indiquer. Un changement de racine suspend
l'ajout de clés jusqu'à une nouvelle vérification explicite. Une signature valide
du service HTTP ne remplace jamais cette vérification.

L'ajout d'un utilisateur au groupe exige une action d'un membre autorisé, avec
identité et liste de destinataires présentées avant signature. Les nouveaux
appareils d'un membre doivent présenter sa délégation valide. Les notifications
du serveur ne déclenchent pas seules l'admission d'une nouvelle racine E2EE.
Le module isolé [`identity`](../../crates/rv-crypto/IDENTITY.md) implémente racines
Ed25519, certificats bornés, pins explicites, comparaison hors bande et
révocations monotones. L'admission d'un KeyPackage validé par OpenMLS exige la
clé de feuille certifiée et son approbation locale exacte. Une confirmation
ancienne ne peut pas rétablir une autre incarnation ; une racine changée exige
les empreintes précédente et nouvelle confirmées et efface les approbations.
Neuf tests couvrent substitution / expiration / révocation / persistance,
dont un vecteur public également vérifié indépendamment sous Node / OpenSSL.
[Demande signée et accord exact](../../crates/rv-crypto/ENROLLMENT.md) sont
implémentés dans le moteur isolé : clé / incarnation neuves, preuve de possession,
confirmation opaque, Grant lié à la demande et reçu privé rejouable. Onze tests
couvrent refus / réouverture / checkpoint perdu, expiration / retour d'horloge,
substitutions / limites et vrai KeyPackage ; le vecteur de demande / Grant passe
Rust et Node / OpenSSL. La [récupération de racine](../../crates/rv-crypto/RECOVERY.md)
par code aléatoire de 256 bits, paquet XChaCha20Poly1305 et restauration dans
un coffre neuf est implémentée. Un reçu exact permet la reprise sans effacer
une feuille créée depuis ; huit tests couvrent refus / altération / réouverture.
Cérémonie UI, livraison, délégation de contrôle,
récupération d'archive et liste de salon restent à intégrer ; un `BasicCredential` MLS seul
ne les fournit pas. Si la
racine privée est compromise, révoquer une seule feuille ne suffit pas : la
racine doit être remplacée avec nouvelle vérification hors bande.

## Groupe, ordre et retraits

Une feuille MLS représente un appareil, plusieurs feuilles pouvant appartenir au
même utilisateur. Le groupe est lié à l'instance, à l'époque des données, au
salon et à une incarnation aléatoire ; un retrait puis retour ne réutilise pas
une ancienne autorisation. Les messages authentifient aussi l'ID d'opération,
l'auteur / appareil, le type de contenu et la portée conversation / fil.

Le serveur sert de livraison et conserve les messages MLS binaires, les arbres
publics et les Welcomes destinés aux appareils autorisés. Il sérialise les
commits par groupe / époque attendue, avec reçu d'opération durable et résultat
consultable. Welcome et commit sont publiés dans la même transaction ; le client
fusionne son commit préparé seulement après confirmation de son acceptation.
Les pairs vérifient signatures, destinataires et politique avant fusion.

Retirer un membre ou révoquer un appareil invalide immédiatement ses accès HTTP
et bloque les nouveaux envois chiffrés de l'ancienne liste. Un appareil autorisé
doit produire le commit de retrait avant reprise. Si aucun appareil capable de
le faire n'est connecté, le salon attend ; le serveur ne possède pas de clé pour
faire tourner le groupe. Un membre déjà destinataire conserve les contenus et
clés reçus auparavant. La suppression distante ne peut les effacer chez lui.

Deux commits concurrents ne se fusionnent pas aveuglément. Le perdant observe le
reçu et le nouvel état avant de proposer un autre commit. Un ciphertext accepté
est rejoué à l'identique ; une opération obsolète définitivement refusée permet
un rechiffrement sous une nouvelle opération. Les boucles automatiques sont
bornées et cessent au changement de compte, de groupe ou d'adhésion.

Le service peut retenir, ordonner ou refuser les livraisons : MLS ne garantit pas
la disponibilité. Les écarts de transcript doivent suspendre le groupe et
produire un diagnostic sans secret. La politique applicative de livraison et
d'identité relève aussi de l'[architecture MLS, RFC 9750](https://www.rfc-editor.org/rfc/rfc9750.html).

## Persistance, récupération et historique

État MLS, consommation des clés, ciphertext de sortie et curseur de traitement
doivent être committés ensemble avant remise réseau ou présentation du clair.
Un crash ne doit pas réutiliser une génération d'envoi ni présenter un message
dont la consommation n'est pas durable. Le moteur doit pouvoir préparer une
transition dans un stockage transactionnel sans muter l'état actif sur un refus.
Le prototype constate que le refus d'un message altéré peut consommer une clé de
réception : restaurer le stockage seul sans recharger le groupe en mémoire est
insuffisant. Il constate aussi que l'ancienne époque reste émettrice pendant un
commit préparé ; notre garde applicative doit donc interdire explicitement l'envoi.
Une base restaurée plus ancienne est traitée comme perte d'état : nouvel appareil
et nouveau Welcome, jamais reprise silencieuse des anciennes clés d'envoi.

Le stockage privé doit être chiffré et authentifié avec une clé protégée par le
trousseau / Keystore. WAL, sauvegardes et fichiers temporaires doivent suivre la
même politique. OpenMLS fait confiance à son stockage ; une simple table SQLite
ne satisfait pas cette exigence. [Contrat de persistance OpenMLS](https://book.openmls.tech/user_manual/persistence.html).

### Fondation de stockage implémentée

La crate isolée [`rv-crypto`](../../crates/rv-crypto/README.md) implémente une ligne
SQLite contenant le fournisseur MLS et les enregistrements d'opération, scellés
ensemble par XChaCha20Poly1305. Clé de 32 octets, nonce aléatoire OS de 24 octets,
AAD `(rocketvibe-mls-vault-v1, portée, révision)` ; document JSON borné à 16 Mio.
La portée comprend instance, génération, compte, appareil et incarnation.
[AEAD RustCrypto 0.10.1](https://docs.rs/chacha20poly1305/0.10.1/chacha20poly1305/).

Le fournisseur est reconstruit pour chaque transaction SQLite immédiate, puis
détruit. Consommation MLS, ciphertext d'outbox et données privées de réception
partagent le commit durable ; un refus annule tous les changements. Le parent
doit être privé ; création exclusive et contrôle des permissions / liens Unix,
WAL chiffré et `synchronous=FULL` sont appliqués. Les ACL Windows et la durabilité
réelle après coupure électrique restent à qualifier.

Un checkpoint public `(révision, digest SHA-256 de l'AAD / nonce / ciphertext)`
est stocké avec la clé dans le trousseau, hors de la base. Chaque nouveau
checkpoint bloque lectures / transactions suivantes tant que l'adaptateur n'a
pas confirmé son écriture protégée. Aucun résultat ne peut être publié avant
cette confirmation. Le verrou OS de l'adaptateur doit couvrir lecture, commit,
écriture et vérification, y compris en cas d'annulation du demandeur, pour
empêcher une écriture de trousseau tardive de rétablir un ancien checkpoint.

Si le processus meurt après commit SQLite mais avant l'écriture du checkpoint,
seul le successeur exactement une révision plus loin peut être repris : son
document authentifié doit contenir le checkpoint protégé précédent. La reprise
reste bloquée jusqu'à protection du nouveau marqueur. Tête antérieure, autre
portée, prédécesseur altéré ou fichier incomplet n'autorisent ni envoi ni
recréation silencieuse.

Le coordinateur `protected::Manager` implémente ce verrou sur le worker possédé,
la vérification du prédécesseur et la relecture du checkpoint après écriture.
L'entrée protégée est liée au répertoire canonique ; une copie de la base sous
un autre verrou ne peut pas bifurquer l'état d'envoi du même appareil.
L'initialisation explicite sauvegarde la clé d'abord ; sa reprise avant marqueur
n'accepte qu'une genèse authentifiée vide. Un fichier incomplet exige retrait
explicite puis nouvelle incarnation. Le retrait sauvegarde un tombstone sans
clé avant de retirer les fichiers, et ne réactive jamais l'ancienne incarnation.

L'adaptateur optionnel keyring 3.6.3 a des backends natifs explicitement choisis
pour Linux / macOS / Windows, dans un service distinct des sessions existantes.
[API et features du trousseau](https://docs.rs/keyring/3.6.3/keyring/).
Le vrai Secret Service Linux est vérifié avec nouveaux processus et bus,
verrou concurrent, arrêt forcé après commit / avant checkpoint, reprise et
retrait. Android / Keystore, raccordement aux comptes / widgets, sauvegardes
du trousseau, Windows / macOS installés et coupure électrique restent ouverts.

Le coffre durable ne revendique pas encore la forward secrecy du stockage :
une ancienne copie chiffrée dans le WAL / backup reste déchiffrable avec la clé
durable compromise. La détection de restauration empêche sa réutilisation,
sans l'effacer. Rotation / destruction des clés de stockage et politique des
copies constituent une condition de J4, distincte de l'archive récupérable.

Quatorze tests du coffre, dont échange MLS après réouverture disque et deux processus
tués avant / après commit, plus le vrai pilote de trousseau vérifient cette
fondation ; neuf tests supplémentaires couvrent les identités certifiées et
onze l'ajout d'appareil et huit la récupération de racine, soit 42 scénarios au total.
Le coffre reste hors des apps. L'[annuaire public serveur](../protocol/E2EE_DIRECTORY.md)
consomme les vérificateurs extraits sans clés privées : certificats / demandes /
grants, publication de vrais KeyPackages et reçus persistants sont disponibles.
Le [lot groupes serveur](../protocol/E2EE_GROUPS.md) ajoute liste signée, CAS de
révision / époque / parent, consommation atomique des packages et Welcomes
ciblés, avec vrai ajout / jointure / retrait MLS testés contre PostgreSQL.
Vérification et admission locales, coordinateur de coffre / outbox et livraison
des messages restent ouverts ; E2EE demeure désactivé.

### Archive et récupération

MLS n'est pas une archive récupérable : les clés d'application sont consommées.
L'auteur ne peut pas redéchiffrer son propre envoi à partir du ciphertext seul.
Un nouveau Welcome ne rend pas automatiquement lisible l'ancien historique.
[Comportement des messages OpenMLS](https://book.openmls.tech/user_manual/application_messages.html).

Pour satisfaire l'historique demandé par RFC 0001, il faudra une archive E2EE
distincte avec destinataires et autorisation de partage explicites. Une clé
d'archive récupérable conserve volontairement l'accès aux messages archivés :
on ne revendiquera pas de forward secrecy pour cette archive. La récupération
réadmet un appareil neuf ; elle ne restaure pas un ancien état MLS pour envoyer.
Nouveau membre, appareil neuf et ancien membre ne sont pas des destinataires
équivalents ; les règles d'historique sont figées avant l'implémentation.

Le format d'archive / sauvegarde de ses clés, son AEAD et son authentification
d'auteur restent à spécifier et revoir. La sauvegarde de **racine de compte**
est implémentée séparément : code OS aléatoire, AAD lié à la racine / ID de backup,
graine privée chiffrée et restauration neuve avec reçu de rejeu exact. Elle ne
récupère aucun ratchet, clé d'archive, pin ou fichier historique. Un code ancien
et une ancienne copie conservent l'accès à la racine ; changer le code ne la
révoque pas. Compromission de racine exige remplacement et vérification.
Cérémonie UI / réseau et revue restent ouvertes. Ce sont des conditions
bloquantes du parcours complet, pas des fonctionnalités promises par le prototype.
Sans secret ni appareil autorisé, l'historique perdu demeure irrécupérable.

## Données et compatibilité

Texte, mentions, cartes, citations, légendes et descripteurs de fichiers vivent
dans la charge chiffrée. Le serveur voit les métadonnées de routage, tailles et
destinataires nécessaires. Recherche, aperçus et contenu des notifications sont
construits localement après déchiffrement. Un verrouillage purge mémoire / index
privés ; il ne prétend pas retirer les copies déjà exportées par l'utilisateur.

Le chiffrement de fichiers en flux doit utiliser un format établi et authentifié,
avec clés de fichier uniquement dans la charge E2EE. Son choix et ses vecteurs
inter-apps sont un lot dédié ; le prototype MLS ne couvre pas les fichiers.

Pour P18, les blobs historiques, enveloppes privées / de salon, algorithmes,
paramètres et UID servant de sel sont importés opaques. Aucun serveur ne reçoit
le secret pour convertir l'historique. Les clients ouvrent ces contenus avec les
lecteurs existants. Passer aux nouveaux envois MLS crée une nouvelle incarnation
avec consentement et frontières d'historique visibles, sans réécriture des blobs.

## Lots et preuves de sortie

1. Prototype Rust isolé : création / Welcome, échange, altération, rejeu, nouvel
   appareil, retrait et attente d'un commit préparé. Ni API publique ni capacité.
2. Stockage privé transactionnel : redémarrage disque, crash à chaque frontière,
   réservation d'envoi, état obsolète / restauration et purge de compte.
   Fondation SQLite chiffrée, coordinateur de checkpoint / verrou, retrait et
   genèse interrompue livrés ; pont Android, raccordement aux apps, politique des
   clés de stockage et qualifications restantes encore ouverts.
3. Identités, délégations et récupération : substitution, changement de racine,
   certification d'appareil, vérification et révocation testées.
   Racines / certificats / pins / confirmations et révocations implémentés dans
   la crate isolée ; demande signée / preuve de possession, confirmation et
   reçu durable ajoutés. Sauvegarde / restauration de racine par code distinct
   et reçu exact livrées ; cérémonie UI / réseau, délégation de contrôle et
   récupération d'archive encore ouvertes.
4. Livraison PostgreSQL : reçus, commits concurrents, Welcome atomique,
   destinataires / droits, retrait en vol et suspension sans appareil disponible.
   Livraison serveur et genèse cliente protégée / retry original / reçu exact
   livrés. Jointure et transitions suivantes dans le coordinateur, réception et
   livraison des messages chiffrés restent ouvertes ; aucune capacité activée.
5. Pont mobile et intégration aux fournisseurs actuels ; archive / fichiers,
   historique autorisé et corpus d'import RC depuis cache vierge.
6. Revue indépendante du protocole applicatif / stockage et qualification des
   trousseaux, Android / Hermes, GTK / SwiftUI. Activation seulement après preuve.

La suite de tests d'une bibliothèque ne remplace pas la revue de notre modèle
d'identité, de persistance ou d'archive. P18 / P19 et J4 restent ouverts jusqu'à
ces parcours et à la vérification des garanties affichées.
