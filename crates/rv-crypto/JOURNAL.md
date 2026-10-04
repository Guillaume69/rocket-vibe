# Journal protégé des groupes et messages

Lot expérimental J4, hors des interfaces actuelles. La capacité E2EE reste
désactivée. Le [journal serveur](../../docs/protocol/E2EE_MESSAGES.md) fournit
transitions et messages dans un ordre commun de positions natives décimales.

## Ordre et durabilité

Après genèse / admission explicitement acceptée, `Worker::journal_page(room)`
lit son curseur dans le coffre, demande une page, puis observe de nouveau le
roster et la tête courants. Le coordinateur vérifie la portée, l'admission,
la fenêtre fixe, les positions strictement croissantes et les labels exacts
des paquets avant consommation. Les positions peuvent avoir des écarts liés
aux autres événements natifs ; les révisions / parents des groupes restent
strictement chaînés par les transitions et le vrai MLS.

Le premier événement doit correspondre à la genèse / au Welcome déjà accepté.
Il n'est pas consommé une seconde fois. Commits suivants, messages, ratchets,
contenus privés et curseur complet sont enregistrés **dans une transaction
protégée par page**. Une signature invalide tardive annule aussi les lectures
et rotations antérieures de cette page. Aucun résultat clair ne sort avant
la protection et la relecture du checkpoint externe.

`JournalBatch` contient tête locale, `after`, `through`, `complete` et contenus
privés de la page. Avec `next`, le coffre conserve le même `through` pour la
reprise. Sans `next`, `after` devient `through`, y compris si la dernière
position livrée est inférieure à cette borne. Le constructeur du worker lie
toujours les données à l'instance / génération / compte / appareil du coffre.
Une restauration ou un changement de génération ne réutilise pas ce curseur.

Les octets du dernier lot restent dans le cache privé. Au redémarrage,
`Worker::journal_last_batch(room)` rend ce lot après nouvelle observation de
l'admission et vérification du checkpoint. Il ne redéchiffre pas et ne
consomme aucun ratchet. Le fournisseur doit projeter ce résultat avant
de demander la page suivante. La projection durable / confirmation côté apps
et l'historique privé au-delà du cache actuel constituent les lots suivants.
Aucun document clair ne doit entrer dans le cache SQLite public des apps.

## Autorisation et rotations

Chaque époque utilise son roster issu du plan signé, vérifié contre le vrai
arbre MLS et les racines / appareils déjà approuvés. Le roster courant ne
remplace pas silencieusement celui d'un événement historique. L'admission
personnelle doit cependant être identique dans le plan courant et dans
chaque époque : portée, membre / versions d'accès et d'activation, appareil,
incarnation, racine, feuille et KeyPackage original. Le renouvellement de
certificat ne change pas cette identité d'admission.

Un retrait / nouvel accès ou un remplacement d'appareil exige une nouvelle
admission ; l'ancien journal ne devient pas un historique du nouvel appareil.
Le consentement initial et l'approbation des pins restent requis. La lecture
d'un commit n'approche aucun nouveau pin et n'autorise aucun nouvel envoi.
L'envoi garde les contrôles de tête, roster, certificats et politique courants.

Lorsqu'un journal est commencé, `confirm` réconcilie l'ACK exact d'une rotation
locale sans fusionner immédiatement le commit. L'ancienne époque reste active
jusqu'à ce que la page traite les messages qui précèdent cette rotation, puis
fusionne le commit préparé original. La réception ordonnée peut donc lire un
message pendant cette attente ; les nouveaux envois restent suspendus.
Les API séparées `receive_message` et `accept_commit` refusent alors la
consommation qui contournerait cet ordre. Un compte déjà avancé hors journal
ne saute pas les anciens événements pour fabriquer un préfixe valide.

## Preuves et limites

Six scénarios avec vrai MLS / SQLite rouverts couvrent trois époques manquées,
reprise entre pages avec entiers supérieurs à `2^53`, fenêtre modifiée refusée,
signature tardive annulant tout le lot, métadonnées / positions / ordre
substitués, ACK de rotation locale avec message encore illisible, retrait
d'un autre membre et nouvel accès propre refusé. Un échec de checkpoint après
commit ne publie aucun clair ; la réouverture retrouve le lot privé original.
Ils passent ensemble en 3,86 s lors de la première vérification. Les gardes
refusant les consommateurs séparés sont également vérifiées sur ces groupes.

Un scénario HTTP supplémentaire perd la réponse de lecture avant réception,
rouvre le worker, retrouve le lot clair protégé et refuse des métadonnées de
salon valides sous une autre URL. Le curseur reste inchangé après refus.

Le vrai banc HTTP / PostgreSQL utilise maintenant ces pages et leur reprise
dans les deux coffres, avec six messages / trois époques et confirmations
perdues après commit réel. Les rotations attendent leur passage dans le
journal. Il passe en 30,15 s. SQL conserve six messages opaques et neuf trames,
sans document clair ni POST de message supplémentaire. Le checkpoint externe
de ce banc est simulé ; aucun essai sur appareil installé n'est revendiqué.
Formatage / Clippy strict passent avec `system-keystore,native-http` ; la suite
privée complète initiale du lot compte 124 succès en 157,95 s, avec l'enfant de
crash exécuté par son parent et aucun filtre. Le scénario HTTP de garde de
route est ajouté et vérifié séparément ensuite.
Après les gardes de route, les onze scénarios HTTP passent ensemble en 2,84 s,
les six scénarios du journal en 4,03 s et le banc réel est revérifié en 30,93 s.

Les certificats et pins restent vérifiés à la date réelle de réception.
Le rattrapage d'une feuille expirée / révoquée, la réadmission après retrait,
la découverte d'un ancien Welcome lorsque les autres grants ont changé,
les refus définitifs d'outbox, archives / fichiers et ponts des apps restent
ouverts. Le cache conserve au plus 64 documents ; il n'est pas une archive.

Le serveur peut retarder ou omettre des trames. Les positions allouées par le
serveur ne constituent pas une preuve cryptographique d'exhaustivité ou de
date de révocation. Cette implémentation refuse les incohérences reçues et
protège un préfixe de pages du journal autorisé ; elle ne promet pas de détecter
toute omission malveillante. La revue crypto indépendante reste nécessaire.
