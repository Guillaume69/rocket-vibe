# rocket-vibe

Client mobile **Rocket.Chat** tiers — **Android d'abord**, en Expo / React Native.
Objectif : un client **plus rapide et plus fiable** que l'application officielle, pour
un usage personnel sur un serveur Rocket.Chat auto-hébergé.

> Ce README explique l'app mobile et comment la faire tourner en local ; **toutes les
> commandes se lancent depuis `apps/mobile/`**. Les **décisions** et leur justification
> vivent dans [`ROADMAP.md`](../../ROADMAP.md) ; l'**état d'avancement** détaillé dans
> [`EXECUTION.md`](EXECUTION.md) ; l'**environnement de build** dans
> [`docs/DEV.md`](../../docs/DEV.md).

---

## Ce que c'est

Un client de consommation Rocket.Chat, pas une console d'administration. Il vise un
serveur précis (`https://chat.barrut.me`, Rocket.Chat **8.5** LTS), mais reste
générique : l'URL du serveur se saisit à l'écran de connexion.

Ce qu'il sait faire aujourd'hui : connexion mot de passe + **2FA** (TOTP ou repli mot
de passe), liste des salons, fil de messages (liste inversée performante), **rendu
markdown** natif, envoi / édition / actions sur message, **fils de discussion**,
**upload de fichiers** (photo, document), **lecture audio et vidéo intégrée**,
**aperçus de lien** (images en ligne, cartes OpenGraph pour articles et tweets,
cartes vidéo **YouTube / Dailymotion**), **emojis** (dont personnalisés),
**présence** et **indicateur de saisie**, **recherche**, **notifications push FCM**,
reconnexion et rattrapage automatiques, le tout **hors-ligne d'abord**.

### Le parti pris d'architecture

```
UI (primitives React Native) — une PROJECTION réactive, jamais un miroir du réseau
        │  useLiveQuery (Drizzle)
SQLite (expo-sqlite + Drizzle, WAL) — LA SOURCE DE VÉRITÉ, une base par serveur
        │  upserts idempotents
REST  → pour AGIR          DDP maison (WebSocket) → pour ÉCOUTER (sub/unsub)
        │
Push FCM direct (expo-notifications) — réveille l'app même tuée
```

Le WebSocket et le REST écrivent dans SQLite ; l'UI **observe** SQLite. Le flux temps
réel n'est jamais gardé dans un store mémoire. C'est le remède direct aux griefs
documentés contre l'app officielle (souscriptions empilées, messages dupliqués, envois
figés). Détails et justifications dans [`ROADMAP.md`](../../ROADMAP.md).

**Contraintes fermes** (voir `ROADMAP.md` §4.2) : primitives React Native **natives par
défaut**, **aucun kit UI** (NativeBase, Tamagui, RN Paper…), **aucune WebView**, builds
Android **100 % locaux** (`expo prebuild` + Gradle, **jamais d'EAS**). Le client DDP est
maison (≈ 200 lignes, écrit depuis la spec, pour éviter toute ambiguïté de licence).

---

## Prérequis

| Outil | Version | Note |
|---|---|---|
| **Node** | 24 | |
| **JDK** | Temurin **17** (17.0.x) | RN 0.86 fixe `sourceCompatibility 17`. **JDK 21 non requis.** |
| **SDK Android** | build-tools **36.0.0**, `platforms/android-36`, **NDK 27.1.12297006** | Exactement ce qu'exige le template RN 0.86. |
| **Docker** + Compose | récent | Pour le serveur Rocket.Chat de développement. |
| **Appareil Android** | physique **ou** émulateur | Un **téléphone physique** est requis pour valider le push (l'émulateur ne reproduit ni Doze ni le kill de process). |

Plateforme de développement : Linux ou macOS. iOS est prévu plus tard, sur un Mac —
l'architecture est gardée agnostique, mais n'est pas encore buildée pour iOS.

`android/` et `ios/` sont **gitignorés** (Continuous Native Generation) : ils sont
regénérés par `expo prebuild`. Toute personnalisation native passe par un config plugin
(voir `plugins/`).

---

## Installation

### 1. Dépendances

```sh
npm install
```

### 2. Environnement de build

```sh
source scripts/env.sh          # RV_ENV_VERBOSE=1 pour voir ce qui est exporté
```

Ce script **auto-détecte** le JDK 17 et le SDK Android, ajuste `PATH`, et calcule
`ROOT_URL` à partir de l'IP LAN de la machine. Il est idempotent (le sourcer plusieurs
fois n'empile rien). Surcharges disponibles : `RV_JDK_HOME`, `RV_ANDROID_HOME`,
`RV_ROOT_URL` (voir `docs/DEV.md`).

### 3. Un serveur Rocket.Chat pour se connecter

Deux options selon l'usage.

**a. Serveur de développement local (recommandé pour développer)**

```sh
cd ../../docker
cp .env.example .env && chmod 600 .env    # puis renseigner ADMIN_PASS
docker compose up -d                       # Rocket.Chat 8.5.1 + MongoDB 8.0 (replica set)
curl -sf "$ROOT_URL/api/info"              # attendu : {"version":"8.5",...}
```

Puis les données de test (idempotent, rejouable même après interruption) :

```sh
cd - && npm run seed                       # crée alice, bob, test-public, test-prive, un DM…
```

> `docker compose up` **échoue volontairement** sans `.env` renseigné, plutôt que de
> créer un compte `admin` sans mot de passe sur un serveur exposé au LAN.

**b. Un serveur réel** — rien à lancer localement : l'URL se saisit à l'écran de
connexion de l'app (ex. `https://chat.barrut.me`).

### 4. Firebase (pour le push)

Le build attend un `google-services.json` dans `apps/mobile/` (référencé par `app.json`, et
**gitignoré** — c'est un secret). Fournis le tien :

1. Crée un projet Firebase (gratuit) et une app Android dont le `package_name`
   correspond **exactement** à `android.package` de `app.json` (actuellement
   `com.rocketvibe.app`) — sinon le plugin Gradle GMS refuse de builder.
2. Télécharge `google-services.json` et pose-le dans `apps/mobile/`.

Côté serveur, le push direct FCM v1 suppose `Push_enable_gateway=false`,
`Push_UseLegacy=false`, et le JSON d'un **compte de service** Firebase dans
`Push_google_api_credentials`. Détails dans `ROADMAP.md` et `docs/DEV.md`.

> Sans `google-services.json`, tu peux tout de même builder en retirant temporairement
> `googleServicesFile` / le plugin de `app.json`, mais le push ne fonctionnera pas.

### 5. Builder et lancer l'app

```sh
npm run prebuild               # expo prebuild --platform android --clean (régénère android/)
npm run android                # build debug + installe + lance ; démarre Metro
```

Pour un appareil physique, branche-le (`adb devices` doit le voir). Pour l'émulateur,
redirige le port du serveur de dev :

```sh
adb reverse tcp:3000 tcp:3000
```

#### ⚠️ Debug vs. release avec le serveur local

Le serveur de dev est en **HTTP en clair**, qu'Android bloque depuis `targetSdk 28`.
Expo autorise le trafic cleartext **uniquement dans le variant `debug`** (via
`android/app/src/debug/AndroidManifest.xml`). Donc :

- **Serveur local HTTP** → utiliser un build **debug** + Metro. Une **release ne joindra
  pas** `http://…:3000` (elle renverra « serveur injoignable »).
- **Serveur de production HTTPS** (`chat.barrut.me`) → non concerné, la release marche.

C'est **voulu** : la release reste sûre par construction. Ne pas activer le cleartext
globalement (voir `docs/DEV.md`).

---

## Scripts npm

| Commande | Effet |
|---|---|
| `npm start` | Démarre Metro (`--dev-client`). |
| `npm run android` | Build debug, installe, lance. |
| `npm run prebuild` | Régénère `android/` (`expo prebuild --clean`). |
| `npm run typecheck` | `tsc --noEmit` (TypeScript strict, zéro `any` implicite). |
| `npm run lint` | `expo lint`. |
| `npm test` | Tests unitaires (`node --test` sur `lib/` et `db/`). |
| `npm run seed` | (Re)pose les données de test sur le serveur de dev. |
| `npm run db:generate` | Génère les migrations Drizzle depuis le schéma. |

Pour une **release** : `source scripts/env.sh && cd android && ./gradlew assembleRelease`,
puis `adb install -r app/build/outputs/apk/release/app-release.apk`.

Une release est signée avec **la clé de l'app**, la même en local et en CI : Android
refuse une mise à jour signée d'une autre clé. Elle vit hors du dépôt, dans
`~/.config/rocket-vibe/` (`release.keystore` et `signature.env`, que `scripts/env.sh`
lit) ; la CI la tient des secrets `ANDROID_KEYSTORE_BASE64` et
`ANDROID_KEYSTORE_PASSWORD`. Sans elle, un build release échoue au lieu de retomber sur
la clé de debug. **À sauvegarder** : perdue, plus aucune mise à jour ne s'installe.

---

## Structure de l'app

```
app/            Routes expo-router (index, connexion, salon/[rid], fil/[id], recherche…)
ui/             Composants et thème « Nuit Étoilée » (theme.ts, kit.tsx, ligneMessage.tsx,
                lecteurAudio/Video, carteEmbed, carteLien, visionneuse, markdown, session…),
                plus l'i18n : messages.ts (catalogue) et i18n.ts (store + hooks)
lib/            Cœur non-UI : ddp.ts (client DDP), rest.ts, auth.ts, envoi.ts, upload.ts,
                sync.ts, rattrapage.ts, reconnexion.ts, presence.ts, push.ts, apercuLien.ts…
db/             SQLite + Drizzle : schema.ts, upserts.ts, depot.ts, migrations/
scripts/        env.sh, génération d'emojis
plugins/        Config plugins CNG (with-fcm-deeplink : deep-link au tap d'un push)
assets/         Icônes de l'app (lanceur, adaptative, notif « fusée » monochrome)
e2e/            Parcours Maestro et leur harnais
```

À la racine du dépôt, partagés avec l'app bureau : `docker/` (Rocket.Chat 8.5.1 +
MongoDB 8.0), `scripts/` (seed.mjs, spike-ddp.mjs) et `docs/` (DEV.md : environnement,
réseau, relevé du serveur cible).

Les modules de `lib/` et `db/` sont accompagnés de tests (`*.test.ts`).

---

## Internationalisation (i18n)

Anglais et français, **sans dépendance** : la langue du téléphone est lue en pur
JS via `Intl.DateTimeFormat().resolvedOptions().locale` (Hermes embarque ICU),
donc aucun module natif ni rebuild. La préférence (Automatique / Français /
English) se choisit dans **Paramètres → Langue** et vit dans SecureStore, lue de
façon synchrone au démarrage (pas de flash de langue).

- `ui/messages.ts` — catalogue **pur** (testable sous Node). `fr` est la
  référence ; `en` est typé `Record<CleTraduction, string>`, donc toute clé
  manquante ou en trop **casse la compilation**. Interpolation `{param}`,
  pluriel `singulier | pluriel` arbitré par un `n` numérique.
- `ui/i18n.ts` — store abonnable (patron de `identites.tsx`) : `useT()` pour le
  rendu, `traduireCourant()` pour les messages figés hors composant (handlers
  natifs, effets). Ajouter une langue = un catalogue de plus, zéro code.

**Frontière assumée** : l'UI est bilingue, mais les messages d'erreur bruts de
la couche `lib/` et du transport (`serveur injoignable`, `Téléversement
annulé`…) restent en français — `lib/` reste pur, testable et sans plateforme.
Ils ne surfacent que par `e.message`, en dernier recours.

---

## Secrets — jamais dans le dépôt

Sont **gitignorés** et à fournir localement : `.env`, `.env.local`,
`google-services.json`, tout JSON de compte de service Firebase
(`*firebase-adminsdk*.json`, `*-service-account*.json`). Seul `docker/.env.example` (à la racine)
documente les variables attendues côté serveur de dev.

---

## Licence & statut

Projet personnel, en développement actif. Branche principale : **`master`**.
Voir `ROADMAP.md` pour le périmètre v1 (l'**E2EE**, les **appels A/V**, l'**admin
serveur** et **iOS au démarrage** sont hors périmètre et documentés comme dettes
assumées).
