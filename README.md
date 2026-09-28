# rocket-vibe

Clients **Rocket.Chat** tiers, plus rapides et plus fiables que les officiels, pour les
serveurs auto-hébergés en Rocket.Chat **8** ou plus récent.

| App | Où | Techno | Version |
|---|---|---|---|
| **Mobile** (Android d'abord) | [`apps/mobile`](apps/mobile/README.md) | Expo / React Native, SQLite | `apps/mobile/app.json` |
| **Bureau** (Linux, Windows, macOS) | [`apps/desktop`](apps/desktop/README.md) | Rust, GTK 4 + libadwaita | `apps/desktop/Cargo.toml` |

Chaque app a son numéro de version et ses propres builds ; la parité fonctionnelle du
bureau avec le mobile est suivie dans [`apps/desktop/docs/PARITY.md`](apps/desktop/docs/PARITY.md).

## Partagé

- [`ROADMAP.md`](ROADMAP.md) — les décisions produit et leur justification.
- [`docs/`](docs) — l'environnement de développement et le relevé du serveur cible
  (`DEV.md`), le push (`PUSH.md`).
- [`docker/`](docker) — un Rocket.Chat 8.5.1 + MongoDB 8.0 de test :

  ```sh
  cd docker && cp .env.example .env && chmod 600 .env   # renseigner ADMIN_PASS
  docker compose up -d
  node ../scripts/seed.mjs                              # alice, bob, salons de test, idempotent
  ```

## CI, versions et releases

Deux workflows GitHub Actions, chacun ne tournant que si son app (ou lui-même) change. Un
push ne fait que vérifier (typecheck, lint, tests ; fmt, clippy et tests Linux pour le
bureau) : les paquets ne se construisent que sur un tag de release, ou à la main par
`workflow_dispatch`.

- **`mobile`** — typecheck, lint, tests, puis un APK Android de release (`expo prebuild` +
  Gradle sur le runner, jamais EAS). Il lit `google-services.json` dans le secret
  `GOOGLE_SERVICES_JSON`.
- **`desktop`** — Linux (même Fedora que le build local : fmt, clippy, tous les tests,
  une archive), Windows (MSYS2 : un installeur par utilisateur, sans droits
  administrateur, qui pose un raccourci et enregistre les liens `rocketvibe://`, testé
  en CI par une installation, un lancement et une désinstallation ; plus un zip) et
  macOS (Apple Silicon, macOS 15+ : une app dans un DMG, autonome, lancée en CI sans
  Homebrew), signée Developer ID et notariée par Apple : elle s'ouvre sans avertissement.
  Le certificat vient du secret `MACOS_CERTIFICATE_P12` (et son mot de passe), la
  notarisation d'une clé d'API App Store Connect (`APPLE_API_KEY_P8`, `_KEY_ID`,
  `_ISSUER_ID`) ; sans eux, la CI signe ad hoc et macOS demande « Ouvrir quand même » au
  premier lancement. Les originaux vivent dans `~/.config/rocket-vibe/apple/`, **à
  sauvegarder** : la clé privée du certificat ne se récupère pas.

`node scripts/version.mjs mobile|desktop` donne la version d'une app et vérifie sa
cohérence. Chaque app tient son journal au format Keep a Changelog
([mobile](apps/mobile/CHANGELOG.md), [bureau](apps/desktop/CHANGELOG.md)). Pour publier :
passer la section « Non publié » / « Unreleased » sous le numéro de la nouvelle version,
monter la version, puis pousser un tag `mobile-vX.Y.Z` ou `desktop-vX.Y.Z`. Le workflow
vérifie que le tag correspond à la version et que le journal a sa section, puis crée la
release GitHub avec ses binaires et cette section pour notes.

## Licence & statut

Projet personnel, en développement actif. Branche principale : **`master`**.
