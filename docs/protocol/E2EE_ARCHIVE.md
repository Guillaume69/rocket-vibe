# Archive chiffrée : règles d'accès

Politique retenue pour RFC 0002. Elle précède l'implémentation du format et des
enveloppes ; aucune capacité d'archive de production n'est activée par ce document.

## Frontières de l'historique

L'archive conserve les documents reçus ou envoyés et authentifiés, indépendamment
des ratchets MLS. Son accès est lié à une identité, un salon et une période
d'adhésion. La portée inclut l'instance et son époque de données. L'identifiant
du salon ou le fait de connaître une clé ne constitue pas une autorisation de
demander d'autres périodes au serveur.

| Destinataire | Accès retenu |
|---|---|
| Appareil déjà admis, adhésion courante | Documents de la période autorisée ; aucune ouverture d'une autre période implicite |
| Nouvel appareil du même compte | Récupération explicite des archives de ce compte après approbation ; nouveau Welcome pour envoyer |
| Nouveau membre du salon | Messages depuis son admission ; aucun accès automatique à l'archive antérieure |
| Membre qui quitte puis revient | Nouvelle période d'adhésion ; les anciennes périodes ne sont pas fusionnées automatiquement |
| Appareil retiré | Aucun nouveau paquet ou partage de clés ; les copies et clés déjà détenues ne peuvent pas être rappelées |
| Compte exclu du salon | Aucun nouveau téléchargement depuis le salon ; ses documents déjà reçus restent des copies locales |
| Compte dont seule la racine a été restaurée | Aucun historique récupéré sans clés d'archive ou partage autorisé supplémentaires |

La récupération par un nouvel appareil conserve les frontières de l'adhésion
originale du compte. Elle ne transforme pas un nouveau membre en ancien membre.
Un partage d'une période plus ancienne exige une action séparée, une autorisation
actuelle et un aperçu des destinataires / bornes confirmé par un appareil qui
détient les clés concernées. Le parcours initial refuse ce partage tant que son
contrat et son interface ne sont pas livrés. Un administrateur du serveur n'a
pas les clés et ne peut accorder seul un accès cryptographique au contenu.

Les lectures en ligne revalident les droits et l'incarnation de l'appareil avant
de publier une réponse. La liste des périodes doit être complète et protégée
contre l'omission / le remplacement après observation locale. Les positions et
révisions traversent les interfaces en chaînes décimales exactes.

## Auteur retiré et documents déjà reçus

La validité actuelle d'un appareil autorise un nouvel envoi. Elle ne décide pas
à elle seule si un document déjà authentifié doit disparaître d'une archive.
Un document déjà accepté et observé dans une transaction protégée conserve son
contenu, son auteur et sa preuve d'origine après expiration ou retrait de cet
auteur. L'interface distingue cet état historique d'un appareil encore autorisé
à envoyer ; elle ne rétablit aucun pin ou consentement actuel pour le lire.

Une simple date fournie par le serveur ne prouve pas qu'un paquet précède un
retrait. Un paquet jamais observé, signé par une clé désormais retirée, ne peut
pas être promu silencieusement en ancien document authentifié. Son chemin
d'admission historique exige une preuve et une politique dédiées ; à défaut,
il reste indisponible. Une archive restaurée doit préserver les témoins
d'authentification d'origine ; elle ne relance pas un ancien envoi MLS et
n'efface pas les retraits connus pour accepter sa signature.

Le format devra lier sans ambiguïté document, preuve d'auteur, reçu d'origine,
salon, période d'adhésion et position. Le remplacement d'une racine, une nouvelle
époque serveur ou une autre incarnation ne doivent pas réinterpréter une preuve
historique comme un consentement courant.

## Clés, sauvegardes et actions

Les clés d'archive et leurs enveloppes sont distinctes de la sauvegarde de racine
`root-backup` et de l'état MLS. La sauvegarde actuelle de racine ne sera pas
étendue silencieusement pour inclure des conversations. La sauvegarde des clés
d'archive aura un consentement, une version et un règlement d'intention propres.
Les paquets seront authentifiés avant tout affichage ou création de projection.

Une archive récupérable garde volontairement l'accès aux documents archivés :
elle ne promet pas de forward secrecy pour ces documents. Retirer un appareil
ou remplacer un paquet de sauvegarde ne détruit pas une ancienne copie ni sa
clé. Sans clé ou appareil pouvant autoriser un partage, les données perdues
restent irrécupérables.

Édition, suppression, réactions et épingles seront des événements authentifiés
appliqués à la même archive. Une suppression retire la projection du document
selon les droits courants ; elle ne garantit pas l'effacement d'une copie déjà
exportée. La recherche privée indexe uniquement les documents autorisés dans
le stockage protégé du client. Texte, index et clés ne sont jamais ajoutés au
cache ordinaire ni à la recherche du serveur.

## Critères avant activation

- Format versionné, AEAD et enveloppes de destinataires spécifiés et revus.
- Transactions protégées conservant contenu et preuve avant l'acquittement.
- Historique au-delà du cache actuel de 64 documents, pagination et fils complets.
- Refus des périodes étrangères, nouveaux membres et appareils non approuvés.
- Reprise sans doublon après interruption du stockage / réseau / confirmation.
- Nouvel appareil du même compte avec cache vierge et racine / clés restaurées.
- Retrait d'auteur : document déjà observé conservé, nouveau paquet refusé.
- Retrait de lecteur pendant téléchargement et retour avec nouvelle adhésion.
- Sauvegarde / restauration serveur et refus de réinterpréter l'ancienne époque.
- Import Rocket.Chat conservant preuves et frontières, sans conversion en clair
  sur le serveur.
- Qualification GTK / SwiftUI / Android installés et revue crypto indépendante.

Les règles ci-dessus fixent les destinataires et la séparation entre lecture
historique et autorisation courante. Les formats, APIs, sauvegardes de clés et
tests de ces critères restent à implémenter.

## Premier format : document immuable v1

Le paquet public `rv-crypto-public::archive::Packet` et les primitives privées
`rv-crypto::archive` sont implémentés. Ce premier lot n'est pas encore raccordé
au journal, au serveur ou aux interfaces ; il ne supprime pas la limite actuelle
de 64 documents de la projection. Le reçu d'origine des tests est synthétique.

Le paquet contient :

| Champ | Liaison |
|---|---|
| `header.version` | Version 1 uniquement |
| `header.origin` | Reçu exact : portée / incarnation de groupe, opération, fil, empreinte du groupe et de l'intention, auteur / appareil / incarnation / certificat, ID et position du message |
| `header.author_membership` | Compte auteur et versions originales d'accès / activation |
| `header.key_id` | Identifiant OS aléatoire de 16 octets |
| `header.nonce` | Nonce OS aléatoire de 24 octets |
| `original_certificate` | Certificat historique correspondant au reçu d'origine |
| `certificate` | Certificat de la feuille qui signe l'archive ; même racine immuable que l'auteur d'origine |
| `ciphertext` | Document canonique chiffré ; codec identique au message privé vivant |
| `signature` | Signature Ed25519 de la feuille d'archive |

`position`, `group_revision` et `epoch` du reçu public sont des chaînes décimales
canoniques ; les versions d'adhésion le sont également. Les entiers sont bornés
à `i64::MAX`, avec zéro autorisé seulement pour l'epoch. Les autres champs du
reçu utilisent son schéma strict existant ; ses clés JSON sont triées lors de
la sérialisation. Le décodage canonique refuse les champs supplémentaires et
les versions / nombres ambigus avant d'accepter le paquet.

Une clé OS aléatoire de 32 octets chiffre un seul document avec
XChaCha20-Poly1305. Les données associées sont
`rocketvibe-archive-document-aad-v1`, un octet nul, puis le JSON canonique du
header. Le document déchiffré conserve opération / fil / citations / cartes et
les mêmes validations que le codec de messages. Sa limite est de 64 Kio ; celle
du ciphertext est de 64 Kio + 16 octets, et le paquet JSON est borné à 384 Kio.

La signature lie `rocketvibe-archive-document-proof-v1`, un octet nul, puis le
tuple JSON : header, empreinte du certificat original, empreinte du certificat
d'archive, SHA-256 du ciphertext. L'empreinte du paquet lie un autre domaine,
`rocketvibe-archive-document-fingerprint-v1`, à ses octets canoniques complets.
Les deux certificats sont authentifiés ; le certificat d'archive doit être
valide actuellement pour une nouvelle publication. Un certificat original
expiré reste une référence historique. Une feuille renouvelée ou récupérée de
la même racine peut archiver un original déjà observé sans en réécrire la preuve.
Une autre racine, même avec le même nom de compte, est refusée.

Les clés privées n'ont ni formatage de diagnostic, ni clone, sérialisation,
affichage ou export brut. Leur persistance utilise uniquement les records du
coffre chiffré, sous un nom dérivé de l'empreinte exacte du paquet. Une clé
substituée ou un paquet AEAD corrompu est refusé avant restitution du document.
Supprimer cette clé locale n'invalide pas une autre copie déjà détenue.

Ces signatures ne prouvent ni la date d'acceptation, ni l'adhésion, ni l'égalité
du document avec son original MLS. Le coordinateur devra vérifier cette égalité
et conserver le témoin d'observation dans la même transaction protégée avant
d'admettre une archive. La simple décryption ne remplace pas les contrôles des
droits actuels et des périodes autorisées définis plus haut.

Cinq tests privés exercent AEAD réel, réouverture de clé, liaison exacte,
substitutions, encodage / limites et certificat renouvelé. Un vecteur public à
positions supérieures à 2^53 est vérifié par Rust et indépendamment par
`node crates/rv-crypto-public/scripts/verify-archive-vector.mjs` (Node/OpenSSL),
ajouté au contrôle serveur. Ce vecteur contient un certificat jetable et un
paquet AEAD réel, sans clé privée ; il n'atteste pas une admission MLS réelle.

Restent la persistance complète des paquets, l'admission / pagination des
archives, les enveloppes de destinataires et sauvegardes de leurs clés, le
transport serveur, les lecteurs existants et la qualification indépendante.

## Stockage local : blocs chiffrés et checkpoint commun

Le coffre peut désormais conserver des blocs immuables dans `private_blobs`,
dans la même base SQLite que l'état MLS. Chaque bloc est chiffré sous la clé
du coffre avec XChaCha20-Poly1305, un nonce OS de 24 octets et un identifiant OS
de 16 octets. L'AAD lie le domaine `rocketvibe-private-blob-v1`, la portée complète
du compte / appareil / époque / incarnation et cet identifiant. Une référence
lie SHA-256 de l'AAD, du nonce et du ciphertext. Elle ne contient aucun hash
public du document en clair.

Les références doivent être conservées dans les records protégés. La liste SQL
des blocs n'est pas un index de confiance. L'admission et la chaîne / pagination
des documents d'archive devront lier leurs références à un catalogue protégé.
Lire un bloc par sa référence ne constitue pas une autorisation de lire un salon.

`Manager::transact_with_blobs` conserve la même lease OS et le même checkpoint
que les opérations MLS existantes. Blocs et références commitent dans une seule
transaction ; le résultat attend l'écriture et la relecture du checkpoint dans
le stockage protégé. Si cette écriture échoue, la reprise reconnaît uniquement
le successeur exact, puis rend l'original sans ajouter un second bloc.
Les blocs écrits sont vérifiés après l'UPDATE de l'état, avant commit : même un
trigger SQL qui efface ou substitue un nouveau bloc fait échouer la transaction.

Un bloc est borné à 1 Mio et une transaction à 1 024 nouveaux blocs. Son payload
ne grossit pas le snapshot principal de 16 Mio. L'ancien schéma est étendu dans
une transaction ; une genèse contenant déjà un bloc ne peut pas être reprise
comme initialisation vide. Un bloc omis, remplacé, d'une autre portée ou dépassant
ses limites est refusé avant sortie du clair. Les longueurs SQL sont contrôlées
avant allocation.

Cinq tests du coffre passent en 8,93 s : 70 blocs de 256 Kio (17,5 Mio) avec
réouverture et lecture après le 64e, absence de clair en DB / WAL, corruption /
omission / autre compte, rollback complet, migration, trigger malveillant et
limites / genèse. Les huit tests du coordinateur protégé passent en 1,34 s,
dont échec du checkpoint suivi d'une reprise sans doublon et refus d'un trousseau
indisponible. Les cinq anciens tests de coffre passent en 2,93 s, avec vrai kill
de processus et une entrée enfant ignorée appelée par son banc parent.

Ce stockage est interne et lié à l'installation protégée. Il ne remplace ni
le paquet portable d'archive, ni les enveloppes / sauvegardes de clés. L'index
d'observation, la pagination d'archive et les lecteurs ne sont pas encore
raccordés ; le cache affiché reste actuellement limité à 64 documents.
