# Citations natives — P07

Les références, leur résolution côté serveur, les caches bureau commun
GTK / SwiftUI et mobile, et les corps d'intention durables sont livrés. La capacité
`quotes` active les actions de réponse des trois interfaces existantes : cartes,
menus, bandeaux et composeurs sont réutilisés, y compris les citations imbriquées
sur deux niveaux. Qualification des applications installées et parité complète
des citations privées restent ouvertes ; ce lot ne ferme pas P07.

## Citations privées expérimentales — GTK / SwiftUI / Android

Les menus de réponse, bandeaux et cartes existants peuvent maintenant citer un
message conservé dans le journal privé, racine ou réponse de fil. Le composeur
garde une sélection transitoire liée à l'instance, à sa génération, à la durée
d'adhésion publique et à l'admission personnelle du coffre. Une nouvelle commande
revérifie cette sélection avant de préparer le document MLS ; seuls les trois
champs de `QuoteReference` sont dans ce document, jamais l'auteur ou l'extrait.
Dans ce premier format privé immuable, la révision observée est la position
signée de publication, conservée comme chaîne décimale exacte.

Une citation seule est possible. Après réponse perdue, reprise et réouverture
consultent le reçu de l'original protégé ; elles ne resélectionnent pas sa source
et ne rechiffrent pas son document. Le SDK borne les références à huit sources
distinctes ; les composeurs actuels sélectionnent une citation à la fois.

Le lecteur résout les sources retenues, y compris les réponses de fil, depuis
le même préfixe privé vérifié. Les observations sont regroupées par salon source.
Chaque source doit conserver son adhésion et son admission ; une relecture avant
exposition masque les sources retirées, sans récupérer leurs mots dans SQLite.
Les noms peuvent réutiliser les identités publiques déjà connues. Les extraits
sont bornés à 1 024 caractères Unicode, les descendants à deux niveaux et les
cycles à leur couple salon / message. Un parent inaccessible ne révèle aucun
enfant. La liste privée est reconstruite sur toute sa fenêtre retenue pour ne
pas conserver une ancienne carte après retrait d'un autre salon.

Sur Android, la feuille d'actions ouvre une vue privée volatile avant toute
lecture SQL du message. « Répondre » transmet uniquement la sélection au
composeur ; son aperçu est reconstruit depuis un accès frais au coffre. Blur,
suspension et retrait effacent ses mots tout en gardant la référence pour
validation ou annulation. La copie relit également le message privé courant.
Une sélection portant une admission crypto est refusée par la file SQL
ordinaire, avant toute écriture. Aucun texte privé ne transite dans les
paramètres de navigation.

### Sources en clair dans une conversation chiffrée

Les lecteurs GTK / SwiftUI / Android réunissent maintenant les sources du
coffre et les extraits ordinaires déjà conservés. La lecture ordinaire est
bornée aux identifiants demandés, à la génération de cache et à l’adhésion
actuelle ; le salon source doit être connu et non chiffré. Une ancienne ligne
SQLite d’un salon devenu chiffré ne sert jamais de source privée. Les extraits
du cache portent leur révision publique courante et seulement les références
de leurs descendants. Les mots d’un descendant privé sont reconstruits dans
la carte volatile depuis son propre coffre, jamais enregistrés dans ce parent.
Relecture avant exposition, deux niveaux et cycles par salon / message
restent appliqués. Source éditée : nouvel extrait ; source retirée ou d’une
ancienne adhésion : parent indisponible et aucun descendant. Un retrait qui
invalide la projection ferme la vue ; une nouvelle vue reconstruit les cartes.

Le SDK bureau et UniFFI peuvent aussi sélectionner une source ordinaire pour
un document MLS, après vérification de sa révision et de son adhésion. Seules
ses références sont envoyées. La sélection distingue explicitement source
ordinaire et admission protégée ; effacer l’admission d’une sélection privée
ne la rend pas ordinaire. Après réponse perdue, le même ciphertext reste
repris par reçu, même si la source a changé.

Android prépare aussi des références en clair dans le document MLS : le runner
revalide les sources exactes dans le cache ordinaire, leur scope, statut non
chiffré, adhésion et révision, puis les relit avant la commande native. Il passe
au pont un témoin par salon portant seulement adhésion et références. Aucun
extrait n’est inclus dans ce témoin ou dans l’intention protégée. Rust vérifie
scope, bornes, unicité et correspondance exacte des témoins ; une source déjà
connue comme groupe protégé, même en attente ou retiré, ne peut devenir claire
en supprimant son admission. La confiance du témoin clair vient de l’adaptateur
de cache authentifié, pas d’une signature MLS de l’auteur ordinaire.

La feuille d’actions Android existante permet de choisir une destination où
l’utilisateur a le droit d’envoyer, parmi les conversations rejointes. Les
sources privées restent limitées aux destinations chiffrées. L’ouverture du
composeur n’envoie rien ; il relit les aperçus et conserve uniquement la sélection
à sa fermeture. Les sélecteurs intersalons bureau et les cartes privées dans
les salons ordinaires restent à raccorder. Ces parcours ne transmettent aucun
extrait privé à d’autres membres.

Parité complète des citations mixtes, fichiers cités, sources
hors de la fenêtre retenue, évolution des révisions avec l'édition privée et
qualification GUI installée restent ouverts. La capacité E2EE de production
reste désactivée ; ce lot ne ferme ni P07 ni J4.

## Commandes et reçus

`SendMessage.quotes` est une liste optionnelle de `QuoteReference` :
`room_id`, `message_id`, `revision`. Une commande d'édition utilise la même liste
dans `MessageContent::Plain`. Aucun auteur, extrait, droit ou pièce jointe calculée
n'est accepté dans ces références. Une ancienne commande sans `quotes` conserve
son comportement et son empreinte de rejeu.

Une commande accepte jusqu'à huit références distinctes. IDs et révisions sont
validés ; les révisions sont des chaînes décimales positives exactes. Un message
ne se cite pas lui-même. Une citation seule est possible sans texte de réponse.
À l'ajout, la source doit exister, être lisible par l'auteur et porter la révision
observée ; sinon la commande échoue sans publication. `quote_revision_conflict`
demande une nouvelle sélection de la source. Les verrous de salons sont acquis
dans l'ordre des IDs, avant adhésions, messages et séquenceur.

L'identité durable inclut la liste ordonnée des références. Un renvoi divergent
échoue avec `operation_conflict` ; le renvoi original conserve son résultat même
après édition ou suppression de la source. Une édition peut conserver une
référence existante devenue inaccessible, sans conserver son extrait privé.

## Lectures et autorisation

`Message.quotes` contient des `MessageQuote` : `reference`, `excerpt`,
`view_position` et `source_membership_version`. L'extrait
est absent (`null`) si la source est supprimée ou inaccessible au lecteur.
L'administration de l'instance ne contourne pas l'adhésion au salon source.
Une référence inaccessible ne contient ni texte ni identité de l'auteur source.

Un `QuoteExcerpt` autorisé contient auteur, texte borné à 1 024 caractères Unicode,
date, révision **actuelle** de la source et `membership_version` du lecteur dans
le salon source. La référence conserve la révision observée lors de la sélection.
L'extrait suit le contenu actuel ; une ancienne copie du texte n'est pas conservée
dans le message de réponse. Les références ne déclenchent aucune mention.

L'extrait porte aussi les `references` actuelles de sa source et les `quotes`
résolues pour ce lecteur. Les deux listes sont additives et vides par défaut.
Le serveur résout au plus deux niveaux, avec huit références par source : une
réponse porte au plus huit extraits directs et soixante-quatre enfants. Le niveau
terminal conserve les références de sa source mais aucun extrait supplémentaire.
Chaque enfant possède sa propre position et son propre droit d'accès ; lire la
source parente ne donne pas accès à ses citations privées. Un parent inaccessible
ne divulgue aucune référence enfant. Les messages système ne sont pas citables.

Chaque résolution porte une `view_position`, chaîne décimale exacte du journal
d'instance, même quand l'extrait est absent. La source, l'adhésion et cette position
sont lus dans une seule vue SQL. `source_membership_version` est présent si le
lecteur appartient au salon source, y compris après suppression du message cité ;
il est absent sans adhésion. Quand l'extrait existe, ses deux durées d'adhésion
doivent correspondre. Ces champs n'entrent pas dans l'événement partagé.

La table PostgreSQL des messages et le journal partagé ne reçoivent pas de copie
d'extrait serveur : les
événements SQL gardent les références. Historique, message, épingles / étoiles,
snapshot et rattrapage HTTP / WebSocket calculent l'extrait pour le lecteur.
Les snapshots matérialisés personnalisés incluent ces extraits dans leurs budgets
et sont invalidés au changement de contenu ou d'accès à la source.

La preuve de remise couvre le salon de destination et chaque salon source dont
un extrait ou une durée d'adhésion est inclus. Elle revérifie identité d'instance, compte / session,
adhésion et version d'autorité, puis garde les verrous jusqu'à la soumission du
corps HTTP ou au flush WebSocket. Retrait / réadhésion ou modification de la
source pendant la construction de la réponse empêchent la remise des anciens
octets ; la vérification porte sur la source même si la destination reste lisible.

## Caches existants bureau et mobile

SQLite garde les références ordonnées séparément des vues de leurs sources.
Une vue mémorise salon, durée d'adhésion, position de résolution et extrait
nullable. Les réponses d'historique ou d'action peuvent actualiser la vue source
même si la révision publique de la réponse citante est inchangée ou plus ancienne.
Elles ne remplacent jamais les références d'une réponse plus récente.

Une édition / suppression reçue de la source actualise les cartes dans tous les
salons. Un résultat indisponible gagne une égalité de position. Un retrait ou une
nouvelle adhésion purge les extraits de l'origine dans les autres salons ; le
jeton de projection existant écarte les anciens appels HTTP. Une absence d'adhésion
datée avant la nouvelle adhésion ne purge pas ses données. Un reset de snapshot
reconstruit les extraits pour ne pas conserver une suppression manquée.

Une ligne source garde seulement son extrait et ses références ; elle ne garde
jamais de copie du texte de ses descendants. Les cartes imbriquées sont rebâties
depuis les lignes source, avec contrôle de chaque adhésion, limite de profondeur
et coupure des cycles. Le cache mobile actualise aussi les réponses dépendant
indirectement d'une source modifiée ou retirée, dans la transaction existante.
Les charges source conservées après un retrait ne contiennent donc aucun texte
privé descendant, et une réponse tardive ne le restaure pas après réouverture.

Les fournisseurs projettent les références et vues autorisées vers les pièces locales
déjà consommées par `content::quotes`, les modèles Swift et le composant mobile
`Citation`. SQLite mobile actualise `messages.pieces_jointes` dans la transaction
de projection / curseur ; ses listeners existants actualisent les listes ouvertes.
La migration additive conserve l'historique et les positions exactes déjà présents.
Le protocole ne porte
aucun arbre Rocket.Chat ni permalien Rocket.Chat. Les cartes existantes gardent
le Markdown de l'extrait, et une référence indisponible ne garde ni auteur ni
texte. Les notifications de cache existantes actualisent les salons ouverts.
Le texte natif est conservé même s'il ressemble à un ancien préfixe de citation
Rocket.Chat ; les citations officielles gardent leur traitement historique.

## Intentions d'édition existantes

Les commandes d'édition bureau et mobile capturent les références ordonnées dans
la même transaction que le texte et l'identifiant d'opération. La révision attendue
doit correspondre à la réponse actuellement projetée. Les références restent
lisibles après perte d'accès ou suppression de la source, sans copier son extrait
ni sa durée d'adhésion dans la commande. Une projection plus récente, un reset ou
une réouverture SQLite ne reconstruisent pas le corps d'une opération en attente.
Les adaptateurs le transmettent au champ `content.quotes` du protocole natif.
Si le cache contient déjà une autre révision, l'intention est conservée en échec
avec `revision_conflict` et ses mots restent disponibles dans le formulaire ;
aucune référence d'une version différente n'est capturée ni envoyée.

La migration additive marque les anciennes commandes par une colonne nullable.
Une ancienne édition sans corps capturé s'arrête avant l'appel réseau ; son texte
reste disponible dans le formulaire actuel et une nouvelle soumission crée une
nouvelle opération. Cette limite évite de changer silencieusement le corps d'une
clé qui a pu être acceptée avant la coupure. Les autres anciennes actions restent
rejouables. Le fournisseur Rocket.Chat et les interfaces d'édition restent inchangés.

## Files d'envoi natives existantes

Le cœur bureau et le moteur mobile capturent une sélection depuis un message
confirmé du cache, avec sa révision exacte, l'instance / génération et l'adhésion
de la source. La transaction de mise en file revérifie cette sélection et, si
fourni, le contexte d'adhésion du composeur de destination. Sources optimistes,
supprimées, anciennes adhésions, autres générations et références dupliquées sont
refusées avant de publier l'intention locale.

Seules les références ordonnées sont persistées dans le corps envoyé. Une citation
seule peut être mise en file ; le même identifiant et le même corps sont transmis
à `SendMessage` après réouverture ou reset, même si l'accès à la source a depuis
disparu. Les cartes optimistes utilisent le cache de vues existant et perdent leur
extrait lors du retrait. Confirmation, suppression de l'intention et curseur restent
transactionnels ; abandon et changement de génération purgent les lignes associées.
Les anciennes intentions texte migrent avec une liste vide sans modifier leur rejeu.

Le pont UniFFI expose cette sélection et l'envoi lié à l'adhésion pour les modèles
Swift existants. Le parcours du fournisseur mobile, HTTP / PostgreSQL et SQLite vérifie réponse
perdue après commit, retrait de source, reprise du corps original, message unique,
conflit après édition et nouvelle sélection. Les trois menus et composeurs sont
raccordés aux références natives. Rocket.Chat conserve ses permaliens et son
affichage optimiste historique. Une sélection native seule peut être envoyée
sans texte ajouté. Une mise en file refusée conserve les mots et la sélection
pour correction / annulation. Les aperçus ouverts perdent leurs mots et auteur
si la source n'est plus actuelle ou accessible ; une référence indisponible a un
libellé traduit dans les cartes existantes.

## Raccordement suivant et conditions de sortie

Une nouvelle référence vers un message MLS dans un salon ordinaire exige le
même contrôle de lecteur que le journal privé : session / certificat actuels,
incarnation, adhésion et activation, puis témoin exact de l’admission historique
au message. La révision attendue est sa position opaque. Le serveur ne renvoie
que la référence et le watermark d’adhésion ; aucun extrait privé, auteur,
ciphertext ou fichier ne rejoint la réponse ordinaire. Une opération déjà
acceptée conserve son reçu même après expiration du certificat.

Android résout ces références dans un lecteur natif distinct du composeur MLS,
sans préparation de message ni brouillon. Le rendu applique ses cartes après
le lissage de la liste ordinaire ; le cache SQL et le tampon de lissage ne
reçoivent aucun mot privé. Une relecture d’adhésion / admission précède leur
publication. Blur, suspension, remplacement de compte / génération et retrait
disposent les lecteurs et purgent aussi le bandeau du composeur.
Avant l’envoi ordinaire, ce lecteur valide scope, source et position conservée ;
une autorisation synchrone en mémoire et la transaction SQL revérifient sa
durée de vie et l’adhésion de la source. La file ordinaire reçoit exclusivement
les références. L’appel ordinaire sans lecteur continue à refuser une sélection
privée. Les lecteurs GTK / SwiftUI pour destinations ordinaires restent à raccorder.

Les adaptateurs traduisent les références vers les cartes de citation
existantes, avec un libellé explicite pour
les références indisponibles. Le cache des extraits reste distinct de la révision publique
de la réponse, suivre les révisions de la source et être lié à son adhésion.
Les positions de résolution ordonnent aussi les résultats sans extrait : une
ancienne réponse ne doit jamais restaurer le texte après une suppression ou un
retrait. À position égale, un résultat indisponible prévaut sur un extrait.
La position par défaut `0` d'un ancien prototype ne fournit aucune autorité
pour restaurer ou effacer le cache. Une réponse antérieure à une réadhésion ne
peut effacer l'extrait de la nouvelle adhésion.
Un retrait purge les extraits de cette origine jusque dans les autres salons ;
une réponse tardive de l'ancienne adhésion ne les restaure pas. Une édition ou
suppression reçue de la source actualise les citations déjà affichées ailleurs.
La file d'envoi durable conserve les références, sans capturer un droit ni un
extrait comme autorité. Les scénarios de perte de réponse et de reprise doivent
traverser les vrais caches mobile / desktop et les modèles Swift.
Les commandes durables d'édition conservent maintenant les références ; le
raccordement de l'envoi depuis les contrôles de réponse existants est livré.

Les fichiers cités sont raccordés aux cartes et lecteurs protégés des trois
clients : [contrat P14](FILES.md#fichiers-cités). Le cache conserve les fichiers
de chaque source dans sa propre adhésion, même sans message source en historique.
Un parent ne conserve pas les métadonnées privées de ses descendants.
Les essais installés
Android / macOS / Windows restent ouverts. Ces lots ne clôturent pas P07.
