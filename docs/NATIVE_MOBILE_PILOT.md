# RocketVibe natif dans l'app mobile existante

Branche : `feature/rocketvibe-server`. La connexion reconnaît Rocket.Chat ou
RocketVibe. Les deux fournisseurs utilisent les mêmes écrans d'accueil, de salon,
la même liste de messages, le même composeur et les paramètres existants. L'ancienne
route `/native` redirige vers l'accueil ; elle n'est plus une messagerie séparée.

Les sessions des deux types cohabitent via le sélecteur de serveurs existant.
Genre, identité et génération sont persistés avec le jeton dans le Keystore /
Keychain. Les sessions anciennes sans genre restent Rocket.Chat.

## Essayer

Les comptes ayant un facteur e-mail explicitement installé peuvent demander leur
code depuis le formulaire de connexion existant et confirmer leur identité dans
les paramètres. « Reprendre l’envoi » lit la livraison initiale ou répète la même
commande interrompue ; « Renvoyer le code » est une nouvelle demande explicite,
bornée par le serveur, avec le même code et la même échéance. Le code saisi reste
transitoire. Les candidats sont conservés dans les entrées SecureStore privées
des défis, avec leurs autres métadonnées de reprise. L'inscription du facteur
depuis les paramètres reste à raccorder ; vérifier une adresse ne l'active pas.

1. Démarrer le [serveur natif](../apps/server/README.md) et créer ses comptes avec
   `create-user` et `RV_USER_PASSWORD`.
2. Installer le mobile en suivant son [README](../apps/mobile/README.md).
3. En debug avec un appareil ADB : `adb reverse tcp:3400 tcp:3400`.
4. Saisir `http://127.0.0.1:3400`, le pseudo et le mot de passe dans le formulaire
   habituel. Un build release exige HTTPS.
5. Les salons existants apparaissent dans l'accueil habituel. Nouvelle conversation
   cherche l'annuaire natif et ouvre un DM. Créer / inviter dans un salon se fait
   pour l'instant par le client GTK ou l'API serveur.
6. Envoyer dans un salon, couper le réseau, envoyer encore, puis reconnecter.
   L'envoi conserve son identifiant et le brouillon est conservé par salon.

Le serveur neuf n'a aucun compte par défaut. Les exigences de build Android,
dont `google-services.json`, restent celles de l'app actuelle ; RocketVibe natif
n'utilise pas encore Firebase pour les notifications.

## Fournisseur et données

`SynchroProvider` sélectionne le fournisseur du compte. Rocket.Chat conserve son
transport DDP et ses moteurs. RocketVibe utilise `NativeChat` / `NativeStore` :
aucune initialisation DDP, présence REST, E2EE, upload ou push Rocket.Chat ne part
sur cette branche. Le client REST de compatibilité bloque localement ces endpoints
et ne produit pas d'URL d'avatar Rocket.Chat avec le jeton natif.

Le moteur écrit dans les tables SQLite que les écrans actuels projettent. Snapshot,
journal, curseur, écho et outbox sont atomiques. La requête de messages commune
utilise les positions décimales natives, même au-delà de `2^53`, tandis que les
dates affichées restent réelles. La pagination utilise la position et ne dépend
pas de la progression des horodatages.

Les retraits d'accès purgent salon, messages, brouillons et outbox avant le renvoi.
Une autre génération est purgée avant que l'UI lise les tables communes. Les lots,
historiques et brouillons d'une ancienne génération ne peuvent pas repeupler la
nouvelle. Les sockets sont suspendues en arrière-plan et arrêtées à la bascule.

Les composants existants rendent le Markdown, la sélection, les dates et l'état
d'envoi. Copier / partager du texte reste local. Les fonctionnalités absentes du
serveur natif sont désactivées : fils, réactions, favoris, non-lus, profils,
fichiers / vocaux, recherche de messages, présence, push, E2EE et appels. Les
fonctions Rocket.Chat restent disponibles sur un compte Rocket.Chat.
La feuille d'actions existante propose l'édition et la suppression selon les
droits natifs ; les commandes et révisions persistent avant le départ HTTP.
Le texte d'une édition refusée peut être retrouvé en rouvrant l'éditeur.

## Vérification et limites

Le renouvellement est raccordé à SecureStore : intention durable avant HTTP,
reprise par le successeur après une réponse perdue, et sérialisation des écritures
par serveur. La publication du nouveau jeton remplace le fournisseur actif en
conservant le cache, les brouillons et l'outbox du compte. Le runner renouvelle à
la connexion et vérifie quotidiennement les connexions longues. Les callbacks
d'un ancien fournisseur arrêté ne peuvent pas publier un renouvellement tardif.
Les tests portables et le banc PostgreSQL prouvent le protocole et le runner ;
le Keystore et le cycle de vie natif Android exigent encore un appareil.

Les paramètres communs accueillent aussi les appareils natifs : liste privée,
nom, activité / expiration et révocation d'un autre appareil après connexion
récente. Les actions utilisent le runner actif ; une confirmation retenue après
bascule ne peut agir sur le fournisseur suivant. L'appareil courant conserve le
parcours de déconnexion existant. Le formulaire est typé, linté et exporté dans
le bundle Android ; le rendu et les confirmations Android restent à qualifier.

Depuis `apps/mobile` :

```sh
npm run typecheck
npm run lint
npm test
npx expo export --platform android --output-dir ../../artifacts/native-mobile-android
```

Les tests du fournisseur exercent SQLite, outbox / retry, génération, la vraie
requête de l'écran commun et sa pagination. Le [banc bureau](NATIVE_DESKTOP_PILOT.md)
exerce la façade mobile réelle contre PostgreSQL avec le desktop GTK.

L'export compile JavaScript / Hermes, sans installer un APK. Le rendu sur Android,
les kills réels et les échanges Android / Windows restent à exercer. L'annuaire
est limité à 100 comptes ; le snapshot matérialisé permet 1 000 salons et 64 Mio,
avec des pages de 1 Mio et une durée de 5 minutes. Le moteur n'applique que la vue
entière validée ; les anciens serveurs natifs gardent la route de 100 salons / 8 Mio.
Les curseurs expirent et sont élagués ; le moteur demande alors un nouveau
snapshot en conservant brouillons et outbox des salons toujours autorisés. Ce
parcours est testé avec expiration réelle en PostgreSQL et le moteur SQLite mobile.
Les refus `429` suspendent les requêtes login / ticket / snapshot jusqu'au délai de reprise.
Le banc `compose.native-email-settings-pilot.yml`, superposé aux overlays natif,
sécurité et OTP dans un projet frais `rocketvibe-email-settings-mobile`, exécute
`email-settings-mobile` puis `email-settings-check`. Trois processus Node
recréent le fournisseur, la projection SQLite et un coffre privé portable sur
disque. Les reçus d'activation / retrait survivent aux réponses perdues ; la
preuve complète par secours est reprise sans consommer un deuxième code. Le
contact vérifié est conservé au retrait. Le volume privé doit être supprimé par
`down -v` après le banc ; cette preuve ne qualifie pas SecureStore installé.
La rétention du cache reste à définir. J1 reste ouvert dans le [suivi](NATIVE_SERVER_EXECUTION.md).
