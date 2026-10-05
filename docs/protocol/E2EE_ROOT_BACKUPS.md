# Sauvegarde chiffrée de la racine de compte

Extension expérimentale de [RFC 0002](../rfcs/0002-e2ee-native.md).
La capacité E2EE de production reste désactivée. Le serveur utilise uniquement
`rv-crypto-public` ; il ne reçoit ni code de récupération, ni clé privée, ni
état MLS. Le format AEAD existant est décrit dans
[RECOVERY.md](../../crates/rv-crypto/RECOVERY.md).

## API et preuve publique

| Requête | Résultat |
|---|---|
| `GET /api/v1/e2ee/root-backup` | Portée actuelle et paquet actif éventuel, pour le compte authentifié seulement |
| `POST /api/v1/e2ee/root-backup` | Publication signée et reçu de la version acceptée |
| `GET /api/v1/e2ee/root-backup/operations/{operation}` | Reçu original de cet appareil HTTP, même après remplacement du paquet actif |

Les lectures passent les barrières d'authentification / livraison et sont
`no-store`. Un nouvel appareil HTTP peut télécharger le paquet du propriétaire
sans être déjà inscrit en E2EE. Ce téléchargement ne crée aucune clé ou confiance.
Il ne donne pas accès aux reçus d'un autre appareil.

La publication JSON contient le paquet opaque et une signature Ed25519 de la
racine sur `rocketvibe-root-backup-publication-v1`, NUL, puis le JSON compact
du corps dans l'ordre v1 : version, portée, opération, appareil, incarnation,
révision de certificat, version active attendue, SHA-256 du paquet canonique.
Les révisions sont des chaînes décimales positives exactes, jusqu'à `i64::MAX`.
Le paquet est limité à 24 Kio et la publication à 32 Kio avant base64url.
Les champs inconnus et les champs secrets sont refusés.

Une nouvelle publication exige la racine enregistrée, le même appareil HTTP,
son incarnation / révision enregistrées, une preuve racine valide et une
connexion récente satisfaisant les facteurs du compte. Un ancien certificat
peut autoriser cette action de racine ; il ne permet aucun nouvel envoi MLS.
Un administrateur ou un détenteur de bearer sans clé racine ne peuvent fabriquer
la preuve. Le quota est de 64 nouvelles opérations par jour et appareil.

Le verrou de racine sérialise CAS, quota et déduplication. La version active
attendue doit correspondre exactement, y compris l'absence initiale ; une
publication concurrente différente reçoit `backup_revision_conflict`. Le paquet
actif et le reçu original sont écrits dans la même transaction. Un même ID et
les mêmes octets rendent le même reçu ; une substitution reçoit
`operation_conflict`. Le reçu original est accessible sans répéter la cérémonie
de connexion récente et pendant le délai de throttling des publications.

## Coffre local et récupération

Le coordinateur partagé lie un aperçu opaque à la portée, au certificat / reçu
du contrôleur et à la version active observée. La confirmation crée une clé de
récupération et un paquet aléatoires, puis sauvegarde l'intention signée et la
clé dans les **records chiffrés du coffre**, avant de rendre la main.
Le code d'affichage n'est jamais enregistré comme chaîne UI. Il est rendu
temporairement, seulement sur demande explicite. Aucun statut ne le contient.

L'intention HTTP n'est disponible qu'après confirmation explicite que le code
est conservé. Après réouverture, code et intention sont identiques. Un reçu
exact règle l'intention et retire sa clé temporaire du coffre. Le renouvellement
du certificat attend ce règlement. Une panne de checkpoint ne rend pas le code
avant confirmation de la persistance ; la reprise retrouve le même paquet.

Le client relit d'abord le reçu original. Seule une absence positive permet
de republier l'intention originale ; une erreur réseau ne permet pas de générer
un autre paquet. Une sauvegarde concurrente et l'abandon d'une intention
incertaine nécessitent encore leur parcours explicite de règlement dans les
adaptateurs / interfaces.

La saisie du code vérifie AEAD, clé racine et empreinte attendue avant toute
initialisation du coffre. La confirmation importe uniquement la racine dans un
coffre neuf, puis crée une nouvelle feuille / incarnation et sa demande d'ajout.
Le rejeu exact de la restauration conserve cette feuille et les records créés
depuis ; un coffre préexistant sans reçu de cette restauration est refusé.
Aucun ancien ratchet, pin, révocation, fichier ou historique n'est importé.
Un nouveau Welcome autorisé reste nécessaire pour chaque groupe.

Une restauration serveur expose sa nouvelle portée tout en conservant le
paquet actif historique pour la récupération de racine. Elle refuse les
intentions et reçus d'opération de l'ancienne époque.

## Qualification et suite

Les vecteurs publics sont vérifiés par Rust et indépendamment par Node /
OpenSSL ; leurs octets opaques servent à la vérification de signature seulement.
Les tests privés utilisent de vrais paquets AEAD. Les scénarios PostgreSQL
couvrent concurrence / CAS, reçu après remplacement, substitution / portée /
contrôleur, connexion récente, quota et réponse HTTP perdue suivie du GET sans
second POST. Leur exécution réelle passe par la CI PostgreSQL.

Restent le raccordement FFI / Keystore Android et aux paramètres existants
GTK / SwiftUI / Android, la qualification installée et la revue indépendante.
L'archive historique nécessite son propre format et ses propres clés.
Changer le code ou remplacer le paquet actif n'invalide aucune ancienne copie
et son ancien code. Aucune garantie de forward secrecy n'est annoncée pour
cette sauvegarde récupérable.
