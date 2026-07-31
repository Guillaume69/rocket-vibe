# rocket-vibe — instructions permanentes

Client mobile **Rocket.Chat** tiers, Android d'abord, en Expo / React Native.
Ce fichier est rechargé à chaque session. Il porte ce qui coûte cher à redécouvrir.

- `ROADMAP.md` — les décisions et leur justification. Bouge rarement.
- `CHANTIERS.md` — la dette relevée par l'audit du 25/07/2026, à cocher au fur et à mesure. **Source de vérité sur « qu'est-ce qu'on corrige ensuite ».**
- `EXECUTION.md` — la checklist de CONSTRUCTION du produit. ⚠️ En retard sur le code (chantier 16) : ne pas s'y fier pour juger de ce qui est livré.
- `docs/AUDIT.md` — le relevé daté de l'audit : mécanisme, scénario d'échec et correction de chaque constat. Figé, on n'y touche plus.
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

## Le shell est zsh — trois pièges à échec silencieux

1. **Un glob sans correspondance est fatal.** `for d in /usr/lib/jvm/*17*` avorte toute la boucle si le motif ne correspond à rien, y compris les autres candidats. Un `?` non quoté dans une URL aussi : toujours `curl "…/settings.public?count=0"`. Passer les motifs à `find -name "…"`, jamais au shell.
2. **Une variable non quotée n'est pas découpée en mots.** `for id in $IDS` itère **une seule fois** avec toute la chaîne. Les `$(…)` le sont, eux. Pour boucler sur une liste : `bash -s <<'BASH'`.

3. **Un pipe masque le code de sortie.** `./gradlew … | tail` rend le statut de `tail` (0), pas celui du build — vécu : un `assembleRelease` en échec déclaré « réussi », APK inexistant installé de confiance. Pour un build : rediriger vers un fichier et tester `$?`, ou `set -o pipefail`.

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
- **Rejouer `rooms.mediaConfirm` sur le même `fileId` est INDÉTERMINÉ — et les deux issues sont mauvaises** (sondé sur le banc 8.5, 29/07/2026, deux fois, résultats opposés) :
  - **rejeu immédiat** → le serveur poste un SECOND message (l'historique en porte bien deux) mais répond **200 en rendant le PREMIER**, légende comprise. Un client qui se fie à la réponse croit à une confirmation idempotente alors qu'il vient de créer un doublon ;
  - **rejeu différé** (quelques minutes) → **`[invalid-file]`**, un refus franc. Traité comme un échec ordinaire, il affiche « non envoyé » sur un fichier pourtant livré.

  Il n'existe donc AUCUNE réponse serveur exploitable : la déduplication doit être entièrement locale, sur le `file_id` persisté (`televersements.file_id`, chantier 7), et le client doit s'assurer que sa base SAIT avant de trancher — d'où le rattrapage ciblé du salon quand elle est muette. Et comme `mediaConfirm` refuse toute clé en trop (`additionalProperties: false`), un `_id` client est exclu.
- **Les appels de méthodes DDP sont dépréciés** (8.0), retrait en 9.0. **REST pour agir, DDP pour écouter.** Notre client DDP maison n'a besoin que de `connect`, `login`, `sub`, `unsub` et du routage des événements. Pas de `call`.
- **Un message DDP hors séquence reçoit `msg: 'error'`, JAMAIS la réponse attendue** (sondé sur 8.5.1 pour `ping`, `sub` et `method`) : `{"msg":"error","reason":"Must connect first","offendingMessage":{"msg":"ping","id":"v1"}}`. `offendingMessage` **porte l'`id` fautif**, donc on peut rejeter la bonne attente — sans ce cas, elle pend jusqu'à son délai et son échec est mis sur le compte de la socket (c'est ce qui rendait la sonde de vie prématurée destructrice, chantier 8). En revanche l'état **`connecte`** — handshake fait, `login` pas encore répondu — **répond bien un `pong`** : il est sondable.
- **Un 401 veut dire « non authentifié », et RIEN D'AUTRE** (sondé sur 8.5.1, 30/07/2026). C'est ce qui autorise une déconnexion automatique sur 401 sans éjecter l'utilisateur à tort. Tout le reste passe par d'autres statuts : **permission manquante → 403** (`error-unauthorized`) ; **exclu du salon ou salon inexistant → 400** (`error-not-allowed`, `error-room-not-found`) ; **2FA exigée → 400** (`totp-required`) ; **code 2FA faux → 400** (`totp-invalid`, et non 401 — sans quoi une faute de frappe détruirait la session). Corps exact d'un jeton révoqué : `{"success":false,"error":"You must be logged in to do this.","status":"error"}`.
  - **Exception : `/api/v1/login` mappe TOUS ses échecs sur 401**, avec une enveloppe Rocket.Chat parfaite et le même `error: "Unauthorized"` — jeton de reprise bidon, corps vide, utilisateur inexistant, mot de passe faux sont indistinguables. Un client qui révoque sur 401 DOIT donc écarter les appels anonymes (le login, mais aussi `reprendreSession`, dont le jeton voyage dans le corps), sinon une saisie ratée efface la session en cours.
  - **« Du JSON » ne prouve pas « du Rocket.Chat »** : un reverse-proxy ou une passerelle répond volontiers `401 {"message":"Unauthorized"}` ou du HTML. Exiger une marque de l'enveloppe (`success`, `status`, `errorType`) avant de croire au statut — voir `reponseComprise` dans `lib/rest.ts`.
- **Trois formes internes d'expo dont dépend la voie push native** (lues dans le code d'expo, jamais devinées — elles n'ont aucune garantie d'API) :
  - `Notifications.dismissNotificationAsync` accepte l'identifiant `expo-notifications://foreign_notifications?[tag=…&]id=<entier>`, que `ExpoPresentationDelegate.parseNotificationIdentifier` traduit en `NotificationManagerCompat.cancel(tag, id)`. C'est le SEUL pont pour retirer depuis JS une notification postée par notre Kotlin — dont l'id est `rid.hashCode()`, sans tag (`lib/notificationId.ts`) ;
  - expo-secure-store range ses entrées dans les SharedPreferences `SecureStore` sous la clé `"<keychainService>-<clé>"`, `keychainService` valant `key_v1` par défaut (`SecureStoreModule.createKeychainAwareKey`) : le natif lit donc `key_v1-langue-preferee` comme il lit `key_v1-session-<condensé>` ;
  - expo-router FUSIONNE les query params d'un lien profond dans les params de route (`getStateFromPath-forks.parseQueryParams`) : `rocketvibe://salon/<rid>?host=…` arrive tel quel dans `useLocalSearchParams`. C'est ce qui porte le deep-link multi-serveur.
- **`GET /api/info` non authentifié rend la version MINEURE seulement** (`{"version":"8.5", …, "success":true}` sur un serveur 8.5.1), dans un corps d'environ 15 Ko dont l'essentiel est un JWT `supportedVersions`. Il vit **hors de `/api/v1/`** : `ClientRest` l'atteint par l'option `horsApiV1`, ce qui lui donne le délai maximal — sans quoi une requête pendante bloque l'écran de connexion à vie.
- `@rocket.chat/ddp-client` est techniquement parfait mais livré **sans champ `license`**, avec un `LICENSE` Enterprise Edition. On écrit le nôtre, depuis la spec DDP. **Ne pas recopier son code.** `@rocket.chat/message-parser` est MIT, lui.
- `MONGO_OPLOG_URL` **n'existe plus** depuis 8.0.0 (change streams). Le replica set reste obligatoire.
- **Push** : le gateway officiel ne route que vers les app-ids officielles. Il faut `Push_enable_gateway=false`, `Push_UseLegacy=false`, et le JSON d'un compte de service Firebase dans `Push_google_api_credentials`. Rocket.Chat parle **FCM HTTP v1**. Le workspace cible **est enregistré sur RC Cloud** (`cloudWorkspaceId` présent).
- **Piège du spike push** : Rocket.Chat ne notifie **que les utilisateurs hors ligne**, et par défaut **uniquement sur DM ou mention**. Un message de canal ordinaire ne déclenche rien, quelle que soit la configuration.
- **Indicateur de saisie** : `stream-notify-room/<rid>/user-activity`. Pas `/typing`, qui est déprécié.
- `chat.syncMessages` traite **un salon à la fois** et le REST est rate-limité (**10 appels/min**, mesuré : le 11ᵉ répond 429 et notre client dort jusqu'au reset, plafonné à 30 s). Ne pas boucler sur tous les salons à la reconnexion. Le mode curseur exige `type` : `UPDATED` et `DELETED` sont **deux requêtes**, le serveur refuse de les combiner (`error-param-required`).
- **`chat.syncMessages?type=UPDATED` est LENT sur un gros salon** : 3 à 4 s mesurées sur `chat.barrut.me` pour répondre « rien de neuf » (0 document), contre 22 ms sur le banc à 3 000 messages. L'index est `{rid, ts, _updatedAt}` : filtrer sur `_updatedAt` seul oblige le serveur à trier tout le salon. Rien côté client ne l'accélère — la seule issue est de ne pas l'appeler (voir `ui/salonChaud.ts`).
- **Un seul stream couvre TOUS les salons : `stream-room-messages` avec la clé `__my_messages__`** (vérifié sur le banc 8.5, et présent dans le bundle serveur comme dans les types de `@rocket.chat/ddp-client`). C'est ce que fait l'app officielle. Il livre les **nouveaux messages ET les éditions** (`editedAt`) de tous les salons de l'utilisateur, sans en ouvrir aucun — mais **pas les suppressions**, qui restent sur `stream-notify-room/<rid>/deleteMessage`, un abonnement PAR salon. Piste non retenue à ce jour : elle remplacerait le LRU de `ui/salonChaud.ts` par une ligne dans `souscriptionsInitiales`, au prix de recevoir en continu le trafic des 25 salons (batterie, données).
- **Rejouer un `_id` client déjà accepté sur `chat.sendMessage` répond 400** (`Cannot read properties of undefined (reading 'starred')`), pas un succès idempotent — vérifié sur 8.5. Aucun doublon n'est créé, mais la réponse ne distingue pas « déjà livré » de « refusé » : confirmer par `chat.getMessage` avant de déclarer l'échec (voir `lib/envoi.ts`).
- **Avatars : l'URL ne bouge que si on la fait bouger.** `/avatar/<pseudo>` répond `Cache-Control: public, max-age=3600` et **aucun `ETag` HTTP** (sondé sur 8.5) ; le cache image d'Android (Fresco) fige donc l'URI à vie. La version de la photo vit dans `avatarETag`, qu'il faut ajouter EN QUERY (le serveur ignore le paramètre) — sinon une photo changée ne s'affiche jamais. Sources, dans l'ordre de fraîcheur : `stream-notify-logged` / **`updateAvatar`** → `args: [{username, etag}]` pour un utilisateur (jamais l'uid !), `[{rid, etag}]` pour un salon ; `me` (au raccordement, porte `avatarETag`) ; `users.info` et le document Rooms (`avatarETag`, ABSENT s'il n'y a pas de photo — ne jamais l'écraser par null). À la SUPPRESSION (`users.resetAvatar`), l'événement arrive **sans etag** : poser un marqueur (`AVATAR_SANS_PHOTO`), sans quoi l'URL retombe sur sa forme d'avant, celle que le cache sert avec l'ancienne photo.
- **Un changement de `name` (nom affiché) n'est PAS diffusé** : ni `Users:NameChanged`, ni `rooms-changed` sur 8.5 (sondé). Seuls l'avatar et le pseudo se propagent en direct.

### Le serveur cible, relevé sans authentification

2FA **active, TOTP seul** (pas d'email), repli mot de passe imposé. **Aucun OAuth, SAML, CAS ni LDAP** → pas de chantier SSO.
`FileUpload_ProtectFiles = true` **et** `Accounts_AvatarBlockUnauthenticatedAccess = true` → fichiers *et* avatars exigent `rc_uid`/`rc_token`.
`E2E_Enable = true`, `E2E_Allow_Unencrypted_Messages = false`, mais **un seul salon chiffré sur 25** (`p:laprivitude`). L'E2EE reste hors périmètre, avec dégradation soignée (`ROADMAP.md` §6.6) : le serveur **rejette** un message en clair dans un salon chiffré (`error-not-allowed`).
**Push « contenu masqué » ACTIF** (`Push_request_content_from_server` — Premium, défaut `true` sur workspace licencié, invisible dans `settings.public`) : chaque push ne porte qu'un `messageId`, **jamais le contenu** ; l'app le récupère par `push.get` authentifié à la réception, avec rattrapage WorkManager sur échec (`plugins/with-fcm-deeplink.js`). On **garde** ce réglage (décision utilisateur 2026-07-16 : rien chez Google/Apple). `push.get` subit la rate-limit REST par défaut (10 req/min) : une rafale dégrade en « Nouveau message » avant rattrapage.
