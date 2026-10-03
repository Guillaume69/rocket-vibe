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

## Prochaines conditions de sortie

Un Grant installé n'ajoute **ni pin de correspondant ni feuille de salon**.
`Pins` et la politique de groupe exigent leurs approbations / commits propres.
La racine privée reste sur le contrôleur ; elle n'est pas transmise au nouvel
appareil par ce format. Délégation de contrôle et récupération E2EE restent à
spécifier / implémenter, avec secret distinct du mot de passe HTTP. Révoquer une
feuille ne retire pas une racine privée déjà compromise.

Le service de livraison des demandes / Grants, les contrôles des appareils
autorisés, la gestion des retraits en vol, les gardes de compte / époque / UI,
le pont Android et les écrans de sécurité existants ne sont pas encore raccordés.
La restauration d'une racine ne doit jamais restaurer un ancien état MLS d'envoi.
Archive / fichiers, protocole de salon et revue indépendante restent ouverts.

Onze tests couvrent preuves altérées, expiration / retour d'horloge, KeyPackage
réel, Grant substitué, objet local périmé, limites / purge / parseurs, refus de
transaction, réouverture du coffre et checkpoint perdu. Ils constituent des
preuves du moteur, sans qualification d'un parcours sur appareil installé.
