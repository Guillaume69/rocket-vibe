# Vendored: whatsapp-rust

This directory is [whatsapp-rust](https://github.com/oxidezap/whatsapp-rust) at commit
`d73c3cc1` (2026-10-23), MIT, copyright João Lucas de Oliveira Lopes (`LICENSE`). It is
reshaped to rocket-vibe's architecture over time; the commits after the vendoring one say
what changed.

Left out on purpose (`brain/decisions.md`, "WhatsApp in Rust"):

| Upstream path | Why |
|---|---|
| `wacore/libsignal` | Signal's AGPL-3.0 library copied in under an MIT label. Replaced by `crates/rv-signal`, written clean room: never read, ported or copied here. |
| `wacore/appstate` | The settings sync, a declared port of whatsmeow (MPL-2.0). Rewritten in place with the same public interface; only its action catalogue (`schemas.rs`, `schemas_unlisted.rs`), generated from whatspec's extraction, is upstream's. |
| `tools`, `benches`, `scripts`, `examples`, `agent_docs`, `.github`, `.cargo`, `.config`, `rust-toolchain.toml`, `release.toml`, `Dockerfile`, `AGENTS.md`, `CLAUDE.md` | Upstream's own tooling, benchmarks, release and agent setup; `tools/oracle-*` also runs Meta's WebAssembly. |
| `plugins` | Opt-in metrics and WhatsApp telemetry (WAM) plugins: the apps send no telemetry to Meta. |
| `tests/bench-integration` | Benchmarks; its only dependency outside the permissive allow-list (MPL-2.0 `colored`) came with it. |
| `tests/api-consumer` (but its `src/`, which three tests include), `tests/sqlite-interop`, `tests/sqlite-sdk-browser` | Separate projects that build the library as an outside crate; nothing here builds them. |
| `tests/noise_frame_size_contract.rs`, `wacore/benches/sender_key_derivation_benchmark.rs` | They swap the AGPL crate's pluggable crypto provider, or reach into its records' internals; neither exists on `rv-signal`. |

Kept although it carries its own risk, by user decision: the calls code, its MLow audio
codec included (`wacore/src/voip/mlow`), whose tables and test data were taken from
WhatsApp's own WebAssembly.

The workspace manifest lists only what is here: the members, workspace dependencies,
examples and benchmarks of the left-out parts are gone.

Added for rocket-vibe:

| Path | What |
|---|---|
| `wacore/signal` (`wacore-signal`) | The Signal interface the engine calls (keys, addresses, records, stores, cipher functions, the counter lease and the session checkout), on `crates/rv-signal`. `wacore` re-exports it as `wacore::libsignal`, so the engine's code keeps its paths. Written from the engine's own code and tests, never from the AGPL crate. |
| `wacore/crypto` (`wacore-crypto`) | The symmetric primitives the AGPL crate used to provide (AES-GCM, AES-CBC, HMAC, SHA-2), on RustCrypto. |
| `waproto` codec wrappers | `record_structure_*`, `session_structure_*`, `identity_key_pair_to_vec`, the pinned encoders `wacore-signal` needs (`clippy.toml` routes protobuf encoding through them). |

Otherwise the vendored code changed only where it named the AGPL crate (`wacore_libsignal`
becomes `wacore_signal`, or `crate::libsignal` inside `wacore`) and in one pinned size
(`client_size_pins_runtime_cache_config_saving`: the `Client` is 216 bytes smaller on
`rv-signal`'s types). Formatting: upstream formats with a nightly `rustfmt`; its files are
left as they came, `cargo fmt --check` covers only the crates written here.
