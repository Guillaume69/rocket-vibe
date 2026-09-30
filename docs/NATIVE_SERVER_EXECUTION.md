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
- 10 tests Rust réussis, dont 8 contre PostgreSQL réel ; le test client exerce aussi
  le transport TypeScript contre le même serveur via HTTP et WebSocket.
- 5 tests du contrat / transport TypeScript et vérification TypeScript stricte réussis.
- JSON Schema et types TypeScript régénérés sans divergence.
- Régression de concurrence couverte : les envois et créations de DM ne bloquent
  pas les vérifications de clés étrangères utilisées par les changements d'adhésion.
- 12 tests existants du fournisseur Rocket.Chat réussis.
- Image de production construite et démarrée localement : readiness HTTP 204 et
  découverte native correcte sur `127.0.0.1:3400`.

La première CI distante est verte ; chaque correctif suit le même workflow sur la
branche. Le premier incrément ne comportait aucun écran natif connecté.

## Deuxième incrément : parcours mobile pilote

- [x] Sonde native avant authentification, sans repli Rocket.Chat si le protocole
  RocketVibe annoncé est incompatible.
- [x] Connexion, reprise et déconnexion natives ; genre, identité / génération et
  jeton conservés dans le stockage sécurisé existant.
- [x] Écran React Native dédié : salons privés / publics, invitation par le
  propriétaire, DM, texte, historique, retry / abandon et changement de serveur.
- [x] Projection SQLite : lot et curseur atomiques, outbox durable, écho idempotent
  et ordre exact des positions dépassant la précision JavaScript.
- [x] Reprise HTTP puis WebSocket, reconnexion, suspension au passage en arrière-plan
  et heartbeats ; file de trames bornée.
- [x] Purge locale au retrait d'un salon ; cache et envois d'une ancienne génération
  masqués avant le nouveau snapshot et jamais rejoués sur la suivante.
- [x] Test de deux moteurs mobiles et de leurs vraies migrations SQLite contre
  PostgreSQL : coupure, recréation, rejeu, retrait privé avant renvoi de l'outbox.
- [x] CI étendue aux changements mobiles, aux tests et à l'export Android.

### Vérifications locales du deuxième incrément

- 946 tests mobiles réussis, dont 18 tests natifs ; typecheck et ESLint des fichiers
  concernés réussis.
- 10 tests Rust réussis, formatage / Clippy et génération des contrats sans diff.
- Export Android Expo réussi : bundle Hermes et assets. Ce n'est pas un APK.
- Image serveur reconstruite ; readiness et découverte locale vérifiées.

La validation visuelle Android n'a pas été exécutée : aucun appareil n'est
connecté et les fichiers Firebase du build natif ne sont pas présents dans ce
checkout. Les tests clients recréent le moteur sous Node et un test SQLite ferme
puis rouvre une base sur disque ; ils ne prouvent pas encore le comportement d'un
processus Android réellement tué.
Les instructions et limites sont dans le [guide pilote](NATIVE_MOBILE_PILOT.md).

## Pour fermer J0

- [ ] Inventaire exhaustif des appels Rocket.Chat dans les écrans et modules natifs.
- [ ] Contrats restants : droits fins, lecture / compteurs, actions, profils, fichiers et clés.
- [ ] Corpus commun de rendu Markdown, mentions, citations et pièces jointes.
- [ ] Capacité / erreur / identité d'instance raccordées au contrat fournisseur des apps.
- [ ] Arbitrages de la RFC : taille d'instance, export disponible et spécification E2EE.

## Pour fermer J1

- [x] Pilote mobile : sonde, connexion, stockage sécurisé, SQLite et outbox.
- [ ] Intégration mobile au contrat fournisseur et aux écrans partagés, brouillons
  persistants et navigation native complète.
- [ ] Fournisseur bureau dans `rv-core`, exposition GTK / `rv-ffi` / SwiftUI.
- [x] Application atomique des lots et curseurs dans le cache SQLite mobile pilote.
- [ ] Même garantie dans les caches bureau.
- [ ] Parcours réel Android ↔ Windows, avec réseau coupé et processus clients tués.
- [ ] Heartbeats, rythme de diffusion, limites et essais d'authentification bornés.
- [ ] Snapshot paginé / tailles maximales et nettoyage des tickets / curseurs.
- [ ] Ordonnancement strict des révocations avec les réponses / sockets actives.
- [ ] Création de salon idempotente et découverte / adhésion aux salons publics.

Le parcours mobile pilote et les tests sans appareil ne ferment pas J1 : il exige
les parcours Android / bureau et les garanties restantes ci-dessus.

## Jalons suivants

- [ ] J2 : actions, fils, lectures / non-lus, présence, recherche, profils et favoris.
- [ ] J3 : fichiers, vocaux, cartes, emojis, push natif Android et partage.
- [ ] J4 : Jitsi et E2EE autonome avec spécification / revue dédiées.
- [ ] J5 : import reprenable, exploitation, sauvegarde / restauration et pilote de bascule.

Le fournisseur Rocket.Chat et son Compose restent disponibles. Aucun merge vers
`master`, changement d'instance réelle ou import utilisateur n'appartient à ces incréments.
