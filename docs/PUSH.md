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

## Trois pièges vérifiés sur le terrain

### `Push_UseLegacy` n'existe pas en 8.5

Ni `Push_gcm_api_key`, ni `Push_gcm_project_number`. L'API FCM legacy a été **entièrement retirée** de Rocket.Chat 8.x : le serveur ne parle que FCM HTTP v1. Le dossier de recherche affirmait le contraire.

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

## Deux défauts connus, à traiter en 6.3

1. **Mauvais canal de notification.** La notification atterrit sur `fcm_fallback_notification_channel` (importance `3` = DEFAULT), pas sur notre canal `default` en `HIGH` — donc pas de bannière *heads-up*. Cause : le payload serveur ne porte pas d'`android_channel_id`, et le manifeste n'a pas la métadonnée `com.google.firebase.messaging.default_notification_channel_id`. `logcat` le dit : *« Missing Default Notification Channel metadata in AndroidManifest »*.

2. **Rien ne s'affiche au premier plan.** Un message FCM de type `notification` reçu app ouverte est remis à l'app, pas au système ; `expo-notifications` n'affiche rien sans `setNotificationHandler`. Ce n'est pas un bug du push — mon premier test, app au premier plan, a failli me le faire croire.

La correction des deux passe par le rendu de la notification **par l'app** (`data`-only côté client), ce que 6.3 prévoit déjà : groupement par salon, `MessagingStyle`, et texte générique pour les salons chiffrés (`Push_show_message = true` exposerait sinon du ciphertext).

## Utilisateurs de test et 2FA par email

Rocket.Chat n'active la 2FA par email que sur une **adresse vérifiée**. Un utilisateur seedé avec `verified: true` ne peut plus se connecter en dev, faute de serveur mail pour recevoir le code (`availableMethods: ["email"]`, `codeGenerated: false`). `scripts/seed.mjs` crée donc les utilisateurs avec `verified: false`. L'administrateur, dont l'adresse n'est pas vérifiée, n'était pas concerné — d'où l'asymétrie déroutante au premier abord.
