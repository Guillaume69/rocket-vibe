# EXECUTION — rocket-vibe

Checklist d'exécution pas à pas. **`ROADMAP.md` dit *pourquoi*, ce document dit *quoi faire ensuite*.**
Chaque sous-étape est un commit. Chaque grosse étape est un incrément livrable.

---

## La boucle, pour chaque sous-étape

Elle se déroule **dans cet ordre**, sans sauter de marche.

1. **Lire** le critère de sortie de la sous-étape. Il est exécutable : c'est une commande dont le résultat tranche.
2. **Implémenter**, en respectant les règles permanentes ci-dessous.
3. **Prouver** — et c'est la marche qu'on est tenté de sauter :
   - sous-étape `[code]` → faire réellement tourner le code (`/verify`, ou exécution directe et observation de la sortie) ;
   - sous-étape `[infra]` → exécuter la commande de preuve et lire sa sortie.
   Relire du code jamais exécuté, c'est relire une intention.
4. **`/code-review`** sur le diff non commité — uniquement pour les sous-étapes `[code]`.
5. **Corriger** les *findings* retenus. Ceux qu'on écarte sont notés dans le message de commit, avec la raison.
6. **Cocher** la case et la dater. On n'y inscrit pas le SHA : un commit ne peut pas contenir le SHA qu'il n'a pas encore. Le lien inverse se fait par le trailer — `git log --grep='Étape: 1.1'`.
7. **Commit unique** : le code *et* la case cochée dans le même commit. Un historique où le code existe mais la case est vide est un historique qui ment.
8. **`git push`** sur `master`.

### Convention de commit

```
<type>(<scope>): <sujet à l'impératif>

<corps optionnel : findings écartés et pourquoi>

Étape: 1.2
```

`type` ∈ `feat`, `fix`, `build`, `chore`, `docs`, `test`, `refactor`.

### Légende

| Marqueur | Sens |
|---|---|
| `@claude` | Je le fais seul. |
| `@guillaume` | Toi seul peux le faire (compte externe, matériel, secret). **Me bloque.** |
| `@duo` | Tu fournis quelque chose, j'enchaîne. |
| `[code]` | Produit du code → boucle complète avec `/code-review`. |
| `[infra]` | Config, scripts d'environnement → preuve par commande, pas de review. |
| `[doc]` | Documentation → pas de review. |

---

## Règles permanentes

- **Aucune dépendance nouvelle** sans qu'elle entre dans un des niveaux de `ROADMAP.md` §4.2. Toute exception se justifie dans le message de commit.
- Interdits fermes, rappel : kit UI, WebView, `react-native-markdown-display`, `@gorhom/bottom-sheet`.
- TypeScript **strict**, zéro `any` implicite. `npx tsc --noEmit` fait partie de chaque critère de sortie `[code]`.
- `android/` et `ios/` sont **gitignorés** (CNG). Toute personnalisation native passe par un config plugin. En SDK 57, `expo prebuild` efface et régénère par défaut : une édition manuelle serait perdue.
- Aucun secret dans le dépôt. `google-services.json`, le JSON de compte de service Firebase et le `.env` sont gitignorés. Des `.example` les documentent.
- Un commit ≈ une sous-étape. Au-delà de ~300 lignes de diff, la review perd en précision : scinder.

---

## Ce qui me bloque, et que toi seul peux faire

À préparer avant l'étape 2. Rien d'autre ne me bloque avant.

| # | Ce dont j'ai besoin | Pourquoi |
|---|---|---|
| ~~B1~~ | ~~Un téléphone Android physique~~ — **fourni** : Pixel 10 Pro, Android 16, `arm64-v8a`, Play Services présents, vu par `adb` (`56211FDCH004E7`). Un Pixel est le meilleur cas : aucune surcouche constructeur n'y tue les services en arrière-plan, donc un échec du *kill gate* sera un vrai échec. | ✔ |
| ~~B2~~ | ~~Projet Firebase + `google-services.json`~~ — **fourni** : projet `rocket-vibe`, `package_name: com.rocketvibe.app`. | ✔ |
| ~~B3~~ | ~~Clé JSON de compte de service~~ — **fournie** : `rocket-vibe-firebase-adminsdk-*.json`, même projet que le `google-services.json` (condition anti-`SENDER_ID_MISMATCH`). | ✔ |
| B4 | Sur le téléphone : **Autostart activé**, **optimisation de batterie désactivée** pour l'app | Vrai facteur de fiabilité du push au quotidien, surtout sur MIUI/Samsung. |

> **L'émulateur couvre une bonne partie du chemin.** L'AVD `duogo_test` tourne sur une image `google_apis` : `com.google.android.gms` y est présent (vérifié), or FCM exige les **Google Play Services**, pas le Play Store. Je peux donc prouver seul toute la chaîne Firebase → serveur → token → réception. Seul le « app tuée, deux fois de suite » exige B1.
>
> Le Pixel 10 Pro est branché et vu par `adb`. Je n'y installe rien sans accord : la chaîne est déjà prouvée sur l'émulateur (`docs/PUSH.md`).

---

## État d'avancement

| Étape | Titre | Statut |
|---|---|---|
| 1 | Socle vérifiable | ✅ 2026-07-10 |
| 2 | Spike push — **kill gate** | ✅ PASS sur émulateur — 2.5b (Pixel) en attente |
| 3 | Transport et données | ☐ |
| 4 | Première tranche verticale | ☐ |
| 5 | Résilience et rattrapage | ☐ |
| 6 | Push intégré | ☐ |
| 7 | Upload | ☐ |
| 8 | Offline-first et finitions | ☐ |
| 9 | iOS | ☐ |

---

## Étape 1 — Socle vérifiable

> Objectif : un APK maison, construit localement, qui parle à un vrai serveur Rocket.Chat.
> Aucune dépendance à toi. Je peux la mener de bout en bout.
> Réf. `ROADMAP.md` §5 phase 0.

- [x] **1.1 — Environnement de build** · `@claude` · `[infra]`
  Écrire `scripts/env.sh` (exporte `JAVA_HOME`, `ANDROID_HOME`, `ANDROID_SDK_ROOT`, `PATH`) et `docs/DEV.md`.
  **Critère de sortie** : `source scripts/env.sh && java -version 2>&1 | grep -q '17\.0\.19' && adb devices`
  Fait le : **2026-07-09** — vert sous zsh *et* bash. `ROOT_URL` résolu à `http://192.168.1.106:3000`.

- [x] **1.2 — Serveur Rocket.Chat en Docker** · `@claude` · `[infra]`
  `docker/compose.yml` : Rocket.Chat **8.5.1** (la version de `chat.barrut.me`, LTS) + MongoDB **8.0** en **replica set `rs0`** (requis : RC lit les *change streams*). `ROOT_URL` sur l'**IP LAN**. `.env.example` versionné, `.env` en `chmod 600` et gitignoré.
  **Critère de sortie** : `curl -sf $ROOT_URL/api/info | node -e 'process.exit(JSON.parse(require("fs").readFileSync(0)).version.startsWith("8.5")?0:1)'`
  Fait le : **2026-07-09** — `version = 8.5`, replica set PRIMARY, login admin vérifié.

- [x] **1.3 — Seed de données de test** · `@claude` · `[code]`
  `scripts/seed.mjs` : deux utilisateurs, un canal public, un groupe privé, un DM, 12 messages par salon, un fil de 3 réponses. **Idempotent même après un échec partiel** : chaque message porte un marqueur `[seed i/n]`, seuls les manquants sont reposés.
  **Critère de sortie** : `node scripts/seed.mjs` deux fois de suite, puis `channels.list` contient `test-public`, sans doublon.
  Fait le : **2026-07-10** — vérifié sur base vierge, puis en supprimant 2 messages et 1 réponse : la relance repose exactement ce qui manque.

- [x] **1.4 — Squelette Expo** · `@claude` · `[code]`
  Expo **SDK 57** (RN 0.86, React 19.2.3), `expo-router`, `expo-dev-client`, TypeScript strict, `expo lint`. Template `blank-typescript` et non `default` : ce dernier impose Reanimated et un écran de démo. `applicationId = me.barrut.rocketvibe` (devra correspondre au `package_name` Firebase).
  **Critère de sortie** : `npx tsc --noEmit` sort en 0, et `expo lint` est propre.
  Fait le : **2026-07-10** — les deux verts. *Correction :* Reanimated **est** installé, `expo-router` en dépend directement. Voir `docs/DEV.md`.

- [x] **1.5 — Premier APK local** · `@claude` · `[infra]`
  `npx expo prebuild --platform android --clean`, puis `./gradlew app:assembleDebug`, puis installation sur l'AVD `duogo_test`.
  **Critère de sortie** : `./gradlew app:assembleDebug` sort en 0 ; `adb install -r <apk>` réussit ; l'app s'ouvre sans crash.
  Fait le : **2026-07-10** — `BUILD SUCCESSFUL in 3m 7s` (Gradle 9.3.1, JDK 17, New Arch + Hermes + edge-to-edge actifs par défaut). APK universel de 248 Mo, 4 ABI. Lancé sur l'AVD via le deep link du dev client : écran rendu, `logcat` sans erreur fatale.
  > L'**incertitude n°5** (`com.google.gms:google-services` × Gradle 9.3.1) **reste ouverte** : le plugin GMS n'est pas encore au projet. Elle se lèvera au premier build de l'étape 2.2.

- [x] **1.6 — Écran « serveur »** · `@claude` · `[code]`
  Saisie de l'URL, `GET /api/info` et `GET /api/v1/settings.public` en parallèle, affichage de la version, des méthodes d'authentification, de la 2FA, de l'E2EE et de la protection des fichiers. `lib/server.ts` sera réutilisé par l'écran de connexion (3.2).
  **Critère de sortie** : sur l'AVD, l'écran affiche la version du serveur Docker.
  Fait le : **2026-07-10** — affiche `8.5`, `TOTP, email`, fichiers et avatars protégés. HTTP en clair OK via l'overlay debug d'Expo et `adb reverse tcp:3000`.

- [x] **1.7 — Spike DDP jetable** · `@claude` · `[code]`
  `scripts/spike-ddp.mjs` : deux connexions WebSocket (anonyme et authentifiée), souscriptions croisées sur salon privé et public, message déclencheur posté via REST.
  **Incertitude n°2 levée** : le login DDP (`method login {resume}`) est **obligatoire pour toute souscription, même sur un canal public** (`nosub: not-allowed` sinon), et le token REST sert tel quel. Verdict complet dans `docs/DEV.md`.
  **Critère de sortie** : le script imprime le message posté et sort en 0.
  Fait le : **2026-07-10** — PASS. Temps réel prouvé avec le `WebSocket` global (API navigateur = API React Native).

**Sortie d'étape** : un APK installé affiche la version d'un vrai serveur Rocket.Chat, et je sais comment le temps réel s'authentifie.

---

## Étape 2 — Spike push · **KILL GATE**

> Objectif : prouver de façon **binaire** qu'un APK auto-compilé reçoit une notification **app tuée**.
> Code jetable, zéro UI. Rien de l'étape 3 ne commence avant que ce gate soit tranché.
> Réf. `ROADMAP.md` §5 phase 1 et §6.1. Prérequis : **B1 à B4**.

- [~] **2.1 — Fournir les accès Firebase** · `@guillaume` · `[infra]` — **à moitié fait**
  ✔ `google-services.json` déposé (projet `rocket-vibe`, sender `321528905029`, `package_name: com.rocketvibe.app`) ; `app.json` aligné dessus (`me.barrut.rocketvibe` → `com.rocketvibe.app`, ancien APK désinstallé).
  ✖ **Manque la clé JSON du compte de service** (console Firebase → Paramètres du projet → Comptes de service → Générer une clé privée ; rôle *Firebase Cloud Messaging API Admin* ; API *FCM V1* activée). C'est elle que le serveur colle dans `Push_google_api_credentials` — sans elle, 2.3 et 2.5 sont bloquées. À déposer **hors du dépôt** (ex. `~/rocket-vibe-secrets/`).

- [x] **2.2 — Intégration `expo-notifications`** · `@claude` · `[code]`
  `lib/push.ts` : canal `default` (HIGH) **avant** `requestPermissionsAsync()`, puis `getDevicePushTokenAsync()`. Bouton de preuve sur l'écran serveur.
  **Incertitude n°4 levée, avec une nuance** : `POST_NOTIFICATIONS` est absent de `src/main/AndroidManifest.xml` mais **présent dans le manifeste fusionné** — il vient du manifeste de la bibliothèque `expo-notifications`, fusionné au build. Deux services `MESSAGING_EVENT` FCM déclarés.
  **Incertitude n°5 levée** : `com.google.gms:google-services:4.4.4` × Gradle 9.3.1 → `BUILD SUCCESSFUL`.
  **Critère de sortie** : un token FCM est visible.
  Fait le : **2026-07-10** — le dialogue de permission s'affiche, et un **vrai jeton FCM** (`…:APA91b…`) émis pour le projet `rocket-vibe` s'affiche à l'écran de l'émulateur (image `google_apis`, GMS présents).

- [x] **2.3 — Configurer le push côté serveur** · `@claude` · `[infra]` — *serveur Docker local uniquement, `chat.barrut.me` non touché*
  `Push_enable = true`, `Push_enable_gateway = false`, JSON du compte de service dans `Push_google_api_credentials`, workspace redémarré.
  **`Push_UseLegacy` n'existe pas en 8.5** — ni `Push_gcm_api_key`, ni `Push_gcm_project_number`. Le legacy est entièrement retiré ; 8.x ne parle que FCM v1. Le dossier de recherche se trompait.
  **Modifier un réglage privilégié exige la 2FA** : `totp-required`, `method: "password"` → rejouer avec `x-2fa-code: <SHA-256 du mot de passe>` et `x-2fa-method: password`. Mécanisme de 3.2, validé en avance.
  Fait le : **2026-07-10**

- [x] **2.4 — Enregistrer le token** · `@claude` · `[code]`
  `lib/pushToken.ts` : `enregistrerJeton` / `desenregistrerJeton`.
  **Incertitude n°3 levée**, dans le code au tag `8.5.0` (`apps/meteor/app/api/server/v1/push.ts`) : `appName` est une **chaîne libre** (`minLength: 1`, aucun lien avec l'applicationId) ; **`DELETE /api/v1/push.token` existe**, corps `{ token }`. Schéma strict (`additionalProperties: false`). Un DELETE rejoué répond **404** — toléré par `desenregistrerJeton` (test sur le statut, pas sur le texte).
  **Critère de sortie** : POST → `success:true`, DELETE → `success:true`, DELETE rejoué → 404.
  Fait le : **2026-07-10** — contrat validé contre le serveur Docker 8.5 (200/200/404).

- [x] **2.5a — La chaîne, sur émulateur** · `@claude` · `[infra]` — **PASS**
  Serveur → `POST https://fcm.googleapis.com/v1/projects/rocket-vibe/messages:send`, `android.priority: HIGH`. Notification affichée (`pkg=com.rocketvibe.app`, `title=admin`), **y compris processus tué** (`am kill`), avec réveil du process par FCM.
  > ⚠️ **`am force-stop` ≠ balayage depuis les récents.** Il place l'app dans l'état *stopped*, où FCM ne livre plus rien. Un spike qui l'utiliserait conclurait à tort que le push est mort. Utiliser **`am kill`**.
  > ⚠️ Rien ne s'affiche **au premier plan** : le message est remis à l'app, et `expo-notifications` n'affiche rien sans `setNotificationHandler`. Ce n'est pas un échec du push.
  > ⚠️ Rocket.Chat ne pousse **que vers les utilisateurs hors ligne**, sur **DM ou mention** seulement.
  Fait le : **2026-07-10** — verdict complet dans `docs/PUSH.md`.

- [ ] **2.5b — Le kill gate, sur appareil physique** · `@duo` · `[infra]` — *le Pixel est branché, mais je n'y installe rien sans toi*
  App **swipe-killed** depuis les récents (pas `force-stop`) sur le Pixel 10 Pro.
  **Critère de sortie (binaire)** : une notification **visible** arrive **deux fois de suite**, app tuée. Confirme Doze et les conditions réelles ; l'émulateur a déjà validé la chaîne.

- [x] **2.6 — Consigner le verdict** · `@claude` · `[doc]`
  `docs/PUSH.md` : payload FCM réel, les trois pièges de terrain, et les deux défauts connus à corriger en 6.3 (canal `fcm_fallback_notification_channel` au lieu du nôtre en `HIGH` ; rien au premier plan sans `setNotificationHandler`).
  **Incertitude n°6 levée** : le serveur envoie **les deux blocs** `notification` et `data`. Le système affiche le premier ; le `rid` du deep link vit dans `data.ejson`.
  Fait le : **2026-07-10**

**Sortie d'étape** : PASS → l'étape 6 est planifiable telle quelle. FAIL sur appareil OEM après réglages batterie → le verdict reste « FCM viable », on documente les réglages. FAIL total → bascule sur le plan B de `ROADMAP.md` §6.1, et le périmètre « notifications » est renégocié.

---

## Étape 3 — Transport et données

> Le cœur invisible. Aucune UI. Tout est testable hors écran.
> Réf. `ROADMAP.md` §5 phase 2 et §6.2.

- [ ] **3.1 — Client REST typé** · `@claude` · `[code]`
  `fetch` enveloppé : en-têtes d'auth, erreurs typées, backoff sur `429`. Pas de dépendance HTTP tierce.
  **Critère de sortie** : tests unitaires verts sur les cas 200 / 401 / 429.
  Fait le : `____`

- [ ] **3.2 — Authentification et 2FA** · `@claude` · `[code]`
  `POST /api/v1/login`. Interception de `errorType = totp-required` — **le nom trompe, il couvre aussi `email` et `password`**. Lire `details.method` et `details.availableMethods`, rejouer la **même** requête avec `x-2fa-code` et `x-2fa-method`. Pour `password`, envoyer le **SHA-256**, jamais le clair. `users.2fa.sendEmailCode` avec backoff : le rate limiter du login est plus agressif que le REST générique.
  Tokens dans `expo-secure-store`, clé par host. **Lève l'incertitude n°1** (le corps accepte-t-il encore `code` en 8.6 ?).
  **Critère de sortie** : login réussi contre le serveur Docker avec `Accounts_TwoFactorAuthentication_Enabled` activé, méthode `totp` **et** méthode `email`.
  Fait le : `____`

- [ ] **3.3 — Mini-client DDP** · `@claude` · `[code]`
  Écoute seule : `connect`, `login {resume}`, `sub`, `unsub`, routage `added` / `changed` / `removed` / `ready` / `nosub` / `ping`. **Pas de `call`** : les appels de méthodes DDP sont dépréciés (8.0), retrait en 9.0. Charge utile dans `fields.args[0]`, clé dans `fields.eventName`, dates EJSON `{"$date": epochMs}`.
  Écrit depuis la spécification DDP et l'observation du trafic — **on ne recopie pas** le code de `@rocket.chat/ddp-client`, sous licence EE.
  **Critère de sortie** : tests unitaires sur un `WebSocket` mocké (handshake, sub, event, unsub, reconnexion) + un test d'intégration contre le serveur Docker.
  Fait le : `____`

- [ ] **3.4 — Schéma local** · `@claude` · `[code]`
  Drizzle + `expo-sqlite`, **`enableChangeListener: true`** obligatoire à l'ouverture. Tables `Server`, `Room`, `Subscription`, `Message` (index `(rid, ts)`, `tmid`), `Outbox`, `Upload`, `SyncState`. **Une base par host.**
  **Critère de sortie** : les migrations s'appliquent, `useLiveQuery` réagit à une écriture.
  Fait le : `____`

- [ ] **3.5 — Moteur de synchro** · `@claude` · `[code]`
  Le WebSocket et le REST écrivent tous deux par **upserts idempotents**. Dédup par `_id`. `SyncState` par salon.
  **Critère de sortie** : rejouer deux fois le même événement ne crée pas de doublon (test).
  Fait le : `____`

- [ ] **3.6 — Écran debug** · `@claude` · `[code]`
  Souscriptions actives, RTT du ping/pong, doublons détectés, trous de synchro. **Il ne sera pas jeté** : c'est l'instrument de mesure du test de torture de l'étape 5.
  **Critère de sortie** : l'écran affiche le nombre de souscriptions actives, qui retombe à zéro quand on quitte un salon.
  Fait le : `____`

---

## Étape 4 — Première tranche verticale

> Objectif : **l'APK devient utile au quotidien**.
> Réf. `ROADMAP.md` §5 phase 2, §6.3, §6.4.

- [ ] **4.1 — Liste des salons** · `@claude` · `[code]` — `subscriptions.get` + `rooms.get` fusionnés par `rid` ; souscriptions `stream-notify-user/<uid>/subscriptions-changed` et `/rooms-changed` ; `fname`, aperçu `lastMessage`, badge `unread`, tri par activité. **Si `room.encrypted` : cadenas, et aperçu `lastMessage` masqué** — il contient du ciphertext. Fait le : `____`
- [ ] **4.2 — Écran salon** · `@claude` · `[code]` — historique via `channels.history` / `groups.history` / `im.history` selon `t` ; `@shopify/flash-list` **`inverted`** + `maintainVisibleContentPosition` ; pagination keyset `WHERE rid = ? ORDER BY ts DESC` ; `sub` à l'ouverture, **`unsub` à la fermeture** ; **débounce des entrants** (des insertions en tête à moins de ~200 ms font sauter le scroll). Fait le : `____`
- [ ] **4.3 — Rendu markdown** · `@claude` · `[code]` — `@rocket.chat/message-parser` sur `msg.md`, rendu en `<Text>` imbriqués. **Repli sur `parse()` obligatoire** : `md` est absent des vieux messages. Sous-chantier à part entière, ne pas le sous-estimer. Fait le : `____`
- [ ] **4.4 — Messages système** · `@claude` · `[code]` — `t = uj / ul / rm / r / ...`, table de traduction. Fait le : `____`
- [ ] **4.6 — Dégradation des salons chiffrés** · `@claude` · `[code]` — le serveur cible a `E2E_Enable = true` et **un salon chiffré** (`p:laprivitude`). Les messages `t === 'e2e'` deviennent « 🔒 Message chiffré, non pris en charge », jamais le blob base64 ; le composer est désactivé avec l'explication, puisque le serveur rejette un message en clair (`error-not-allowed`, `E2E_Allow_Unencrypted_Messages = false`). Voir `ROADMAP.md` §6.6. Fait le : `____`
- [ ] **4.5 — Outbox et optimistic UI** · `@claude` · `[code]` — `_id` 24-hex généré **avant** l'affichage → insert `pending` → `chat.sendMessage` → réconciliation au retour du même `_id`. Retry au retour du réseau, statut `failed` actionnable.
  **Critère de sortie** : tuer l'app avec un message `pending`, la relancer → le message part **sans doublon** (le serveur déduplique sur `_id`). Fait le : `____`

**Sortie d'étape** : je me connecte (2FA comprise), je vois mes salons, je lis, je reçois en direct, j'envoie. Sur l'AVD **et** sur un appareil physique.

---

## Étape 5 — Résilience et rattrapage

> Réf. `ROADMAP.md` §5 phase 3, §6.2.

- [ ] **5.1 — Reconnexion** · `@claude` · `[code]` — backoff exponentiel avec gigue (1 s → 30 s). À **chaque nouvelle socket** : reconnexion, re-login, **re-souscription de tous les streams**. Une souscription ne survit jamais à une reconnexion. Fait le : `____`
- [ ] **5.2 — Rattrapage** · `@claude` · `[code]` — piloté par `SyncState`, sur `AppState 'active'` et à la reconnexion. **`chat.syncMessages` traite un salon à la fois et le REST est rate-limité** : ne pas boucler sur tous les salons. Un `subscriptions.get?updatedSince=` + `rooms.get?updatedSince=` pour le gros, `syncMessages` **seulement** sur les salons ouverts ou récemment actifs. Fait le : `____`
- [ ] **5.3 — Multi-serveurs** · `@claude` · `[code]` — registre `Server`, tokens **et** base SQLite isolés par host. Fait le : `____`
- [ ] **5.4 — Démarrer une conversation** · `@claude` · `[code]` — `GET /api/v1/spotlight?query=`, puis `POST /api/v1/im.create` ou `POST /api/v1/channels.join`. Sans cela l'app ne fait que lister l'existant. Fait le : `____`
- [ ] **5.5 — Test de torture** · `@claude` · `[code]` — couper le Wi-Fi 30 s dix fois, basculer arrière-plan/premier-plan vingt fois, envoyer cinquante messages rapides.
  **Critère de sortie** : état local == état serveur. **Zéro doublon, zéro message manquant, zéro souscription fantôme**, mesuré sur l'écran debug de 3.6. Fait le : `____`

---

## Étape 6 — Push intégré

> Dépend du verdict de l'étape 2. Réf. `ROADMAP.md` §5 phase 4.

- [ ] **6.1 — Cycle de vie du token** · `@claude` · `[code]` — enregistrement à la connexion, dé-enregistrement au logout. Fait le : `____`
- [ ] **6.2 — Cycle de vie du socket** · `@claude` · `[code]` — fermeture propre sur `AppState 'background'`, réouverture et resynchronisation sur `'active'`. Fait le : `____`
- [ ] **6.3 — Deep link** · `@claude` · `[code]` — handler de notification → route `expo-router` vers le salon ; badge cohérent avec `subscription.unread` ; canaux de notification Android. **`Push_show_message = true` sur le serveur cible** : une notification venant du salon chiffré transporte du ciphertext → la remplacer par un texte générique. Fait le : `____`

---

## Étape 7 — Upload

> Réf. `ROADMAP.md` §5 phase 5. **`rooms.upload` a été supprimé en 8.0.0**, pas déprécié.

- [ ] **7.1 — Flux en deux temps** · `@claude` · `[code]` — `POST /api/v1/rooms.media/:rid` puis `POST /api/v1/rooms.mediaConfirm/:rid/:fileId`. **`rooms.media` seul ne poste aucun message** : oublier le `mediaConfirm` laisse un fichier orphelin. **Lève l'incertitude n°7** (schéma de réponse de `mediaConfirm`). Fait le : `____`
- [ ] **7.2 — Transport** · `@claude` · `[code]` — `expo-file-system/legacy` `createUploadTask` en `MULTIPART`, `fieldName: 'file'`, progression via `totalBytesSent`. Intégré à l'`Outbox` par la table `Upload`. Fait le : `____`
- [ ] **7.3 — Sélection et validation** · `@claude` · `[code]` — `expo-document-picker`, `expo-image-picker`, compression `expo-image-manipulator`. Valider `FileUpload_MaxFileSize` et `FileUpload_MediaTypeWhiteList` (lus dans `settings.public`) **avant** l'upload. Fait le : `____`
- [ ] **7.4 — Lecture protégée** · `@claude` · `[code]` — si `FileUpload_ProtectFiles`, ajouter `rc_uid` / `rc_token` en query sur `/file-upload/:id/:name`. Fait le : `____`
- [ ] **7.5 — Messages vocaux** · `@claude` · `[code]` — `expo-audio`, `.m4a` AAC, `mimeType: audio/mp4`. Fait le : `____`

---

## Étape 8 — Offline-first et finitions

> Réf. `ROADMAP.md` §5 phase 6.

- [ ] **8.1 — Non-lus** · `@claude` · `[code]` — `subscriptions.read`, barre « nouveaux messages » via `ls`. Fait le : `____`
- [ ] **8.2 — Actions message** · `@claude` · `[code]` — `chat.update`, `chat.delete`, `chat.react`, `chat.pinMessage`. Décision d'affichage **centralisée dans une fonction pure** `(message, currentUser, subscription.roles, permissions, settings)` : le délai d'édition vient des **settings** (`Message_AllowEditing_BlockEditInMinutes`), pas des permissions. Feuille d'actions via `presentation: 'formSheet'` (natif). Fait le : `____`
- [ ] **8.3 — Threads et discussions** · `@claude` · `[code]` — `tmid`, `tcount`, `tlm`. Fait le : `____`
- [ ] **8.4 — Présence** · `@claude` · `[code]` — `users.presence?from=` et `stream-user-presence`, avec **dégradation gracieuse** : `Presence_broadcast_disabled` s'active seul au-delà d'environ 200 connexions. L'UI ne doit jamais en dépendre. Fait le : `____`
- [ ] **8.5 — Recherche** · `@claude` · `[code]` — `chat.search`. Fait le : `____`
- [ ] **8.6 — Indicateur de saisie** · `@claude` · `[code]` — `stream-notify-room/<rid>/user-activity`. **Pas `/typing`, qui est déprécié.** Fait le : `____`
- [ ] **8.7 — Brouillons** · `@claude` · `[code]` — MMKV, par `rid` et par `tmid`. Fait le : `____`
- [ ] **8.8 — Suite E2E** · `@claude` · `[code]` — Maestro : login, 2FA, envoi, reconnexion, upload. Fait le : `____`

---

## Étape 9 — iOS

> Hors chemin critique. Réf. `ROADMAP.md` §5 phase 7. Prérequis `@guillaume` : un Mac, un compte Apple Developer (99 $/an).

- [ ] **9.1 — `prebuild` iOS** depuis les mêmes config plugins · `@duo` · `[infra]`
- [ ] **9.2 — Push APNs** avec Notification Service Extension · `@claude` · `[code]`
- [ ] **9.3 — Keychain access groups** · `@claude` · `[code]`

---

*Créé le 2026-07-09. `ROADMAP.md` fixe les décisions ; ce document suit leur exécution.*
