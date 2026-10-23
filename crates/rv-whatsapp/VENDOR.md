# Vendored: whatsapp-rust

This directory is [whatsapp-rust](https://github.com/oxidezap/whatsapp-rust) at commit
`d73c3cc1` (2026-10-23), MIT, copyright João Lucas de Oliveira Lopes (`LICENSE`). It is
reshaped to rocket-vibe's architecture over time; the commits after the vendoring one say
what changed.

Left out on purpose (`brain/decisions.md`, "WhatsApp in Rust"):

| Upstream path | Why |
|---|---|
| `wacore/libsignal` | Signal's AGPL-3.0 library copied in under an MIT label. Replaced by `crates/rv-signal`, written clean room: never read, ported or copied here. |
| `wacore/appstate` | The settings sync, a declared port of whatsmeow (MPL-2.0). Rewritten. |
| `tools`, `benches`, `scripts`, `examples`, `agent_docs`, `.github`, `.cargo`, `.config`, `rust-toolchain.toml`, `release.toml`, `Dockerfile`, `AGENTS.md`, `CLAUDE.md` | Upstream's own tooling, benchmarks, release and agent setup; `tools/oracle-*` also runs Meta's WebAssembly. |
| `plugins` | Opt-in metrics and WhatsApp telemetry (WAM) plugins: the apps send no telemetry to Meta. |
| `tests/bench-integration` | Benchmarks; its only dependency outside the permissive allow-list (MPL-2.0 `colored`) came with it. |

Kept although it carries its own risk, by user decision: the calls code, its MLow audio
codec included (`wacore/src/voip/mlow`), whose tables and test data were taken from
WhatsApp's own WebAssembly.
