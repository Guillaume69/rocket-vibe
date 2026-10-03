# Stockage privé du moteur E2EE natif

Fondation Rust de [RFC 0002](../../docs/rfcs/0002-e2ee-native.md), distincte du
[prototype MLS](../rv-crypto-spike/README.md). Workspace et lock propres : aucun
serveur ni client ne dépend encore de cette crate. Aucune capacité E2EE activée.

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
Initialisation interrompue, retrait / purge de compte et contrat de verrou sont
des travaux d'intégration encore ouverts.

## Limite de confidentialité des anciennes copies

Le WAL et les sauvegardes contiennent des **anciens documents chiffrés**. Avec
une clé de coffre durable, ils redeviennent lisibles si cette clé est compromise.
Le checkpoint empêche leur réutilisation par le moteur ; il ne les efface pas et
n'assure pas la forward secrecy du stockage. `secure_delete` ne suffit pas à
effacer les copies d'un SSD, du WAL ou d'une sauvegarde. La politique de clés
éphémères / rotation et la revue de leur destruction restent des conditions de
J4. [Exigences du stockage OpenMLS](https://book.openmls.tech/user_manual/persistence.html).

MLS n'est pas l'archive récupérable demandée par la RFC. Cette crate ne fournit
encore ni identité certifiée, ni politique d'admission, ni livraison serveur,
ni archive / fichiers, ni pont Android, ni adaptateur réel de trousseau.

## Vérifications

```sh
cargo fmt --manifest-path crates/rv-crypto/Cargo.toml -- --check
cargo clippy --locked --manifest-path crates/rv-crypto/Cargo.toml --target-dir target --all-targets -- -D warnings
cargo test --locked --manifest-path crates/rv-crypto/Cargo.toml --target-dir target
```

Six scénarios Linux passent, dont l'échange OpenMLS entre deux véritables bases
rouvertes : consommation / ciphertext original conservés, réception altérée
annulée puis original accepté, et rejeu refusé. Les autres preuves couvrent AEAD,
portées, tête ancienne restaurée, auteur concurrent, échec SQL, limites, fichier
incomplet et permissions / liens Unix. Deux arrêts forcés de processus encadrent
le commit SQLite : avant commit, état original ; après commit, reprise du seul
successeur authentifié. Le test enfant marqué `ignored` est exécuté par ce test
parent et tué à la frontière ; ce n'est pas un scénario omis.

Clés connues et BasicCredentials sont des fixtures publiques non certifiées.
Le checkpoint est simulé par le pilote de test ; ces preuves ne qualifient pas
un trousseau réel ni le comportement après coupure électrique. Le script serveur
exécute ces contrôles en CI. J4 reste ouvert jusqu'à l'intégration et la revue.
