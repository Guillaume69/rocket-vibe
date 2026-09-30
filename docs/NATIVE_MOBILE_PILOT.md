# Pilote mobile du serveur RocketVibe

Branche : `feature/rocketvibe-server`. Ce deuxième incrément raccorde le serveur
Rust au mobile, via une messagerie React Native dédiée. Il ne ferme pas J1 de la
[RFC](rfcs/0001-serveur-rocketvibe-rust.md).

## Essayer en développement

1. Démarrer le [serveur natif](../apps/server/README.md) et créer deux comptes avec
   la CLI `create-user`. Les mots de passe passent par `RV_USER_PASSWORD`, sans
   les mettre dans les arguments ni dans un fichier versionné.
2. Installer un build de développement du mobile en suivant son
   [README](../apps/mobile/README.md). Les exigences natives habituelles, dont
   `google-services.json`, s'appliquent toujours au build ; le serveur natif
   n'utilise pas encore Firebase pour le push.
3. Avec l'appareil connecté par ADB, rediriger le port du serveur :

   ```sh
   adb reverse tcp:3400 tcp:3400
   ```

4. Saisir `http://127.0.0.1:3400` dans la connexion de l'app **debug**, puis le
   pseudo et le mot de passe créés par CLI. La sonde identifie RocketVibe et ouvre
   automatiquement le parcours natif. Un build release exige HTTPS ; le Compose
   conserve son écoute locale et ne publie pas PostgreSQL.
5. Créer un salon, inviter l'autre pseudo depuis le compte propriétaire, ouvrir
   un DM et échanger des messages. Couper le réseau, envoyer, puis reconnecter :
   l'envoi reste en attente et conserve son identifiant d'opération.

Le serveur neuf n'a aucun compte par défaut. Les utilisateurs créés par les tests
SQLx vivent dans des bases temporaires et ne servent pas à la connexion manuelle.
L'annuaire est limité aux 100 premiers comptes ; les invitations / DM du pilote
recherchent un pseudo exact dans cet annuaire.

## Fonctionnement livré

La session native contient le genre du serveur, son `instance_id` et son
`data_epoch`. La découverte vérifie ces deux valeurs avant les appels authentifiés.
Une identité changée impose une nouvelle connexion. Les jetons restent dans le
Keystore / Keychain via le stockage sécurisé existant.

SQLite est la source des messages affichés. Le snapshot, chaque lot du journal
et leur curseur sont écrits atomiquement dans la base du compte. L'outbox et le
message optimiste sont aussi écrits ensemble. Un écho HTTP ou WebSocket supprime
l'intention dans la même transaction que le message confirmé. Les positions sont
des chaînes décimales ordonnées exactement, même au-delà de `2^53`.

Après une coupure, le client rattrape les changements avant de vider l'outbox,
puis ouvre la socket depuis le dernier curseur committé. Un retrait de salon
purge messages, brouillons et envois locaux avant ce renvoi. Le snapshot d'une
nouvelle génération purge les anciennes intentions ; son cache reste masqué
avant cette reconstruction. Les sockets sont suspendues en arrière-plan et
reprises au premier plan.

Le parcours utilise des primitives React Native, le thème et les traductions de
l'app. Le moteur Rocket.Chat reste réservé aux sessions Rocket.Chat. Le client
REST de compatibilité d'une session native refuse localement les anciens
endpoints ; il ne transmet pas le jeton natif à ces routes.

## Limites du pilote

- Interface dédiée : pas encore de raccordement au contrat `Fournisseur` ni aux
  écrans communs, et aucun raccordement des clients bureau.
- Texte brut uniquement ; fichiers, Markdown enrichi, fils, actions, réactions,
  non-lus, présence, recherche, push, appels et E2EE restent au backlog.
- Les brouillons du composeur ne sont pas encore persistés. Les messages déjà
  envoyés à la file d'attente le sont.
- Invitation réservée au propriétaire côté serveur ; l'écran explique le refus
  si un autre membre tente cette action. Retrait de membre et administration
  n'ont pas encore de commandes dans cet écran.
- Pas d'annuaire public des salons ni d'adhésion libre. Les créations de salon
  ne sont pas idempotentes.
- L'historique affiche d'abord 100 messages locaux, puis élargit sa fenêtre par
  50. Le cache natif n'a pas encore de politique de rétention. Snapshot serveur
  limité à 100 salons, 50 messages récents chacun ; pagination du snapshot à venir.
- La validation visuelle et les kills réels sur Android restent à faire. L'export
  Expo vérifie le bundle JavaScript / Hermes, pas l'installation d'un APK.

Les limites de sécurité, de charge et d'exploitation du serveur sont détaillées
dans le [contrat du pilote](protocol/README.md).

## Vérifications reproductibles

Depuis la racine, les vérifications Rust / PostgreSQL et le scénario de deux
moteurs mobiles SQLite sont lancés par le service `check` du Compose natif :

```sh
docker compose --env-file docker/.env.native -f docker/compose.rocketvibe.yml run --rm check bash apps/server/scripts/check.sh
```

Depuis `apps/mobile/` :

```sh
npm ci --no-audit --no-fund
npm run typecheck
npm test
npx expo export --platform android --output-dir ../../artifacts/native-mobile-android
```

La CI dédiée exécute les deux suites et l'export. Le
[suivi du chantier](NATIVE_SERVER_EXECUTION.md) conserve les résultats et la suite
requise pour fermer J1.
