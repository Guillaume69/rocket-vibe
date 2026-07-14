# rocket-vibe — instructions permanentes

Client mobile **Rocket.Chat** tiers, Android d'abord, en Expo / React Native.
Ce fichier est rechargé à chaque session. Il porte ce qui coûte cher à redécouvrir.

- `ROADMAP.md` — les décisions et leur justification. Bouge rarement.
- `EXECUTION.md` — la checklist, l'état, le propriétaire de chaque sous-étape. **Source de vérité sur « où on en est ».**
- `docs/DEV.md` — l'environnement et le relevé du serveur cible.

## La boucle de travail

**Version de base acceptable atteinte (juillet 2026) : la cérémonie par sous-étape est levée.** On travaille désormais léger :

1. Implémenter.
2. Garder le réflexe de vérifier que ça tient — `npx tsc --noEmit` et un lancement réel quand le changement touche au code — mais ce n'est plus un critère de sortie formel qui bloque.
3. Commiter (message conventionnel) et `git push origin master`.

- **Plus de `/code-review` systématique.** La revue ne se lance plus que sur demande explicite.
- Plus d'obligation de case cochée/datée dans `EXECUTION.md` ni de trailer `Étape: N.M`. On peut toujours mettre `EXECUTION.md` à jour quand ça éclaire l'état, mais ce n'est plus un passage obligé.

Branche principale : **`master`**. Commits directs, pas de PR.

> Pourquoi « prouver en exécutant » reste un bon réflexe même sans l'imposer : ça a déjà attrapé un `env.sh` cassé que je croyais testé, et un `docker compose` qui créait un compte admin **sans mot de passe** sur un serveur exposé au LAN. Relire du code jamais exécuté, c'est relire une intention.

## Le shell est zsh — deux pièges à échec silencieux

1. **Un glob sans correspondance est fatal.** `for d in /usr/lib/jvm/*17*` avorte toute la boucle si le motif ne correspond à rien, y compris les autres candidats. Un `?` non quoté dans une URL aussi : toujours `curl "…/settings.public?count=0"`. Passer les motifs à `find -name "…"`, jamais au shell.
2. **Une variable non quotée n'est pas découpée en mots.** `for id in $IDS` itère **une seule fois** avec toute la chaîne. Les `$(…)` le sont, eux. Pour boucler sur une liste : `bash -s <<'BASH'`.

Se méfier d'une assertion qui passe alors qu'aucune ligne d'effet de bord ne s'est affichée : c'est un test vide, pas un test vert.

## Environnement

```sh
source scripts/env.sh                 # JAVA_HOME, ANDROID_HOME, PATH, ROOT_URL
cd docker && docker compose up -d     # Rocket.Chat 8.5.1 + MongoDB 8.0 (replica set rs0)
node scripts/seed.mjs                 # données de test, idempotent
```

- Linux, Node 24, **Temurin JDK 17.0.19** (suffisant : RN 0.86 fixe `sourceCompatibility 17`, Gradle 9.3.1 accepte 17→24). **JDK 21 non requis.**
- SDK Android complet : build-tools 36.0.0, `platforms/android-36`, NDK 27.1.12297006 — exactement ce qu'exige le template RN 0.86.
- AVD `duogo_test` (Pixel 7, android-36, image `google_apis` : **les Google Play Services y sont**, donc FCM y fonctionne).
- **Aucun téléphone physique branché.** Le critère binaire du *kill gate* push (étape 2.5b) l'exige.
- Builds Android **100 % locaux** : `expo prebuild` + `./gradlew`. **Jamais d'EAS.** iOS plus tard, sur un Mac.

## Contraintes non négociables

- **Composants natifs par défaut.** Interdits fermes : tout kit UI (NativeBase, Tamagui, gluestack, RN Paper), toute **WebView**, `react-native-markdown-display`, et **`@gorhom/bottom-sheet`** — les bottom sheets sont natifs via `react-native-screens` (`presentation: 'formSheet'`). Toute dépendance UI se justifie dans le commit, contre `ROADMAP.md` §4.2.
- **Modules natifs par défaut, pas de polyfill pur JS.** Pour tout calcul lourd (crypto, compression, image), préférer un module natif (JSI/Nitro) à une implé pur JS. L'E2EE passe par `react-native-quick-crypto` (API `node:crypto` native OpenSSL) : `lib/e2e/crypto.ts` importe `crypto`/`buffer`, Metro les alias vers quick-crypto (`metro.config.js`) — mêmes imports résolus vers `node:crypto` sous les tests Node. Un module natif exige un **rebuild du dev-client** (`expo prebuild` + `./gradlew`) — un simple reload Metro ne suffit pas.
- `android/` et `ios/` sont **gitignorés** (CNG). Toute personnalisation native passe par un config plugin : en SDK 57, `expo prebuild` efface et régénère par défaut.
- **Aucun secret dans le dépôt.** `.env`, `.env.local`, `google-services.json`, JSON de compte de service. Des `.example` les documentent.
- TypeScript strict, zéro `any` implicite. `npx tsc --noEmit` fait partie de chaque critère de sortie `[code]`.
- **New Architecture obligatoire** depuis RN 0.82 : `newArchEnabled=false` n'a plus aucun effet. Ne pas la présenter comme un filet.

## Faits sur Rocket.Chat qu'un résumé ne doit pas perdre

Serveur cible : `https://chat.barrut.me`, **version 8.5** (LTS). Le Docker local est épinglé dessus, pas sur la 8.6.

- **`POST /api/v1/rooms.upload` a été SUPPRIMÉ en 8.0.0.** L'upload se fait en deux temps : `rooms.media/:rid` puis `rooms.mediaConfirm/:rid/:fileId`. `rooms.media` seul ne poste aucun message — l'oublier laisse un fichier orphelin.
- **Les appels de méthodes DDP sont dépréciés** (8.0), retrait en 9.0. **REST pour agir, DDP pour écouter.** Notre client DDP maison n'a besoin que de `connect`, `login`, `sub`, `unsub` et du routage des événements. Pas de `call`.
- `@rocket.chat/ddp-client` est techniquement parfait mais livré **sans champ `license`**, avec un `LICENSE` Enterprise Edition. On écrit le nôtre, depuis la spec DDP. **Ne pas recopier son code.** `@rocket.chat/message-parser` est MIT, lui.
- `MONGO_OPLOG_URL` **n'existe plus** depuis 8.0.0 (change streams). Le replica set reste obligatoire.
- **Push** : le gateway officiel ne route que vers les app-ids officielles. Il faut `Push_enable_gateway=false`, `Push_UseLegacy=false`, et le JSON d'un compte de service Firebase dans `Push_google_api_credentials`. Rocket.Chat parle **FCM HTTP v1**. Le workspace cible **est enregistré sur RC Cloud** (`cloudWorkspaceId` présent).
- **Piège du spike push** : Rocket.Chat ne notifie **que les utilisateurs hors ligne**, et par défaut **uniquement sur DM ou mention**. Un message de canal ordinaire ne déclenche rien, quelle que soit la configuration.
- **Indicateur de saisie** : `stream-notify-room/<rid>/user-activity`. Pas `/typing`, qui est déprécié.
- `chat.syncMessages` traite **un salon à la fois** et le REST est rate-limité : ne pas boucler sur tous les salons à la reconnexion.
- **Rejouer un `_id` client déjà accepté sur `chat.sendMessage` répond 400** (`Cannot read properties of undefined (reading 'starred')`), pas un succès idempotent — vérifié sur 8.5. Aucun doublon n'est créé, mais la réponse ne distingue pas « déjà livré » de « refusé » : confirmer par `chat.getMessage` avant de déclarer l'échec (voir `lib/envoi.ts`).

### Le serveur cible, relevé sans authentification

2FA **active, TOTP seul** (pas d'email), repli mot de passe imposé. **Aucun OAuth, SAML, CAS ni LDAP** → pas de chantier SSO.
`FileUpload_ProtectFiles = true` **et** `Accounts_AvatarBlockUnauthenticatedAccess = true` → fichiers *et* avatars exigent `rc_uid`/`rc_token`.
`E2E_Enable = true`, `E2E_Allow_Unencrypted_Messages = false`, mais **un seul salon chiffré sur 25** (`p:laprivitude`). L'E2EE reste hors périmètre, avec dégradation soignée (`ROADMAP.md` §6.6) : le serveur **rejette** un message en clair dans un salon chiffré (`error-not-allowed`).
