# Push — verdict du kill gate

**PASS sur émulateur.** Chaîne complète prouvée le 2026-07-10 : Firebase → Rocket.Chat 8.5 → FCM HTTP v1 → émulateur → notification système, **y compris processus tué**.

Reste à confirmer sur le Pixel 10 Pro (étape 2.5b) pour Doze et les conditions réelles.

## La chaîne, telle qu'observée

1. `getDevicePushTokenAsync()` renvoie un jeton FCM natif (`…:APA91b…`) — pas un jeton Expo Push.
2. `POST /api/v1/push.token` `{type:'gcm', value, appName}` → stocké dans la collection Mongo **`_raix_push_app_tokens`**, sous la forme `token: { gcm: '…' }`.
3. Réglages serveur (`Admin → Push`, tous modifiés via l'API avec la 2FA) :

| Réglage | Valeur |
|---|---|
| `Push_enable` | `true` |
| `Push_enable_gateway` | `false` |
| `Push_google_api_credentials` | le JSON **complet** du compte de service, en chaîne |

4. À la réception d'un DM vers un utilisateur **hors ligne**, le serveur émet :

```
POST https://fcm.googleapis.com/v1/projects/rocket-vibe/messages:send
{
  "message": {
    "notification": { "title": "admin", "body": "…" },
    "data": {
      "ejson": "{\"host\":\"…\",\"messageId\":\"…\",\"notificationType\":\"message\",
                 \"rid\":\"…\",\"sender\":{…},\"type\":\"d\",\"tmid\":null}",
      "msgcnt": "15", "notId": "…", "style": "inbox"
    },
    "android": { "priority": "HIGH" },
    "token": "…"
  }
}
```

Le `rid` du deep link vit dans `data.ejson`, pas à la racine.

## Bundle serveur patché

Le choix gateway / natif est GLOBAL au serveur (`shouldUseGateway()` dans `app/push/server/push.ts`) : gateway coupé, les jetons des applis officielles partent chez notre projet Firebase, FCM répond `SENDER_ID_MISMATCH` et le serveur les **supprime**. Les applis officielles n'ont plus de push sur ce serveur.

`docker/patch-push.mjs` retouche le bundle de l'image (`/app/bundle/programs/server/app/app.js`, lisible, non minifié) :

1. le gateway ne sert plus que les jetons dont `appName` n'est pas `rocket-vibe` : les nôtres partent en natif, les applis officielles gardent le gateway. `Push_enable_gateway` peut revenir à `true`, `Push_google_api_credentials` reste renseigné ;
2. le message FCM porte un bloc `apns` (`mutable-content: 1`, `thread-id` = `notId`) : un jeton FCM iOS enregistré en `gcm` réveille la Notification Service Extension. Côté Firebase, la clé APNs `.p8` est déposée dans la console ; rien d'APNs côté Rocket.Chat.

```sh
node docker/patch-push.mjs                  # tag lu dans docker/compose.yml -> docker/patched/app-<tag>.js
node docker/patch-push.mjs <image:tag>      # image explicite, pour le serveur de prod
```

Le compose monte `patched/app-${RC_VERSION}.js` avec `create_host_path: false` : après une montée de version, `up` échoue tant que le script n'a pas été relancé. Le script s'arrête si une ancre n'apparaît pas exactement une fois (code changé en amont) et garde le nombre de lignes, donc `app.js.map` reste aligné.

Vérifié sur le banc 8.5.1 : démarrage sain sur le bundle patché, forme du message FCM contrôlée en isolant `getFCMMessagesFromPushData`. **Pas encore vérifié** : l'acceptation du bloc `apns` par FCM (le banc n'a pas de compte de service) et la branche gateway (le banc n'est pas enregistré sur RC Cloud) - à confirmer sur `chat.barrut.me`.

## iOS

Même voie qu'Android : jeton **FCM** enregistré en `gcm`, Rocket.Chat pousse vers FCM, FCM relaie vers APNs avec la clé `.p8` déposée dans la console Firebase (projet `rocket-vibe`, app iOS `com.rocketvibe.app`). Aucun réglage APNs côté Rocket.Chat.

| Pièce | Rôle |
|---|---|
| `apps/mobile/modules/jeton-fcm/` | Module Swift : remet le jeton APNs (rendu par `getDevicePushTokenAsync()`) à Firebase et rend le jeton FCM ; émet `jetonRenouvele` à la rotation. |
| `apps/mobile/plugins/with-ios-push.js` | `FirebaseAppDelegateProxyEnabled = false` (pas de swizzling contre expo-notifications), pods Firebase en `modular_headers`, groupe de trousseau partagé, cible `NotificationService`. |
| `apps/mobile/plugins/ios-notification-service/NotificationService.swift` | Notification Service Extension, pendant du service Kotlin : lit la session au trousseau, `push.get`, réécrit titre et texte, `threadIdentifier` = rid, range `ejson` (rid, host) dans `userInfo["body"]`, que expo-notifications expose comme `data` au tap. |

Ce qui diffère d'Android, par contrainte iOS :

- l'extension ne peut pas **supprimer** un push (il faudrait l'entitlement de filtrage, sur dossier Apple) : sans session, elle remplace le texte par « Nouveau message » ;
- pas de rattrapage différé : un `push.get` raté ou trop long (~30 s) laisse « Nouveau message » ;
- la session et la langue sont écrites `AFTER_FIRST_UNLOCK` (`lib/sessionStore.ts`, `ui/i18n.ts`) : avec le défaut `WHEN_UNLOCKED`, l'extension ne les lirait pas écran verrouillé ;
- le groupe de trousseau `$(AppIdentifierPrefix)com.rocketvibe.app` est EN TÊTE des groupes de l'app, donc c'est là qu'expo-secure-store écrit par défaut ;
- « Répondre » est une action de saisie iOS : l'extension pose la catégorie `rv-message` (sauf salon chiffré), et `modules/reponse-notif` envoie le texte par `chat.sendMessage` en natif, app réveillée en arrière-plan, sans passer par le JS. Échec : une notification « Réponse non envoyée » reprend la même action. Le code de session (`SessionPush.swift`) est commun aux deux cibles.

Vérifié sous Linux : `expo prebuild --platform ios --no-install` (cible, embarquement, réglages, Podfile, entitlements), `swiftc -parse` des deux fichiers Swift, typecheck de l'extension contre des doublures des API Apple, et sa logique exécutée contre le banc 8.5.1 (vrai `push.get`, origine étrangère refusée, repli, E2EE, DM). **Jamais compilé avec Xcode.**

### Premier build sur Mac

```sh
cd apps/mobile
npx expo prebuild --platform ios      # régénère ios/ et lance pod install
open ios/rocketvibe.xcworkspace
```

1. Xcode, cibles `rocketvibe` **et** `NotificationService` → Signing & Capabilities : choisir l'équipe (ou `ios.appleTeamId` dans `app.json`, repris par le plugin pour les deux cibles).
2. Build sur un **iPhone réel** (le simulateur n'a pas de push distant fiable).
3. Se connecter, accepter les notifications ; vérifier dans les logs que `push.token` part avec un jeton FCM (forme `…:APA91b…`), pas 64 caractères hexadécimaux.
4. App tuée, un DM depuis un autre compte hors ligne : la notification doit montrer le vrai texte (preuve que l'extension a tourné), groupée par salon ; le tap ouvre le salon.
5. Refaire téléphone verrouillé, puis en mode avion le temps de la réception (« Nouveau message » attendu).

Points à surveiller au premier `pod install` / build : la liste des pods en `modular_headers` si CocoaPods réclame un module de plus, et la version de FirebaseMessaging (non épinglée dans `JetonFcm.podspec`).

## Trois pièges vérifiés sur le terrain

### `Push_UseLegacy` ne sert plus en 8.5

Le réglage est encore déclaré dans le bundle 8.5.1, caché, à `false` par défaut, comme `Push_gcm_api_key` et `Push_gcm_project_number` (un `TODO` prévoit leur retrait). Seul l'écran d'administration le lit, pour griser des champs : aucun code d'envoi ne le consulte. L'API FCM legacy a été **entièrement retirée** de Rocket.Chat 8.x : le serveur ne parle que FCM HTTP v1, il n'y a rien à régler. Le dossier de recherche affirmait le contraire.

### `am force-stop` ≠ balayage depuis les récents

`adb shell am force-stop <pkg>` place l'application dans l'état **stopped** d'Android, où FCM **ne lui livre plus rien** jusqu'à un relancement manuel. Aucune notification n'arrive, et ce n'est **pas** un échec du push.

Le bon équivalent d'un swipe-kill est **`adb shell am kill <pkg>`** (processus tué, pas d'état stopped) : la notification arrive, et FCM **réveille le processus** — vérifié, un nouveau pid apparaît.

Un spike qui utiliserait `force-stop` conclurait à tort que le push est mort.

### Modifier un réglage privilégié exige la 2FA

`POST /api/v1/settings/<id>` répond `errorType: totp-required`, `details.method: "password"`. Le nom trompe : c'est le **repli mot de passe**, et le code attendu est le **SHA-256 du mot de passe**, jamais le mot de passe en clair.

```sh
SHA=$(printf '%s' "$MOTDEPASSE" | sha256sum | cut -d' ' -f1)
curl -X POST -H "x-2fa-code: $SHA" -H "x-2fa-method: password" …
```

C'est le mécanisme générique de l'étape 3.2, validé en avance.

## Deux défauts relevés au spike, corrigés depuis

Les deux sont réglés : le service Kotlin (`plugins/with-fcm-deeplink.js`) rend la notification lui-même sur notre canal `default`, en `HIGH`, créé par `lib/push.ts`, et `ui/notifications.tsx` pose un `setNotificationHandler`. Le constat d'origine :

1. **Mauvais canal de notification.** La notification atterrit sur `fcm_fallback_notification_channel` (importance `3` = DEFAULT), pas sur notre canal `default` en `HIGH` — donc pas de bannière *heads-up*. Cause : le payload serveur ne porte pas d'`android_channel_id`, et le manifeste n'a pas la métadonnée `com.google.firebase.messaging.default_notification_channel_id`. `logcat` le dit : *« Missing Default Notification Channel metadata in AndroidManifest »*.

2. **Rien ne s'affiche au premier plan.** Un message FCM de type `notification` reçu app ouverte est remis à l'app, pas au système ; `expo-notifications` n'affiche rien sans `setNotificationHandler`. Ce n'est pas un bug du push — mon premier test, app au premier plan, a failli me le faire croire.

La correction des deux est passée par le rendu de la notification **par l'app** (`data`-only côté client), comme 6.3 le prévoyait : groupement par salon, `MessagingStyle`, et texte générique pour les salons chiffrés (`Push_show_message = true` exposerait sinon du ciphertext).

## Utilisateurs de test et 2FA par email

Rocket.Chat n'active la 2FA par email que sur une **adresse vérifiée**. Un utilisateur seedé avec `verified: true` ne peut plus se connecter en dev, faute de serveur mail pour recevoir le code (`availableMethods: ["email"]`, `codeGenerated: false`). `scripts/seed.mjs` crée donc les utilisateurs avec `verified: false`. L'administrateur, dont l'adresse n'est pas vérifiée, n'était pas concerné — d'où l'asymétrie déroutante au premier abord.
