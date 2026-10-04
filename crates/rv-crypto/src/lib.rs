//! Shared client-side crypto storage. No server/client feature is enabled here.
#![forbid(unsafe_code)]

#[cfg(feature = "native-http")]
pub mod delivery;
pub mod groups;
pub mod identity;
pub mod installation;
pub mod packages;
pub mod protected;
pub mod vault;
