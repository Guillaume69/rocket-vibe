# Citations natives — P07

Les premiers lots livrent les références, leur résolution côté serveur et le
caches bureau commun GTK / SwiftUI et mobile. La capacité
`quotes` reste désactivée tant que les adaptateurs et caches des trois interfaces
existantes ne satisfont pas les règles ci-dessous. Les cartes, menus et bandeaux
de réponse actuels seront réutilisés.

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

## Raccordement suivant et conditions de sortie

Les adaptateurs doivent traduire les références vers les cartes de citation
existantes, avec un libellé explicite pour
les références indisponibles. Le cache des extraits doit rester distinct de la révision publique
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
Les éditions d'une réponse citante doivent conserver ses références dans la
commande durable, y compris après suppression ou perte d'accès à la source.

Les citations imbriquées, fichiers cités et aperçus protégés restent à raccorder
avec leur contrôle d'accès ; les fichiers sont liés à J3. Les essais installés
Android / macOS / Windows restent ouverts. Ces lots ne clôturent pas P07.
