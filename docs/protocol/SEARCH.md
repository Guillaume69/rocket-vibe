# Recherche native dans un salon — P13 / J2

`GET /api/v1/rooms/{room}/messages/search?q=…&before=…&limit=…` rend
`SearchPage { membership_version, messages, has_more }`. `before` est la
position décimale exacte du dernier résultat ; les pages sont triées de la plus
grande position à la plus petite, racines et réponses ensemble. Défaut et maximum :
50 résultats. La réponse reste limitée à 512 Kio ; une page écourtée conserve
`has_more`. Les écrans existants présentent les 50 premiers résultats, comme
leur recherche Rocket.Chat ; le protocole permet de poursuivre la pagination.

PostgreSQL utilise un vecteur `simple` généré à partir du texte écrit et un index
GIN. Tous les mots de la requête doivent être présents. Casse ignorée, accents
conservés ; pas de regex, syntaxe SQL, stemming ni opérateur booléen fourni par
le client. Limites : 256 octets, 16 mots, au moins un caractère alphanumérique.
Les messages supprimés et les événements système sont exclus de l'index.
Une édition actualise le vecteur dans sa transaction habituelle.

Seuls les membres actuels peuvent chercher dans un salon, public, privé ou DM.
Le rôle administrateur ne donne aucun accès implicite. La requête autorisée et
ses citations personnalisées sont lues dans une vue cohérente ; la barrière de
remise revalide session, génération et droits de chaque salon source avant de
transmettre. Le texte des citations d'un autre salon n'entre pas dans l'index
du message qui les cite. Requête, résultats et budget n'écrivent pas au journal.

Budget séparé : 20 recherches / minute / appareil, partagé entre processus via
une table UNLOGGED. `429 search_rate_limited` porte `Retry-After` ; le transport
mobile respecte ce délai. L'expiration du budget est nettoyée par lots. Les
lectures SQL sont bornées à deux secondes et les commandes de messagerie gardent
leurs propres budgets. Champs inconnus, limite excessive et position non
canonique sont refusés.

Les fournisseurs normalisent les résultats pour les mêmes lignes mobile,
panneaux GTK et modèles / vues SwiftUI. Ils ne les ajoutent pas à SQLite, à la
fenêtre d'historique, à l'outbox ou au curseur de synchronisation. La version
d'adhésion publique est vérifiée avant affichage. Édition, suppression, retrait,
nouvelle génération et suspension invalident les observations temporaires ; une
simple actualisation de lecture ne les périme pas. Le champ de recherche permet
une relance avec Entrée. Une réponse tardive de l'ancien compte ou de l'ancien
salon ne repeuple pas les résultats.

La capacité `search` expose cette recherche de texte en clair. RocketVibe
n'annonce pas encore `e2ee`. **La partie P13 / J4 reste ouverte** : index local
borné du contenu déchiffré disponible, indication de l'historique téléchargé,
effacement au verrouillage, à la suppression et selon la rétention. Elle doit
être intégrée au cycle des clés natif de J4 ; aucun plaintext chiffré n'est
envoyé au serveur pour contourner cette étape.

Qualification : scénarios PostgreSQL d'accès, pagination, Unicode, édition,
suppression et budget ; validation des pages et SQLite réel côté clients ;
parcours du fournisseur mobile réel et contrôles du panneau GTK et des modèles
Swift connectés. La qualification d'applications installées reste ouverte.
