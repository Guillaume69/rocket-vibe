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

## Outils

`docker` et `docker compose` sont disponibles, daemon accessible sans `sudo`. `jq` est absent : les scripts utilisent `node` pour lire du JSON.
