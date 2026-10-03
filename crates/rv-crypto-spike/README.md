# Prototype MLS de J4

Les tests de faisabilité de [RFC 0002](../../docs/rfcs/0002-e2ee-native.md).
Aucun serveur ou client ne dépend de cette crate ; son workspace et son lock
sont indépendants pour éviter de modifier les dépendances de production.

```sh
cargo test --locked --manifest-path crates/rv-crypto-spike/Cargo.toml --target-dir target
```

Trois scénarios utilisent OpenMLS 0.9.0 / RustCrypto 0.6.0 avec la suite 0x0001 :

- Welcome, ciphertext et identité / AAD, altération, restauration de l'état puis
  rejeu refusé. Une réception altérée consomme une clé : le futur moteur doit
  annuler les écritures et recharger le groupe avant de retenter.
- Trois appareils, dont deux du même utilisateur de test ; retrait d'une feuille
  et impossibilité d'ouvrir la nouvelle époque avec son état antérieur.
- Nouvelle feuille sans accès automatique à l'historique ; commit préparé
  conservé après rechargement. La bibliothèque permet encore d'émettre dans
  l'ancienne époque : la politique applicative doit bloquer ces envois.

Les identités de test sont des BasicCredentials non certifiés. Le stockage est
en mémoire, les copies de test contiennent des secrets et le rechargement n'est
pas un redémarrage disque. Le serveur de livraison et sa confirmation sont
simulés. Ces preuves ne valident ni la récupération / archive, ni le pont mobile,
ni l'authentification des comptes, ni la sécurité du stockage ou de l'application.
Les capacités E2EE natives restent désactivées.
