# Citations natives — P07

Les références plates, leur résolution côté serveur, les caches bureau commun
GTK / SwiftUI et mobile, et les corps d'intention durables sont livrés. La capacité
`quotes` active les actions de réponse des trois interfaces existantes : cartes,
menus, bandeaux et composeurs sont réutilisés. Citations imbriquées, fichiers cités
et qualification des applications installées restent ouverts ; ce lot ne ferme
pas P07.

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

Les citations imbriquées, fichiers cités et aperçus protégés restent à raccorder
avec leur contrôle d'accès ; les fichiers sont liés à J3. Les essais installés
Android / macOS / Windows restent ouverts. Ces lots ne clôturent pas P07.
