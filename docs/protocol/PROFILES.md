# Profils et réglages natifs — P16

Le socle serveur et les transports sont disponibles. La fiche publique et les
avatars mobiles sont raccordés aux interfaces existantes. L'éditeur personnel,
les préférences et les clients GTK / SwiftUI restent en cours ; le masque général
`profiles` reste désactivé jusqu'à leur raccordement complet.

## Lectures et confidentialité

- `GET /api/v1/me` conserve le DTO `User` v1 utilisé pour reprendre une session.
- `GET /api/v1/me/profile` renvoie `OwnProfile` : profil, préférences et adresse
  vérifiée personnelle. L'adresse se modifie par le parcours de vérification P02,
  jamais par une écriture de profil public.
- `GET /api/v1/users/{id}` et `GET /api/v1/users/lookup?username=…` renvoient
  `UserProfile` sans email ni préférences. Un compte authentifié peut consulter
  les profils de base ; les comptes désactivés sont indisponibles.
- Ces réponses sont `no-store`. Leur construction et leur remise vérifient
  encore la session, l'activation, la génération et la révision du profil.

`UserProfile.status` représente le statut **choisi**, conservé entre appareils.
La présence effectivement observée reste celle des baux P12. Les champs publics
sont le nom, le pseudo, la bio, le texte de statut et l'identifiant d'avatar.

## Commandes et concurrence

`PATCH /api/v1/me` accepte `UpdateProfile` : `operation_id`,
`expected_revision`, `username`, `display_name`, `bio`, `status`, `status_text`.
Les noms sont bornés à 256 octets, la bio à 4096, le texte de statut à 512.
Le pseudo conserve les règles d'inscription (1–128 caractères ASCII,
alphanumériques, `_` et `-`). Un changement de pseudo exige une session récente
ou une réauthentification P02 avec le facteur du compte ; un doublon renvoie
`username_taken`. L'identifiant du compte et les références existantes restent
stables après changement de pseudo.

`PATCH /api/v1/me/preferences` accepte `UpdatePreferences` : langue
`auto` / `fr` / `en`, horloge 24h, activation des push, mentions seules et
notifications bureau `default` / `all` / `mention` / `nothing`. Ce stockage
prépare les paramètres des consommateurs ; il n'annonce pas le service push P17.
Sa révision est indépendante des changements du profil public.

Les deux commandes, la pose et le retrait d'avatar partagent un espace de reçus
**personnel aux commandes P16** et un budget de 20 mutations par minute.
Un reçu ne contient que `operation_id` et `applied_revision`. Le même identifiant
avec le même contenu retrouve le reçu initial, même après une modification plus
récente ; il ne remet jamais les anciennes valeurs. Un contenu divergent renvoie
`operation_conflict`, une révision périmée `revision_conflict`. Les clients doivent
conserver l'intention originale pendant le retry et relire le profil courant.
Les champs supplémentaires d'une commande sont refusés.

Le choix de statut ajuste tous les baux actifs. Un ancien appareil qui renouvelle
`online` respecte aussi le choix courant `away`, `busy` ou `offline`. Le retrait
du bail d'un seul appareil reste distinct du choix global `offline`.

## Avatars protégés et volume durable

- `PUT /api/v1/me/avatar?operation_id=…&expected_revision=…` reçoit le corps brut
  PNG ou JPEG et son `Content-Type`. `DELETE` sur le même chemin retire la photo.
- Taille d'entrée maximale : **2 Mio** ; dimensions maximales : **2048 × 2048**.
  Deux décodages simultanés au plus, mémoire de décodage configurée à 32 Mio.
  Les limites de dimensions sont strictes ; la limite mémoire du décodeur est
  une limite au mieux, conformément à la [bibliothèque image](https://docs.rs/image/0.25.10/image/struct.Limits.html).
  Le résultat est réduit à 512 × 512 au plus, sans agrandir les petites images,
  puis réencodé en PNG sans métadonnées ni contenu ajouté au fichier original.
- Une réservation SQL validée avant le décodage fait consommer le budget même
  à une image malformée. Le décodeur ne conserve aucun verrou de compte.
  La session et la révision sont vérifiées à nouveau avant de publier le résultat.
- `GET /api/v1/avatars/{avatar_file_id}` exige le bearer en en-tête. L'identifiant
  est opaque, l'URL ne contient aucun credential. Seule une photo actuellement
  référencée par un compte actif est servie ; le remplacement / retrait invalide
  immédiatement l'ancienne URL, même si une suppression physique a échoué.
- La remise conserve les verrous de session et de référence jusqu'à la soumission
  du corps, avec le délai de livraison commun de cinq secondes. Réponse PNG,
  `no-store`, `nosniff`, sans redirection ni lecture d'un chemin utilisateur.

`RV_OBJECTS_DIR` / `--objects-dir` choisit un volume local, par défaut
`data/objects`. Le Compose natif monte `native-objects`. Le serveur finalise
l'objet immuable, synchronise le fichier et, sous Unix, le répertoire avant la
référence SQL. Un échec disque ne produit pas de succès ni de référence nouvelle.
Un crash entre finalisation et commit laisse un objet orphelin, récupérable après
une heure par le nettoyage borné ; les photos actives sont conservées. Ce volume
doit être sauvegardé avec PostgreSQL dans le lot d'exploitation J5.

La découverte annonce `profiles`; `profile_avatars` est une capacité additive
séparée, vraie lorsque le stockage est configuré. Les photos live incluent les
`ProfileStamp` de soi et des membres de salons partagés, dans la limite commune
de 512 observations, afin de rafraîchir identités et versions de cache. Ces
informations temporaires ne modifient pas le curseur ni le journal durable ;
les anciens clients v1 ignorent le champ ajouté.

## Vérifications et travail restant

Les scénarios PostgreSQL / HTTP couvrent la confidentialité, les conflits de
révision, les reçus rejoués, le changement de pseudo, l'expiration de preuve,
les préférences indépendantes, le statut conservé, la finalisation disque, le
retrait des anciennes URLs, les pannes disque, le nettoyage et les limites.
Les transports mobiles sont vérifiés avec le contrat JSON Schema généré, le
corps binaire, les en-têtes d'authentification et le cooldown partagé.

La fiche publique mobile lit chaque serveur par son fournisseur, depuis un UID
stable ou une mention. Le préchargement borne son tampon à 64 fiches et refuse
cache / navigation après changement de compte. Les stamps live mettent à jour
les pseudos et versions de photos dans `utilisateurs`, sans étendre l'historique
ni avancer le curseur. Une réponse de profil antérieure à un stamp est refusée.

Les tuiles d'avatars existantes chargent les octets via le transport natif
(`Bearer`, redirections refusées), puis affichent une URI PNG locale. Aucune URL
d'image ne porte un credential natif. Le cache applicatif reste en mémoire, par
fournisseur : 128 entrées, 32 Mio de caractères d'image et quatre téléchargements
simultanés au plus. Retrait / remplacement efface les pixels et refuse une
réponse tardive ; une identité disparue de la photo live provoque une relecture
autorisée si sa photo est encore affichée. La fermeture du fournisseur purge le
cache. Aucun fichier d'avatar n'est ajouté au stockage du téléphone par ce cache.

Le banc HTTP / PostgreSQL / WebSocket / SQLite exécute ce même fournisseur :
fiche / préchargement, avatar protégé, renommage, retrait, DM par UID stable et
purge de compte. Les tests ciblés couvrent aussi les réponses tardives et la
limite de concurrence. Ce banc n'est pas une qualification de l'écran Android.

Restent les intentions de modification persistantes, l'éditeur personnel et les
préférences mobiles, les fiches / réglages / caches GTK et SwiftUI, puis les
validations sur applications installées. P16 ne peut être déclaré livré avant
ces étapes.
