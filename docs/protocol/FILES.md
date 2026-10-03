# Fichiers natifs — P14 / J3

Le serveur et les transports Rust / TypeScript disposent du cycle de fichiers
clairs. `uploads` est annoncée quand le volume d'objets est présent. Les clients
croisent cette annonce avec leurs propres capacités : outboxes, caches protégés,
pièces jointes et lecteurs. Le mobile utilise désormais sa file et ses composants
existants ; son bouton exige aussi le module natif de transfert. GTK / SwiftUI
restent à raccorder. La qualification sur appareils reste ouverte.

## Réservation, octets et message

Toutes les routes exigent `Authorization: Bearer …` et restent sur l'origine
épinglée. Aucun URL tiers ou credential en query n'est accepté.

| Méthode | Route sous `/api/v1` | Résultat |
|---|---|---|
| POST | `/uploads` | `PrepareUpload` → réservation `Upload` |
| GET | `/uploads/{id}` | État privé de la réservation |
| PUT | `/uploads/{id}/bytes` | Corps binaire → état `ready` |
| POST | `/uploads/{id}/complete` | `CompleteUpload` → message confirmé |
| DELETE | `/uploads/{id}` | Abandon avant confirmation |
| GET | `/files/{id}` | Octets protégés du fichier confirmé |

`PrepareUpload` porte une opération persistante, salon, taille décimale,
SHA-256 hexadécimal, type MIME, nom et `encrypted:false`. Le nom n'est jamais
utilisé comme chemin sur le volume. La réponse comprend `id`, `file`, `state`,
`expires_at` et `message_id`. États : `prepared`, `ready`, `completed`,
`cancelled`, `expired`.

Une même préparation retrouve la même réservation sans prolonger son expiration.
Des arguments différents sous son ID sont refusés. L'upload est lié à l'UID,
la génération et la durée de vie de l'adhésion ; quitter puis rejoindre ne
réactive pas une ancienne intention. Les droits de rédaction sont contrôlés
avant et après le transfert.

Les octets vont dans un objet temporaire. Taille réelle, empreinte et signature
du format déclaré sont vérifiées. Fichier et répertoire sont synchronisés avant
de publier la référence PostgreSQL. Une interruption permet de recommencer le
transfert entier ; aucune reprise par morceaux n'est promise. Un upload prêt
retrouve son état sans réécrire ses octets. Un transfert concurrent reçoit
`upload_in_progress` ; sa lease persistante expire après un crash.

La confirmation utilise une autre identité persistante et un contenu `plain`
avec `files:[upload_id]`, Markdown, citations et racine de fil facultative.
Les mentions sont résolues par le serveur depuis le texte. Message, fichier,
journal, lectures et lien de réservation sont confirmés dans la même transaction.
Réponse perdue ou confirmations concurrentes retrouvent le même message ; un
reçu ne restaure pas une ancienne légende après édition. Une légende vide reste
possible. L'abandon concurrent n'est pas annulé par la fin tardive du transfert.

Les descripteurs accompagnent historique, snapshots et journal. Les messages
texte antérieurs restent valides sans ce champ. Une suppression expose un
tombstone sans fichiers et coupe le téléchargement. Les fichiers cités restent
un raccordement J3.

## Remise et politique du pilote

Le téléchargement exige une confirmation, une adhésion actuelle et un message
vivant. L'administrateur d'application n'a pas d'accès privé implicite.
Avant chaque trame de 256 Kio, le serveur revérifie compte, session, génération,
politique et adhésion puis conserve leur lease jusqu'à la soumission. Une lease
expire en cinq secondes même pour un corps non consommé. Retrait, logout ou
tombstone coupe la suite ; les octets déjà remis restent détenus par le lecteur.

Les plages `Range` simples rendent `206` et `Content-Range` ; une plage invalide
est refusée. Réponses : `no-store`, `nosniff`, `Content-Disposition: attachment`
avec nom encodé. Le SDK Rust expose un corps d'upload streamé et une réponse à
consommer en chunks ; le transport portable TypeScript vérifie taille et MIME.
Le raccordement mobile utilisera son transport natif vers le cache pour les
grands fichiers.

Politique fixe actuelle : 1 octet à 100 Mio par objet, dix réservations non
terminées par compte, trente préparations par minute, expiration après 24 h.
Un verrou interprocessus borne à 50 Gio la somme des fichiers confirmés et
réservations non libérées ; une réservation expirée reste comptée jusqu'à son
nettoyage sous verrou, afin qu'une confirmation en cours ne puisse dépasser
le quota. Ce quota logique exclut avatars et orphelins.
Quatre transferts par processus, durée complète 120 s, attente d'un chunk
d'upload 10 s ; SDK 150 s. J5 exposera les réglages d'exploitation.

Types acceptés : octets génériques, texte, PDF, ZIP, PNG, JPEG, GIF, WebP, MP3,
Ogg, WAV, MP4 / M4A, MOV et WebM. Leurs signatures ne valident pas complètement
un codec. HTML et SVG ne sont pas des types déclarés acceptés. Les fichiers
chiffrés restent désactivés jusqu'au protocole J4 ; ses DTO opaques ne l'activent pas.

Les réservations expirées libèrent leur référence. Le collecteur des avatars
retire les objets non référencés après une heure et parcourt aussi les objets
actifs. Une écriture finalisée suivie d'un rollback reste un orphelin, sans
message ni route publique. Les fichiers confirmés sont conservés jusqu'à la
politique de rétention J5, y compris après suppression du message.

## Validation et suite

### Desktop dans les interfaces existantes

GTK et SwiftUI utilisent les composeurs, la progression et les actions retry /
abandon actuels. `native_file_intents` conserve une copie privée streamée,
son empreinte, l'adhésion et les IDs de préparation / confirmation avant le réseau.
Une réponse perdue reprend l'intention originale ; une confirmation rejouée
projette le message courant, y compris après édition ou suppression. L'abandon
est durable et ne masque pas une confirmation qui a déjà gagné la course.
Une réservation prouvée expirée reste en échec ; Retry prépare une nouvelle
réservation en conservant l'identité du message.

Les manifests sont traduits vers les pièces jointes existantes. Les URI
`rv-file:` sont des handles locaux sans jeton. Les downloads passent par le SDK,
vers un `.part` privé vérifié par taille / SHA-256 avant publication. Chaque
réutilisation exige un Range authentifié ; generation, adhésion et tombstone
ferment l'accès. Les lecteurs Swift reçoivent le chemin privé du cœur, sans copie
publique intermédiaire. Les lecteurs GTK et les modales Swift retirent leur
contenu quand le droit local disparaît. Cache limité à 32 fichiers / 512 Mio,
prévisualisation mémoire à 32 Mio et quatre downloads simultanés. Les résultats
de recherche conservent des manifests temporaires bornés, sans ajouter d'historique.

Les tests sur SQLite réouvrent l'outbox après deux réponses perdues et vérifient
les frontières d'adhésion / génération. Le banc PostgreSQL réel vérifie un upload
streamé, une source modifiée après sélection, redémarrage, abandon hors ligne,
cache / sauvegarde, refus d'un autre compte et tombstone. Sous Xvfb, le composeur
GTK existant produit sa carte et ouvre le fichier protégé. Les modèles Swift
réels et leur Secret Service couvrent envoi, lecteurs et abandon. Ces bancs
n'attestent pas les codecs audio / vidéo ni les applications installées.

### Mobile dans l'interface existante

La migration SQLite 0030 conserve le fichier privé d'origine, son empreinte,
l'adhésion et les identifiants distincts de préparation / confirmation avec la
ligne `televersements` existante. Les retries et la progression utilisent les
contrôles actuels. Un abandon hors ligne est persisté puis prouvé côté serveur :
une confirmation déjà exécutée est récupérée, sans prétendre l'annuler.

Le module Expo `transfert-fichier` transmet les octets depuis le disque sous
Android / iOS, avec progression, annulation, deadline et redirections désactivées.
Il nécessite une reconstruction native de l'app ; son absence désactive le bouton.
Le download Expo reçoit les chunks dans un `.part` privé, contrôle taille / SHA-256,
puis publie le fichier local. Les lecteurs et la feuille de partage reçoivent ce
chemin, sans jeton dans leurs URLs. La réutilisation du cache exige un Range
authentifié ; fermeture, changement d'adhésion / génération et tombstone retirent
les accès. Les résultats de recherche peuvent ouvrir un fichier sans devenir de
l'historique confirmé. Les copies d'envoi sont séparées par compte / génération.
Le nettoyage retire les générations antérieures et les copies abandonnées.

Le vrai moteur mobile / HTTP / PostgreSQL / SQLite est rouvert après perte de
chacune des trois réponses : une seule confirmation visible à chaque fois.
L'abandon hors ligne est aussi repris sans message. Tests ciblés : 103 scénarios
TypeScript, incluant projection, citations, refus d'intégrité et contrôle d'origine.
Typecheck / lint et export Android réussis ; autolinking du module vérifié.
Cet export n'est pas un APK et ne valide pas la compilation Kotlin / iOS ni les
lecteurs sur appareils. Ces qualifications restent explicitement ouvertes.

Sept scénarios PostgreSQL couvrent concurrence, perte de réponse dans le vrai
transport TypeScript, streaming du SDK Rust, taille / intégrité / type, transfert
incomplet, abandon en cours, expiration, quotas, génération / réadhésion,
confidentialité, tombstones, légende vide et arrêt entre deux trames après retrait.
Les messages, profils / avatars, contrats et compatibilité du cœur bureau restent
vérifiés. Les tests SDK TypeScript contrôlent headers, redirections et troncature.

La sortie de P14 exige encore fichiers cités et qualification installée des
trois interfaces, dont les codecs et la compilation du module mobile. J4 complète
les fichiers chiffrés ; J5 ajoute
configuration, rétention, sauvegarde / restauration du volume et capacité.
