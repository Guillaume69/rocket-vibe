# Transitions MLS protégées

`groups::Commit` porte la transition signée, son vrai commit TLS, le reçu et les
versions de salon / adhésions observées indépendamment. `preview_commit` valide
le successeur dans un fournisseur temporaire ; `accept_commit` répète cette
validation et conserve état MLS, reçu et invalidation de l'outbox concurrente
dans la même transaction protégée. Rien n'est remis avant le checkpoint.

## Préparation du successeur

`groups::Change` fournit le roster courant observé indépendamment, la tête
serveur complète, l'opération, les IDs d'appareils à retirer explicitement et
leurs nouveaux KeyPackages publics. `preview_change` exige cette tête identique
au reçu local accepté et vérifie l'ancien arbre réel avant confirmation. Un
état hors ligne périmé doit rattraper les événements avant préparation.

Sans ajout ni retrait, le parcours fait une vraie rotation de feuille. Ajouts,
retraits et remplacements Remove+Add sont inclus dans un seul commit, même avec
des nombres différents. L'auteur reste admis ; un retrait local relève du
parcours distinct à intégrer. Tous les utilisateurs du roster doivent être
représentés. Un nonce d'accès / activation changé interdit de conserver une
ancienne admission : les appareils concernés doivent être retirés et réadmis
avec packages frais. Les références déjà observées restent interdites.

Les appareils conservés gardent leur identité, indice et référence initiale de
package, avec certificat courant et pins approuvés. Un appareil retiré peut
déjà être révoqué ou expiré. Le certificat local renouvelé est installé dans la
véritable feuille MLS par les paramètres du commit ; sa racine, incarnation et
clé de signature doivent rester les mêmes. Les autres appareils vérifient
ensuite le certificat renouvelé par le parcours de réception.

La confirmation opaque lie demande, état accepté, pins, certificat local et
échéance de cinq minutes au maximum. Les indices des nouveaux destinataires
dans le preview sont provisoires ; le plan signé emploie les vrais indices
du PublicGroup validé après préparation. Le contexte, arbre, époque et chaque
feuille sont contrôlés avant persistance. Les entrées sont bornées avant copie
et hash ; l'ordre des retraits ou packages ne modifie pas l'identité de demande.
Les propositions MLS déjà en attente sont refusées, sans ajout implicite.

`prepare_change` conserve état MLS préparé, preuve, arbre, commit et Welcomes
originaux dans la même transaction protégée avant toute remise au réseau.
L'époque acceptée demeure ancienne jusqu'au reçu exact. Réouverture, réponse
perdue et checkpoint interrompu reprennent les mêmes octets ; une demande
différente ne remplace pas l'outbox. Le retry original reste possible après
expiration du preview seulement si certificat et confiance sont toujours
valides. Le reçu historique exact demeure réconciliable séparément.

## Validation et réception

La preuve doit désigner exactement la portée du coffre et son groupe, le parent
accepté, la révision et l'époque précédentes, ainsi que les versions de politique
et membres observées. Le reçu lie la preuve et son opération. OpenMLS authentifie
et déchiffre ensuite le message : un contenu applicatif, une proposition isolée,
un auteur externe, une auto-exclusion ou une proposition PSK sont refusés dans
ce parcours. Un retrait propre de cette installation et sa réadmission par un
nouveau Welcome restent des parcours à intégrer, sans héritage implicite.

Le véritable auteur MLS doit correspondre à la racine / appareil / incarnation
et clé de signature du certificat déclarant la transition, avec son indice
réel. Une signature de preuve valide ne suffit pas à attribuer le commit d'un
autre membre. Un certificat renouvelé peut garder sa clé ; sa preuve courante
reste soumise aux pins et révocations. Après fusion, contexte, arbre, époque,
indices, certificats et clés de **chaque** feuille correspondent à la preuve.
Les appareils distants exigent leurs approbations locales persistantes.

Une admission conservée garde ses nonces, identité, indice et référence initiale
de package. Un membre réactivé / revenu ou un appareil déplacé exige un vrai
ajout MLS avec nouveau package et Welcome déclaré. Le moteur compare la référence
RFC 9420 au package réellement couvert par la proposition Add ; les Welcomes
déclarés concernent exactement les nouvelles admissions. Changer les nonces
locaux exige une réadmission distincte : les anciennes ratchets ne deviennent
pas celles de la nouvelle adhésion.

Les références observées dans les états acceptés sont conservées après retrait
du membre. Une nouvelle admission ne peut pas réutiliser une telle référence,
même après disparition de la feuille. Cette mémoire est bornée à 8 192 références
par incarnation de groupe, sans éviction qui rendrait un ancien package réutilisable.
Le document reste borné à 8 Mio ; le coffre global à 16 Mio. Les anciennes
genèses / admissions sans cet index le reconstruisent depuis leur plan accepté.
Ce cache ne prétend pas connaître des références antérieures jamais observées
par cette installation ; le serveur conserve également ses références dépensées.

## Données authentifiées du commit

La genèse préparée par le coffre utilise désormais les AAD de ce profil pour
son commit d'ajout. La réception exige ces mêmes octets authentifiés. Les AAD
sont le préfixe UTF-8 `rocketvibe-mls-commit-routing-v1`, un octet nul, puis le
JSON compact sérialisé dans cet ordre :

`version`, `scope`, `operation`, `expected_revision`, `expected_epoch`, `epoch`,
`previous`, `authority_version`, `members`, `devices`.

Les champs reprennent les types et ordres du plan signé, avec `version = 1`.
Les appareils sont triés par ID et contiennent, dans cet ordre : `user`, `device`,
`incarnation`, `root`, `certificate`, `key_package`. Les empreintes sont les
tableaux de 32 octets du plan, l'incarnation ses 16 octets ; l'absence de référence
est `null`. Les membres gardent l'ordre canonique de leurs UID. Les entiers
sont sérialisés exactement par Rust, sans passage par un nombre JavaScript.

Les indices de feuilles, contexte / arbre / commit et digests de Welcomes sont
exclus : leurs valeurs finales dépendent du commit en préparation et créeraient
une dépendance circulaire. Le moteur vérifie séparément ces déclarations avec
les véritables résultats MLS. L'opération, les nonces, destinataires et références
restent authentifiés par le commit ; une preuve re-signée pour une autre
opération ne peut pas réattribuer son ciphertext original.

Ce profil client demeure expérimental et désactivé. Le serveur livre des octets
opaques ; sa validation publique ne prouve pas les AAD ou le contenu MLS. Les
fixtures de preuve publique ne revendiquent pas cette validation privée.

## Commit concurrent et reprise

Le coffre vérifie son commit local en attente contre son état préparé. Un
successeur reçu différent peut le remplacer après validation complète et
confirmation. Les previews, TLS altérés et refus applicatifs tardifs annulent
également les mutations OpenMLS : ils ne suppriment pas l'outbox précédente.
Après succès, un ACK tardif du commit remplacé ne réactive pas cet ancien fork.

L'écho exact de sa propre préparation conserve son état original sans essayer
de déchiffrer son propre PrivateMessage. Le reçu exact peut aussi être traité
par `confirm`, désormais valable après une genèse déjà active. Le dernier ACK
historique peut être répété après interruption / expiration / révocation, sans
transformer ce diagnostic d'état en autorisation d'envoyer. Une nouvelle
transition exige à nouveau les versions, pins et certificats valides.

Les groupes rejoints conservent la configuration d'extension d'arbre, nécessaire
à la préparation ultérieure d'un vrai GroupInfo et à sa vérification publique.

## Preuves et travail restant

Onze scénarios utilisent de vrais coffres / commits MLS : rotations et secrets
identiques après réouverture, ajout / retrait, approbations, nonces réactivés,
vrai remplacement avec package frais, preuve re-signée mais faux contexte /
arbre / index / auteur / AAD / Welcome, référence déclarée différente de l'Add,
réutilisation après retrait, ciphertext applicatif à la place d'un commit,
conflit entre deux préparations, rollback après fusion, ACK propre et récupération
après checkpoint perdu. Les bornes, reçus changés et consentements périmés sont
également refusés. La suite complète conserve les scénarios antérieurs.

Onze scénarios de préparation supplémentaires passent par l'API du coordinateur,
avec vrais coffres et commits : rotation / retry exact, ajout et retrait révoqué,
deux retraits avec un ajout, nonces réactivés, approbations et références dépensées,
ancien head, certificat renouvelé dans la vraie feuille, checkpoint perdu,
bounds et historique de références plein, puis rotation d'un singleton à
l'époque zéro avant admission. La suite complète compte 90 tests réussis,
plus l'enfant de crash exécuté par son parent.

Conversion des événements HTTP vers le moteur et ordonnanceur réseau restent
à livrer. Cette réception
vise un successeur correspondant aux versions observées ; le rattrapage complet
de pages à travers des changements d'adhésion, Welcome initial ancien, retrait
local / retour et nouvelles incarnations reste ouvert. L'outbox et l'inbox des
messages, les fichiers / archives / import, pont Android et interfaces existantes,
qualifications des appareils / trousseaux et revue indépendante restent les
conditions de J4. Aucune capacité E2EE n'est activée.
