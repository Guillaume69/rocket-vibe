//! WhatsApp's app-state ("syncd") collections, the settings a linked device
//! shares with the phone: archive, mute, pin, contacts, labels and the rest.
//!
//! Each collection is a versioned list of encrypted records. A snapshot gives
//! all of them at once, a patch adds and removes some; an integrity hash (an
//! LTHash over every live record's value MAC) and three MACs (snapshot, patch,
//! per record) say whether this device and the server agree. The rules below
//! follow WhatsApp Web's arithmetic exactly, since the server's MACs are
//! computed by clients running it.
//!
//! Written for rocket-vibe; `schemas` and `schemas_unlisted` are the action
//! catalogue generated from whatspec's extraction of WhatsApp Web.

pub mod decode;
pub mod encode;
pub mod errors;
pub mod hash;
pub mod keys;
pub mod lthash;
pub mod patch_decode;
pub mod processor;
pub mod schemas;
pub mod schemas_unlisted;

mod crypto;

pub use decode::{
    Mutation, RecordMacs, collect_key_id_refs_from_patch_list, collect_key_ids_from_patch_list,
    decode_record,
};
pub use encode::encode_record;
pub use errors::*;
pub use keys::{ExpandedAppStateKeys, expand_app_state_keys};
pub use lthash::{LTHash, WAPATCH_INTEGRITY};
pub use processor::{
    AppStateMutationMAC, PatchMacVerdict, PatchProcessingResult, ProcessedSnapshot, process_patch,
    process_snapshot, validate_patch_macs, validate_snapshot_mac,
};
