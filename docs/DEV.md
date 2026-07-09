# Environnement de développement

## Démarrage

```sh
source scripts/env.sh          # RV_ENV_VERBOSE=1 pour voir ce qui est exporté
java -version                  # 17.0.19
adb devices
```

Le script auto-détecte le JDK et le SDK Android, et est **idempotent** : le sourcer plusieurs fois n'empile pas les entrées de `PATH`.

Il **interroge `javac -version`** au lieu de lire le nom du répertoire : `jdk1.8.0_171` contient « 17 » sans être un JDK 17. Il accepte les majeures 17 à 24 et retient la plus récente (`sort -V`, car lexicalement `jdk-17.0.9` précède `jdk-17.0.19`).

Surcharges :

| Variable | Effet |
|---|---|
| `RV_JDK_HOME` | Court-circuite la détection du JDK. |
| `RV_ANDROID_HOME` | Court-circuite la détection du SDK. |
| `RV_ROOT_URL` | Fige `ROOT_URL` au lieu de le déduire de l'IP LAN. |
| `RV_ENV_VERBOSE=1` | Affiche ce qui est exporté. |

`ROOT_URL` est **recalculé à chaque source**, car l'IP LAN change (DHCP, VPN, Wi-Fi vers Ethernet) et un `ROOT_URL` rance pointerait silencieusement sur l'ancien réseau. Sans route par défaut, il n'est **pas défini** — plutôt que de valoir `http://:3000`.

## La chaîne de build, et pourquoi elle marche telle quelle

Le template `@react-native-community/template@0.86.0` exige :

| Exigence | Valeur | Statut local |
|---|---|---|
| `buildToolsVersion` | 36.0.0 | installé |
| `compileSdk` / `targetSdk` | 36 | `platforms/android-36` |
| `minSdk` | 24 | — |
| `ndkVersion` | 27.1.12297006 | installé à la version exacte |
| Gradle | 9.3.1 | téléchargé par le wrapper |
| `sourceCompatibility` | `VERSION_17` | Temurin 17.0.19 |

**Le JDK 21 n'est pas requis.** Gradle 9.3.1 accepte Java 17 à 24, et React Native fixe `sourceCompatibility = VERSION_17`.

## Réseau

`ROOT_URL` pointe sur l'**IP LAN** de la machine, pas sur `10.0.2.2`. Deux raisons : un appareil physique doit joindre le serveur, et `ROOT_URL` conditionne les payloads de notification et les deep links — il ne peut pas valoir les deux à la fois.

Pour l'émulateur, rediriger le port plutôt que changer `ROOT_URL` :

```sh
adb reverse tcp:3000 tcp:3000
```

## Émulateur

```sh
emulator -avd duogo_test -no-audio -no-boot-anim -gpu auto &
adb wait-for-device
adb shell getprop sys.boot_completed   # 1 = prêt
adb exec-out screencap -p > /tmp/screen.png
```

L'AVD `duogo_test` est un Pixel 7, `android-36`, image `google_apis` (x86_64).

Deux remarques :

- L'image `google_apis` embarque les **Google Play Services**, que FCM exige. L'émulateur peut donc servir à valider la chaîne de push (Firebase → serveur → token → réception). Il ne reproduit en revanche ni Doze ni le kill de process : le critère binaire du *kill gate* reste sur un appareil physique.
- `hw.ramSize = 1536M` est un peu juste pour Hermes et le bundler. Passer à `4096` dans `~/.android/avd/duogo_test.avd/config.ini` si le bundle rame.

## Serveur Rocket.Chat de développement

```sh
cd docker && cp .env.example .env && chmod 600 .env   # renseigner ADMIN_PASS
docker compose up -d
curl -sf "$ROOT_URL/api/info"                          # {"version":"8.5",...}
```

Épinglé sur **Rocket.Chat 8.5.1** — la version de `chat.barrut.me` — et non sur la dernière publiée (8.6.0). Coller à la production évite les écarts d'API qui se paient en fin de parcours. 8.5 est une LTS supportée jusqu'au 2027-06-30.

**MongoDB 8.0 est imposé** : `https://releases.rocket.chat/8.5.1/info` renvoie `compatibleMongoVersions: ["8.0"]`. Les séries 6 et 7 ne sont plus supportées depuis la 8.2.

Le **replica set est obligatoire**, même à un seul nœud : Rocket.Chat s'appuie sur les *change streams* MongoDB, qui n'existent pas sur un `mongod` autonome. Le healthcheck du service `mongodb` initie le replica set lui-même, puis n'est vert qu'une fois le nœud `PRIMARY` — c'est ce qui garantit que Rocket.Chat ne démarre pas trop tôt.

`MONGO_OPLOG_URL` n'est **pas** définie : la variable a été supprimée en 8.0.0.

`ROOT_URL` et `ADMIN_PASS` utilisent la forme `${VAR:?message}` : un `docker compose up` sans `.env` échoue immédiatement, au lieu de créer un compte `admin` sans mot de passe sur un serveur exposé au LAN.

### Données de test

```sh
node scripts/seed.mjs
```

Crée `alice` et `bob`, le canal public `test-public`, le groupe privé `test-prive`, un message direct, 12 messages par salon et un fil de 3 réponses.

Le script est **idempotent y compris après une interruption**. Chaque message seedé porte un marqueur `[seed i/12]` : la relance lit l'historique, calcule les indices manquants et ne repose que ceux-là. Une idempotence en tout-ou-rien (« ce salon a déjà des messages, je passe ») figerait pour toujours un salon interrompu à 7 messages sur 12.

## Ce que dit le serveur cible (`chat.barrut.me`, relevé sans authentification)

| Réglage | Valeur | Conséquence |
|---|---|---|
| `version` | `8.5` | `rooms.upload` supprimé, appels de méthodes DDP dépréciés. |
| `cloudWorkspaceId` | présent | Le workspace **est enregistré sur Rocket.Chat Cloud** : le Push Gateway officiel est actif, il faudra le désactiver. |
| `Accounts_TwoFactorAuthentication_Enabled` | `true` | 2FA obligatoire dès l'étape 3.2. |
| `..._By_TOTP_Enabled` / `..._By_Email_Enabled` | `true` / `false` | Seul le TOTP est à implémenter, plus le repli mot de passe. |
| OAuth, SAML, CAS, LDAP | tous inactifs | **Aucun chantier SSO** dans le v1. |
| `E2E_Enable` | `true` | Un salon marqué `encrypted` sera illisible et inaccessible en écriture. À arbitrer. |
| `E2E_Allow_Unencrypted_Messages` | `false` | Le serveur **rejette** un message en clair dans un salon chiffré. |
| `E2E_Enabled_Default_PrivateRooms` | `false` | Les nouveaux salons privés ne sont pas chiffrés d'office. |
| `FileUpload_ProtectFiles` | `true` | Fichiers accessibles seulement authentifié (`rc_uid`/`rc_token`). |
| `Accounts_AvatarBlockUnauthenticatedAccess` | `true` | Les avatars aussi. |
| `Presence_broadcast_disabled` | `false` | La présence fonctionne. |
| `Message_AllowEditing_BlockEditInMinutes` | `0` | Pas de limite de temps d'édition. |

## Outils

`docker` et `docker compose` sont disponibles, daemon accessible sans `sudo`. `jq` est absent : les scripts utilisent `node` pour lire du JSON.
