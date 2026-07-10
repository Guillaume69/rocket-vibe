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
| 3 | Transport et données | ✅ 2026-07-10 (3.6 partiel) |
| 4 | Première tranche verticale | ✅ 2026-07-10 (gate téléphone physique en attente) |
| 5 | Résilience et rattrapage | ✅ 2026-07-10 |
| 6 | Push intégré | ✅ 2026-07-10 |
| 7 | Upload | ✅ 2026-07-10 |
| 8 | Offline-first et finitions | ✅ 2026-07-10 |
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

- [x] **3.1 — Client REST typé** · `@claude` · `[code]`
  `lib/rest.ts` : `ClientRest`, en-têtes d'auth et 2FA, erreurs typées (`ErreurRest`, `ErreurDeuxFacteurs`), rejeu sur `429` honorant `x-ratelimit-reset`. Aucune dépendance HTTP tierce, et **aucun import de `react-native`** : le module tourne sous Node, donc ses tests s'exécutent contre de vrais serveurs HTTP. `lib/server.ts` et `lib/pushToken.ts` reposent désormais dessus.
  **Critère de sortie** : `npm test` vert, `npx tsc --noEmit` vert, et login + 2FA réels contre le serveur Docker.
  Fait le : **2026-07-10** — 15 tests verts ; contre le vrai serveur : login, GET authentifié, `ErreurDeuxFacteurs` puis rejeu avec le SHA-256 du mot de passe.

- [x] **3.2 — Authentification et 2FA** · `@claude` · `[code]`
  `lib/auth.ts` (pur, hachage injecté) + `lib/sessionStore.ts` (`expo-secure-store`, une session par host).
  **Deux formes de 2FA découvertes contre le serveur réel** : `/api/v1/login` renvoie `error: 'totp-required'` **sans** `errorType`, alors que `/api/v1/settings/*` renvoie `errorType`. Ne tester qu'`errorType` laissait la 2FA du login passer pour une erreur ordinaire.
  **`POST /api/v1/logout` répond 200 avec un corps VIDE** : `ClientRest` le traite comme un succès.
  **Incertitude n°1 levée** : la 2FA passe par les en-têtes `x-2fa-code` / `x-2fa-method`, jamais par le corps.
  **Critère de sortie** : `npm test` vert, et contre le serveur Docker : login, `resume`, `/me`, logout, puis 2FA réelle déclenchée (méthode `email`).
  Fait le : **2026-07-10** — 29 tests verts ; intégration complète, `sendEmailCode` accepté.

- [x] **3.3 — Mini-client DDP** · `@claude` · `[code]`
  `lib/ddp.ts` : écoute seule. `connect` → `method login {resume}` → `sub` / `unsub` → routage `changed` / `ready` / `nosub` / `ping`. **Pas de `call`** : les appels de méthodes DDP sont dépréciés (8.0), retrait en 9.0. `WebSocket` injecté, donc testable sous Node.
  Souscriptions **dédupliquées par `(nom, clé)` avec compteur de références**, y compris pour les `sub` en vol du même tick — sinon le serveur duplique chaque événement. Les souscriptions désirées survivent à la chute de la socket, pour que 5.1 les rejoue.
  **Critère de sortie** : `npm test` vert, et contre le serveur Docker : login DDP par jeton REST, souscription, message REST reçu en temps réel, `nosub` sur salon inconnu.
  Fait le : **2026-07-10** — 48 tests verts ; intégration : aucun doublon sur deux souscriptions concurrentes, reconnexion après login refusé.

- [x] **3.4 — Schéma local** · `@claude` · `[code]`
  Drizzle + `expo-sqlite`, **`enableChangeListener: true`**, WAL. Tables `salons`, `abonnements`, `messages` (index `(rid, horodatage)` et `fil_id`), `sortie`, `etat_synchro` (clé composite). **Une base par host** (`db/nomFichier.ts`). Migrations générées par `drizzle-kit`, appliquées avant le premier rendu.
  **Critère de sortie** : les migrations s'appliquent, `useLiveQuery` réagit à une écriture.
  Fait le : **2026-07-10** — vérifié **sur l'appareil** via `sqlite3` : `journal_mode = wal`, 1 migration enregistrée, les 4 index présents, et `EXPLAIN QUERY PLAN` confirme `SEARCH messages USING INDEX idx_messages_salon_date`. Les compteurs de l'écran debug se rafraîchissent sans rechargement.

- [x] **3.5 — Moteur de synchro** · `@claude` · `[code]`
  `lib/normaliser.ts` (traduction pure des charges Rocket.Chat), `lib/sync.ts` (routage DDP + ingestion REST, derrière une interface `Depot`), `db/upserts.ts` (le SQL **et** les constructeurs de paramètres, une seule source), `db/depot.ts` (implémentation `expo-sqlite`).
  Deux invariants dans le SQL : `ON CONFLICT DO UPDATE` (pas de doublon) et `WHERE excluded.mis_a_jour_le >= …` (**un événement plus ancien n'écrase pas un état plus récent** — un rattrapage REST en retard ne ressuscite pas un message édité, ni des non-lus déjà remis à zéro).
  **Critère de sortie** : rejouer deux fois le même événement ne crée pas de doublon.
  Fait le : **2026-07-10** — 89 tests verts ; bout en bout contre le serveur Docker : ingestion REST (14 messages), rejeu → toujours 14, message temps réel écrit en base avec son `md`, suppression propagée, `ignores: 0`.

- [x] **3.6 — Écran debug** · `@claude` · `[code]` — *première moitié*
  `app/debug.tsx` : compteurs de lignes en base, insertion et purge. Il **ne sera pas jeté** : c'est l'instrument de mesure du test de torture de 5.5. Les compteurs passent par `count(*)`, pas par `select *`.
  **Reste à ajouter** (après 3.5) : souscriptions actives, RTT du ping/pong, doublons détectés, trous de synchro.
  Fait le : **2026-07-10** — partiel.

---

## Étape 4 — Première tranche verticale

> Objectif : **l'APK devient utile au quotidien**.
> Réf. `ROADMAP.md` §5 phase 2, §6.3, §6.4.

- [x] **4.0 — Écran de connexion** · `@claude` · `[code]` — *manquait à la checklist*
  L'étape 3.2 a livré la **bibliothèque** d'authentification, pas son écran. Rien dans 4.1 ne peut charger des salons sans session. Écran : saisie serveur (réutilise `sonderServeur`), identifiant, mot de passe ; interception de `ErreurDeuxFacteurs` et UI selon `erreur.methode` (`totp` → code à 6 chiffres, `email` → bouton « envoyer le code » puis saisie, `password` → ressaisie du mot de passe, haché en SHA-256) ; session dans `expo-secure-store`, reprise au démarrage par `reprendreSession`.
  **Critère de sortie** : sur l'AVD, se connecter comme `alice`, tuer l'app, la relancer → toujours connecté. Puis activer un TOTP sur le compte et refaire le tour.
  Vérifié sur l'AVD : alice → `am force-stop` → relance → toujours `@alice` ; TOTP activé sur `bob` via `method.call/2fa:enable`, tour complet (défi TOTP affiché, code accepté, session survit au kill), puis TOTP désactivé. La reprise au démarrage est optimiste : seul un 401 déconnecte, pas une panne réseau.
  Fait le : `2026-07-10`

- [x] **4.1 — Liste des salons** · `@claude` · `[code]` — `subscriptions.get` + `rooms.get` fusionnés par `rid` ; souscriptions `stream-notify-user/<uid>/subscriptions-changed` et `/rooms-changed` ; `fname`, aperçu `lastMessage`, badge `unread`, tri par activité. **Si `room.encrypted` : cadenas, et aperçu `lastMessage` masqué** — il contient du ciphertext.
  Vérifié sur l'AVD : message posté via REST → aperçu mis à jour en direct ; salon `encrypted` créé via REST → apparu avec cadenas et sans aperçu ; `subscriptions.read` via REST → badge éteint en direct (écriture `abonnements` seule — le `useLiveQuery` de drizzle n'écoute que la table du FROM, d'où deux requêtes vives fusionnées en JS). Base **par serveur et par compte** depuis cette étape. Fait le : `2026-07-10`
- [x] **4.2 — Écran salon** · `@claude` · `[code]` — historique via `channels.history` / `groups.history` / `im.history` selon `t` ; `@shopify/flash-list` **`inverted`** + `maintainVisibleContentPosition` ; pagination keyset `WHERE rid = ? ORDER BY ts DESC` ; `sub` à l'ouverture, **`unsub` à la fermeture** ; **débounce des entrants** (des insertions en tête à moins de ~200 ms font sauter le scroll).
  **Écart mesuré à la spec** : pas de prop `inverted` — en FlashList 2.3.2 elle n'est que de la compatibilité, sa détection « proche du bas » travaille en coordonnées brutes (autoscroll et ouverture visaient le mauvais bout, constaté sur l'AVD). L'idiome v2 équivalent : données croissantes + `startRenderingFromBottom` + `autoscrollToBottomThreshold` + `onStartReached`. Vérifié sur l'AVD : ouverture en bas, rafale de 8 messages à 150 ms sans saut, arrivée en direct suivie, position tenue quand on lit le passé. Fait le : `2026-07-10`
- [x] **4.3 — Rendu markdown** · `@claude` · `[code]` — `@rocket.chat/message-parser` sur `msg.md`, rendu en `<Text>` imbriqués. **Repli sur `parse()` obligatoire** : `md` est absent des vieux messages. Sous-chantier à part entière, ne pas le sous-estimer.
  Vérifié sur l'AVD : titre, gras/italique/barré, code inline et bloc, citation, listes, lien, mentions — rendus depuis le `md` serveur ; le repli `parse()` et la résistance aux `md` empoisonnés sont prouvés par les tests Node (garde de forme + garde-fou de rendu par message : un message corrompu ne coûte jamais l'écran). Fait le : `2026-07-10`
- [x] **4.4 — Messages système** · `@claude` · `[code]` — `t = uj / ul / rm / r / ...`, table de traduction. Vérifié sur l'AVD avec de vrais événements (kick, invite, setTopic via REST) : « a retiré bob du salon », « a ajouté bob au salon », « a changé le sujet : … », arrivés en direct. Type inconnu → phrase générique, jamais rien. Fait le : `2026-07-10`
- [x] **4.6 — Dégradation des salons chiffrés** · `@claude` · `[code]` — le serveur cible a `E2E_Enable = true` et **un salon chiffré** (`p:laprivitude`). Les messages `t === 'e2e'` deviennent « 🔒 Message chiffré, non pris en charge », jamais le blob base64 ; le composer est désactivé avec l'explication, puisque le serveur rejette un message en clair (`error-not-allowed`, `E2E_Allow_Unencrypted_Messages = false`). Voir `ROADMAP.md` §6.6.
  Vérifié sur l'AVD avec un message `t: e2e` injecté (blob base64 simulé) dans `test-chiffre` (`encrypted: true`) : le blob n'apparaît nulle part — ni liste (« Messages chiffrés »), ni salon (« 🔒 … non pris en charge ») — et le composer est remplacé par l'explication. Le blob n'atteint même pas la base (testé unitairement dès 3.5). Fait le : `2026-07-10`
- [x] **4.5 — Outbox et optimistic UI** · `@claude` · `[code]` — `_id` 24-hex généré **avant** l'affichage → insert `pending` → `chat.sendMessage` → réconciliation au retour du même `_id`. Retry au retour du réseau, statut `failed` actionnable.
  **Critère de sortie** : tuer l'app avec un message `pending`, la relancer → le message part **sans doublon** (le serveur déduplique sur `_id`).
  Vérifié sur l'AVD : réseau coupé (`adb reverse --remove`) → message « ⏳ envoi… » → `am force-stop` → réseau rétabli → relance → **1 occurrence serveur**, y compris après un second rejeu, file vide. Découverte importante : le rejeu d'un `_id` accepté répond **400**, pas un succès idempotent (consigné dans `CLAUDE.md`) — d'où la confirmation `chat.getMessage` et la réconciliation par toute copie d'origine serveur. Fait le : `2026-07-10`

**Sortie d'étape** : je me connecte (2FA comprise), je vois mes salons, je lis, je reçois en direct, j'envoie. Sur l'AVD **et** sur un appareil physique.

---

## Étape 5 — Résilience et rattrapage

> Réf. `ROADMAP.md` §5 phase 3, §6.2.

- [x] **5.1 — Reconnexion** · `@claude` · `[code]` — backoff exponentiel avec gigue (1 s → 30 s). À **chaque nouvelle socket** : reconnexion, re-login, **re-souscription de tous les streams**. Une souscription ne survit jamais à une reconnexion.
  Le premier raccordement passe par le même pilote que les reconnexions ; `connecter()` rejoue toutes les souscriptions désirées ; le rechargement REST et le flush de la file d'envoi suivent chaque nouvelle socket. Vérifié sur l'AVD : socket coupée 12 s (`adb reverse --remove`), rétablie → un message posté ensuite arrive **en direct**, sans toucher l'app. Backoff, gigue, relance-pendant-vol et nettoyage du timeout de négociation testés sous Node (138 tests). Fait le : `2026-07-10`
- [x] **5.2 — Rattrapage** · `@claude` · `[code]` — piloté par `SyncState`, sur `AppState 'active'` et à la reconnexion. **`chat.syncMessages` traite un salon à la fois et le REST est rate-limité** : ne pas boucler sur tous les salons. Un `subscriptions.get?updatedSince=` + `rooms.get?updatedSince=` pour le gros, `syncMessages` **seulement** sur les salons ouverts ou récemment actifs.
  Curseurs = plus grand `_updatedAt` **ingéré** (jamais l'horloge locale), qui ne régressent pas ; `syncMessages` sur le seul salon actif ; `remove[]` traités avec la vraie projection serveur (`_id` d'abonnement → colonne `sub_id`, migration 0001) ; sonde de vie DDP au retour au premier plan (socket à moitié morte détectée et reconnectée). Vérifié sur l'AVD : message posté PENDANT une coupure de socket, salon ouvert → présent après reconnexion, via `chat.syncMessages`. Fait le : `2026-07-10`
- [x] **5.3 — Multi-serveurs** · `@claude` · `[code]` — registre `Server`, tokens **et** base SQLite isolés par host.
  Registre « serveurs connus » (SecureStore ne sait pas énumérer ses clés), bascule sans déconnexion depuis l'accueil, validation en arrière-plan après bascule (seul un 401 déconnecte). Vérifié sur l'AVD avec deux hôtes (`localhost:3000` = alice, `127.0.0.1:3000` = bob) : sessions préservées à travers les bascules dans les deux sens, bases isolées (bob ne voit que ses salons), bascule instantanée par le registre. Fait le : `2026-07-10`
- [x] **5.4 — Démarrer une conversation** · `@claude` · `[code]` — `GET /api/v1/spotlight?query=`, puis `POST /api/v1/im.create` ou `POST /api/v1/channels.join`. Sans cela l'app ne fait que lister l'existant.
  Vérifié sur l'AVD : alice a rejoint `#general` (dont elle n'était pas membre — le « a rejoint le salon » est arrivé en direct), puis créé le DM alice↔bob et envoyé le premier message, confirmé côté bob (`im.list`). Salons ingérés depuis la réponse du serveur : la navigation n'attend pas le stream. Fait le : `2026-07-10`
- [x] **5.5 — Test de torture** · `@claude` · `[code]` — couper le Wi-Fi 30 s dix fois, basculer arrière-plan/premier-plan vingt fois, envoyer cinquante messages rapides.
  **Critère de sortie** : état local == état serveur. **Zéro doublon, zéro message manquant, zéro souscription fantôme**, mesuré sur l'écran debug de 3.6.
  Exécuté sur l'AVD : 10 coupures de 30 s (`adb reverse --remove`), 20 cycles HOME/retour, 50 messages à 100 ms d'écart. Résultat : 50/50 en local, 50 textes distincts, zéro doublon d'`_id` sur toute la table, file d'envoi vide, `ignorés: 0`, souscriptions établies == désirées == 2 (les streams utilisateur — l'écran salon fermé a relâché les siens). Note : le rate limiter REST du serveur de test a dû être suspendu pendant la rafale (10/50 passaient sinon — c'est le serveur qui limitait, le client était cohérent : local == serveur == 10). L'écran debug affiche désormais les compteurs du moteur et l'état DDP. Fait le : `2026-07-10`

---

## Étape 6 — Push intégré

> Dépend du verdict de l'étape 2. Réf. `ROADMAP.md` §5 phase 4.

- [x] **6.1 — Cycle de vie du token** · `@claude` · `[code]` — enregistrement à la connexion, dé-enregistrement au logout.
  Vérifié dans MongoDB (`_raix_push_app_tokens`) : raccordement → 1 jeton `gcm` (appName `rocket-vibe`, userId d'alice) ; « Se déconnecter » → 0 jeton (dé-enregistré AVANT le logout, l'appel exige l'authentification ; best-effort, 404 = succès) ; re-login → 1 jeton. Fait le : `2026-07-10`
- [x] **6.2 — Cycle de vie du socket** · `@claude` · `[code]` — fermeture propre sur `AppState 'background'`, réouverture et resynchronisation sur `'active'`.
  Vérifié par la présence serveur : alice `online` au premier plan → `offline` 5 s après le passage en fond (socket fermée volontairement — donc le push partira : RC ne notifie que les hors-ligne) → `online` au retour (reconnexion + re-souscriptions + rattrapage via le pilote de 5.1/5.2). Fait le : `2026-07-10`
- [x] **6.3 — Deep link** · `@claude` · `[code]` — handler de notification → route `expo-router` vers le salon ; badge cohérent avec `subscription.unread` ; canaux de notification Android. **`Push_show_message = true` sur le serveur cible** : une notification venant du salon chiffré transporte du ciphertext → la remplacer par un texte générique.
  Vérifié sur l'AVD, chaîne complète : app en fond (socket fermée → alice offline) → DM de bob → notification sur le canal `default` (meta-data `default_notification_channel_id` posée par le config plugin — fini le `fcm_fallback_notification_channel` du défaut 2.x) → **tap → ouverture directe du salon** (`data.ejson.rid`), y compris à froid (`getLastNotificationResponseAsync`). Badge = somme des non-lus (`setBadgeCountAsync`). Chiffré : substitution par un texte générique quand C'EST L'APP qui affiche ; app tuée, c'est le système qui affiche la charge serveur telle quelle — la vraie parade est `Push_show_message=false` côté serveur, hors de notre main (décision à l'exploitation). Fait le : `2026-07-10`

---

## Étape 7 — Upload

> Réf. `ROADMAP.md` §5 phase 5. **`rooms.upload` a été supprimé en 8.0.0**, pas déprécié.

- [x] **7.1 — Flux en deux temps** · `@claude` · `[code]` — `POST /api/v1/rooms.media/:rid` puis `POST /api/v1/rooms.mediaConfirm/:rid/:fileId`. **`rooms.media` seul ne poste aucun message** : oublier le `mediaConfirm` laisse un fichier orphelin. **Lève l'incertitude n°7** (schéma de réponse de `mediaConfirm`).
  Incertitude levée contre le serveur réel : `media` → `{file:{_id,url}}` ; `mediaConfirm` → `{message}` complet (`attachments[]` avec `title_link`/`image_url`/`image_preview`/`fileId`, `file`, `md`) — il repasse tel quel par l'ingestion. Un upload réel a posté un message dans `test-public`. `lib/upload.ts` : flux pur (transport injecté), refus de `media` = erreur claire SANS confirm, corps du confirm vide sans légende (`additionalProperties: false`) ; `urlFichierProtege` (7.4) posée au passage. Fait le : `2026-07-10`
- [x] **7.2 — Transport** · `@claude` · `[code]` — `expo-file-system/legacy` `createUploadTask` en `MULTIPART`, `fieldName: 'file'`, progression via `totalBytesSent`. Intégré à l'`Outbox` par la table `Upload`.
  Table `televersements` (migration 0002) : l'intention (uri locale, nom, type, légende) est persistée AVANT l'envoi, rejouée à chaque raccordement ; un rejet d'`uploadAsync` (aucune réponse HTTP) vaut statut 0 → la ligne reste en-attente ; un fichier de cache purgé (kill entre sélection et rejeu) est un échec franc, affiché dans le salon avec réessayer/abandonner. Vérifié sur l'AVD : image envoyée via le picker → fichier côté serveur, affichée dans l'app. Fait le : `2026-07-10`
- [x] **7.3 — Sélection et validation** · `@claude` · `[code]` — `expo-document-picker`, `expo-image-picker`, compression `expo-image-manipulator`. Valider `FileUpload_MaxFileSize` et `FileUpload_MediaTypeWhiteList` (lus dans `settings.public`) **avant** l'upload.
  Bouton 📎 → document-picker (couvre les images ; image-picker installé pour la suite) ; photos > 500 Ko recompressées en JPEG 1920 px (GIF épargnés). **Découverte de revue vérifiée serveur : le paramètre `query` de `settings.public` a été SUPPRIMÉ en 7.0** — la lecture passe par `count=0` + filtre client, sinon la validation est un no-op silencieux. Le repli permissif hors-ligne n'est jamais mémoïsé. Fait le : `2026-07-10`
- [x] **7.4 — Lecture protégée** · `@claude` · `[code]` — si `FileUpload_ProtectFiles`, ajouter `rc_uid` / `rc_token` en query sur `/file-upload/:id/:name`.
  `urlFichierProtege` (testée) appliquée au rendu des pièces jointes : images affichées avec dimensions bornées, autres fichiers en lien. Vérifié sur l'AVD : l'image téléversée s'affiche dans le salon. Fait le : `2026-07-10`
- [x] **7.5 — Messages vocaux** · `@claude` · `[code]` — `expo-audio`, `.m4a` AAC, `mimeType: audio/mp4`.
  🎤 dans le composer (quand le brouillon est vide) → permission → enregistrement (préréglage HIGH_QUALITY, `.m4a`) → ⏺ stop → envoi par le MÊME pipeline fichiers (persisté, validé, rejoué). Vérifié sur l'AVD : `recording-….m4a | audio/mp4` reçu côté serveur. Les vocaux reçus s'affichent en lien 🎵 (lecture in-app plus tard). Fait le : `2026-07-10`

---

## Étape 8 — Offline-first et finitions

> Réf. `ROADMAP.md` §5 phase 6.

- [x] **8.1 — Non-lus** · `@claude` · `[code]` — `subscriptions.read`, barre « nouveaux messages » via `ls`.
  Marquage lu à l'ouverture et à chaque entrant écran ouvert (débouncé 1,5 s — REST rate-limité) ; la barre se place sur un INSTANTANÉ de `ls` pris au montage (sinon le `read` l'efface avant qu'on la voie), avant le premier message d'AUTRUI postérieur. Vérifié sur l'AVD : 2 messages posés écran fermé → à la réouverture, barre exactement au bon endroit ; `ls` n'existait pas avant le premier `read` de notre app (barre absente à la première ouverture — attendu). Fait le : `2026-07-10`
- [x] **8.2 — Actions message** · `@claude` · `[code]` — `chat.update`, `chat.delete`, `chat.react`, `chat.pinMessage`. Décision d'affichage **centralisée dans une fonction pure** `(message, currentUser, subscription.roles, permissions, settings)` : le délai d'édition vient des **settings** (`Message_AllowEditing_BlockEditInMinutes`), pas des permissions. Feuille d'actions via `presentation: 'formSheet'` (natif).
  Prouvé sur l'AVD contre le serveur réel : appui long → formSheet ; message d'autrui = réagir + épingler seulement, le mien = tout ; `chat.react` (**le serveur refuse l'unicode brut, il veut le shortname `:+1:`**), `chat.update` (`editedBy` serveur + « (modifié) » en direct), `chat.pinMessage` (refus `not-authorized` affiché proprement puis succès une fois owner), `chat.delete` (parti du serveur et de l'écran). Trouvé en route : **FlashList montée à vide** traite le premier lot comme des insertions au-dessus de l'ancre `maintainVisibleContentPosition` → viewport sous tout le contenu, écran blanc au cold start ; la liste ne monte plus que peuplée. Revue (8 angles) : **la file d'écritures appartient à la connexion, pas au dépôt** — `transaction(fn)` passe désormais l'écrivain direct à `fn` (réentrance impossible par construction) et les dépôts envoi/téléversements partagent la même file, sinon leurs écritures rejoignaient un `BEGIN` ouvert et un rollback de lot les emportait ; `presentation: 'formSheet'` déclarée dans `_layout.tsx` (posée depuis l'écran, elle arrive après la création native) ; pas d'actions sur les lignes d'outbox (`_id` jamais accepté par le serveur) ; hors ligne, repli permissif non mémoïsé au lieu d'une feuille vide à jamais ; cache des règles par `baseUrl` (un global survivait au changement de serveur) ; garde anti double-tap en ref (l'état React d'un rendu passé laissait passer le doublon) ; permissions RC réelles (`bypass-time-limit-edit-and-delete`, `edit-message` — `force-edit-messages` n'existe pas) ; appui long transmis aux pièces jointes (un toucher né sur un enfant Pressable ne remonte pas) ; `accessible={false}` sur la ligne (TalkBack retrouvait UN nœud fusionné). Écarté, consigné : consolidation des trois lecteurs `settings.public` (reportée, touche des chemins testés de 7.x) ; affichage des réactions reçues (hors critère) ; lint `set-state-in-effect` dans `ui/synchro.tsx` (antérieur au diff). Fait le : `2026-07-10`
- [x] **8.3 — Threads et discussions** · `@claude` · `[code]` — `tmid`, `tcount`, `tlm`.
  Colonnes `fil_dernier` (tlm) et `fil_affiche` (tshow), migration 0003. Le flux principal filtre les réponses de fil (`fil_id IS NULL OR fil_affiche`) ; la racine porte « 💬 N réponses · HH:MM » → écran `fil/[id]` (racine + réponses, composer avec `tmid`, mêmes drapeaux chiffré/lecture seule que le salon). `LigneMessage` extraite en composant partagé (`ui/ligneMessage.tsx`). **Vérifié contre 8.5 : le défaut de `channels.history` est DÉJÀ `showThreadMessages=false`** — rendu explicite pour verrouiller l'accord serveur/filtre local, sans quoi une page entière de réponses masquées ferait boucler la pagination keyset. `chat.getThreadMessages` ne renvoie JAMAIS la racine (récupérée par `chat.getMessage`, indispensable au lien direct à froid) et son `count=0` dépend d'`API_Allow_Infinite_Count` → pagination défensive par pages de 100. Revue : échec d'une réponse de fil visible depuis le salon (bandeau — la ligne est filtrée du flux) ; autoscroll près du bas + défilement à l'envoi ; test aller-retour des nouvelles colonnes à valeurs non par défaut (garde contre l'interversion de paramètres voisins). Prouvé sur l'AVD : réponse de bob masquée du flux + compteur, écran fil complet, réponse d'alice depuis l'app (`tmid` serveur, id client 24-hex, tcount 2→4, tlm à jour), réponse `tshow` visible dans le flux ET le fil. Écarté, consigné : les réponses `tshow` ingérées avant 8.3 restent masquées jusqu'au prochain passage d'historique (rétro-remplissage à 0 — aucune installation en production) ; non-lus de fil (`tunread`) hors périmètre. Fait le : `2026-07-10`
- [x] **8.4 — Présence** · `@claude` · `[code]` — `users.presence?from=` et `stream-user-presence`, avec **dégradation gracieuse** : `Presence_broadcast_disabled` s'active seul au-delà d'environ 200 connexions. L'UI ne doit jamais en dépendre.
  `MoteurPresence` VOLATIL (jamais persisté — une présence périmée est pire que rien), hook `usePresence` (useSyncExternalStore, identités stables, pas d'abonnement hors DM), pastille colorée sur les DM. **Deux écarts au plan, consignés.** (1) Le stream : l'abonnement 8.5 à `stream-user-presence` passe par un protocole propriétaire (`{added:[uid]}` sur une publication « main » par connexion — relevé dans le bundle serveur après qu'une sonde a montré `ready` sans jamais rien recevoir) ; la MÊME présence est diffusée sur `stream-notify-logged`/`user-status` (`[[uid, username, n° statut, texte]]`, 0=offline 1=online 2=away 3=busy), qui s'abonne comme tout stream et se rejoue à la reconnexion. (2) Pas de curseur `?from=` : il s'ancrerait sur l'HORLOGE LOCALE (interdit par la règle des curseurs) et la réponse ne porte aucun `_updatedAt` ; photo complète à chaque raccordement, coût borné (non-offline seulement). Revue : la photo REST ne régresse jamais un statut plus frais du stream (garde de séquence par uid) ; un uid connu absent de la photo passe `offline` (la photo n'inclut que les non-offline) ; chargements sérialisés. **Le rid d'un DM 8.5 est un ObjectId aléatoire, PAS la concaténation des uids** : l'autre participant vient de `uids` du document Rooms (`uids` et `usernames` ne sont pas alignés entre eux) → colonne `salons.dm_autre_uid`, migration 0004 avec rétro-remplissage par invalidation du curseur `*/salons`. Prouvé sur l'AVD, mesuré au pixel : pastille `#f5455c` (busy) sur la ligne bob pendant sa session DDP, `#9ea2a8` (offline) à sa fermeture — en direct, sans action locale. Fait le : `2026-07-10`
- [x] **8.5 — Recherche** · `@claude` · `[code]` — `chat.search`.
  Écran « Rechercher dans le salon » (🔍 dans l'en-tête du salon) : `chat.search?roomId=&searchText=` débouncé avec garde de séquence (même idiome que le spotlight 5.4), résultats ÉPHÉMÈRES — normalisés par `versMessage`, rendus par la `LigneMessage` partagée, jamais écrits en base. Pas d'actions sur un résultat (la feuille lit la base par id, un résultat ancien n'y est pas forcément) ni de saut vers le message dans l'historique — consignés. Revue : indicateur « recherche » dès la frappe (sinon faux « aucun message » pendant le débounce), erreur nettoyée au vidage du champ, portier `deconnecte` → connexion comme les autres écrans. Prouvé sur l'AVD : « torture2 » → résultats immédiats, charabia → « Aucun message trouvé », « vocal » → vide à raison (le nom d'un fichier vit dans les pièces jointes, hors plein-texte). Fait le : `2026-07-10`
- [x] **8.6 — Indicateur de saisie** · `@claude` · `[code]` — `stream-notify-room/<rid>/user-activity`. **Pas `/typing`, qui est déprécié.**
  ÉCOUTE seule : « bob écrit… » au-dessus du composer, dans une hauteur RÉSERVÉE (l'apparition ne redimensionne pas la liste). Format sondé sur 8.5 : `args = [username, ['user-typing'] | [], extra]`. `MoteurSaisie` volatil par écran, chaque entrée EXPIRE seule (15 s — l'événement « stop » d'un correspondant qui perd le réseau ne viendra jamais) ; notification sur changement réel uniquement (RC ré-émet en battement de cœur pendant la frappe — chaque battement re-rendrait l'écran). **Écart consigné : on n'ÉMET pas notre saisie** — l'émission cliente passe par la method DDP du streamer (`allowWrite` de `stream-notify-room`, relevé dans le bundle) sans AUCUN équivalent REST, et notre client DDP est volontairement sans `call` ; à réévaluer si la parité l'exige. Revue : `user-activity` n'incrémente plus le compteur d'anomalies du moteur de synchro. Prouvé sur l'AVD, mesuré : 555 px de texte « bob écrit… » pendant sa frappe (simulée par sonde DDP), 0 après son arrêt. Fait le : `2026-07-10`
- [x] **8.7 — Brouillons** · `@claude` · `[code]` — MMKV, par `rid` et par `tmid`.
  **Écart au plan consigné : SQLite (table `brouillons`, migration 0005), pas MMKV.** Le brouillon s'écrit DÉBOUNCÉ (400 ms) — la latence asynchrone de la base est sans objet — et une dépendance NATIVE de plus (donc un rebuild) ne se justifie pas contre ROADMAP §4.2 quand la base couvre déjà tout l'état local ; par (serveur, compte), les brouillons ne fuient pas d'un compte à l'autre. Clés `rid` (salon) et `rid:tmid` (fil). Le composer ne MONTE qu'une fois le brouillon lu, semé par `useState(initial)` et rejeté par `key` au changement de salon — ni restauration après coup, ni fuite d'un salon vers l'autre ; flush du débounce au départ de l'écran. Revue : refs du flush remises à zéro (le cleanup court aussi au changement de clé — le texte de l'ancienne clé aurait pu rejouer sous la nouvelle) ; l'envoi d'un fichier n'efface plus le texte tapé PENDANT l'upload (comparaison fonctionnelle). Au passage : les trois écritures `setState`-dans-effet signalées par la nouvelle règle React sont restructurées (remise à zéro pendant le rendu, état dérivé dans la recherche). Prouvé sur l'AVD : brouillon tapé → kill de l'app → relance → texte restauré dans le champ ; brouillon de fil et brouillon de salon indépendants (aller-retour, chacun retrouve le sien). Fait le : `2026-07-10`
- [x] **8.8 — Suite E2E** · `@claude` · `[code]` — Maestro : login, 2FA, envoi, reconnexion, upload.
  `e2e/lancer.sh` (bash, `set -euo pipefail`, épinglé sur `ANDROID_SERIAL=emulator-5554` — un téléphone personnel branché ne doit jamais recevoir la suite) orchestre 5 flows YAML + harnais node : 01 connexion depuis un état VIERGE (clearState → launcher du dev-client → reprise Metro, champ serveur PRÉ-REMPLI donc effacé d'abord) ; 02 envoi ; 03 reconnexion (coupure RÉELLE : `adb reverse --remove`, bob poste pendant, rétablissement sous trap) ; 04 upload par le picker SYSTÈME (PNG généré, poussé dans Téléchargements ; légende AVANT le 📎) ; 05 2FA TOTP (activée/désactivée par harnais DDP — seul endroit du dépôt autorisé à faire du `method`, il simule l'app officielle de bob ; TOTP RFC 6238 en node:crypto pur). **Les asserts Maestro ne suffisent pas** : le rendu OPTIMISTE satisfait le 02, la légende encore dans le composer satisfait le 04 — `verifier-serveur.mjs` tranche par REST (message présent, fichier joint). Pièges tués en route : `hideKeyboard` = parfois BACK (éjecte de l'écran, voire de l'app) ; le brouillon 8.7 restauré pollue le champ (eraseText systématique) ; RC refuse la RÉUTILISATION d'un code TOTP (essais multi-fenêtres) et `/login` met le code d'erreur dans `error`, pas `errorType` ; `console.log` + `process.exit` tronque un tube (le secret se perdait) ; secret 2FA persisté dans /tmp pour le nettoyage d'un run interrompu ; `launchApp` sans `stopApp:false` recharge tout le bundle dev et retombe parfois sur le launcher. `accessibilityLabel` posés sur 📎/🎤 (nécessaires à Maestro, dus à TalkBack de toute façon). Preuve : suite complète VERTE, exit 0, deux vérités serveur imprimées, 2FA nettoyée. Installation Maestro par la release GitHub officielle (documentée en tête du script). Fait le : `2026-07-10`
- [x] **8.9 — Clavier par-dessus le composer** · `@claude` · `[code]` — premier retour d'essai du Pixel : le clavier s'ouvrait PAR-DESSUS le champ de saisie. Cause : l'edge-to-edge (imposé par Android 15+, donc par le SDK 57) neutralise `adjustResize` — le manifeste l'a, la fenêtre ne se redimensionne plus.
  Correctif calqué sur **duogo** (référence pointée par @guillaume) : `react-native-keyboard-controller` + `reanimated` — `KeyboardProvider` à la racine, `VueEvitantLeClavier` (`ui/clavier.tsx`) qui anime `paddingBottom = max(inset bas, hauteur clavier)` depuis la SharedValue frame-par-frame (`useReanimatedKeyboardAnimation`), en remplacement de `SafeAreaView edges=['bottom']` sur les 5 écrans à saisie (salon, fil, connexion, recherches). Piste « RN core sans dépendance » écartée APRÈS mesure à la sonde : `keyboardDidShow` rapporte `imeInsets.bottom − barInsets.bottom` (820 px annoncés pour 883 réels → composer aux deux tiers caché, vérifié dans la source de `ReactRootView`), et l'événement est unique et tardif — pas de suivi. duogo avait aussi écarté le `KeyboardAvoidingView` de la lib (« automaticOffset ratait par moments »). Revue (8 angles) : le composant porte lui-même `flex: 1` + fond (triplet de style dupliqué aux 5 appels supprimé) ; renvoi de convention posé sur les `SafeAreaView` restants (index, debug) ; **réfutés en exécutant** : le formSheet d'édition gère son clavier nativement (champ + « Enregistrer » visibles au-dessus du clavier plein), et le listener d'insets de keyboard-controller survit au cycle de la feuille ; **consignés** : relayout par frame pendant l'animation (coût assumé du pattern duogo — à surveiller sur le Pixel, FlashList non inversée), champs de connexion en moitié haute (le padding rend de toute façon le contenu défilable au-dessus du clavier). Preuve sur AVD (`hw.keyboard=no` le temps du test, restauré ensuite) : composer posé PILE sur le clavier plein, aller-retour ouvert/fermé propre, envoi clavier ouvert OK ; **suite E2E complète VERTE, exit 0** après le rebuild (3 modules natifs ajoutés). Fait le : `2026-07-10`
- [x] **8.10 — Liste inversée : le chat s'imbrique au clavier en natif** · `@claude` · `[code]` — second retour du Pixel : malgré 8.9, liste, composer et clavier restaient « un peu décorrélés » — FlashList recalculait sa fenêtre en JS à chaque frame de l'animation (mVCP + autoscroll = recalage après coup), diagnostic de @guillaume confirmé.
  Port de l'idiome **duogo** (`chat/[id].tsx`, pointé comme référence) : `inverted` — le plus récent en `data[0]`, à l'offset natif 0 = collé au composer, le redimensionnement animé ne demande AUCUNE compensation — `maintainVisibleContentPosition={{disabled: true}}` (le recalage natif partait avant le snap JS et l'écrasait, cicatrice duogo), suivi des entrants par `scrollToOffset(0)` si « de moi ou près du bas » (refs, zéro re-rendu), données `DESC` telles quelles (plus de `reverse()`), passé par `onEndReached` (la fin des données = le haut visuel), barre de non-lus recalculée en DESC (dernière occurrence du prédicat, insérée à k+1). Revue (2 passes multi-angles) : **garde chronologique sur le snap** (la SUPPRESSION du message de tête change aussi `data[0]` — snap intempestif en pleine lecture d'historique) ; **verrou `passeEpuise`** (`onEndReached` se réarme à CHAQUE changement de data : passé épuisé + utilisateur garé au haut = une requête REST identique par entrant, sur une API rate-limitée) ; commentaires réalignés (l'en-tête prétendait « on ne dérange pas », le lissage 200 ms invoquait un mécanisme disparu, le fil renvoyait à un salon qui n'existe plus). Écartés, consignés : le décalage du contenu quand un entrant arrive PENDANT la lecture d'historique (compromis duogo assumé — mVCP le corrigerait mais casse le snap ; le lissage groupe les rafales) ; barre non-lus hors fenêtre de chargement (sémantique 8.1 inchangée) ; le FIL garde l'ancien montage (il se lit depuis sa racine, liste courte — à porter si le ressenti l'exige). Prouvé sur l'AVD : ouverture calée en bas, liste collée au composer clavier plein ouvert/fermé, entrant PENDANT clavier ouvert collé au composer avec barre de non-lus au bon endroit, envoi + vérité serveur REST, pagination au-delà de la fenêtre initiale (torture2 13:02). **Trouvé en route : crash natif intermittent du DEV-CLIENT** — SIGSEGV Fabric (`MountingCoordinator::pullTransaction`, thread JS) au premier chargement du bundle après `clearState`, mesuré **2/8 en dev, 0/8 en release** (le Pixel n'est pas exposé) ; apparu avec reanimated 4.5 (8.9), à suivre en amont → `e2e/lancer.sh` accorde un second essai aux trois lancements à froid (01, 05, remise en état — TOTP recalculé au retry, rejouer 02/04 reposterait le même message). Suite E2E complète VERTE, exit 0 (ce run-ci sans le moindre retry). Fait le : `2026-07-10`

---

## Étape 9 — iOS

> Hors chemin critique. Réf. `ROADMAP.md` §5 phase 7. Prérequis `@guillaume` : un Mac, un compte Apple Developer (99 $/an).

- [ ] **9.1 — `prebuild` iOS** depuis les mêmes config plugins · `@duo` · `[infra]`
- [ ] **9.2 — Push APNs** avec Notification Service Extension · `@claude` · `[code]`
- [ ] **9.3 — Keychain access groups** · `@claude` · `[code]`

---

*Créé le 2026-07-09. `ROADMAP.md` fixe les décisions ; ce document suit leur exécution.*
