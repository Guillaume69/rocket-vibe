# Présence et saisie natives — P12

Les clients conservent leurs composeurs, indicateurs de saisie et pastilles de DM.
Le fournisseur Rocket.Chat garde son transport actuel. Le fournisseur RocketVibe
expose `presence` / `typing` uniquement si le serveur les annonce aussi.

## Écriture et expiration

- `PUT /api/v1/me/presence` : `{ "status": "online" }`, avec `online`,
  `away`, `busy` ou `offline`. Un bail appartient à un appareil authentifié,
  survit au renouvellement de son bearer et expire après **60 secondes**.
  `offline` retire ses baux de présence et de saisie. Un autre appareil actif
  conserve la présence du compte. Priorité d'agrégation : busy, online, away.
- `PUT /api/v1/rooms/{id}/typing` : `{ "active": true,
  "membership_version": "jeton-du-read-state" }`, avec `root_id` optionnel
  pour un fil. Le jeton public d'adhésion doit encore être courant ; une
  réadhésion ne réanime aucun ancien composeur. Une saisie active exige le
  droit d'envoyer et une racine disponible dans ce même salon. Un arrêt reste
  autorisé après passage en lecture seule. Le bail expire après **10 secondes**.
- Ces deux écritures répondent HTTP 200 / JSON `null`. Elles ne constituent pas
  des commandes durables et ne disposent d'aucun reçu ni mécanisme de rejeu.
- Les clients actifs renouvellent la présence toutes les **20 secondes** et
  limitent les émissions de saisie active à une toutes les **3 secondes** par
  composeur. Les arrêts suivent les émissions engagées. Hors connexion, aucune
  intention de présence / saisie ne rejoint SQLite ou l'outbox.

Les tables PostgreSQL sont **UNLOGGED** : plusieurs processus partagent les
baux, mais une récupération après crash n'a pas à restaurer un ancien « écrit ».
Les lecteurs vérifient aussi les sessions valides, la génération d'instance,
l'activation du compte, l'adhésion actuelle et les droits / racines actuels.
Une suspension / fermeture oublie immédiatement la photo locale et tente un
`offline` sans bloquer l'interface. Si le réseau est coupé, les baux expirent.

## Lecture et temps réel

Le lot [profils P16](PROFILES.md) ajoute des `profiles` optionnels à la photo :
identité, révision, version d'avatar et texte de statut de soi et des membres
de salons partagés. Ils respectent la même limite et expiration ; ils ne
contiennent ni email ni préférences et n'ajoutent aucun événement durable.

`GET /api/v1/live` renvoie une photo autorisée. La même photo est envoyée toutes
les **2 secondes** par la socket de synchronisation négociée avec `live=true` :

```json
{"type":"live","data":{"ttl_ms":8000,"limited":false,
  "presence":[{"user":{"id":"u2","username":"bob","display_name":"Bob"},"status":"online"}],
  "rooms":[{"room_id":"r1","membership_version":"grant1","typing":[]}]}}
```

Une entrée de salon peut porter `direct_peer` pour raccorder la pastille du DM
à l'identité réelle du correspondant, sans dériver son UID du nom du salon.
Les saisies portent un utilisateur et éventuellement `root_id` : les saisies
d'un fil ne s'affichent pas dans le flux principal du salon.

Ces trames sont distinctes des `SyncBatch`, n'ont **aucun curseur** et ne
modifient pas le journal. Une ancienne socket sans `live=true` continue de
recevoir uniquement les lots durables. HTTP et WebSocket conservent la barrière
de livraison des adhésions / politiques. Les clients refusent une photo d'une
ancienne adhésion et l'oublient à la révocation, à la suspension ou après
**8 secondes sans nouvelle photo**, sans dépendre de leur horloge murale pour
valider un bail serveur. Un utilisateur absent d'une photo valide est hors ligne ;
une photo absente / expirée signifie que son statut est inconnu.

Bornes du pilote : 1 000 salons, 512 utilisateurs présents, 512 saisies et
256 Kio par photo. Au-delà, `limited=true` fait oublier les observations au lieu
d'exposer une liste tronquée. Un appareil dispose de 60 écritures temporaires
par minute, avec HTTP 429 / `live_rate_limited` et `Retry-After`. Ce budget est
indépendant des envois, actions et lectures. Un appareil n'a qu'un composeur
actif côté serveur ; l'ouverture d'une autre saisie remplace la précédente.

## Mentions `@here`

Les destinataires sont capturés dans la transaction du premier envoi : autres
membres actifs du salon ayant un appareil avec un bail `online` ou `busy`
encore valable. Les utilisateurs `away` / hors ligne ne sont pas ajoutés.
Une connexion ultérieure ou une édition n'ajoute aucun destinataire. Retirer
le token lors d'une édition retire le ping d'origine. `@here` ne signifie jamais
`@all` ; les règles de Markdown et de lecture des fils restent les mêmes.

## Qualification

Les tests PostgreSQL / WebSocket couvrent expiration, isolement des salons,
appareils multiples, révocation de session, génération, réadhésion, budget et
capture de `@here`. Les tests clients couvrent expiration sans arrêt reçu,
photos périmées, séparation des composeurs, absence de persistance et arrêt
sérialisé. Les bancs connectés utilisent les fournisseurs mobiles réels, les
widgets GTK et les modèles Swift existants. La qualification des applications
installées Android / Windows / macOS reste un critère ouvert de la RFC.
