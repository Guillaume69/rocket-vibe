# Pont privé Android

Ce workspace indépendant expose le coffre de `rv-crypto` à Kotlin avec
UniFFI 0.32.2. Le serveur ne dépend pas de ce crate. Le moteur privé conserve
son interdiction de code `unsafe` ; les exports ABI générés restent ici.

Le module Expo local `apps/mobile/modules/crypto-native` utilise ces bindings.
Son API JavaScript expose le scope public, un handle terminal, l'état de stockage
et les messages publics signés de la cérémonie d'association. Le trait étranger `ProtectedKeystore` ne sort pas de Kotlin :
aucun export Expo ne lit / écrit une clé, un checkpoint ou un enregistrement
protégé. Les valeurs de ce trait sont bornées à 4096 octets.

Une clé AES-256-GCM Android Keystore non exportable enveloppe les petits
enregistrements plateforme. Les blobs et le coffre sont séparés dans
`noBackupFilesDir`, sous répertoires 0700 / fichiers 0600. L'AAD lie le blob à
son nom exact. Seule une absence confirmée retourne `None` ; clés existantes
manquantes / indisponibles, tags corrompus et IO ambiguës restent bloquants.
Les écritures font le travail OS synchrone, synchronisent fichier et répertoire,
puis vérifient la publication exacte avant de libérer la lease Rust.

Rust 1.97 ne fournit pas les méthodes de verrouillage `std::fs::File` sur
Android. Le moteur prend donc son même verrou exclusif non bloquant via l'API
sûre `rustix::fs::flock` sur cette seule plateforme. Il reste interprocessus ;
un appelant fermé n'en détache pas une écriture plateforme en cours.
[Implémentation de la bibliothèque standard](https://github.com/rust-lang/rust/blob/1.97.0/library/std/src/sys/fs/unix.rs).

Le fournisseur mobile revalide la découverte épinglée, les capacités et la
famille HTTP `current` avant et après chaque appel. Une réponse tardive à
l'ouverture ferme son handle original ; suspension / déconnexion ferme toutes
les vues existantes. Les champs publics ne rejoignent pas la SQL ordinaire.

La cérémonie locale est `rv-crypto::account::Coordinator`, également utilisée
par le fournisseur bureau. Créer / adopter une identité est explicite ; adopter
une racine demande sa comparaison sur un appareil déjà associé. Un aperçu
vérifié produit un handle de consentement opaque lié à la vue native ; seule
une confirmation séparée émet l'approbation. La demande d'enregistrement exacte
est persistée avant HTTP. Le runner lit son reçu avant toute soumission et
seul un `404 not_found` compris autorise le POST original. La fermeture n'efface
ni cette intention ni les clés. Les annuaires complets sont revalidés en Rust ;
une révocation locale signée est conservée même si le serveur l'omet ensuite.
Les réglages mobiles existants portent ce parcours, derrière les capacités
expérimentales du serveur. L'état `ready` du coffre demeure distinct de celui
de l'identité enregistrée et des groupes MLS admis.

Les fiches utilisateur existantes utilisent aussi les contrôles de confiance
`rv-crypto::account::peers`, avec le même `Pins` privé que les groupes / desktop.
La consultation n'accepte aucune nouvelle racine. Premier contact, vérification
et remplacement sont explicites ; remplacement exige l'ancienne empreinte
exacte et la nouvelle comparée. L'aperçu d'appareil conserve son consentement
dans Rust, lié à l'annuaire signé et au handle natif. Les retraits signés d'une
racine déjà épinglée sont mémorisés avant de refuser un aperçu périmé et restent
bloquants après omission / réouverture. Seul un état public borné passe par Expo.
Ces contrôles ne publient aucun package et n'admettent aucun membre de groupe.

`Ready` signifie **stockage prêt**. Aucune identité ou groupe n'est créé, aucun
appareil n'est enregistré et aucun masque E2EE de production n'est activé.
Le renouvellement des appareils et les actions privées restent à raccorder
aux contrôleurs partagés et aux écrans existants.

Les informations du salon, et la fiche du correspondant ouverte depuis un DM,
portent maintenant les contrôles de groupe : publication explicite de packages,
création / mise à jour (ajouts, retraits, rotation), admission / réadmission et
réception d'un commit, avec aperçu des destinataires puis confirmation distincte.
`groupAction` n'accepte que les DTOs publics bornés. Le consentement opaque reste
en RAM Rust ; le paquet original, les bundles et le fournisseur MLS restent dans
le coffre. Le roster frais et les pins sont revérifiés lors de la confirmation.
Les retraits signés des correspondants sont appris avant une préparation ou reprise.
La vue est liée à l'adhésion, la projection et l'appareil HTTP ; retrait / retour,
suspension et changement de compte ferment cette vue. Les versions d'adhésion
de la projection de lectures et les grants du roster MLS sont distincts.

La reprise lit le reçu avant de demander au moteur son paquet original. Un reçu
accepté ne provoque pas un second POST. Une nouvelle soumission exige encore
le droit courant d'envoyer ; une décision déjà acceptée reste récupérable en
lecture seule. L'abandon est checkpointé avant HTTP puis réglé selon la décision
terminale du serveur. Les publications de packages se reprennent aussi par
leur reçu, avant de retenter un bundle éventuellement expiré. Aucun texte,
brouillon privé ou ratchet ne rejoint la SQL ordinaire par ce raccordement.

## Build et qualification

`conversationAction` raccorde la liste et le composeur Android existants aux
coordinateurs de journal, brouillons et messages. Les pages, transitions MLS et
messages sont vérifiés puis checkpointés ensemble avant projection. Un viewer
est lié au grant personnel et au témoin privé d'admission avant toute commande ;
une réadmission ne peut réutiliser une ancienne vue. Les positions restent des
chaînes décimales, y compris au-delà de la précision entière JavaScript.

La projection transitoire comprend le préfixe retenu dans le cache privé (64
messages maximum) et les intentions personnelles en attente. Elle ne rejoint
aucune table de messages / outbox / brouillons ordinaire. Les heures exposées
sont les observations locales, pas une date certifiée de l'auteur. Lecture /
reprise HTTP revérifient scope, annuaires, roster et droits. La frappe locale
utilise uniquement le dernier binding public vérifié : Rust contrôle encore son
identité, son grant, son admission protégée et l'horloge, sans HTTP ni nouveau
destinataire. Ces écritures sont sérialisées et leur handle devient terminal
avec la session ; elles ne permettent aucune soumission au serveur.

Les envois sont préparés avant HTTP, reprennent par GET du reçu et ne POSTent
l'original qu'après un `404 not_found` compris et un droit d'envoi frais. Un
résultat incertain garde le même ciphertext. L'abandon est checkpointé avant
HTTP ; son document reste récupérable dans un brouillon vide. La projection est
disposée au blur, à la suspension et à la fermeture du runner, sans lissage du
clair. Le journal opaque est interrogé à l'ouverture, à la reprise, après les
actions et toutes les dix secondes quand la vue est active / en ligne.

Les parcours Rust à deux acteurs couvrent réouverture de l'original, annulation,
rotation reçue par le journal, brouillons distincts, page altérée sans progression,
positions exactes et retrait signé persistant après omission. L'instrumentation
Android exerce le vrai Keystore / ABI / coffre, avec brouillons et messages
privés, réouverture et reçu substitué ; ses reçus sont synthétiques. Cela ne
qualifie pas encore le parcours complet de l'application installée contre HTTP.
Les fils utilisent l’écran existant, une projection de racine / réponses dans
le même journal privé et un brouillon distinct du salon. Les compteurs sont
ceux des réponses retenues ; une racine évincée ou provenant d’un autre grant
ne permet pas de préparer un nouvel envoi. Les parcours Rust à deux acteurs et
l’instrumentation Android exercent aussi une vraie réponse MLS après réouverture,
sa racine, les compteurs et le refus d’un fil imbriqué. Les reçus Android restent
synthétiques ; les qualifications GUI et HTTP installées restent distinctes.
Citations / actions / recherche, archive et fichiers restent
ouverts, ainsi que la qualification physique et la revue. Aucun masque activé.

Prérequis : Rust 1.97, cibles `aarch64-linux-android` et `x86_64-linux-android`,
Node 24, JDK 17 et NDK 27.1.12297006. Le `preBuild` du module lance
`build-android.mjs` pour les ABI demandées, génère les bindings depuis la vraie
bibliothèque, puis les intègre aux sources Kotlin / `jniLibs`. Les `.so` sont
alignés sur 16 Kio ; les fichiers générés restent dans `android/build/`.
[Compatibilité des pages Android](https://developer.android.com/guide/practices/page-sizes),
[Keystore](https://developer.android.com/privacy-and-security/keystore).

```sh
cargo test --locked --manifest-path crates/rv-crypto-mobile/Cargo.toml --lib
cd apps/mobile/android
./gradlew :crypto-native:connectedDebugAndroidTest
```

Les tests Android utilisent une APK de test isolée et un scope aléatoire,
jamais un compte utilisateur. Ils couvrent le vrai Keystore / ABI / coffre,
réouverture originale, corruption, copie, retrait et lease retenue après
fermeture pendant une écriture, et cérémonie réelle de création / aperçu /
approbation / enregistrement / réouverture avec refus d'un reçu substitué.
La CI dédiée construit les deux ABI et lance
ces tests sur émulateur. Les tests JS couvrent aussi le runner mobile existant,
le changement d'identité / appareil, les capacités désactivées et les résultats
tardifs, pagination exacte au-delà de 2^53 et réponse HTTP perdue sans second POST.
Le test Rust du pont associe deux vrais appareils et mémorise leur révocation.
Deux autres scénarios vérifient premier contact / comparaison / remplacement,
consentement d'appareil et retrait d'un correspondant. Le quatrième test Android
associe deux identités via le vrai moteur et vérifie la réouverture des pins /
approbations dans le Keystore. Les tests JS vérifient les gardes lors des requêtes
publiques et le refus d'un consentement pour un autre utilisateur.
L'émulateur ne qualifie pas le matériel, les coupures électriques ou
le parcours E2EE complet dans une application installée.

Le septième test Rust exerce deux vrais acteurs MLS : packages, création,
Welcome, rotation, commit, réouverture du paquet original, refus d'un reçu
substitué / grant changé et règlement d'abandon. Le cinquième test Android
exerce création / rotation / paquet original après réouverture et abandon sur
le vrai Keystore / ABI. Les reçus de ces deux bancs privés sont synthétiques ;
ils ne remplacent pas une qualification contre le serveur HTTP réel.
Quatre régressions JS qualifient le routage HTTP, réponse perdue sans second
POST, publication originale, lecture seule et fermeture après changement
d'appareil / retrait du salon. Conversations mobiles, iOS et GUI installé restent ouverts.
