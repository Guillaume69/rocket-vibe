# Réunions natives Jitsi — P20 / J4

Le serveur et les transports Rust / TypeScript sont disponibles. Le raccordement
aux boutons, cartes et fenêtres d'appel GTK / SwiftUI / mobile existants suit ce
lot ; leurs capacités clientes restent désactivées tant que ce parcours manque.
La qualification d'un vrai service Jitsi et des applications installées reste ouverte.

## Configuration opérateur

`RV_JITSI_CONFIG_FILE` désigne un fichier JSON régulier, privé (0600 sur Unix),
de 16 Kio au plus, contenant `url`, `app_id` et `secret`. L'URL est une origine
HTTPS, port optionnel, sans credentials, chemin, query ni fragment. Le secret
contient 32–1024 octets et doit être généré aléatoirement par l'opérateur.
Il est partagé avec le validateur Jitsi, jamais stocké en PostgreSQL ni envoyé
au client. Une configuration invalide arrête le démarrage sans imprimer sa valeur.
Sans configuration, la découverte annonce `calls: false` et les commandes
authentifiées échouent avec `503 calls_unavailable`.

Exemple de forme, à remplacer dans un fichier privé hors du dépôt :

```json
{
  "url": "https://meet.example.org",
  "app_id": "rocketvibe",
  "secret": "REPLACE_WITH_A_RANDOM_SECRET_OF_AT_LEAST_32_BYTES"
}
```

Le service doit activer l'authentification JWT HS256, l'identifiant d'application
exact, l'audience `jitsi`, refuser les jetons absents et vérifier le nom de la
conférence dans le composant MUC. Le claim `sub` est le domaine de l'origine,
sans son port. Les origines de tenant / proxy avec chemin ne sont pas prises en
charge par cette configuration. Sources : [contrat officiel des jetons Jitsi](https://github.com/jitsi/lib-jitsi-meet/blob/master/doc/tokens.md),
[configuration Docker officielle](https://github.com/jitsi/docker-jitsi-meet/blob/master/env.example).

## Routes et identité

Les routes utilisent le bearer RocketVibe habituel et les contrôles de remise
privée. Un administrateur sans adhésion n'obtient pas l'adresse d'un appel privé.

| Route | Intention / résultat |
|---|---|
| `POST /api/v1/rooms/{room}/meetings` | `StartMeeting` : opération, version d'adhésion, époque ; retourne `Meeting` |
| `GET /api/v1/meetings/{id}` | Métadonnées accessibles aux membres actuels |
| `POST /api/v1/meetings/{id}/join` | `JoinMeeting` : adhésion et époque ; retourne `MeetingJoin`, URL privée et expiration du jeton |
| `POST /api/v1/meetings/{id}/end` | Même portée ; créateur, propriétaire ou modérateur ; fermeture idempotente |

La version d'adhésion est celle de `ReadState.membership_version`, commune aux
caches mobiles et bureau. La permission de démarrer suit les droits de rédaction
du salon. Un membre en lecture seule peut rejoindre un appel existant. Retrait,
réadhésion et restauration refusent les anciennes intentions. Une nouvelle
configuration d'origine / identifiant ne réutilise pas les réunions de l'ancienne.

## Démarrage et durée

Les transactions verrouillent compte / session, salon, adhésion et époque. Les
démarrages concurrents d'un salon retrouvent une seule conférence active, de
nom opaque aléatoire, valable deux heures. Une seule activité structurée
`call_started` contenant l'identifiant de réunion est publiée dans le journal.
Le même ID d'opération retrouve son résultat, même après redémarrage, expiration
ou fin de réunion ; il ne crée pas un autre appel. Réutiliser l'ID dans une autre
portée est refusé. Les reçus sont durables ; 256 nouvelles opérations par compte
sur 24 h sont autorisées, sans éviction des anciens reçus. Une opération nouvelle
peut créer une nouvelle réunion lorsque la précédente a expiré ou est terminée.

## Jeton et révocation

Chaque entrée contrôle à nouveau le compte, la session, l'adhésion et l'époque.
Le JWT HS256 est limité à une conférence exacte (`room`, jamais `*`), au domaine,
à l'application et à l'audience. Il dure au plus 120 secondes, sans dépasser la
fin de validité de la réunion. Le contexte utilisateur contient l'UID et le nom
affiché ; il n'accorde pas de privilège de modération. Un nouveau jeton est émis
à chaque entrée et ne figure dans aucun message, journal, reçu ou lien partagé.

L'URL privée transporte le JWT dans `?jwt=`, conformément au client web Jitsi.
Les réponses sont `Cache-Control: no-store` et `Referrer-Policy: no-referrer`.
Une remise conserve les verrous d'accès et revérifie l'état de la réunion jusqu'à
la soumission du corps HTTP, avec le bail borné habituel. Fin d'appel, retrait et
révocation ne peuvent dépasser une remise déjà acceptée.

La fermeture bloque les nouveaux jetons. Elle **ne révoque pas un JWT déjà
remis**, valable jusqu'à son expiration, et n'expulse pas automatiquement les
participants connectés. L'expulsion / modération Jitsi et son comportement à
l'expiration restent à qualifier contre un vrai service. Le chiffrement E2EE
des messages ne constitue aucune garantie de chiffrement des médias d'appel.

## Preuves et sortie encore ouverte

Les tests PostgreSQL / HTTP réels exercent concurrence, reçus après redémarrage,
absence de bypass admin, lecture seule, retrait / réadhésion, changement d'époque,
expiration, fermeture idempotente et refus des nouvelles entrées. Un corps HTTP
de join est retenu pendant une fermeture concurrente, puis consommé : la fermeture
attend sa remise et le join suivant est refusé.
Le quota refuse une nouvelle opération sans bloquer la reprise d'un reçu, la
lecture, l'entrée ni la fin. Maintenance et passage du temps ne retirent pas
les reçus ; une session révoquée ne peut plus recevoir de JWT.

Le transport mobile réel s'authentifie contre le même serveur et rejoue son
démarrage. Un vérificateur Node indépendant contrôle la signature HS256, les
claims de portée et la durée des JWT Rust ; aucun jeton n'est imprimé.
Ces bancs ne prouvent pas encore l'acceptation / le refus par Prosody, le média,
la modération, ni les parcours dans les applications installées. P20 / J4 restent ouverts.
