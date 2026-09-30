//! Rocket.Chat client core: protocol, local store and sync, no UI.
//! Port of the Android app's `lib/`, whose tests are the spec.

pub mod account;
pub mod actions;
pub mod animation;
pub mod call;
pub mod commands;
pub mod completion;
pub mod compose;
pub mod content;
pub mod ddp;
pub mod diff;
pub mod e2e;
pub mod emoji;
pub mod i18n;
pub mod info;
pub mod links;
pub mod live;
pub mod markdown;
pub mod media;
pub mod normalize;
pub mod notify;
pub mod outbox;
pub mod parse;
pub mod rest;
pub mod rooms;
pub mod runs;
pub mod server;
pub mod session;
pub mod store;
pub mod sync;
pub mod timeline;
pub mod update;
pub mod uploads;
