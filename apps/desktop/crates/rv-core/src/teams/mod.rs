//! Microsoft Teams: the saved account kind (`auth`, `client`, `translate`,
//! `sync`) and the transient read preview (`preview`).
pub mod actions;
pub mod auth;
pub mod client;
pub mod frames;
pub mod live;
pub mod preview;
pub mod sync;
pub mod translate;

pub use auth::{SESSION_REJECTED, TeamsAccount};
pub use preview::*;
