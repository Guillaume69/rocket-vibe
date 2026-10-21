//! Microsoft Teams: the saved account kind (`auth`, `client`, `translate`,
//! `sync`) and the transient read preview (`preview`).
pub mod auth;
pub mod preview;
pub mod translate;

pub use auth::{SESSION_REJECTED, TeamsAccount};
pub use preview::*;
