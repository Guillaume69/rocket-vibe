//! Shared client-side crypto storage. No server/client feature is enabled here.
#![forbid(unsafe_code)]

pub mod account;
pub mod archive;
#[cfg(feature = "native-http")]
pub mod delivery;
pub mod groups;
pub mod history;
pub mod history_backup;
pub mod identity;
pub mod installation;
pub mod packages;
pub mod protected;
pub mod vault;
