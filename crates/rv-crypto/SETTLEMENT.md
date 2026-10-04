# Règlement définitif des envois personnels

État au 4 octobre 2026 : serveur / SDKs / worker expérimental livrés ; pas de
nouveau parcours dans les interfaces, capacité E2EE toujours désactivée.
[Contrat serveur](../../docs/protocol/E2EE_MESSAGES.md).

`Worker::cancel_message(operation)` reprend l'intention opaque exacte depuis
le coffre et checkpoint d'abord son intention d'abandon, puis appelle la route
personnelle. `resume_message` reprend cette décision après redémarrage : aucun
nouveau POST d'envoi, même si la coupure précède l'arrivée de l'abandon au serveur.
Un résultat d'abandon y retourne `crypto_message_cancelled` après checkpoint ;
le document reste accessible via `cancelled_message`. Le worker ne cherche pas de
nouveau roster, ne rechiffre pas le document et n'exige pas que le certificat
original soit encore valide. La portée de compte / données et les gardes d'arrêt
du worker restent obligatoires ; aucun réseau ne tient le bail du coffre.

Un résultat `MessageSettlement::Accepted` est comparé à la preuve originale et
checkpoint comme une confirmation normale. Un résultat `Cancelled` exige les
mêmes Header et empreinte, puis inscrit un marqueur terminal dans le ledger
privé. Les labels HTTP sont canoniques et bornés. Les reçus sont des décisions
du serveur authentifié : ils ne prouvent pas sa bonne foi ou l'absence de
publication cachée.

Une erreur réseau, un mauvais reçu ou un checkpoint non confirmé ne rend pas
l'abandon disponible au fournisseur. Le même appel peut être rejoué après
réouverture. Une panne de checkpoint externe après le commit SQLite peut avoir
déjà enregistré la décision ; le coffre la récupère et son rejeu est idempotent.
Le certificat expiré ne bloque ni cette réconciliation ni le corps personnel
conservé. L'horloge monotone privée interdit toujours un retour temporel.

Le marqueur d'abandon interdit retry, préparation avec l'ancien ID, ACK tardif
et écho contradictoire. Il libère le verrou des messages pendants qui empêchait
une rotation propre. Il ne retire aucun message déjà confirmé. La génération
MLS consommée par la préparation reste consommée ; le pair peut recevoir la
génération suivante en sautant celle abandonnée.
Les bornes de saut de génération d'OpenMLS restent en vigueur : de longs
enchaînements d'abandons exigent une rotation, avec une politique à raccorder
au fournisseur. Ce lot n'augmente pas ces bornes et ne prouve que le saut testé.

`Coordinator::cancelled_message` rend le document personnel conservé dans un
buffer privé effacé à sa destruction. Le fournisseur devra le récupérer dans
son propre stockage protégé avant `forget_cancelled_message`. Le marqueur
terminal survit à cet effacement. Un nouvel envoi exige une nouvelle opération,
une observation / clé actuelles et les contrôles habituels. Aucun journal,
projection ordinaire, notification ou texte serveur n'est écrit par l'abandon.

Un statut personnel `409 crypto_message_cancelled`, par exemple après abandon
depuis une autre session du compte, provoque la récupération du reçu exact
contre la preuve protégée. Le code d'erreur seul ne suffit pas à libérer l'outbox.
Les anciens ledgers sans champs `cancelled` / `cancelling` restent lisibles. Les bornes du
ledger restent 64 corps et 8192 identités ; un corps abandonné n'est pas
automatiquement effacé. Les refus transitoires ne sont jamais convertis en
abandon automatique. Le [règlement des transitions préparées](GROUP_SETTLEMENT.md)
possède son propre original et ses marqueurs terminaux. Retrait / nouvelle
admission du groupe, projection privée dans les apps, archives / fichiers,
qualification des appareils et revue indépendante restent ouverts.
