# Chantier du serveur natif RocketVibe

Date de lancement : 30 septembre 2026. Branche : `feature/rocketvibe-server`.
Destination : [RFC 0001](rfcs/0001-serveur-rocketvibe-rust.md).

## Premier incrément : socle serveur et transports pilotes

- [x] Workspace Rust natif indépendant du bureau, `rv-server`, `rv-protocol`, `rv-client`.
- [x] Compose, base et volumes isolés du banc Rocket.Chat ; écoute locale.
- [x] Contrat JSON Schema, génération TypeScript et fixtures communes.
- [x] Comptes créés par CLI, Argon2id, sessions hachées et révocation.
- [x] Salons, contrôle des adhésions par le propriétaire et DM unique par paire.
- [x] Envoi texte idempotent, refus des demandes divergentes et historique paginé.
- [x] Séquenceur transactionnel, journal durable, snapshot cohérent et curseurs opaques.
- [x] WebSocket avec tickets à usage unique et reprise depuis un curseur.
- [x] Transports pilotes Rust et TypeScript, non raccordés aux interfaces existantes.
- [x] Tests contre PostgreSQL réel, HTTP / WebSocket, rejeu et redémarrage du serveur.
- [x] CI dédiée et documentation de démarrage / limites.

Les cases décrivent du code livré. Les résultats d'exécution et limites pratiques
doivent être conservés dans le résumé de livraison ; une définition de workflow
ne signifie pas que sa première exécution distante a déjà réussi.

### Vérifications exécutées le 30 septembre 2026

- Formatage et Clippy sur tout le workspace natif, sans avertissement.
- 9 tests Rust réussis, dont 7 contre PostgreSQL réel ; le test client exerce aussi
  le transport TypeScript contre le même serveur via HTTP et WebSocket.
- 5 tests du contrat / transport TypeScript et vérification TypeScript stricte réussis.
- JSON Schema et types TypeScript régénérés sans divergence.
- 12 tests existants du fournisseur Rocket.Chat réussis.
- Image de production construite et démarrée localement : readiness HTTP 204 et
  découverte native correcte sur `127.0.0.1:3400`.

La validation distante de la CI est à suivre sur la branche. Aucun parcours dans
les interfaces Android, GTK ou SwiftUI n'a encore été validé avec le serveur natif.

## Pour fermer J0

- [ ] Inventaire exhaustif des appels Rocket.Chat dans les écrans et modules natifs.
- [ ] Contrats restants : droits fins, lecture / compteurs, actions, profils, fichiers et clés.
- [ ] Corpus commun de rendu Markdown, mentions, citations et pièces jointes.
- [ ] Capacité / erreur / identité d'instance raccordées au contrat fournisseur des apps.
- [ ] Arbitrages de la RFC : taille d'instance, export disponible et spécification E2EE.

## Pour fermer J1

- [ ] Fournisseur RocketVibe mobile : sonde, connexion, stockage sécurisé, SQLite et outbox.
- [ ] Fournisseur bureau dans `rv-core`, exposition GTK / `rv-ffi` / SwiftUI.
- [ ] Application atomique des lots et curseurs dans les caches locaux.
- [ ] Parcours réel Android ↔ Windows, avec réseau coupé et processus clients tués.
- [ ] Heartbeats, rythme de diffusion, limites et essais d'authentification bornés.
- [ ] Snapshot paginé / tailles maximales et nettoyage des tickets / curseurs.
- [ ] Ordonnancement strict des révocations avec les réponses / sockets actives.
- [ ] Création de salon idempotente et découverte / adhésion aux salons publics.

Les transports pilotes et tests sans UI ne ferment pas J1 : il exige les parcours
dans les apps et les garanties restantes ci-dessus.

## Jalons suivants

- [ ] J2 : actions, fils, lectures / non-lus, présence, recherche, profils et favoris.
- [ ] J3 : fichiers, vocaux, cartes, emojis, push natif Android et partage.
- [ ] J4 : Jitsi et E2EE autonome avec spécification / revue dédiées.
- [ ] J5 : import reprenable, exploitation, sauvegarde / restauration et pilote de bascule.

Le fournisseur Rocket.Chat et son Compose restent disponibles. Aucun merge vers
`master`, changement d'instance réelle ou import utilisateur n'appartient au premier incrément.
