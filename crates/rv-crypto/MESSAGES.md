# Messages applicatifs protégés

Lot expérimental du coordinateur privé `groups::Coordinator`, hors des apps.
`capabilities.e2ee` reste désactivé. Les [routes serveur et le journal opaque](../../docs/protocol/E2EE_MESSAGES.md)
existent séparément. Le [worker privé HTTP](GROUP_HTTP.md) raccorde maintenant
envoi / reprise et réception. Le [journal protégé](JOURNAL.md) ajoute les pages
communes aux transitions et messages, leur checkpoint et le rattrapage sur
la même admission, y compris les signatures de feuilles expirées après
renouvellement du lecteur. Réadmission après retrait et apps restent ouverts.

## Authentification et contenu

`rv-crypto-public::messages` définit un en-tête canonique : instance / génération,
salon / incarnation de groupe, opération, révision / époque / empreinte de tête,
auteur / appareil / incarnation / certificat, genre `chat` et fil éventuel.
L'en-tête entier devient l'AAD du vrai `PrivateMessage` MLS. Une preuve externe
signée par l'appareil lie cet en-tête, son certificat et le SHA-256 du ciphertext.
Les nouveaux envois exigent un certificat valide à la date d'observation.
Le journal historique authentifie aussi les signatures de feuilles expirées,
avec lecteur courant et pins / révocations actuels, selon [JOURNAL.md](JOURNAL.md).
La preuve permet une
vérification publique de routage ; elle ne remplace pas la vérification privée
de l'auteur MLS, de l'AAD, des destinataires et du contenu déchiffré.

`Proof::from_bytes` vérifie bornes, forme et encodage canonique. Seul `verify`
authentifie le certificat et la signature, puis vérifie le type / groupe / époque
du véritable message TLS. Décoder ou calculer une empreinte ne confère aucune
confiance. La réception compare aussi le certificat du vrai auteur MLS et sa
feuille à la liste active, puis l'AAD exact à l'en-tête externe.

Le document privé versionné reprend `rv_protocol::SendMessage` : texte Markdown,
réponse dans un fil, références de citations avec révision décimale exacte et
cartes d'intégration. Les cartes et références restent dans le ciphertext ;
l'identifiant du fil reste une métadonnée de routage visible. Les descripteurs
de fichiers, éditions / suppressions et archives ne sont pas couverts par ce lot.
La validation du document est bornée avant copie et identique avant chiffrement
et après déchiffrement. Le contenu doit être canonique et correspondre à
l'opération / au fil authentifiés.

## Envoi et reçu

`MessageObservation` exige tête et roster indépendamment observés, identiques
à l'état actif protégé. Pins, certificats, véritables feuilles MLS et adhésion
courante sont revérifiés. Aucun message nouveau ou renvoyé ne passe avec rekey
nécessaire, transition locale ou propositions MLS en attente. Une rotation
locale attend également la confirmation des messages déjà préparés.

`prepare_message` chiffre une seule fois puis conserve, dans le même commit
protégé, la consommation de génération MLS, le ciphertext original, la preuve,
le document privé et l'autorisation de réception. Les octets ne sortent qu'après
checkpoint externe confirmé. La même intention ou `retry_message` renvoient
exactement ces octets ; le même ID avec un autre contenu ne rechiffre pas.

`pending_message` fournit uniquement les métadonnées publiques d'une demande
de reçu, même après expiration ou révocation. `confirm_message` exige tous les
champs originaux et la même empreinte ; ID serveur et position du premier reçu
deviennent immuables. Un ACK historique exact ne redonne aucun droit d'envoi.
Le reçu utilise une position `u64` bornée à `i64::MAX` ; l'adaptateur HTTP / JS
devra l'exposer en chaîne décimale, sans conversion par un nombre JavaScript.

## Réception et réouverture

`receive_message` consomme le vrai message MLS, vérifie son auteur, son contenu
et sa portée, puis conserve ensemble ratchet, preuve / ciphertext, document
privé, reçu et dernière position reçue. Le clair n'est rendu qu'après checkpoint.
Un refus tardif annule aussi la consommation de génération. La réouverture
retrouve un résultat confirmé sans redéchiffrement et sans nouvelle génération.

Un écho de son propre envoi ne passe que par les octets originaux de l'outbox
protégée : `OwnPrivateMessage` est explicitement non authentifié par OpenMLS.
Une identité d'opération oubliée ou un ciphertext propre inconnu ne recrée donc
pas de clair. Un écho confirmé déjà conservé peut être relu après rotation si
l'autorisation personnelle reste identique ; cela ne permet pas de déchiffrer
un nouveau message d'une époque passée.

Une opération nouvelle avec position antérieure à la dernière position reçue
est refusée avant consommation. Le rejeu exact d'un résultat conservé ne peut
pas faire reculer cette position. Cette valeur ne constitue pas à elle seule un
curseur complet : le journal protégé valide et checkpoint les pages communes,
y compris les commits entre messages. La projection des apps reste à raccorder.
Les positions peuvent présenter des écarts pour d'autres événements natifs.

## Bornes et preuves

Preuve publique ≤ 16 Kio ; ciphertext ≤ 128 Kio ; document privé ≤ 64 Kio ;
registre privé ≤ 4 Mio avec 64 contenus conservés, 8 192 identités d'opération
et 1 024 positions de groupe. Les limites du coffre global restent applicables.
`forget_message` exige un reçu exact et retire le contenu privé / ciphertext ;
l'identité et l'empreinte du reçu restent mémorisées. Aucun contenu en attente
n'est évincé automatiquement. Une borne atteinte suspend explicitement les
nouvelles opérations ; la politique d'archive / purge à long terme reste ouverte.

Les scénarios utilisent de vrais groupes certifiés et coffres SQLite rouverts,
avec checkpoint externe simulé : échange riche, écho exact, ACK perdu / altéré,
checkpoint d'envoi / réception refusé, fausse AAD / auteur MLS, document tardivement
refusé, ciphertext altéré, propre ciphertext inconnu, rotation réellement préparée,
ordre des positions, bornes et libération explicite du cache. Ils ne qualifient
ni le réseau des messages ni les appareils / trousseaux physiques.

Le lot initial de dix scénarios passe ; sa suite privée complète comptait 111 succès en
164,33 s sous Linux. Le seul enfant ignoré est exécuté et tué par son parent de
crash. L'arithmétique `curve25519-dalek` du profil test est optimisée, avec les
assertions du coordinateur conservées ; aucun scénario n'est retiré pour gagner
du temps. Le profil de production et le journal des apps ne changent pas.

```sh
cargo test --locked --manifest-path crates/rv-crypto/Cargo.toml --target-dir target --features system-keystore,native-http groups::tests::application_messages
```

Suite : politique d'historique des appareils révoqués, réadmission après retrait,
refus définitifs / nouvelles opérations, archive / fichiers, pont Android et
fournisseurs des interfaces existantes, revue crypto et qualifications natives.
