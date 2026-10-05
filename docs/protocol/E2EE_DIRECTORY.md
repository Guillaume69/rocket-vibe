# Annuaire E2EE natif — premier lot de livraison J4

Ce lot publie des preuves **publiques**. Il ne permet pas encore l'envoi chiffré,
la création de groupe ou la livraison de Welcome. `capabilities.e2ee` reste faux.
Les interfaces et le fournisseur Rocket.Chat existants sont conservés.

| Route authentifiée | Résultat |
|---|---|
| `POST /api/v1/e2ee/devices` | Enregistrement / renouvellement / remplacement conditionnel du certificat de l'appareil de session courant |
| `POST /api/v1/e2ee/revocations` | Retrait signé par la racine, fermeture de la famille HTTP ciblée et reçu original du contrôleur |
| `POST /api/v1/e2ee/key-packages` | Vérification et publication atomique de 1–8 KeyPackages MLS TLS |
| `GET /api/v1/e2ee/users/{user}?after={position}` | Racine publique, appareils actifs et page de révocations signées |
| `GET /api/v1/e2ee/operations/{operation}` | Reçu original du compte et de l'appareil courants |

Les blobs utilisent base64url sans padding ; `request`, `grant`, `certificate`,
`root` et `signed` contiennent les formats JSON signés de `rv-crypto-public`.
Les KeyPackages contiennent la sérialisation TLS d'OpenMLS 0.9.0, suite 0x0001.
Les chaînes de révision et position sont des décimaux exacts, jamais des nombres
JavaScript. Décoder le DTO ne vérifie pas ses signatures ou sa confiance.

Pour le propriétaire authentifié, l'annuaire conserve aussi les certificats
expirés des appareils dont la session HTTP est encore active. Ces preuves
historiques permettent d'afficher l'expiration et de renouveler / retirer
l'incarnation précise. Les correspondants reçoivent seulement les certificats
actuellement valides ; une preuve historique ne permet pas un nouvel envoi MLS.

## Enregistrement

Le client conserve l'intention et son `operation_id` avant HTTP. La portée
instance / `data_epoch` doit correspondre à la base sous verrou. Le serveur
vérifie la demande signée par la feuille, le grant et le certificat signés par
la racine, et leur liaison exacte à l'UID et au `session_device` courant.
Le premier enregistrement exige les révisions attendues absentes ; les suivants
exigent l'empreinte de racine et la révision d'appareil observées.

La racine du compte ne change pas par cette API. Une session HTTP renouvelée
conserve son appareil. Un login neuf crée un autre appareil ; son certificat
exige l'approbation de la même racine. Le serveur ne fournit ni cette approbation,
ni une clé privée. Le premier enregistrement demeure un bootstrap TOFU : un
bearer volé avant celui-ci peut installer une autre racine. Les pins et la
vérification hors bande restent obligatoires côté correspondant.

Le renouvellement garde incarnation et clé et ne diminue pas les dates du
certificat. Remplacer l'incarnation exige une révocation de l'ancienne signée
par la racine. Cette révocation demeure en base ; les anciens packages sont
retirés et leurs références ne redeviennent jamais disponibles par publication.
Une racine changée, une confirmation périmée ou une incarnation révoquée est
refusée explicitement. La rotation de racine reste à intégrer ; cette route
ne remplace pas le retrait indépendant ci-dessous.

## Retrait indépendant

`RevokeDevice` porte la portée, l'ID original, la révision / incarnation du
contrôleur enregistré et un `Revocation` signé par la racine. La signature
désigne l'appareil et l'incarnation à retirer ; elle doit correspondre à la
racine courante du compte HTTP. Une connexion récente avec les facteurs
actuellement requis est nécessaire pour accepter une nouvelle opération.
Une racine / révision / incarnation substituée est refusée. L'expiration du
certificat du contrôleur ne retire pas son autorité de racine ; son appareil
HTTP et son inscription doivent toujours exister, sans retrait signé connu.

Le compte est sérialisé avant l'attribution de la position du retrait. Preuve
signée, retrait des packages et suppression de la famille HTTP sont dans le
même commit que le reçu. Une ancienne incarnation ne supprime pas la famille
d'une incarnation remplacée. Un appareil déjà déconnecté peut encore recevoir
son retrait permanent ; réémettre le même retrait ne le duplique pas.
Le contrôleur ne peut pas retirer sa propre incarnation actuelle par cette
route, afin de conserver l'accès au reçu après réponse perdue.

Le `OperationReceipt` de type `revoke_device` décrit le contrôleur émetteur,
avec `key_package_refs` vide. `GET /operations/{operation}` retrouve ce résultat
sans nouvel envoi et un rejeu exact reste lisible après la fenêtre de
réauthentification. Un ID réutilisé avec un autre retrait est refusé.
Ce transport ne fournit aucun consentement ou clé privée. Le coordinateur
protégé signe après confirmation de l'aperçu exact et sauvegarde le retrait
avec sa demande originale avant publication. Il mémorise aussi les retraits
reçus pour l'identité locale déjà établie. Omission ultérieure, réouverture ou
premier pin explicite tardif ne réautorisent pas l'incarnation. Aucun pin ou
accord d'appareil n'est créé implicitement. Le renouvellement du contrôleur
attend le règlement du retrait en attente. Les trois interfaces existantes
proposent confirmation et reprise ; leur qualification CI / installée reste
distincte. Les groupes concernés attendent leur commit MLS de retrait avant
reprise. La révocation d'une feuille ne retire pas une racine compromise.

## Packages et reçus

OpenMLS valide effectivement TLS, signatures et durée de vie ; le serveur
vérifie en plus le certificat et la clé de feuille, l'appareil actif, sa révision
et sa racine. Une référence est le `KeyPackageRef` RFC 9420, et un SHA-256 TLS
distinct garde l'intégrité de la publication. Le protocole expérimental de
[groupes](E2EE_GROUPS.md) consomme ensuite les références avec leur transition,
sans réservation par une simple lecture.

Une opération identique retrouve son reçu avant une nouvelle vérification
crypto, même si le certificat a expiré depuis. Ce reçu décrit l'opération passée
et ne réactive aucune clé. Réutiliser l'ID avec une autre intention est refusé.
Reçus et mutation sont dans le même commit PostgreSQL. Logout / suppression de
famille HTTP retire le certificat et les octets des packages, tout en gardant
les références retirées. Une restauration / nouvelle génération refuse les
anciennes intentions et reçus ; la procédure complète de restauration J5 doit
encore révoquer les sessions et réconcilier les états clients.

Limites : quatre workers crypto possédés par processus, y compris après abandon
HTTP ; 16 Kio TLS par package, 64 packages disponibles par appareil, 256 nouvelles
opérations par jour et appareil ; 64 appareils et 128 révocations par page.
Les requêtes de packages sont bornées à 256 Kio ; les autres à 64 Kio. Un lot
refusé ne laisse ni packages partiels ni reçu. Un `429` conserve `Retry-After` ;
les SDK laissent consulter les reçus pendant le délai. Les lectures sont privées,
`no-store`, et soumises aux barrières de livraison du serveur.

## Suite du lot

Liste de destinataires / adhésions signée, consommation unique liée au commit,
ordre / CAS et Welcomes ciblés sont implémentés dans le lot [groupes](E2EE_GROUPS.md).
Leur vérification, outbox durable et admission locale sont raccordées aux
écrans GTK / SwiftUI / Android existants. Qualification installée, historique
récupérable, fichiers / actions privés et revue dédiée restent ouverts. Les clés privées et le
secret de récupération ne doivent jamais entrer dans ce protocole serveur.
