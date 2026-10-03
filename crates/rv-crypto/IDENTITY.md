# Identités et approbations E2EE — format v1

`identity` fournit les racines de compte, certificats d'appareil, pins locaux et
révocations de [RFC 0002](../../docs/rfcs/0002-e2ee-native.md). Cette crate reste
isolée : aucune UI ni capacité E2EE n'est activée par ce lot.

## Racine et certificat

`Issuer::generate` crée une graine Ed25519 avec l'aléa OS. La racine publique lie
l'identifiant immuable d'instance, l'UID et une génération aléatoire de 16
octets. Un nom affiché, un bearer ou le mot de passe HTTP ne remplace pas cette
identité. `Issuer` n'a ni `Debug`, ni `Clone`, ni export public de la clé privée.
`save` / `load` utilisent `crypto-root-v1` dans les enregistrements **chiffrés du
coffre** ; une racine existante différente est refusée, jamais remplacée.

Le certificat signé lie cette racine à un ID d'appareil, une incarnation de 16
octets, un numéro aléatoire, la suite MLS `0x0001`, la clé de signature de la
feuille et une durée d'au plus 90 jours. Sa signature Ed25519 est vérifiée avec
[`verify_strict`](https://docs.rs/ed25519-dalek/2.2.0/ed25519_dalek/struct.VerifyingKey.html#method.verify_strict),
en refusant aussi les clés faibles. Les timestamps Unix sont en secondes ;
l'admission exige `issued_at <= now < expires_at`.

Le `BasicCredential` MLS transporte le JSON du certificat, au plus 4096 octets.
Un texte Rocket.Chat, des champs inconnus ou un format non Basic sont refusés.
Le certificat n'est **ni une preuve de possession, ni une autorisation de salon**.
Le KeyPackage reçu doit d'abord passer la validation OpenMLS (signature et
lifetime) ; `authorize_key_package` compare ensuite sa suite et sa clé de
signature au certificat, puis exige le pin et l'approbation d'appareil exacts.
Un KeyPackage valide signé par une autre clé avec un certificat copié est refusé.

## Encodage signé et vecteur public

Chaque cadre est `UTF8(domaine) || 0x00 || UTF8(JSON compact ordonné)`. Il ne
s'agit pas de JCS / RFC 8785. Les champs sont reconstruits dans l'ordre ci-dessous,
sans espaces. Les entiers sont décimaux et les tableaux de bytes des tableaux
JSON d'entiers `0..255`. Les noms ont au plus 256 octets, sans contrôle Unicode.
Le payload signé a au plus 4096 octets. Un changement d'ordre ou de représentation
exige une nouvelle version.

| Objet | Ordre du payload | Domaine |
| --- | --- | --- |
| Racine | `version, instance, user, generation, public_key` | `rocketvibe-root-fingerprint-v1` pour SHA-256 |
| Appareil | `version, root, device, incarnation, serial, suite, signature_key, issued_at, expires_at` | `rocketvibe-device-certificate-v1` pour la signature |
| Certificat | `device, signature` | `rocketvibe-certificate-fingerprint-v1` pour SHA-256 |
| Révocation | tableau `[root, device, incarnation]` | `rocketvibe-device-revocation-v1` pour la signature |

La racine imbriquée respecte son ordre propre. Les signatures sont des tableaux
de 64 bytes. Le [vecteur public](fixtures/identity-certificate-v1.json) est produit
par [`identity_vector`](examples/identity_vector.rs) avec les graines publiques
`[7; 32]` et `[11; 32]`, exclusivement pour ce fixture. Le test Rust utilise le
vérificateur de production. Un vérificateur indépendant Node / OpenSSL reconstruit
le cadre, vérifie la signature et refuse substitutions d'appareil et de domaine :

```sh
node crates/rv-crypto/scripts/verify-identity-vector.mjs
cargo run --locked --manifest-path crates/rv-crypto/Cargo.toml --target-dir target --example identity_vector
```

## Confiance persistante et confirmation locale

`Pins::observe` est une lecture ; elle n'ajoute rien. Le premier pin exige
`accept_first` avec l'empreinte exacte affichée. Il reste **non vérifié** : une
substitution au premier contact reste possible. `verify_root` ne doit être appelé
qu'après comparaison hors bande. Une réponse HTTP ne suffit pas. Un changement
de racine bloque l'admission ; son remplacement exige les empreintes ancienne
et nouvelle confirmées et efface toutes les approbations d'appareils.

`preview_device` retourne un `Consent` local opaque, sans désérialisation réseau,
lié au certificat exact et à l'état du pin. `approve` refuse une confirmation
ancienne après une autre décision. Répéter la confirmation d'un appareil déjà
approuvé est idempotent. Changer sa clé sous la même incarnation est refusé.
Le futur adaptateur UI doit aussi contrôler compte actif, génération et portée
de la demande : ce token ne remplace pas les gardes de navigation des apps.

Les pins sont dans `crypto-trust-v1`, au plus 2 Mio / 1024 comptes / 64 appareils
par compte. Une révocation signée par la racine est additive, idempotente et
conservée après réouverture ; réémettre un certificat pour l'incarnation révoquée
ne la réadmet pas. La limite de 4096 révocations par compte bloque les ajouts
supplémentaires, sans éviction silencieuse d'une révocation ancienne.

Les décisions et clés sont sauvegardées via `protected::Manager::transact` ;
leur résultat ne sort qu'après confirmation du checkpoint dans le trousseau.
Une transaction refusée ne sauvegarde ni certificat ni changement de confiance.

## Conditions encore ouvertes

La [demande signée / preuve de possession](ENROLLMENT.md), son accord exact et
ses reçus durables sont implémentés dans le moteur isolé. La cérémonie UI /
livraison de nouvel appareil et la récupération E2EE restent à intégrer.
L'API interne `certify` ne doit pas être exposée directement à une réponse du serveur.
La liste signée des destinataires, les commits de salon, la consommation unique
des KeyPackages et la livraison réseau restent à intégrer.

Une révocation n'efface pas les données reçues auparavant. Un service peut
retenir sa livraison ; le retrait de feuille MLS et la suspension des envois
doivent être appliqués par le moteur / serveur. Si la **racine privée** est
compromise, un simple retrait d'appareil ne suffit pas : une nouvelle racine et
sa confirmation hors bande sont nécessaires. L'expiration d'un certificat
d'admission ne définit pas à elle seule la vérification des archives historiques.

Ces tests ne sont pas une revue crypto indépendante. J4 reste ouvert jusqu'aux
parcours intégrés, à la récupération / archive / fichiers et aux qualifications
des plateformes consignées dans la RFC.
