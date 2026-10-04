# Stack

The exact technologies and pinned versions of both apps, the shared test server and the build toolchains, read from the manifests (`package.json`, `app.json`, the `Cargo.toml` files, `Package.swift`, `docker/compose.yml`, the Dockerfiles and the CI workflows). When a version here and a manifest disagree, the manifest wins.

## Repository versions

| App | Version | Where it lives |
|---|---|---|
| Mobile | 0.5.0, `android.versionCode` 500 | `apps/mobile/app.json` (`expo.version`), mirrored in `apps/mobile/package.json` |
| Desktop (GTK and SwiftUI) | 0.7.0 | `apps/desktop/Cargo.toml`, `[workspace.package] version` |

Both apps share one version per app; the SwiftUI macOS app takes the desktop version. See [operations.md](operations.md) for how `scripts/version.mjs` checks them.

## Mobile (`apps/mobile`)

Runtime and framework:

| Piece | Version | Note |
|---|---|---|
| Expo SDK | `expo ~57.0.4` | The major of the `expo` package is the SDK number. |
| React Native | 0.86.0 | New Architecture is mandatory since RN 0.82; `newArchEnabled=false` has no effect. |
| React | 19.2.3 | `overrides: { "react-dom": "$react" }` aligns the transitive `react-dom` pulled by expo-router, which otherwise fails `npm install` with `ERESOLVE`. |
| JS engine | Hermes | Expo's default; `app.json` sets no other engine. |
| TypeScript | `~6.0.3`, `strict`, `allowImportingTsExtensions` | Imports carry `.ts` extensions so Node can load `lib/` and `db/` directly in tests. |
| Navigation | `expo-router ~57.0.4` on `react-native-screens 4.25.2` | Typed routes (`experiments.typedRoutes`), native stack, bottom sheets via `presentation: 'formSheet'`. |

Data and protocol:

| Piece | Version | Role |
|---|---|---|
| `expo-sqlite` | `~57.0.0` | The local database, one per server. |
| `drizzle-orm` / `drizzle-kit` | `^0.45.2` / `^0.31.10` | Schema, `useLiveQuery`, generated migrations (`driver: 'expo'` in `apps/mobile/drizzle.config.ts`). |
| `@rocket.chat/message-parser` | `^0.31.35` | Markdown AST (MIT). Rendered by the app's own code, not by a markdown library. |
| DDP client | in-house (`lib/ddp.ts`) | Written from the DDP spec; `@rocket.chat/ddp-client` is not used (Enterprise licence). |
| `expo-secure-store` | `~57.0.0` | Session tokens and small preferences (Android Keystore). |
| `expo-notifications` | `~57.0.3` | Native FCM token and notification display; no Expo Push service. |

Native modules (each requires a dev-client rebuild, see [architecture/mobile-native.md](architecture/mobile-native.md)):

| Piece | Version | Role |
|---|---|---|
| `react-native-quick-crypto` | `^1.1.6` | `node:crypto` API over OpenSSL for E2EE; Metro aliases `crypto` to it (`apps/mobile/metro.config.js`). |
| `react-native-nitro-modules` | `^0.36.1` | Runtime for quick-crypto. |
| `react-native-quick-base64` | `^3.0.1` | Native base64. |
| `react-native-reanimated` / `react-native-worklets` | 4.5.0 / 0.10.0 | Pulled directly by expo-router. |
| `react-native-gesture-handler` | `~2.32.0` | |
| `react-native-keyboard-controller` | 1.21.9 | Keyboard tracking. |
| `react-native-safe-area-context` | `~5.7.0` | |
| `@shopify/flash-list` | `^2.3.2` | The message and room lists. |
| `react-native-webview` | 13.16.1 | Only for the Jitsi call screen (`app/call/[callId].tsx`), the one allowed WebView. |
| `expo-share-intent` | `^8.0.1` | Share into the app; patched by `patches/expo-share-intent+8.0.1.patch` through `patch-package` on `postinstall`. |
| Media | `expo-audio`, `expo-video`, `expo-image-picker`, `expo-image-manipulator`, `expo-document-picker`, `expo-media-library`, `expo-file-system`, `expo-sharing` (all `~57.0.x`) | Voice messages, players, pickers, saving. |
| Fonts | `@expo-google-fonts/baloo-2`, `@expo-google-fonts/nunito` (`^0.4.2`) | Embedded at build time by the `expo-font` plugin. |

Local Expo modules under `apps/mobile/modules/`: `video-compressor` (video downscaling, Android Media3 and iOS AVFoundation), `downloads` (public Downloads folder, Android only), `fcm-token` and `notification-reply` (iOS only). Config plugins under `apps/mobile/plugins/` customise the generated native projects; `android/` and `ios/` are gitignored (CNG).

Dev tooling: ESLint 9 with `eslint-config-expo ~57.0.0`, `patch-package ^8.0.1`, `emoji-toolkit 10.0.0` (source of the generated emoji table), Node's built-in test runner.

Android build chain (local and CI): Node 24, Temurin JDK 17 (env.sh accepts 17 to 24), Gradle 9.3.1 from the wrapper, SDK `platforms;android-36`, `build-tools;36.0.0`, NDK `27.1.12297006`, `compileSdk`/`targetSdk` 36, `minSdk` 24. The application id is `com.rocketvibe.app`, the URL scheme `rocketvibe`. Native libraries are restricted to `arm64-v8a,x86_64` by `plugins/with-target-architectures.js`; CI builds `arm64-v8a` only.

## Desktop (`apps/desktop`)

A Cargo workspace (`resolver = "3"`, edition 2024, licence MIT) of four crates, plus a SwiftPM package. Workspace lints: `unsafe_code = "deny"` (lifted file by file only in the platform shims: `rv-native`'s Windows and macOS modules, `rv-gtk`'s `focus.rs`, `macos.rs` and `windows.rs`), `clippy::all` at warn, and CI and `build.sh` turn warnings into errors. Formatting: `rustfmt.toml` with `max_width = 120`.

### rv-core (UI-free core)

| Crate | Version | Role |
|---|---|---|
| `tokio` | 1.53.1 (multi-thread runtime) | All async work. |
| `reqwest` | 0.13.5, rustls, `json`, `multipart`, `stream` | REST. |
| `tokio-tungstenite` | 0.30.0, `rustls-tls-webpki-roots` | DDP WebSocket. |
| `rusqlite` | 0.40.2, `bundled` | The local store; SQLite compiled in. |
| `aws-lc-rs` | 1.18.1 | E2EE crypto. |
| `sha2` 0.11, `base64` 0.22, `serde_json` 1.0.151, `chrono` 0.4.45, `url` 2.5.8, `thiserror` 2, `gif` 0.13, `fastrand` 2.5, `futures-util` 0.3 | | |

`crates/rv-core/data/emojis.tsv` is the emoji table, generated from emoji-toolkit by `scripts/generate-emojis.mjs`.

### rv-gtk (binary `rocket-vibe-gtk`, package `rocket-vibe-gtk`)

| Crate | Version | Role |
|---|---|---|
| `gtk4` | 0.11.5, feature `v4_12` | Minimum GTK 4.12 at runtime. |
| `libadwaita` | 0.9.2, feature `v1_6` | Minimum libadwaita 1.6. |
| `pango` | 0.22, feature `v1_56` | Minimum Pango 1.56. |
| `gstreamer`, `gstreamer-app`, `gstreamer-video` | 0.24 | Audio and video playback, voice recording. |
| `webkit6` | 0.6.1, Linux only | The inline web video player (YouTube and similar cards). |
| `oo7` | 0.6.0, Linux only | Session tokens in the Secret Service. |
| `keyring` | 3.6, Windows and macOS | Session tokens in the system keychain. |
| `spellbook` | 0.4.2 | Hunspell-compatible spell check. |
| `gdk4-win32` | 0.11.5, Windows only | |
| `winresource` | 0.1.31 (build) | Windows icon and metadata. |

### rv-native (platform shims)

Windows: `windows 0.62` (WinRT toasts, taskbar badge, registry, tray, single instance) and `webview2-com 0.39` (call window and inline player). macOS: `objc2 0.6`, `objc2-app-kit`, `objc2-foundation`, `objc2-web-kit`, `objc2-user-notifications` (0.3), `block2 0.6`. On Linux every call is a no-op.

### rv-ffi (UniFFI bindings for Swift)

`uniffi 0.32.2` (proc-macros, no UDL), crate types `lib`, `staticlib`, `cdylib`, plus a `uniffi-bindgen-swift` binary. Its own tokio runtime with two worker threads; `keyring 3.6` (with `apple-native` on macOS).

### SwiftUI app (`apps/desktop/macos`)

`swift-tools-version: 6.0`, Swift language mode 5, platform macOS 15. Targets: `rv_ffiFFI` (C header and the Rust static library linked by path, `RV_FFI_LIB_DIR`), `RocketVibeCore` (generated bindings, gitignored), `RocketVibeKit` (view models, builds on Linux), `rv-rooms` (CLI), `RocketVibe` (the app, macOS only), `RocketVibeKitTests`.

### Desktop toolchains

| Where | Toolchain |
|---|---|
| Local build and Linux CI | Fedora 44 container (`apps/desktop/docker/Dockerfile`): Fedora's `rust`, `cargo`, `clippy`, `rustfmt`, `gtk4-devel`, `libadwaita-devel`, `webkitgtk6.0-devel`, GStreamer, Xvfb, `cargo-llvm-cov`. `build.sh` states it carries GTK 4.22 and libadwaita 1.9. |
| AppImage | `ghcr.io/pkgforge-dev/archlinux:latest`, quick-sharun from Anylinux-AppImages at a pinned commit. |
| Windows | MSYS2 UCRT64 (`mingw-w64-ucrt-x86_64-rust`, gtk4, libadwaita, GStreamer), Inno Setup 6 for the installer. |
| macOS (GTK) | Homebrew `gtk4 libadwaita gstreamer adwaita-icon-theme pkgconf dylibbundler`, rustup stable. |
| macOS (SwiftUI) | Xcode Swift on `macos-15`; on Linux, `swift:6.1-noble` (`apps/desktop/macos/docker/Dockerfile`). |

Bundled assets fetched at pinned commits for Windows, macOS and the AppImage: Hunspell `en_US` and `fr_FR` from LibreOffice's dictionaries, Noto Color Emoji.

## Test server (`docker/compose.yml`)

| Service | Image | Note |
|---|---|---|
| `rocketchat` | `registry.rocket.chat/rocketchat/rocket.chat:${RC_VERSION:-8.5.1}` | Pinned on the production target's version (8.5 LTS), not the latest. Runs a push-patched bundle (see [operations.md](operations.md)). |
| `mongodb` | `mongodb/mongodb-community-server:${MONGODB_VERSION:-8.0-ubi8}` | Rocket.Chat 8.5 requires MongoDB 8.0; single-node replica set `rs0` for change streams. On Linux kernels 6.19 and later, set `8.0.4-ubi8`: 8.0.5+ refuses to start (SERVER-121912). |

## CI runners

GitHub Actions: `ubuntu-24.04` (with `fedora:44`, the Arch image and `ubuntu:22.04` containers), `windows-2025`, `macos-15`. Actions used: `actions/checkout@v5`, `setup-node@v5`, `setup-java@v5`, `cache@v4`, `upload-artifact@v4`, `download-artifact@v4`, `dtolnay/rust-toolchain@stable`, `msys2/setup-msys2@v2`, `softprops/action-gh-release@v2`.

## Sources

- `apps/mobile/package.json`
- `apps/mobile/app.json`
- `apps/mobile/tsconfig.json`
- `apps/mobile/metro.config.js`
- `apps/mobile/drizzle.config.ts`
- `apps/mobile/plugins/with-target-architectures.js`
- `apps/mobile/modules/`
- `apps/mobile/patches/expo-share-intent+8.0.1.patch`
- `apps/desktop/Cargo.toml`
- `apps/desktop/rustfmt.toml`
- `apps/desktop/crates/rv-core/Cargo.toml`
- `apps/desktop/crates/rv-gtk/Cargo.toml`
- `apps/desktop/crates/rv-native/Cargo.toml`
- `apps/desktop/crates/rv-ffi/Cargo.toml`
- `apps/desktop/macos/Package.swift`
- `apps/desktop/docker/Dockerfile`
- `apps/desktop/macos/docker/Dockerfile`
- `apps/desktop/scripts/build.sh`
- `apps/desktop/scripts/appimage-build.sh`
- `docker/compose.yml`
- `docker/.env.example`
- `.github/workflows/mobile.yml`
- `.github/workflows/desktop.yml`
- `.github/workflows/desktop-swiftui.yml`
