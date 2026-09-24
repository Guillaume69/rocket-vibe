# rocket-vibe

Clients **Rocket.Chat** tiers, plus rapides et plus fiables que les officiels, pour un
serveur auto-hébergé (`https://chat.barrut.me`, Rocket.Chat **8.5** LTS).

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

Deux workflows GitHub Actions, chacun ne tournant que si son app (ou lui-même) change :

- **`mobile`** — typecheck, lint, tests, puis un APK Android de release (`expo prebuild` +
  Gradle sur le runner, jamais EAS). Il lit `google-services.json` dans le secret
  `GOOGLE_SERVICES_JSON`.
- **`desktop`** — Linux (même Fedora que le build local : fmt, clippy, tous les tests,
  une archive), Windows (MSYS2 : un installeur par utilisateur, sans droits
  administrateur, qui pose un raccourci et enregistre les liens `rocketvibe://`, testé
  en CI par une installation, un lancement et une désinstallation ; plus un zip) et
  macOS (Homebrew, une archive qui demande `brew install gtk4 libadwaita gstreamer`).

`node scripts/version.mjs mobile|desktop` donne la version d'une app et vérifie sa
cohérence. Pour publier : monter la version, puis pousser un tag `mobile-vX.Y.Z` ou
`desktop-vX.Y.Z` — le workflow vérifie qu'il correspond et crée la release GitHub avec
ses binaires.

## Licence & statut

Projet personnel, en développement actif. Branche principale : **`master`**.
