# Déployer un serveur RocketVibe

Ce guide installe un serveur RocketVibe sur un serveur dédié, derrière un nom de domaine en HTTPS, avec le vocal (LiveKit). Tout part du dépôt : le serveur se construit depuis les sources, il n'y a pas d'image publiée.

**Pile :** Linux, Docker Compose, PostgreSQL 18, LiveKit v1.13, Caddy pour le HTTPS. C'est un **serveur pilote** (voir les [limites connues](#limites-connues)).

## Sommaire

1. [Prérequis](#1-prérequis)
2. [Le code et les secrets](#2-le-code-et-les-secrets)
3. [Le fichier de prod](#3-le-fichier-de-prod)
4. [Le démarrage](#4-le-démarrage)
5. [HTTPS avec Caddy](#5-https-avec-caddy)
6. [Le pare-feu](#6-le-pare-feu)
7. [Les comptes](#7-les-comptes)
8. [2FA, e-mail, push](#8-2fa-e-mail-push-facultatif)
9. [Sauvegardes et mises à jour](#9-sauvegardes-et-mises-à-jour)
10. [Limites connues](#limites-connues)
11. [Check-list](#check-list)

## Vue d'ensemble

```
Apps (Android, GTK, SwiftUI)
   │ HTTPS / WSS
   ▼
Caddy :443 ──── chat.example.org  ──▶ rv-server 127.0.0.1:3400 ──▶ PostgreSQL (réseau Docker interne)
           └─── voice.example.org ──▶ LiveKit   127.0.0.1:7880 (signalisation)

Apps ◀──── média vocal ────▶ LiveKit 7881/tcp, 50000-50020/udp (ouverts sur Internet)
```

Seuls Caddy (80, 443) et le média de LiveKit sont joignables depuis Internet. L'API et la signalisation LiveKit restent sur `127.0.0.1`, derrière Caddy.

## 1. Prérequis

- Un Linux récent (Debian 12, Ubuntu 24.04) avec une **IP publique**.
- [Docker Engine](https://docs.docker.com/engine/install/) avec le plugin Compose **2.24.4 ou plus** (pour la balise `!override` de l'étape 3), et `git`.
- Deux enregistrements DNS `A` vers l'IP du serveur, par exemple `chat.example.org` (l'API) et `voice.example.org` (le vocal).
- Caddy pour le HTTPS : `apt install caddy`.

Vérifier la version de Compose :

```bash
docker compose version
```

> **Pourquoi HTTPS est obligatoire.** Android refuse le trafic en clair dans une build de release, et les WebSockets du chat comme du vocal passent alors en `wss://`.

## 2. Le code et les secrets

Récupérer le dépôt :

```bash
git clone https://github.com/Guillaume69/rocket-vibe.git
cd rocket-vibe
```

Créer le fichier d'environnement :

```bash
cp docker/.env.native.example docker/.env.native
chmod 600 docker/.env.native
```

Générer deux secrets, et copier chaque sortie dans le fichier :

```bash
openssl rand -hex 32   # RV_DATABASE_PASSWORD
openssl rand -hex 32   # RV_LIVEKIT_API_SECRET
```

| Variable | Valeur |
|---|---|
| `RV_DATABASE_PASSWORD` | la première valeur aléatoire (en hexadécimal : aucun caractère à échapper dans l'URL de la base) |
| `RV_LIVEKIT_NODE_IP` | l'**IP publique** du serveur |
| `RV_LIVEKIT_API_KEY` | `rocketvibe` convient |
| `RV_LIVEKIT_API_SECRET` | la seconde valeur aléatoire (32 octets ou plus) |
| `RV_LIVEKIT_URL` | **à ajouter** : `wss://voice.example.org`. C'est l'adresse du vocal que le serveur donne aux apps ; sans elle, elles reçoivent `ws://IP:7880`, en clair. |

Exemple de `docker/.env.native` (valeurs à remplacer) :

```ini
RV_DATABASE_PASSWORD=…64 caractères hexadécimaux…
RV_LIVEKIT_NODE_IP=203.0.113.10
RV_LIVEKIT_API_KEY=rocketvibe
RV_LIVEKIT_API_SECRET=…64 caractères hexadécimaux…
RV_LIVEKIT_URL=wss://voice.example.org
```

> **Chiffrement de bout en bout.** `RV_E2EE` vaut `true` par défaut. Ajouter `RV_E2EE=false` pour une instance sans chiffrement.

## 3. Le fichier de prod

Un fichier Compose de plus, propre à la machine, se superpose à ceux du dépôt. Il referme le port de signalisation LiveKit sur l'hôte local (Caddy le sert), et branchera plus tard les options de l'étape 8.

`docker/compose.prod.yml` :

```yaml
# Propre à ce serveur : ne pas le committer.
services:
  livekit:
    # 7880 (signalisation) seulement en local : Caddy le sert en wss://
    ports: !override
      - "127.0.0.1:7880:7880"
      - "7881:7881"
      - "50000-50020:50000-50020/udp"
```

Pour ne pas retaper la commande, un alias dans `~/.bashrc`, à lancer depuis la racine du dépôt :

```bash
alias rv='docker compose --env-file docker/.env.native -f docker/compose.rocketvibe.yml -f docker/compose.voice.yml -f docker/compose.prod.yml'
```

> **Attention : Docker passe à travers ufw.** Les ports publiés par Docker contournent les règles d'ufw. Sans ce fichier, `7880` serait ouvert sur Internet même si ufw le bloque. L'API, elle, est déjà liée à `127.0.0.1:3400` par le dépôt.

## 4. Le démarrage

Construire et lancer (la première fois prend quelques minutes) :

```bash
rv up --build -d
rv ps
```

Les migrations de la base s'appliquent toutes seules au démarrage du serveur. Pour suivre les journaux :

```bash
rv logs -f server
rv logs -f livekit
```

> **Sans le vocal.** Retirer `-f docker/compose.voice.yml` et le fichier de prod de l'alias : seuls PostgreSQL et le serveur tournent, et les apps n'affichent aucun vocal.

## 5. HTTPS avec Caddy

Caddy obtient et renouvelle les certificats tout seul, et transmet les WebSockets sans réglage.

`/etc/caddy/Caddyfile` :

```
chat.example.org {
    reverse_proxy 127.0.0.1:3400
}

voice.example.org {
    reverse_proxy 127.0.0.1:7880
}
```

Recharger, puis vérifier :

```bash
sudo systemctl reload caddy
curl -f https://chat.example.org/health/ready
curl https://chat.example.org/.well-known/rocketvibe
```

La seconde réponse annonce les capacités du serveur : `voice` doit y valoir `true` si LiveKit est configuré.

> **Adresse des clients.** Caddy transmet l'adresse de chaque client dans `X-Forwarded-For`. Le serveur ne la croit que si la connexion vient d'un proxy de confiance, `RV_TRUSTED_PROXIES` (adresses ou plages CIDR, séparées par des virgules). Le fichier Compose du dépôt y met déjà le local et les plages privées, celles de la passerelle Docker : les quotas de connexion (30 tentatives par minute et par adresse) comptent alors chaque client à part. Sans ce réglage, tous les clients partageraient le quota de Caddy, et une trentaine d'échecs par minute bloquerait la connexion de tout le monde.

## 6. Le pare-feu

| Port | Rôle | Ouvert ? |
|---|---|---|
| `22/tcp` | SSH | oui |
| `80/tcp`, `443/tcp` | Caddy (certificats, API, signalisation vocale) | oui |
| `7881/tcp` | LiveKit, repli TCP du média | oui |
| `50000-50020/udp` | LiveKit, média | oui |
| `3400`, `7880` | API et signalisation, derrière Caddy | **non** (liés à `127.0.0.1`) |

Avec ufw :

```bash
sudo ufw allow 22/tcp
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw allow 7881/tcp
sudo ufw allow 50000:50020/udp
sudo ufw enable
```

> **Pas de TURN.** Aucun serveur TURN n'est configuré. Un client derrière un réseau très fermé peut se rabattre sur `7881/tcp`, mais pas toujours.

## 7. Les comptes

Il n'y a pas d'inscription publique : l'opérateur crée les comptes, ou invite.

### Le compte administrateur

Le mot de passe (12 octets au moins) passe par l'environnement, jamais en argument. `read -s` le saisit sans l'afficher ni l'écrire dans l'historique :

```bash
read -rs RV_USER_PASSWORD && export RV_USER_PASSWORD
rv run --rm -e RV_USER_PASSWORD server create-user ton-pseudo --admin
unset RV_USER_PASSWORD
```

### Les autres : une invitation

Le code s'affiche une seule fois ; le transmettre à la personne, qui choisit ses identifiants dans l'app. Il vaut 7 jours au plus.

```bash
rv run --rm server invite --hours 168
rv run --rm server list-invitations
rv run --rm server revoke-invitation IDENTIFIANT
```

### Mot de passe oublié

Un code de récupération, valable 24 heures au plus :

```bash
rv run --rm server recover-user pseudo --hours 24
```

Dans les apps, on entre `https://chat.example.org` : le type de serveur est reconnu automatiquement. Les canaux vocaux se créent depuis les apps (le bouton « + » de la liste des salons), et un propriétaire peut transformer un salon en canal vocal dans ses réglages.

## 8. 2FA, e-mail, push (facultatif)

| Variable | Sert à | Contenu |
|---|---|---|
| `RV_AUTH_KEY_FILE` | chiffrer les seconds facteurs (TOTP, e-mail) | 64 caractères hexadécimaux : `openssl rand -hex 32` |
| `RV_SMTP_CONFIG_FILE` | e-mails (vérification, récupération) | JSON sur le modèle de `docker/smtp.example.json` |
| `RV_FCM_CONFIG_FILE` | notifications push Android | JSON du compte de service Firebase du projet de l'app |

Le serveur tourne sous l'utilisateur `10001` et refuse les fichiers lisibles par d'autres : les ranger hors du dépôt, à lui, en mode `600`.

```bash
sudo install -d -m 700 /etc/rocketvibe
openssl rand -hex 32 | sudo tee /etc/rocketvibe/auth.key > /dev/null
# Copier aussi smtp.json et firebase.json dans /etc/rocketvibe, puis :
sudo chown 10001:10001 /etc/rocketvibe/*
sudo chmod 600 /etc/rocketvibe/*
```

À ajouter dans `docker/compose.prod.yml`, sous `services:` :

```yaml
  server:
    environment:
      RV_AUTH_KEY_FILE: /run/secrets/auth.key
      RV_SMTP_CONFIG_FILE: /run/secrets/smtp.json
      RV_FCM_CONFIG_FILE: /run/secrets/firebase.json
    volumes:
      - /etc/rocketvibe/auth.key:/run/secrets/auth.key:ro
      - /etc/rocketvibe/smtp.json:/run/secrets/smtp.json:ro
      - /etc/rocketvibe/firebase.json:/run/secrets/firebase.json:ro
```

Ne garder que les lignes des options utilisées, puis `rv up -d`.

> **La clé des facteurs se sauvegarde à part.** Si `auth.key` est perdue, les seconds facteurs deviennent inutilisables, et une réinitialisation de mot de passe ne les retire pas. Garder la même clé lors d'une restauration.

## 9. Sauvegardes et mises à jour

### Ce qu'il faut sauvegarder

- la base PostgreSQL ;
- le volume des fichiers envoyés (`rocketvibe-native_native-objects`) ;
- `/etc/rocketvibe` et `docker/.env.native`, à part.

Une sauvegarde, à mettre dans un cron :

```bash
rv exec -T postgres pg_dump -U rocketvibe rocketvibe | gzip > rocketvibe-$(date +%F).sql.gz
docker run --rm -v rocketvibe-native_native-objects:/data:ro -v "$PWD":/backup busybox \
  tar czf /backup/objects-$(date +%F).tgz -C /data .
```

### Mettre à jour

Faire une sauvegarde avant : les migrations s'appliquent au redémarrage.

```bash
git pull
rv up --build -d
```

## Limites connues

- **Petite plage UDP pour le vocal.** LiveKit n'a que 21 ports UDP (50000-50020). Pour un groupe nombreux, élargir la plage dans `docker/livekit.yaml`, dans les ports du fichier de prod et dans le pare-feu.
- **Serveur pilote.** Le chiffrement de bout en bout a été activé avant sa revue indépendante ([RFC 0002](rfcs/0002-e2ee-native.md)).

## Check-list

- [ ] DNS `chat.` et `voice.` vers l'IP publique
- [ ] Docker et Compose 2.24.4+, Caddy installés
- [ ] `docker/.env.native` rempli, mode 600, avec `RV_LIVEKIT_URL`
- [ ] `docker/compose.prod.yml` créé, alias `rv` en place
- [ ] `rv up --build -d`, tous les services en marche
- [ ] Caddyfile chargé, `/health/ready` répond en HTTPS
- [ ] `voice: true` dans `/.well-known/rocketvibe`
- [ ] Pare-feu : 22, 80, 443, 7881/tcp, 50000-50020/udp
- [ ] Compte admin créé, connexion depuis une app
- [ ] Un appel vocal entre deux appareils sur des réseaux différents
- [ ] Sauvegarde planifiée, clé des facteurs mise à l'abri

## Sources

- [apps/server/README.md](../apps/server/README.md)
- [docker/compose.rocketvibe.yml](../docker/compose.rocketvibe.yml), [docker/compose.voice.yml](../docker/compose.voice.yml), [docker/livekit.yaml](../docker/livekit.yaml)
- [docs/protocol/VOICE.md](protocol/VOICE.md), [AUTHENTICATION.md](protocol/AUTHENTICATION.md), [EMAIL.md](protocol/EMAIL.md), [PUSH.md](protocol/PUSH.md)
