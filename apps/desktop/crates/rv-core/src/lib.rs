//! Rocket.Chat client core: protocol, local store and sync, no UI.
//! Port of the Android app's `lib/`, whose tests are the spec.

pub mod ddp;
pub mod diff;
pub mod media;
pub mod normalize;
pub mod outbox;
pub mod rest;
pub mod session;
pub mod store;
pub mod sync;
