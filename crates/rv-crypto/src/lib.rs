//! Shared client-side crypto storage. No server/client feature is enabled here.
#![forbid(unsafe_code)]

pub mod account;
pub mod archive;
#[cfg(feature = "native-http")]
pub mod delivery;
pub mod files;
pub mod groups;
pub mod history;
pub mod history_backup;
pub mod identity;
pub mod installation;
pub mod packages;
pub mod protected;
pub mod vault;

// A browser worker owns the virtual encrypted databases. Its host persists an
// authenticated snapshot before exposing any result or sending an HTTP packet.
#[cfg(all(target_arch = "wasm32", target_os = "unknown"))]
pub mod browser;
