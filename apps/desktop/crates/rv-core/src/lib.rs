//! Rocket.Chat client core: protocol, local store and sync, no UI.
//! Port of the Android app's `lib/`, whose tests are the spec.

pub mod account;
pub mod actions;
pub mod completion;
pub mod content;
pub mod ddp;
pub mod diff;
pub mod emoji;
pub mod info;
pub mod live;
pub mod markdown;
pub mod media;
pub mod normalize;
pub mod notify;
pub mod outbox;
pub mod rest;
pub mod rooms;
pub mod session;
pub mod store;
pub mod sync;
pub mod uploads;
