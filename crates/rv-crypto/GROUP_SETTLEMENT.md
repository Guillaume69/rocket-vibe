# Règlement des transitions de groupe

Le coordinateur conserve chaque `GroupSubmission` préparé dans le coffre avant
HTTP, avec l'état OpenMLS. La décision d'abandon est checkpoint avant son appel
réseau. L'outbox ne se libère qu'après comparaison du reçu terminal avec
l'original : portée complète, opération, appareil auteur et empreinte signée.
Signature, digests du commit / arbre / Welcomes et identité locale sont
revérifiés. Une signature historique ne permet aucun nouvel envoi.

`Coordinator::request_group_cancellation` fournit l'original checkpointé ou la
décision déjà connue, y compris sans la feature HTTP. `Worker::cancel_group(room, operation)` renvoie `GroupSettlement::Accepted` ou
`Cancelled`. Une acceptation déjà durable gagne toujours. `resume_group` reprend
l'abandon demandé après coupure ; il ne republie pas cette transition. Les
marqueurs terminaux permettent le rejeu local de `cancel_group` et interdisent
de préparer une autre intention avec le même ID. Une erreur réseau, un reçu
substitué ou une réponse non checkpointée ne libère aucun commit.

Un abandon de genèse supprime son groupe OpenMLS non accepté et son état local,
puis exige une nouvelle opération et une nouvelle confirmation pour le groupe
suivant. Une rotation / ajout abandonné efface seulement le commit préparé ;
l'époque acceptée, les ratchets et les références de packages acceptées restent
intacts. Les packages d'un ajout jamais accepté ne deviennent pas consommés.

Un successeur valide reçu d'un pair peut remplacer le commit préparé. L'original
public incertain reste alors dans le coffre, disponible après redémarrage. Une
nouvelle transition propre est bloquée jusqu'à son règlement. Un statut 404
n'autorise pas sa republication depuis le nouvel état MLS. Son abandon libère
l'intention sans toucher au groupe accepté. Si le serveur prétend avoir accepté
cet ancien fork, le coordinateur refuse de remplacer l'état courant. Une
confirmation propre déjà acceptée ne peut être supplantée par un fork de pair.

Une rotation acceptée après démarrage du journal garde le commit préparé jusqu'à
sa position native. Le reçu HTTP terminal est mémorisé, mais il ne supprime pas
l'époque avec messages non lus. Réception, marqueur terminal éventuel, état MLS
et curseur partagent la transaction protégée ; tout refus tardif les annule.

Le registre est lié à l'instance, l'époque des données, l'utilisateur,
l'appareil / incarnation et la racine de compte du coffre. Son horloge interdit
de recommencer une genèse à une date antérieure après suppression de son état.
Les anciens états sans registre sont enregistrés avant règlement ou succession.
Les bornes sont 16 intentions incertaines, une par salon, 8192 marqueurs et 8 MiB
par registre ; les limites globales du coffre peuvent refuser plus tôt. Aucun
marqueur n'est supprimé pour rendre un ancien ID réutilisable.

Le serveur garde le marqueur sans commit / arbre / Welcome, sous le même verrou
que l'acceptation ; [contrat HTTP](../../docs/protocol/E2EE_GROUPS.md). Sa décision
HTTP authentifiée n'est pas une preuve cryptographique de non-acceptation.
Les quotas et refus transitoires ne déclenchent pas d'abandon automatique.

[La réadmission avec nouveau Welcome](READMISSION.md) dans le même coffre est
ajoutée séparément. Projection dans les interfaces existantes,
archives / fichiers, pont Android, qualification des trousseaux / appareils et
revue indépendante restent ouverts. `capabilities.e2ee` reste désactivé.
