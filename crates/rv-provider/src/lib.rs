//! What the desktop's providers share below rv-core: the REST client and its
//! dialects, the live socket's frames, the normalized room and message types,
//! presence, emoji and the TLS provider.

use std::sync::OnceLock;

pub mod emoji;
pub mod live;
pub mod normalize;
pub mod rest;
pub mod socket;
pub mod text;
pub mod tls;

static VERSION: OnceLock<&'static str> = OnceLock::new();

/// The app's version, named in every request; set once at start-up.
pub fn set_version(version: &'static str) {
    let _ = VERSION.set(version);
}

pub fn version() -> &'static str {
    VERSION.get().copied().unwrap_or("0.0.0")
}

pub fn user_agent() -> String {
    format!("rocket-vibe-desktop/{}", version())
}
