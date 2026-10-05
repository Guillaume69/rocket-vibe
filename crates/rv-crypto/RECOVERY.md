# Récupération de la racine E2EE — format v1

`identity::recovery` sauvegarde l'identité de compte de [RFC 0002](../../docs/rfcs/0002-e2ee-native.md).
Elle restaure la capacité de certifier une **nouvelle feuille**, sans exporter
ou restaurer l'ancien état MLS d'envoi. Ce lot reste hors des apps et ne récupère
pas encore les messages / fichiers historiques.

## Secret et sauvegarde

`RecoverySecret::generate` remplit une clé de 32 bytes avec l'aléa OS, dans un
buffer effacé au drop. Le secret n'a ni `Debug`, ni `Clone`, ni serde. Il est
indépendant du mot de passe HTTP, des sessions et des codes de récupération du
compte. `for_display` produit une chaîne temporaire `Zeroizing<String>`, réservée
à l'affichage explicite / copie du code. Aucun flux réseau, log ou index ne doit
la recevoir. L'adaptateur devra effacer aussi son état de vue au verrouillage.

Le code a 78 caractères : `rvk1-`, 64 chiffres hexadécimaux, `-`, puis 8 chiffres
de checksum. Celui-ci est constitué des quatre premiers bytes de
`SHA256("rocketvibe-recovery-code-v1\0" || clé)`. Il détecte les erreurs de saisie,
sans authentifier un compte. Le parseur borne la taille avant allocation et
accepte les hexadécimaux minuscules / majuscules ; un mot de passe n'est pas un code.

`RootBackup::seal` exporte uniquement un paquet chiffré. XChaCha20Poly1305 utilise
cette clé de récupération et un nonce OS de 24 bytes différent à chaque
sauvegarde. L'AEAD est l'[implémentation RustCrypto épinglée 0.10.1](https://docs.rs/chacha20poly1305/0.10.1/chacha20poly1305/).
La racine publique, l'ID de sauvegarde aléatoire et son instant de création sont
authentifiés dans l'AAD. Le service peut stocker le paquet opaque ; il ne possède
ni code ni clé privée.

## Encodage v1

Les [règles JSON ordonné](IDENTITY.md) s'appliquent. Le paquet a les champs
`header, nonce, ciphertext`. Le header a l'ordre
`version, root, backup_id, created_at` ; `version=1` fixe XChaCha20Poly1305.
`backup_id` a 16 bytes non nuls, `created_at` est un timestamp Unix en secondes.
Racine et tableaux de bytes suivent l'encodage v1 des identités.

- AAD : `UTF8("rocketvibe-root-recovery-v1") || 0x00 || JSON_compact(header)`.
- Clair : objet `root, seed`, avec la graine Ed25519 de 32 bytes ; il est borné
  à 4096 bytes et effacé au drop, ainsi que le buffer temporaire de décodage.
- Nonce : 24 bytes ; ciphertext : au plus 4096 bytes plus les 16 bytes du tag.
- Paquet JSON : au plus 24 Kio, tenant compte de l'expansion des tableaux de
  bytes ; champs inconnus et versions non prises en charge sont refusés.

La racine du clair doit être identique au header et à la racine attendue ; la
clé publique dérivée de la graine doit également correspondre. Un paquet AEAD
authentifié contenant une autre racine / graine est refusé.

## Restauration et confirmation perdue

La première restauration exige un coffre / fournisseur OpenMLS vierge. Elle
ne remplace jamais une identité ou une feuille déjà présente. L'adaptateur
confirme la racine attendue et vérifie compte / instance / époque / génération
de l'action avant d'appeler `restore` sur le worker protégé. HTTP ne fournit pas
ce consentement. Le résultat public ne sort qu'après confirmation du checkpoint.

Dans le même commit que la racine, `crypto-recovery-import-v1` conserve les
empreintes de racine et de **ce paquet exact** : SHA-256 du JSON compact du paquet
reconstruit dans l'ordre v1. Si le checkpoint / résultat est perdu, répéter la
même restauration avec le code correct retrouve le résultat. La répétition est
une lecture : elle ne retire aucune feuille, demande ou donnée MLS créée depuis.
Un autre paquet, même pour la même racine, ne peut pas emprunter ce reçu. Un
code incorrect reste refusé lors du rejeu.

L'appareil neuf génère ensuite sa clé et son incarnation via le
[parcours d'ajout](ENROLLMENT.md). Il doit recevoir un nouveau Welcome / commit
autorisé. Ni ancien ratchet, KeyPackage consommé, outbox, pin de correspondant,
ni révocation ne sont importés par ce paquet.

## Conditions restantes

Détenir le code et le paquet donne la clé racine privée : il faut protéger les
deux. Cette sauvegarde est volontairement récupérable et ne revendique pas de
forward secrecy. Changer le code ou supprimer un paquet du service **n'invalide
pas une ancienne copie** et son code. Une compromission exige une nouvelle
racine et la vérification explicite des correspondants ; une révocation de
feuille seule ne suffit pas. La politique des anciennes copies du coffre reste
celle de [README.md](README.md).

Le coordinateur `account::recovery` prépare maintenant le paquet / code dans
le coffre protégé avant sortie, exige la confirmation du code conservé avant
de rendre l'intention HTTP, règle un reçu exact et restaure une feuille neuve.
Le serveur et les transports gèrent une version active avec CAS et des reçus
originaux distincts ; voir [le protocole de sauvegarde](../../docs/protocol/E2EE_ROOT_BACKUPS.md).
Le règlement terminal des conflits et le pont Android / FFI sont raccordés.
Les paramètres Android existants proposent code temporaire / confirmation /
reprise / abandon et récupération d'une identité sur un appareil neuf.
Les contrôles GTK / SwiftUI et la qualification installée restent à intégrer.
L'archive E2EE et la récupération de ses clés ont un format / une autorisation
propres à définir ; ce paquet ne promet pas l'accès automatique à l'historique.
Sans code sauvegardé ni contrôleur de racine disponible, cette identité ne peut
pas être récupérée. Revue indépendante et qualifications installées restent
conditions d'activation.

Huit tests couvrent code / checksum / bornes, nonce / roundtrip, nouvelles clés
distinctes, altération / mauvaise portée / mauvais code, clair incohérent,
coffre actif refusé, refus transactionnel / réouverture et checkpoint perdu avec
rejeu préservant le nouvel appareil. Le backend de trousseau de ces tests est
une doublure ; le vrai trousseau Linux est testé séparément par le coffre.
