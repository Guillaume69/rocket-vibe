//! Rocket.Chat, as a `Session` backend: its REST calls, the counterpart of
//! `crate::mattermost`. The DDP client, the sync engine and the store it
//! feeds live in their own modules, written for Rocket.Chat first.

pub mod actions;
