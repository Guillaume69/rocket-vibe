# Pont privé Android

Ce workspace indépendant expose le coffre de `rv-crypto` à Kotlin avec
UniFFI 0.32.2. Le serveur ne dépend pas de ce crate. Le moteur privé conserve
son interdiction de code `unsafe` ; les exports ABI générés restent ici.

Le module Expo local `apps/mobile/modules/crypto-native` utilise ces bindings.
Son API JavaScript expose uniquement le scope public, un handle terminal et
l'état de stockage. Le trait étranger `ProtectedKeystore` ne sort pas de Kotlin :
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

`Ready` signifie **stockage prêt**. Aucune identité ou groupe n'est créé, aucun
appareil n'est enregistré et aucun masque E2EE de production n'est activé.
L'association / renouvellement, les groupes et les conversations mobiles
restent à raccorder aux contrôleurs partagés et aux écrans existants.

## Build et qualification

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
fermeture pendant une écriture. La CI dédiée construit les deux ABI et lance
ces tests sur émulateur. Les tests JS couvrent aussi le runner mobile existant,
le changement d'identité / appareil, les capacités désactivées et les résultats
tardifs. L'émulateur ne qualifie pas le matériel, les coupures électriques ou
le parcours E2EE complet dans une application installée.
