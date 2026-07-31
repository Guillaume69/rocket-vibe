# ROADMAP — rocket-vibe

Client mobile **Rocket.Chat** tiers. Android d'abord, builds **100 % locaux** (`expo prebuild` + Gradle, sans EAS), **primitives React Native natives par défaut**, iOS ouvert plus tard sans refonte.

Objectif produit : un client **plus rapide et plus fiable** que l'app officielle, pour un usage personnel sur un serveur auto-hébergé.

Document d'exécution, pas cahier des charges. Calibré pour **un développeur expérimenté à temps partiel** (≈ 10‑15 h/semaine) ; les estimations sont en semaines-calendrier à ce rythme.

---

## 1. Verdict de faisabilité

**Le projet est réaliste, et le risque que je croyais existentiel est levé.**

Le point dur numéro un était les notifications push pour un client non-officiel. Il est **résolu positivement** : Rocket.Chat a migré vers l'API **FCM HTTP v1** (PR #32208, présente depuis la 6.8, donc dans la 8.6). Un serveur auto-hébergé peut pousser directement vers **notre propre projet Firebase**, sans gateway auto-hébergé et sans Rocket.Chat Cloud. Comme tu es seul administrateur du serveur, les cinq conditions requises sont toutes sous ton contrôle.

| Difficulté | Sujets |
|---|---|
| **Facile** | Login mot de passe, liste des salons (`subscriptions.get` + `rooms.get`), rendu markdown (le serveur fournit l'AST dans `msg.md`), envoi de message, chaîne de build Gradle locale. |
| **Moyen** | Mini-client DDP, reconnexion et rattrapage, liste inversée performante, 2FA, upload en deux temps, offline-first. |
| **Sous contrôle** | Push FCM direct : chaîne connue de bout en bout, mais **à prouver par un spike** avant d'investir dans l'UI. L'incertitude résiduelle est opérationnelle (réveil en app tuée, surcouches constructeur), pas architecturale. |

### Ce que ton environnement change

Ton poste est déjà exactement au niveau requis. Le template `@react-native-community/template@0.86.0` exige `buildToolsVersion 36.0.0`, `compileSdk`/`targetSdk` 36, `minSdk` 24, `ndkVersion 27.1.12297006`, Gradle 9.3.1, et React Native fixe `sourceCompatibility = JavaVersion.VERSION_17`. Tu as **build-tools 36.0.0, `platforms/android-36`, NDK 27.1.12297006 exactement, et Temurin 17.0.19**. **JDK 21 n'est pas requis** : JDK 17 fait tourner Gradle 9.3.1 (qui accepte Java 17→24) et satisfait `sourceCompatibility`.

Il ne manque que deux variables d'environnement. Rien à installer.

### Le coût d'entrée, en clair

Un projet Firebase (gratuit), un compte de service avec le rôle *Firebase Cloud Messaging API Admin*, l'accès admin au serveur (acquis), et **un téléphone Android physique**. L'émulateur ne reproduit ni Doze ni le kill de process : il ne peut pas valider le push. C'est le seul matériel indispensable.

---

## 2. Décisions verrouillées

Prises explicitement, elles ne se rediscutent pas en cours de route.

| Décision | Choix | Raison |
|---|---|---|
| Plateforme v1 | **Android seul** | Pas de Mac. iOS en phase 7. |
| Build | **Local** : `expo prebuild` + `./gradlew` | Jamais d'EAS pour Android. |
| Distribution | **Sideload `adb install`** | Ni Play Store, ni revue, ni risque de marque. |
| Client DDP | **Le nôtre, minimal** | Zéro ambiguïté de licence, zéro dépendance à `core-typings`. |
| Serveur | **Auto-hébergé, admin** | Rend le push faisable. Cible réelle : `chat.barrut.me`, Rocket.Chat **8.5** (LTS). |
| Source de vérité | **SQLite locale** | L'UI est une projection, pas un miroir du réseau. |
| Actions / écoute | **REST pour agir, DDP pour écouter** | Les appels de méthodes DDP sont dépréciés (8.0), retrait en 9.0. |
| E2EE | **Hors périmètre, avec dégradation soignée** | `E2E_Enable=true` sur le serveur cible, mais **1 salon chiffré sur 25** (mesuré). Plusieurs semaines de crypto pour 4 % de l'usage : mauvais rapport. |

### Pourquoi le client DDP maison est plus petit qu'annoncé

`@rocket.chat/ddp-client` est techniquement excellent — 144 Ko de JS, aucun module Node, `WebSocket` injectable, reconnexion écrite — mais son `package.json` ne porte **aucun champ `license`** et le `LICENSE` embarqué est celui de la Rocket.Chat **Enterprise Edition**, qui interdit la redistribution. Le texte contient bien une clause repassant en MIT tout ce qui est *« compiled into client-side JavaScript »*, ce qui le couvre probablement — mais « probablement » n'est pas une base pour un projet.

Or, puisque **les appels de méthodes DDP sont dépréciés** et que le REST est la voie officielle pour agir, notre client n'a besoin que de : `connect`, `login` (resume, pour authentifier la socket), `sub`, `unsub`, et le routage de `added` / `changed` / `removed` / `ready` / `nosub` / `ping`. Pas de `call`, pas de gestion de collections Meteor. **On vise 200 lignes, pas 300.** On l'écrit depuis la spécification DDP (publique) et l'observation du trafic — on ne recopie pas le code sous licence EE.

Les noms de streams et les clés d'événements sont des faits d'interface, déjà relevés : `stream-room-messages`, `stream-notify-user` (`<uid>/subscriptions-changed`, `/rooms-changed`, `/notification`, `/message`, `/userData`), `stream-notify-room` (`<rid>/user-activity`, `<rid>/deleteMessage`), `stream-notify-logged` (`user-status`, `roles-change`, `permissions-changed`), `stream-user-presence`.

> `@rocket.chat/message-parser` (MIT explicite) reste une dépendance assumée : le serveur envoie déjà l'AST markdown dans `msg.md`, le re-parser serait absurde.

---

## 3. Hors périmètre v1

| Exclu | Raison |
|---|---|
| **E2EE** | Mesuré sur le serveur cible : `E2E_Enable=true`, mais **un seul salon chiffré sur 25** (`p:laprivitude`). Coût élevé (`react-native-quick-crypto` pour RSA-OAEP, `expo-crypto` ne fait pas de RSA) pour 4 % de l'usage. Le v1 **dégrade proprement** : cadenas dans la liste, aperçu `lastMessage` masqué, messages `t='e2e'` remplacés par un placeholder, composer désactivé, notification générique. Voir §6.6. |
| **Appels audio/vidéo** | Hors motivation. C'est ce que tire `@rocket.chat/media-signaling` — on l'évite. |
| **Administration serveur** | Client de consommation, pas console admin. |
| **Apps / blocs UiKit interactifs** | On rend `attachments` et `md`, on ignore proprement les `blocks` inconnus. |
| **Omnichannel / LiveChat** | Cas d'usage entreprise. |
| **OTR** | **Supprimé en 8.0.0.** Ne pas l'implémenter. |
| **iOS au démarrage** | Pas de Mac. Architecture gardée platform-agnostic (phase 7). |
| **EAS Update (OTA)** | On réinstalle l'APK via `adb`. |

Ce sont des **dettes assumées**, documentées pour éviter la dérive de périmètre.

---

## 4. Architecture cible

```
┌───────────────────────────────────────────────────────────────┐
│  UI — primitives RN (View/Text/Pressable/TextInput/Modal…)     │
│       + FlashList inverted + exceptions justifiées (§4.2)      │
├───────────────────────────────────────────────────────────────┤
│  Projection réactive — useLiveQuery (Drizzle) : l'UI OBSERVE   │
├───────────────────────────────────────────────────────────────┤
│  SOURCE DE VÉRITÉ — SQLite (expo-sqlite + Drizzle, WAL)         │
│  Server · Room · Subscription · Message · Outbox · Upload       │
│  · SyncState            (UNE base par host serveur)            │
├────────────────────────────┬──────────────────────────────────┤
│  Moteur de synchro         │  Secrets — expo-secure-store      │
│  (upserts idempotents,     │  (authToken/userId par host,      │
│   dédup par _id)           │   Android Keystore)               │
├──────────────┬─────────────┴──────────────────────────────────┤
│  REST fetch  │  Mini-client DDP maison (WebSocket natif RN)     │
│  → AGIR      │  → ÉCOUTER : sub/unsub uniquement                │
├──────────────┴──────────────────────────────────────────────── ┤
│  Push FCM direct (expo-notifications) — réveille l'app tuée     │
└────────────────────────────────────────────────────────────────┘
```

**Principe directeur** : le WebSocket et le REST font des **upserts** dans SQLite ; l'UI est une **projection réactive**. Le flux temps réel n'est jamais stocké dans un store mémoire. C'est le remède direct aux griefs documentés contre l'app officielle (souscriptions empilées, messages dupliqués, envois figés).

### 4.1 Stack

| Couche | Choix | Justification |
|---|---|---|
| Runtime | **Expo SDK 57** (`expo@57.0.4`), RN 0.86, React 19.2, Hermes | Le majeur du paquet `expo` = le numéro de SDK. **New Architecture obligatoire et non désactivable** depuis RN 0.82 : `newArchEnabled=false` n'a plus aucun effet. Ne compte pas dessus comme filet. |
| Build | CNG : `android/` **gitignoré**, tout passe par config plugins | En SDK 57 `expo prebuild` **efface et régénère par défaut** (`--no-clean` pour l'éviter) : une édition manuelle du dossier serait perdue. |
| Navigation | `expo-router` (57.x) sur `react-native-screens` | Deep link natif depuis la notification, routes typées, stack natif, **bottom sheets natifs** via `presentation: 'formSheet'`. |
| Persistance | `expo-sqlite` + `drizzle-orm` | `useLiveQuery` depuis `drizzle-orm/expo-sqlite`, avec **`enableChangeListener: true`** obligatoire à l'ouverture de la base. |
| Clé-valeur | `react-native-mmkv` 4.x | Brouillons, préférences. Nitro/TurboModule, New Arch. |
| Temps réel | **Mini-client DDP maison** | Voir §2. |
| Liste | **`@shopify/flash-list` 2.3.2, `inverted`** | Voir §6.3. |
| Markdown | `@rocket.chat/message-parser` + rendu maison en `<Text>` imbriqués | MIT. L'AST vient du serveur. |
| Push | `expo-notifications` 57.x, `getDevicePushTokenAsync()` | Token FCM natif, **sans le service Expo Push**. |
| Secrets | `expo-secure-store` | Android Keystore, clé par host. |

Écartés : **`@notifee/react-native`** (archivé le 7 avril 2026, pas de New Architecture, incompatible RN 0.86) ; **WatermelonDB** (dernière publication juillet 2025, support RN 0.86 non documenté) ; `@rocket.chat/sdk` et `simpleddp` (morts). `@react-native-firebase/messaging@25.1.0` reste un **repli** si `expo-notifications` déçoit sur les messages data-only en app tuée.

### 4.2 Les « exceptions qui ont du sens »

Ta contrainte est *« uniquement des composants natifs tant que c'est possible, sauf exception qui a du sens »*. On classe chaque dépendance, pour ne pas prétendre « deux exceptions » en en tirant huit.

| Niveau | Dépendances | Statut |
|---|---|---|
| **0 — Primitives RN pures** | `View`, `Text`, `Pressable`, `ScrollView`, `TextInput`, `Modal`, `Image` | Aucune justification requise. |
| **1 — Bindings natifs** (exposent une capacité de l'OS, pas un design system) | `react-native-screens` (stack natif **et bottom sheets natifs**), `react-native-safe-area-context` (edge-to-edge imposé par targetSdk 36), `expo-image` (cache disque natif, headers), `react-native-gesture-handler`, `expo-haptics`, `@react-native-menu/menu` (menu contextuel Material natif) | Justifiés : chacun mappe une capacité Android native, aucun n'impose un look. |
| **2 — Exceptions assumées** | **`@shopify/flash-list`** : recyclage de vues natif, indispensable pour des milliers de messages. **`react-native-keyboard-controller`** : `KeyboardAvoidingView` est médiocre sur Android ; cette lib s'abonne à `WindowInsetsAnimationCallback` pour un composer synchronisé image par image. **`@rocket.chat/message-parser`** : parseur JS pur, pas de l'UI. **`react-native-webview`** : l'écran d'appel Jitsi, et lui seul — voir l'encadré ci-dessous. | Quatre exceptions, chacune motivée. |

**Les bottom sheets sont natifs, aucune dépendance à ajouter.** `react-native-screens` 4.25 embarque une implémentation Android bâtie sur le `BottomSheetBehavior` de Material (`android/src/main/java/com/swmansion/rnscreens/bottomsheet/`, dépendance `com.google.android.material:material:1.13.0`), et le `UISheetPresentationController` natif sur iOS. `expo-router` l'expose directement :

```tsx
<Stack.Screen
  name="message-actions"
  options={{
    presentation: 'formSheet',
    sheetAllowedDetents: [0.4, 0.9],
    sheetGrabberVisible: true,
    sheetCornerRadius: 16,
    sheetInitialDetentIndex: 0,
    sheetLargestUndimmedDetentIndex: 0,
  }}
/>
```

C'est ce qu'on utilisera pour la feuille d'actions sur un message, le sélecteur d'emoji et le choix de pièce jointe.

**Interdits fermes** : tout kit UI (NativeBase, Tamagui, gluestack, RN Paper), toute **WebView** hors l'exception bornée ci-dessous, `react-native-markdown-display`, `react-native-render-html`, et **`@gorhom/bottom-sheet`** — c'est une réimplémentation JS/Reanimated d'un composant que la plateforme fournit déjà.

> **L'exception WebView : l'écran d'appel, et rien d'autre** (consignée au chantier 16, livrée
> le 2026-07-12, `61fc7d4`). La visioconférence Jitsi est une **web-app** : l'alternative native,
> `@jitsi/react-native-sdk`, vise RN ~0.79 et embarque `react-native-webrtc` — un pari New
> Architecture fragile contre notre RN 0.86. `app/appel/[callId].tsx` charge donc l'URL rendue
> par `video-conference.join` (JWT inclus) dans une WebView plein écran. Les bornes, et elles ne
> se négocient pas : **une seule route** ; **origine verrouillée** sur celle que le serveur a
> désignée (`originWhitelist` + `onShouldStartLoadWithRequest`, primitives de `lib/origine.ts`) —
> parce que l'app détient caméra et micro pendant l'appel et qu'Android ne sait pas arbitrer ces
> permissions par origine, la navigation est le seul verrou. Partout ailleurs, l'interdit tient :
> la lecture intégrée des liens vidéo, par exemple, reste une carte native (`ui/carteEmbed.tsx`).

> **Piège transverse, et il est inévitable** : `react-native-reanimated` augmente la RAM de 25 à 30 % depuis RN 0.85 (changement Hermes), même inutilisé. Vérifié après installation : **`expo-router@57.0.4` en dépend directement**, ainsi que de `react-native-worklets`. Aucun choix de template ne l'évite. S'en passer supposerait d'abandonner `expo-router` pour `react-navigation` nu — probablement pas rentable. À surveiller au profilage plutôt qu'à combattre.

---

## 5. Les phases

Ordre : **dé-risquer d'abord, livrer de la valeur vite ensuite**. Chaque phase produit un APK installable via `adb`.

### Phase 0 — Socle : build local, serveur de dev, levée des incertitudes — *1 à 2 sem*

**Objectif** : prouver la chaîne de build Android de bout en bout et vérifier les points que la recherche a laissés ouverts.

**Livrables**
- `JAVA_HOME`, `ANDROID_HOME`, `PATH` exportés ; `java -version` → 17.0.19 ; `adb devices` OK.
- `docker compose` : Rocket.Chat 8.6 + MongoDB en **replica set `rs0`** (obligatoire, sinon RC refuse de démarrer). **`ROOT_URL` sur l'IP LAN**, pas `10.0.2.2` : la phase 1 exige un téléphone physique, et `ROOT_URL` conditionne les payloads push et les deep links. Pour l'émulateur, `adb reverse tcp:3000 tcp:3000`.
- Compte admin, Personal Access Token, données de test (`users.create`, `channels.create`, `im.create`, `chat.postMessage`, un thread).
- App Expo SDK 57 + `expo-dev-client` + `expo-router` + TypeScript strict ; `npx expo prebuild` puis `./gradlew app:assembleDebug` → APK sur l'AVD `duogo_test` ; écran « serveur » affichant `GET /api/v1/info` et `settings.public`.
- **Fiche des incertitudes** (§7) remplie.

**Done when** : un APK maison installé par `adb` affiche des données réelles du serveur local, et la fiche d'incertitudes est remplie.

**Risques** : Mongo sans replica set → RC ne démarre pas. `ROOT_URL` désaligné → login et CORS cassés. Cleartext HTTP bloqué par défaut sur Android → `expo-build-properties` avec `usesCleartextTraffic` **scopé au dev**.

---

### Phase 1 — SPIKE JETABLE : push tiers (kill gate) — *≈ 1 sem*

**Objectif** : prouver de façon **binaire** qu'un APK auto-compilé reçoit une notification **quand l'app est tuée**. Code jetable, zéro UI.

**Protocole** — l'ordre compte, et deux pièges rendent le test faussement négatif :

1. Projet Firebase, app Android dont le `package_name` **est exactement** l'`applicationId` de l'APK (le plugin Gradle GMS échoue sinon : *« No matching client found for package name »*). `google-services.json` à la racine, déclaré dans `app.json` via `expo.android.googleServicesFile`.
2. Compte de service Firebase, rôle **Firebase Cloud Messaging API Admin**, API *Firebase Cloud Messaging API (V1)* activée dans Google Cloud.
3. `npx expo prebuild --clean` → `./gradlew assembleDebug` → `adb install`. **Premier point de contrôle** : le build passe (valide `com.google.gms:google-services` × Gradle 9.3.1).
4. Dans l'app : `setNotificationChannelAsync('default', { importance: HIGH })` **avant** `requestPermissionsAsync()` — sinon le prompt `POST_NOTIFICATIONS` (Android 13+) n'apparaît jamais. Puis `getDevicePushTokenAsync()`, logger `.data`.
5. Serveur, Admin → Push, **puis redémarrer le workspace** : `Push_enable_gateway = false`, `Push_UseLegacy = false`, coller le JSON du compte de service dans `Push_google_api_credentials`.
6. Enregistrer le token : `POST /api/v1/push.token`, corps `{ type: 'gcm', value: <token>, appName: <applicationId> }`, en-têtes `X-Auth-Token` / `X-User-Id`. *(`gcm` est un nommage legacy : la valeur est bien un token FCM v1.)*
7. Déclencher : bouton admin **« Send a test push to my user »**, puis un **vrai message direct** depuis un autre compte.

> ⚠️ **Piège n°1 — le faux échec.** Rocket.Chat ne pousse **que vers les utilisateurs hors ligne**, et par défaut **uniquement pour un DM ou une mention**. Un message de canal ordinaire, ou un compte de test resté « online », ne déclenche **aucun** push, quelle que soit la configuration. Un spike naïf conclurait à tort à un échec sur le gate qui décide du projet.
>
> ⚠️ **Piège n°2 — le `SENDER_ID_MISMATCH`.** Le token de l'app et le compte de service du serveur doivent appartenir au **même projet Firebase**. Sinon FCM renvoie 403 et le serveur **supprime silencieusement le token**. C'est l'échec le plus fréquent.

**Done when (binaire)** : une notification **visible** arrive **deux fois de suite**, app **swipe-killed**, sur un **appareil physique**, en quelques secondes. Le tap ouvre la bonne route.

**Ce que le spike tranche** : la chaîne prebuild/build local, le `SENDER_ID_MISMATCH`, le comportement du double bloc `notification` + `data`, et la réalité du réveil en app tuée.

**Plan B** si l'échec ne survient que sur un appareil OEM après réglages batterie : le verdict reste « FCM viable », et on documente les réglages par appareil (Autostart, optimisation batterie désactivée). Voir §6.1 pour les plans B et C réels.

---

### Phase 2 — Cœur : connexion (2FA incluse), salons, temps réel — *6 à 9 sem*

**Objectif** : la première valeur réelle. **APK utile au quotidien.**

La 2FA est ici, pas plus tard : sur un serveur où `Accounts_TwoFactorAuthentication_Enabled` est actif, un « login simple » ne permet même pas de s'authentifier.

**Livrables**
- Découverte : `GET /api/v1/settings.public` et `settings.oauth` (non authentifiés) pour adapter l'UI.
- Login `POST /api/v1/login` ; `authToken` + `userId` dans `expo-secure-store`, clé par host.
- **2FA** : intercepter `errorType = totp-required`, lire `details.method` / `details.availableMethods`, rejouer la **même** requête avec `x-2fa-code` et `x-2fa-method`. Pour la méthode `password`, envoyer le **SHA-256** du mot de passe, jamais le clair. `POST /api/v1/users.2fa.sendEmailCode` pour le code par email.
- **Mini-client DDP** : `connect` → `login {resume}` → ping/pong → `sub` / `unsub` → routage `added` / `changed` / `removed` (charge utile dans `fields.args[0]`, clé dans `fields.eventName`, dates EJSON `{"$date": epochMs}`) → **upserts SQLite**.
- **Écran debug permanent** dès maintenant : souscriptions actives, RTT ping/pong, doublons détectés, trous de synchro. Il ne sera pas jeté.
- **Schéma Drizzle complet** : `Server`, `Room`, `Subscription` (jointes par `rid`), `Message` (index `(rid, ts)`, `tmid`), `Outbox` (`pending`/`sent`/`failed`), `Upload`, `SyncState`. **Une base par host.**
- Liste des salons : `subscriptions.get` + `rooms.get` fusionnés par `rid` ; souscription à `stream-notify-user/<uid>/subscriptions-changed` et `/rooms-changed` ; `fname`, aperçu `lastMessage`, badge `unread`, tri par activité.
- Écran salon : historique initial (`channels.history` / `groups.history` / `im.history` selon `t`) ; `FlashList` `inverted` ; rendu markdown maison sur `msg.md` (repli sur `parse()` si absent) ; messages système (`t = uj/ul/rm/r/...`) ; `sub` sur `stream-room-messages/<rid>` à l'ouverture et **`unsub` à la fermeture** ; **dédup par `_id`**.
- Envoi via **Outbox** : `_id` 24-hex généré côté client **avant** l'affichage → insert `pending` → `POST /api/v1/chat.sendMessage` → réconciliation au retour du stream. Le serveur déduplique sur `_id`, donc une réémission après crash ne crée pas de doublon.

**Done when** : sur l'AVD **et** sur un appareil physique — je me connecte (2FA comprise), je vois mes salons avec les non-lus, j'ouvre un salon, je lis l'historique, je reçois en direct, j'envoie avec affichage immédiat. Tuer l'app avec un message `pending` → réémis, sans doublon.

**Risques** : souscriptions empilées si un `unsub` est oublié. `md` absent sur les vieux messages → le repli `parse()` est obligatoire, pas optionnel. Le rendu markdown récursif couvrant tous les tokens de l'AST est un sous-chantier à part entière — c'est la principale raison de la fourchette large.

---

### Phase 3 — Résilience, rattrapage, multi-serveurs, démarrer une conversation — *3 à 4 sem*

**Livrables**
- Reconnexion : backoff exponentiel avec gigue (1 s → 30 s). À **chaque nouvelle socket** : reconnexion, re-login, **re-souscription de tous les streams**. Une souscription ne survit jamais à une reconnexion.
- Rattrapage piloté par `SyncState`, sur `AppState 'active'` et à la reconnexion. **Attention au coût** : `chat.syncMessages` traite **un salon à la fois** et le REST est rate-limité. Ne pas boucler sur tous les salons : un seul `subscriptions.get?updatedSince=` + `rooms.get?updatedSince=` pour le gros, et `syncMessages` **seulement** sur les salons ouverts ou récemment actifs.
- Cycle de vie du token : 401 → tentative `resume` → sinon retour au login. `POST /api/v1/logout`.
- Multi-serveurs : registre `Server`, tokens **et** base SQLite isolés par host.
- **Démarrer une conversation** : `GET /api/v1/spotlight?query=` puis `POST /api/v1/im.create` (nouveau DM) ou `POST /api/v1/channels.join`. Sans cela l'app ne fait que lister l'existant — or « canaux » et « messages privés » supposent d'en ouvrir de nouveaux.

**Done when — test de torture** : couper le Wi-Fi 30 s dix fois, basculer arrière-plan/premier-plan vingt fois, envoyer cinquante messages rapides → **état local == état serveur** : zéro doublon, zéro message manquant, zéro souscription fantôme, mesuré sur l'écran debug.

---

### Phase 4 — Push intégré — *≈ 2 sem*

Capitalise sur le spike. Enregistrement du token à la connexion, dé-enregistrement au logout. Fermeture propre du WebSocket sur `AppState 'background'`, réouverture et resynchronisation sur `'active'`. Handler de notification → deep link `expo-router` vers le salon. Canaux de notification Android, badge cohérent avec `subscription.unread`.

**Done when** : app fermée, un DM me notifie ; le tap ouvre le bon salon et resynchronise ; le logout retire le token.

---

### Phase 5 — Upload de documents, images, vocaux — *2 à 3 sem*

**Attention, l'API a changé** : `POST /api/v1/rooms.upload` a été **supprimé en 8.0.0** — pas déprécié, supprimé. Le flux est en deux temps.

- `POST /api/v1/rooms.media/:rid` puis `POST /api/v1/rooms.mediaConfirm/:rid/:fileId`. **`rooms.media` seul ne poste aucun message** : oublier le `mediaConfirm` laisse un fichier orphelin.
- Upload Android : `expo-file-system/legacy` `createUploadTask` en `MULTIPART`, `fieldName: 'file'`, progression via `totalBytesSent`. *(L'API `legacy` est dépréciée ; la parité d'upload revient dans la nouvelle API `File` — migration à prévoir.)* Intégré à l'`Outbox` via la table `Upload`.
- Sélection : `expo-document-picker`, `expo-image-picker` ; compression `expo-image-manipulator` ; validation de `FileUpload_MaxFileSize` et `FileUpload_MediaTypeWhiteList` lus dans `settings.public` **avant** l'upload.
- Vocaux : `expo-audio`, `.m4a` AAC, `mimeType: audio/mp4`.
- Lecture protégée : si `FileUpload_ProtectFiles`, ajouter `rc_uid` / `rc_token` en query sur `/file-upload/:id/:name` ; `expo-image` pour l'affichage inline.

---

### Phase 6 — Offline-first, actions, présence, recherche — *4 à 6 sem*

Non-lus (`subscriptions.read`, barre « nouveaux messages » via `ls`). Actions message (`chat.update`, `chat.delete`, `chat.react`, `chat.pinMessage`) avec la **décision d'affichage centralisée dans une fonction pure** `(message, currentUser, subscription.roles, permissions, settings)` — le délai d'édition vient des **settings** (`Message_AllowEditing_BlockEditInMinutes`), pas des permissions. Threads (`tmid`, `tcount`) et discussions. Présence via `users.presence?from=` et `stream-user-presence`, avec **dégradation gracieuse** : `Presence_broadcast_disabled` s'active tout seul au-delà d'environ 200 connexions, l'UI ne doit jamais en dépendre. Recherche `chat.search`. Indicateur de saisie via `stream-notify-room/<rid>/user-activity` — **pas** `/typing`, qui est déprécié. Brouillons locaux en MMKV. Suite E2E Maestro.

---

### Phase 7 — iOS, plus tard — *2 à 3 sem sur macOS*

`prebuild` iOS depuis les mêmes config plugins. Push APNs avec **Notification Service Extension**. Keychain access groups. Build sur Mac, ou EAS Build cloud (seule voie depuis Linux — contradiction assumée, spécifique à iOS). Compte Apple Developer à 99 $/an.

### Calendrier

| Phase | Contenu | Estimation |
|---|---|---|
| 0 | Socle + serveur + incertitudes | 1–2 sem |
| 1 | **Spike push (kill gate)** | ≈ 1 sem |
| 2 | **Cœur — 1er APK utile** | 6–9 sem |
| 3 | Résilience + multi-serveurs | 3–4 sem |
| 4 | Push intégré | ≈ 2 sem |
| 5 | Upload | 2–3 sem |
| 6 | Offline-first + polish | 4–6 sem |
| 7 | iOS | 2–3 sem |

**Premier APK réellement utile** : fin de phase 2, soit **8 à 12 semaines**. **Daily-driver complet** : fin de phase 6, soit **19 à 27 semaines** (5 à 7 mois à temps partiel).

---

## 6. Les points durs

### 6.1 Push FCM pour un client tiers

**Problème.** Le gateway public `gateway.rocket.chat` exige l'enregistrement sur Rocket.Chat Cloud et ne relaie que vers les app-ids officielles. La doc le dit : *« When you white-label the mobile app, the default push notification gateway is unavailable. »*

**Solution retenue.** Push FCM **direct**, cinq conditions : `Push_UseLegacy=false` (défaut), `Push_enable_gateway=false`, un **JSON de compte de service** dans `Push_google_api_credentials` (pas une clé API), **le même projet Firebase des deux côtés**, et les **Google Play Services présents sur l'appareil** (aucune installation via le Play Store n'est requise — un APK `adb install` reçoit les push).

**Plan B — Foreground Service + WebSocket persistant.** Faisable en Expo via config plugin, mais **mauvais** : depuis Android 15 le type `dataSync` est **plafonné à 6 h cumulées par 24 h**, puis `Service.onTimeout()`, et son démarrage depuis `BOOT_COMPLETED` est interdit. Aucun type de FGS n'est légitime pour un WebSocket permanent. Plus une notification permanente non-dismissible et la batterie. À réserver aux ROMs dégooglisées.

**Plan C — notifications locales déclenchées par le WebSocket.** **Structurellement insuffisant** : la socket JS n'existe que tant que le process tourne. App tuée, aucune notification possible. Ne couvre que le premier plan.

**Le vrai facteur de fiabilité au quotidien**, une fois le push branché, n'est pas le code : ce sont les surcouches constructeur (MIUI en tête). Sur chaque appareil il faut activer l'Autostart et désactiver l'optimisation de batterie. Tu es admin du serveur, pas des téléphones.

### 6.2 Mini-client DDP, reconnexion, rattrapage

**Problème.** Les souscriptions ne survivent pas à une reconnexion, et oublier un `unsub` fait exploser le nombre de souscriptions et les doublons.

**Solution.** Client maison en écoute seule (§2). Backoff avec gigue. À chaque socket : re-connect, re-login, **re-sub complet**. Souscriptions minimales : deux à quatre sur `stream-notify-user`, plus `stream-room-messages/<rid>` **uniquement pour le salon ouvert**. Rattrapage REST piloté par `SyncState`. Test de torture en critère d'acceptation.

**Plan B.** Adopter `@rocket.chat/ddp-client` en acceptant son poids et son flou de licence. En dernier recours, polling REST pur : dégradé mais fonctionnel.

### 6.3 Liste de messages inversée

`@shopify/flash-list` **2.3.2** en `inverted`. La prop avait été retirée au début de la v2 (mi-2025) puis **réintroduite en 2.3.0** (mars 2026) : je l'ai vérifiée dans `FlashListProps.d.ts` du paquet publié, et l'expérience terrain le confirme. On l'appuie sur `maintainVisibleContentPosition`, qui est bien implémenté nativement sur Android en RN 0.86 (`MaintainVisibleScrollPositionHelper.kt` est présent dans `ReactAndroid`).

Pagination par keyset (`WHERE rid = ? ORDER BY ts DESC`), et **débounce des messages entrants** : des insertions en tête plus rapprochées que ~200 ms font sauter le scroll.

**Plan B** : `@legendapp/list` v3.

### 6.4 Optimistic UI et file d'envoi

`_id` 24-hex généré **avant** l'affichage (`expo-crypto`) → insert `pending` → `chat.sendMessage` → réconciliation au retour du même `_id` via le stream. L'`Outbox` est une table de première classe, avec retry automatique au retour du réseau et statut `failed` actionnable. Test **kill-and-relaunch** → zéro doublon. C'est le remède aux « messages figés » de l'app officielle.

### 6.5 2FA

Le mécanisme est **générique et son nom trompe** : `errorType = totp-required` couvre aussi `email` et `password`. Toujours lire `details.method` et `details.availableMethods`. Rejouer avec `x-2fa-code` / `x-2fa-method`. Pour `password`, envoyer `digestStringAsync(SHA256, mdp)`. Backoff sur les 429 : le rate limiter du login est plus agressif que le REST générique, ne jamais boucler sur `sendEmailCode`.

### 6.6 E2EE — un salon sur vingt-cinq

**Le fait mesuré.** Sur `chat.barrut.me` : `E2E_Enable = true`, `E2E_Allow_Unencrypted_Messages = false`, `E2E_Enabled_Default_PrivateRooms = false`, et **un seul salon chiffré sur 25** (`p:laprivitude`). Les nouveaux salons privés ne sont donc pas chiffrés d'office.

**Le comportement du serveur.** Il **rejette activement** un message en clair dans un salon `encrypted` (`error-not-allowed`), garde appliqué aussi à `chat.sendMessage`. Bonne nouvelle : un client sans E2EE **ne peut pas corrompre** un salon chiffré, il est simplement incapable d'y poster. Un client non-déchiffrant voit `t='e2e'` et un `msg` base64 opaque.

**La solution retenue : dégrader proprement, à trois endroits.**

1. **Liste des salons** — cadenas sur `room.encrypted`, et **aperçu `lastMessage` masqué** : il contient du chiffré. Ne jamais rendre le blob.
2. **Écran salon** — les messages `t === 'e2e'` deviennent « 🔒 Message chiffré, non pris en charge ». Le composer est désactivé avec l'explication, puisque le serveur refuserait l'envoi de toute façon.
3. **Notifications** — `Push_show_message = true` sur ce serveur, donc le corps d'une notification venant d'un salon chiffré est du ciphertext. Le remplacer par un texte générique côté client.

Ce salon se consulte depuis le web ou l'app officielle. Coût de la dégradation : moins d'une journée.

**Plan B — l'implémenter (étape 10 optionnelle, hors chemin critique).** RSA-OAEP 2048/SHA-256 pour la paire utilisateur, **AES-GCM 256** pour les nouveaux messages (`rc.v2.aes-sha2` — et non AES-CBC, qui n'est conservé que pour l'historique `rc.v1`), PBKDF2-SHA256 à 100 000 itérations. `expo-crypto` **ne fait pas de RSA** : il faudrait `react-native-quick-crypto` (New-Arch only, via `react-native-nitro-modules`). Compter plusieurs semaines, et le risque réel de rendre des messages définitivement illisibles.

**Plan C — désactiver le chiffrement de ce salon.** Tu en es propriétaire : le basculer en clair rend tout accessible, au prix du chiffrement pour tous les clients.

---

## 7. Incertitudes à lever en phase 0

Ce que la recherche n'a **pas** tranché. Chacune est une tâche, pas une hypothèse.

| # | Incertitude | Comment la lever |
|---|---|---|
| 1 | `POST /api/v1/login` en 8.6 accepte-t-il encore un champ `code` dans le corps, ou impose-t-il les en-têtes `x-2fa-*` ? | Un `curl` sur le serveur de dev avec la 2FA activée. |
| 2 | Les streams privés exigent-ils une session DDP authentifiée (`login {resume}`) en plus de l'auth REST ? | Souscrire à `stream-notify-user` sans login DDP et observer. |
| 3 | Valeur attendue d'`appName` dans `push.token`, et existence d'un `DELETE /api/v1/push.token`. | Lire `apps/meteor/app/api/server` au tag `8.6.0`. *(Le dossier de recherche dédié a échoué.)* |
| 4 | `expo prebuild` ajoute-t-il bien `POST_NOTIFICATIONS` au manifeste ? | `grep POST_NOTIFICATIONS android/app/src/main/AndroidManifest.xml` après prebuild. |
| 5 | Compatibilité `com.google.gms:google-services` × Gradle 9.3.1. | Le premier build local est la preuve. |
| 6 | Double affichage `notification` + `data` sur Android. | Capturer le payload réel au spike. |
| 7 | Schéma de réponse exact de `rooms.mediaConfirm`. | Un upload de test. |
| 8 | Compat RN 0.86 exacte de `react-native-mmkv@4.3.2` et `react-native-keyboard-controller@1.22.0`. | Table de compat de chaque lib, puis build. |

---

## 8. Premier lot de travail

```sh
# 1. Environnement (à mettre dans ~/.zshrc)
export JAVA_HOME=/home/guillaume/android-build/jdk-17.0.19+10
export ANDROID_HOME=/home/guillaume/Android/Sdk
export ANDROID_SDK_ROOT="$ANDROID_HOME"
export PATH="$JAVA_HOME/bin:$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator:$PATH"

# 2. Vérifier
java -version          # 17.0.19
adb devices
emulator -list-avds    # duogo_test
```

3. **Serveur de dev** : `docker compose` avec Rocket.Chat 8.6 et MongoDB en replica set `rs0` (`rs.initiate()`). `ROOT_URL` sur l'**IP LAN** de la machine, pas `10.0.2.2`. Créer l'admin, générer un Personal Access Token, seeder quelques canaux et un DM.

4. **Squelette Expo** : `npx create-expo-app@latest rocket-vibe-app --template default`, puis `expo-dev-client`, `expo-router`, TypeScript strict, `expo-sqlite` + `drizzle-orm` (avec `enableChangeListener: true`), `expo-secure-store`. Gitignorer `android/` et `ios/`.

5. **Premier build local** : `npx expo prebuild --platform android` puis `./gradlew app:assembleDebug` puis `adb install`. Écran unique affichant `GET /api/v1/info` du serveur de dev. **C'est le premier jalon vérifiable.**

6. **Spike DDP** (une soirée, jetable) : ouvrir un `WebSocket` sur `ws://<IP_LAN>:3000/websocket`, envoyer `{"msg":"connect","version":"1","support":["1"]}`, puis `login` avec le resume token, puis `sub` sur `stream-room-messages`. Poster un message depuis le web et vérifier qu'il arrive. **Répond du même coup à l'incertitude n°2.**

7. **Spike push** (phase 1) — ne pas le commencer avant que les points 3 à 5 soient verts.

---

## 9. Sources principales

- Push serveur : `apps/meteor/app/push/server/fcm.ts` et `apps/meteor/server/settings/push.ts` (dépôt `RocketChat/Rocket.Chat`), PR #32208 (migration FCM HTTP v1), <https://developer.rocket.chat/docs/configuring-push-notifications>
- Push client : <https://docs.expo.dev/versions/latest/sdk/notifications/>, <https://firebase.google.com/docs/android/android-play-services>
- Upload : <https://developer.rocket.chat/apidocs/upload-media-files-to-a-room>, issue #34956
- Dépréciations : <https://docs.rocket.chat/docs/deprecated-and-phasing-out-features>, release 8.0.0
- E2EE : `apps/meteor/app/lib/server/methods/sendMessage.ts` au tag `8.6.0`
- New Architecture : <https://docs.expo.dev/guides/new-architecture/>
- CNG : <https://docs.expo.dev/workflow/continuous-native-generation/>
- Foreground services Android 15+ : <https://developer.android.com/develop/background-work/services/fgs/service-types>

---

*Faits vérifiés en juillet 2026. Rocket.Chat 8.6.0, Expo SDK 57, React Native 0.86.*
