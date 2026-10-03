# Administration native — P23

La CLI `rv-server` utilise le `DATABASE_URL` opérateur. Ce droit d'exploitation
est distinct du rôle administrateur dans une application : aucune route HTTP
ne permet à ce rôle de lire implicitement une conversation privée. Les commandes
de salons ne lisent ni messages, ni fichiers, ni clés de chiffrement.

## Comptes et invitations

`create-user <username> [--admin]` conserve le mot de passe dans
`RV_USER_PASSWORD`, hors des arguments. `invite`, `list-invitations`,
`revoke-invitation`, `recover-user`, `list-recovery-codes` et
`revoke-recovery-code` restent disponibles. Les secrets d'invitation et de
récupération sont rendus uniquement par leur commande d'émission ; leurs listes
et le journal d'audit n'en contiennent pas.

`list-users [--after <uid>] [--limit 50]` rend `{items,next}` avec UID, pseudo,
nom, statut actif, rôle administrateur, droits de création et version de
politique. Email, hash du mot de passe, bearer et facteurs sont exclus.

```sh
rv-server set-user <uid> --disabled true --operation-id suspend-account-001
rv-server set-user <uid> --disabled false --operation-id restore-account-001
rv-server set-user <uid> --admin true --revision <revision> --operation-id grant-admin-001
rv-server set-user <uid> --create-public-room false --operation-id creation-policy-001
```

Les champs absents sont conservés. Une version de politique fournie est
vérifiée sous verrou ; un conflit ne modifie rien. Un changement effectif
révoque les familles d'appareils, tickets et preuves associés, annule les
snapshots / curseurs et invalide les défis d'authentification. Le verrou du
compte attend la fin d'une remise HTTP / WebSocket déjà autorisée. Mot de passe,
facteurs, adresse vérifiée, identité, adhésions et historique sont conservés.
Réactiver le compte exige une nouvelle connexion et ses facteurs habituels ;
aucun ancien bearer n'est réactivé.

## Salons et membres

`list-rooms` rend les métadonnées, le nombre de membres, la version opaque de
réglages et la position de journal sous forme de chaîne. `list-members <rid>`
rend UID, pseudo, nom, rôle et désactivation. Ces listes acceptent `--after` et
`--limit` (1 à 100). Les UID sont utilisés pour agir même après un renommage.

```sh
rv-server create-room <owner-uid> 'Équipe' --private --operation-id create-team-001
rv-server set-room <rid> --revision <revision> --topic 'Planning' --read-only true --operation-id team-settings-001
rv-server set-member <rid> <uid> --revision <revision> --role moderator --operation-id team-moderator-001
rv-server set-member <rid> <uid> --revision <revision> --remove --operation-id team-remove-001
```

Les modifications de réglages / membres exigent la version courante. Le serveur
verrouille le salon, applique ses contraintes et publie un `RoomUpsert` dans le
journal commun. Le retrait publie aussi le `RoomRemoved` personnel et annule
les snapshots concernés. Une réadhésion possède un nouveau jeton d'accès.
Le dernier propriétaire ne peut être retiré ou rétrogradé ; transférer d'abord
la propriété. Le propriétaire d'un nouveau salon doit être actif. Les commandes
de réglages / membres refusent les DM, dont la paire reste immuable.

Le pouvoir opérateur permet de gérer un salon pour le compte d'un propriétaire,
y compris sa politique de création. Cette intervention est tracée séparément
des activités écrites par les membres ; elle ne fabrique pas un message attribué
à un utilisateur. Les parcours ordinaires de création, découverte, adhésion,
invitation et gestion continuent à appliquer les droits P04 dans les apps.

## Rejeu, audit et diagnostic

Les nouvelles commandes de mutation rendent un reçu
`{operation_id,subject_id,applied_revision}`. Fournir `--operation-id` avant
une commande permet de répéter exactement ses arguments après une réponse
perdue. Sans cet argument, la CLI génère un ID rendu dans le reçu.

Un reçu conservé se rejoue avant les vérifications de révision et ne réapplique
jamais l'ancien état. Ainsi, rejouer une ancienne désactivation après une
réactivation ne suspend pas une seconde fois le compte. Un même ID avec d'autres
arguments, ou après changement de génération, est refusé. Reçu, changement,
événements et audit sont validés dans la même transaction PostgreSQL.

`audit [--after <id>] [--limit 50]` rend des événements paginés : ID en chaîne,
date, rôle PostgreSQL effectif, génération, action, sujet, ID de commande et
métadonnées publiques avant / après. Les échecs ne produisent pas un événement
de succès ; un rejeu n'en ajoute pas. La création d'un compte et l'émission /
révocation des invitations ou codes de récupération sont également enregistrées
dans leur transaction. Le journal n'atteste pas l'identité humaine derrière
un compte PostgreSQL partagé. Sa conservation / sauvegarde appartient à J5.

`health` rend la disponibilité PostgreSQL, ses versions, instance / génération,
position du journal et nombres de comptes, salons et messages. Il ne rend ni
DSN, ni configuration SMTP, ni secret d'authentification. Les paramètres de
service restent fournis par les arguments / variables et fichiers privés du
serveur ; import et restauration seront raccordés dans J5.

## Validation

Les tests PostgreSQL couvrent la révocation et la réactivation conservant les
données, le verrou de remise, les reçus concurrents, les conflits, la limite de
pagination, l'absence d'accès privé implicite, le retrait / réadhésion et l'audit
sans secrets. Un scénario lance aussi le vrai binaire CLI sur la base isolée
du test pour vérifier les arguments, les reçus, les codes de sortie et JSON.
Ces scénarios complètent les validations P04 des parcours dans les apps ; la
qualification sur applications installées et l'exploitation J5 restent ouvertes.
