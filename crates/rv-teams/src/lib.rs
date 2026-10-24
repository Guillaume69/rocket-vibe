//! Microsoft Teams: an account signed in with a device code (`auth`), its
//! service calls (`client`), translation and the Trouter live connection.
pub mod auth;
pub mod client;
pub mod frames;
pub mod live;
pub mod service;
pub mod translate;

pub use auth::{SESSION_REJECTED, Session, TeamsAccount};
