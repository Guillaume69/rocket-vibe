//! Rocket.Chat client core: protocol, local store and sync, no UI.
//! Port of the Android app's `lib/`, whose tests are the spec.

pub mod account;
pub mod account_mute;
pub mod actions;
pub mod activity;
pub mod admin;
pub mod animation;
pub mod call;
pub mod call_ring;
pub mod collapsed_sections;
pub mod commands;
pub mod completion;
pub mod compose;
pub mod content;
pub mod context;
pub mod ddp;
pub mod diff;
pub mod e2e;
pub use rv_provider::emoji;
pub mod emoji_usage;
pub mod i18n;
pub mod info;
pub mod last_room;
pub mod links;
pub use rv_provider::live;
pub mod markdown;
pub mod mattermost;
pub mod media;
pub mod members;
pub mod native;
pub use rv_provider::normalize;
pub mod notify;
pub mod outbox;
pub mod parse;
pub mod player;
pub mod provider;
pub mod reminders;
pub use rv_provider::rest;
pub mod rocketchat;
pub mod rooms;
pub mod runs;
pub mod server;
pub mod server_icon;
pub mod server_rail;
pub mod session;
pub mod slack;
pub mod social;
pub mod store;
pub mod supervisor;
pub mod sync;
pub mod teams;
pub mod timeline;
pub use rv_provider::tls;
pub mod update;
pub mod uploads;
pub mod voice;
pub mod voice_prefs;
pub mod whatsapp;
pub mod whatsapp_session;
pub mod x_syndication;
pub mod zoom;

/// Names this build in the requests the providers send; the app calls it first.
pub fn identify() {
    rv_provider::set_version(env!("CARGO_PKG_VERSION"));
}
