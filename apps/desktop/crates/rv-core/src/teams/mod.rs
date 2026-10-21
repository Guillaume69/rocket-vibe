//! Microsoft Teams: a saved account kind signed in with a device code
//! (`auth`), its service calls (`client`), translation, sync, actions and
//! the Trouter live connection.
pub mod actions;
pub mod auth;
pub mod client;
pub mod frames;
pub mod live;
pub mod sync;
pub mod translate;

pub use auth::{SESSION_REJECTED, TeamsAccount};
