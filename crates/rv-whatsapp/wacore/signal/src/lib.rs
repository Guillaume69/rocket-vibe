//! The Signal interface the vendored WhatsApp engine was written against:
//! keys, addresses, records, stores, and the encrypt and decrypt functions
//! over them. Everything cryptographic is `rv-signal`; this crate adds the
//! storage contract the engine relies on (records leased in counter batches,
//! sessions checked out of a write-back cache) and the vocabulary its code
//! uses.
//!
//! Written for rocket-vibe from what the engine's own code and tests expect
//! (`brain/decisions.md`, "WhatsApp in Rust"). The aim is to shrink it as the
//! engine moves onto `rv-signal` directly.

pub mod protocol;
pub mod store;
