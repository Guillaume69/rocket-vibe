# Ajout d'appareil — moteur isolé v1

`identity::enrollment` complète les [identités certifiées](IDENTITY.md) avec une
preuve de possession, une approbation locale liée à la demande exacte et son
reçu privé durable. Aucune capacité ni interface supplémentaire n'est activée.

## Parcours et stockage

1. Dans un coffre neuf, `LocalDevice::create` génère une clé Ed25519 de feuille
   et une incarnation aléatoire. La racine attendue doit déjà avoir été confirmée
   par le parcours d'identité ; une racine fournie par HTTP ne devient pas fiable
   parce qu'elle figure dans la demande. Une clé existante n'est pas remplacée.
2. `request` crée et sauvegarde une demande signée par cette **clé de feuille**.
   Elle lie racine, appareil, incarnation, ID aléatoire de 32 bytes, clé et fenêtre
   d'au plus 10 minutes. Un rejeu reprend exactement la même demande / expiration.
   Une demande expirée peut être remplacée, en gardant la clé et l'incarnation.
3. Sur le contrôleur qui détient la racine privée, `Issuer::preview_request`
   vérifie la preuve et retourne un consentement opaque lié à la racine, demande,
   état du registre et expiration choisie du certificat. L'UI devra présenter
   l'empreinte / QR de la demande à comparer avec le nouvel appareil. Une
   notification serveur, session HTTP ou preuve de possession n'est pas un
   accord humain. Le token n'est pas désérialisable depuis le réseau.
4. Après confirmation, `approve_request` signe le certificat et un `Grant` qui
   lie ce certificat à l'empreinte de la demande. Le registre `crypto-issuance-v1`
   persiste ce résultat dans le même commit. Répéter cette demande rend le Grant
   original ; réutiliser son ID avec un autre contenu ou confirmer une autre
   demande avec un aperçu périmé est refusé.
5. Le nouvel appareil vérifie le Grant, sa signature de racine et son lien exact
   à la demande privée encore en attente. `install` sauvegarde le certificat et
   retire cette attente. Une clé / incarnation différente ou un ancien Grant
   présenté pour une nouvelle demande sont refusés. Un rejeu déjà installé ne
   retire pas une autre demande de renouvellement en attente.

`crypto-device-v1` contient la graine de feuille, la demande et le Grant dans
les enregistrements chiffrés du coffre. `LocalDevice` n'a ni `Debug`, ni `Clone`,
ni export privé. Il implémente le
[`Signer` OpenMLS 0.6.0](https://docs.rs/openmls_traits/0.6.0/openmls_traits/signatures/trait.Signer.html)
pour créer les KeyPackages / messages avec la clé certifiée. Un objet chargé
avant une autre écriture ne peut pas écraser le nouvel enregistrement.

Ces méthodes sont internes : elles s'exécutent dans un callback
`protected::Manager::transact` sur le worker possédé. La demande ou le Grant
n'est remis à la livraison qu'après confirmation du checkpoint protégé. Un
refus annule le registre ; si l'écriture du checkpoint échoue après le commit,
la reprise retrouve le Grant original. L'état MLS / `LocalDevice` ne doit pas
sortir du callback, ni être réutilisé après une transaction refusée.

Le registre garde au plus 256 reçus encore rejouables / 2 Mio. Les reçus dont
la demande a expiré sont retirés lors d'une nouvelle émission ; la demande
expirée reste refusée avant ce traitement. Le dernier instant d'émission est
persisté : un retour d'horloge avant ce marqueur ne rouvre pas une fenêtre
ancienne après purge. `now` vient de l'horloge locale du worker, jamais d'HTTP.
Ces bornes n'évincent pas une décision encore rejouable pour faire de la place.

## Cadres v1 et vecteur

Les règles JSON / domaine NUL de [IDENTITY.md](IDENTITY.md) s'appliquent :

| Objet | Ordre du payload | Domaine |
| --- | --- | --- |
| Corps de demande | `version, root, device, incarnation, request_id, signature_key, issued_at, expires_at` | `rocketvibe-device-request-v1`, signature de feuille |
| Demande | `body, signature` | `rocketvibe-request-fingerprint-v1`, SHA-256 |
| Grant | tableau `[empreinte_demande, certificat]` | `rocketvibe-device-grant-v1`, signature de racine |

Le JSON du Grant réseau contient `request, certificate, signature`. Les
décodeurs explicites `from_bytes` sont bornés à 4096 bytes pour une demande et
8192 pour un Grant ; champs inconnus / doublons / formats hérités sont refusés.
Décoder n'est pas vérifier : il faut ensuite appeler la vérification et les
contrôles de portée / attente. Les signatures et empreintes sont des tableaux
de bytes ; les objets imbriqués suivent leur ordre v1.

Le [vecteur public](fixtures/enrollment-v1.json) utilise les mêmes graines de
fixture publiques que le certificat, et un ID de demande `[5; 32]`. Il passe les
vérificateurs de production Rust et le vérificateur indépendant Node / OpenSSL :

```sh
node crates/rv-crypto/scripts/verify-identity-vector.mjs
cargo run --locked --manifest-path crates/rv-crypto/Cargo.toml --target-dir target --example enrollment_vector
```

## Renouvellement de l'incarnation enregistrée

Le coordinateur partagé propose une demande explicite de renouvellement.
Il authentifie le certificat historique et le reçu actuel de l'appareil, y
compris après expiration, sans les employer pour autoriser un nouvel envoi MLS.
Une date antérieure à l'émission, une racine remplacée, une révision substituée
ou un retrait signé refusent la cérémonie. Le certificat de l'annuaire doit
être exactement celui installé, pas seulement contenir la même clé publique.

La demande conserve racine, incarnation, clé de signature et coffre. Un second
appareil transmet sa demande à son contrôleur de racine ; le contrôleur compare
et approuve explicitement, même si son propre certificat de feuille a expiré.
L'expiration de cette feuille ne détruit pas son autorité de racine. Une demande
encore valable se reprend sans prolonger sa durée ; son renouvellement après
expiration crée une nouvelle demande et invalide l'ancienne approbation.

Le certificat valide précédent peut encore servir tant que seule la demande
est en attente. Installer le Grant conserve le certificat et le reçu précédents
comme baseline privée, checkpoint l'enregistrement original et suspend les
nouveaux accès de conversation jusqu'à son ACK exact. L'adaptateur bureau ferme
les workers précédents à cette installation. Un serveur ayant accepté le POST
avant une réponse perdue est interrogé par l'ID original avant toute nouvelle
publication ; révision, portée, appareil, incarnation et racine du reçu sont
contrôlés. L'ancien baseline n'est supprimé qu'après cet ACK.

Les enregistrements antérieurs restent lisibles ; le champ privé optionnel de
renouvellement n'est écrit que pendant cette intention. Les réglages Android,
GTK et SwiftUI exposent l'expiration, la demande / approbation et la reprise.
Ils n'émettent pas automatiquement de commit MLS. Les contrôles existants de
chaque salon signalent le décalage entre sa feuille MLS effectivement vérifiée
et le certificat installé ; la transition explicite actualise cette feuille.
Le nouveau certificat n'autorise pas d'envoi avant cette mise à jour. Le reçu
HTTP accepté conserve l'ancienne époque jusqu'à la position exacte du commit
dans le journal, afin de lire les messages précédents. Historique et brouillon
restent dans le même coffre. Le banc bureau exerce renouvellement, HTTP réel,
rotation perdue, reprise sans second POST et nouvel envoi ; le pont mobile
exerce deux acteurs MLS et la réception du commit renouvelé. Les reçus mobiles
de ce banc sont synthétiques. Le remplacement des feuilles de pairs déjà
expirées et les parcours installés restent à qualifier.
Les essais du coordinateur exercent expiration, second appareil, réouverture,
reçu incorrect, annuaire changé et retrait ; le banc bureau exerce HTTP réel,
workers précédents et réponse perdue. Qualification installée et revue restent
des conditions distinctes.

## Prochaines conditions de sortie

Un Grant installé n'ajoute **ni pin de correspondant ni feuille de salon**.
`Pins` et la politique de groupe exigent leurs approbations / commits propres.
La racine privée reste sur le contrôleur ; elle n'est pas transmise au nouvel
appareil par ce format. La [récupération de racine](RECOVERY.md) emploie un code
aléatoire distinct du mot de passe HTTP et crée un nouveau parcours de feuille.
Délégation de contrôle et récupération visible restent à intégrer. Révoquer une
feuille ne retire pas une racine privée déjà compromise.

Les demandes / Grants se transfèrent explicitement entre appareils. Les gardes
de compte / époque / UI, le pont Android et les écrans de sécurité existants
sont raccordés ; leurs parcours installés complets, les feuilles de pairs
expirées et la revue indépendante restent à qualifier.
La restauration d'une racine ne doit jamais restaurer un ancien état MLS d'envoi.
Archive / fichiers, protocole de salon et revue indépendante restent ouverts.

Onze tests couvrent preuves altérées, expiration / retour d'horloge, KeyPackage
réel, Grant substitué, objet local périmé, limites / purge / parseurs, refus de
transaction, réouverture du coffre et checkpoint perdu. Ils constituent des
preuves du moteur, sans qualification d'un parcours sur appareil installé.
