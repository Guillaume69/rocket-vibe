//! Current hierarchy, lookup and call-action imports through the public SDK.
//!
//! ```
//! use whatsapp_rust::{GroupHierarchy, GroupMetadata, features::Community};
//! use whatsapp_rust::wacore::types::call::CallAction;
//! let metadata = GroupMetadata::new("120363000000000021@g.us".parse().unwrap());
//! assert_eq!(metadata.hierarchy(), GroupHierarchy::Standalone);
//! let _: Option<Community<'_>> = None;
//! fn wire(action: &CallAction) -> &str { action.wire_tag() }
//! ```
//!
//! Domain modules remain private even for retained public types.
//! ```compile_fail,E0603
//! use whatsapp_rust::features::community::Community;
//! ```
//!
//! Call actions expose their wire tag, not an additional action-kind accessor.
//! ```compile_fail,E0599
//! use whatsapp_rust::wacore::types::call::CallAction;
//! fn unsupported(action: &CallAction) { let _ = action.action_kind(); }
//! ```
