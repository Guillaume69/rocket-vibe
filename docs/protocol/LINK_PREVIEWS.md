# Aperçus de liens natifs — P15

Le serveur ajoute `Message.previews`, une liste optionnelle de trois aperçus au
maximum, à ses lectures et au journal de synchronisation. Le texte et la position
d'origine restent inchangés ; la publication des métadonnées avance la révision,
sans marquer le message comme édité.

## Contrat

Chaque aperçu porte le lien d'origine, `kind` (`page` ou `image`), un titre de
512 octets au plus, une description de 2 048 octets et un site de 256 octets.
Les chaînes sont du texte, sans HTML ni contenu exécutable. Le lien d'origine
reste la cible de navigation, même après une redirection de collecte.

Une image porte `file_id`, SHA-256, poids décimal exact, dimensions et type PNG.
L'identifiant opaque est distinct de l'empreinte. La ressource est accessible par
`GET /api/v1/messages/{message}/previews/{file_id}` avec le bearer du compte.
Le lecteur vérifie la session, l'accès actuel au salon et la présence de cette
image dans le message courant. Édition, suppression et retrait du salon peuvent
donc retirer l'accès à un objet conservé sur disque. La réponse est `no-store` et
`nosniff` ; les verrous d'autorisation couvrent la remise du corps HTTP.

Le transport Rust vérifie type, taille, SHA-256 et dimensions PNG. Il construit
lui-même le chemin sur l'origine native ; une URL distante n'est jamais utilisée
pour envoyer le bearer.

## Collecte et limites

Les liens viennent de la structure Markdown du message en clair. Code,
citations, images Markdown et activités système ne sont pas collectés.
L'envoi et chaque édition remplacent atomiquement les tâches du message par une
nouvelle génération. Les tâches vivent dix minutes, avec trois tentatives au
maximum, un bail d'une minute et quatre collectes concurrentes par processus.
Les processus partagent les baux PostgreSQL. Aucun accès réseau n'est fait dans
une transaction SQL ; la publication vérifie génération, epoch, compte,
adhésion et bail, puis émet un événement normal du journal.

Seuls HTTP et HTTPS sur les ports 80/443 sont collectés. Userinfo, réseaux privés,
loopback, link-local, multicast, adresses de documentation, IPv6 de transition et
espaces non alloués sont refusés. La politique est conservatrice et exclut aussi
quelques affectations spéciales publiques. Chaque réponse DNS doit contenir au
plus 64 adresses, toutes publiques. Le client est épinglé sur ces adresses avec
l'hôte original pour HTTP et TLS : aucun second DNS implicite n'est utilisé.

Chaque redirection est validée et résolue à nouveau, au plus quatre fois ; une
descente HTTPS vers HTTP est refusée. Proxy automatique, cookies, authentification
et Referer sont absents. Les réponses compressées sont refusées. DNS : trois
secondes ; requête : huit secondes ; collecte complète : vingt-quatre secondes.

HTML/XHTML : 512 Kio, au plus 512 balises meta lues. OpenGraph, Twitter et titre
HTML sont parsés avec un parseur HTML, sans exécution ni confiance dans `base`.
Une vignette relative est résolue sur la page finale, puis suit la même politique
réseau. PNG/JPEG/GIF/WebP : deux Mio en entrée, allocation de décodage bornée,
normalisation statique en PNG de 1 200 × 1 200 au plus et quatre Mio en sortie.
SVG et formats non pris en charge sont refusés. Une vignette invalide laisse
disponible une carte textuelle dont le titre est valable.

La politique réseau suit les recommandations de
[l'OWASP](https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html)
et les registres spéciaux
[IPv4](https://www.iana.org/assignments/iana-ipv4-special-registry) /
[IPv6](https://www.iana.org/assignments/iana-ipv6-special-registry) de l'IANA.

## État de livraison

Le contrat, la collecte, les tâches durables, la publication et le lecteur Rust
sont implémentés. Les tests ciblés exercent les politiques réseau, DNS mixtes,
redirections, limites de corps, parsing, normalisation, baux, reprises, éditions,
suppression, changement d'epoch et lectures privées HTTP / SDK réelles.

P15 reste ouvert : projection dans les cartes existantes mobile / GTK / SwiftUI,
caches protégés et invalidation côté client, métadonnées des lecteurs vidéo et
cartes structurées d'intégration. La capacité `link_previews` reste désactivée
tant que ces raccordements ne sont pas livrés. Aucun nouveau client ni renderer
n'est introduit. Les aperçus E2EE seront construits côté client après déchiffrement.
