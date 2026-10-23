//! The server's answer to a sync request: `<sync>` holding one `<collection>`
//! per name, each with optional `<snapshot>` (an external blob reference),
//! `<patches>` of `<patch>` protobufs, or `type="error"` and an `<error>`.

use std::str::FromStr;

use anyhow::{Result, anyhow};
use wacore_binary::node::{Node, NodeRef};
use waproto::whatsapp as wa;

pub use crate::schemas::WAPatchName;

#[derive(Debug, Clone)]
pub struct PatchList {
    pub name: WAPatchName,
    pub has_more_patches: bool,
    pub patches: Vec<wa::SyncdPatch>,
    /// A snapshot carried inline; the server only ever sends a reference.
    pub snapshot: Option<wa::SyncdSnapshot>,
    pub snapshot_ref: Option<wa::ExternalBlobReference>,
    pub error: Option<CollectionSyncError>,
}

/// A collection the server answered with an error, classed as WhatsApp Web
/// classes it.
#[derive(Debug, Clone)]
pub enum CollectionSyncError {
    /// 409: the collection moved; `has_more` says whether more patches wait.
    Conflict { has_more: bool },
    /// 400 or 404: no retry will help.
    Fatal { code: u16, text: String },
    /// Anything else, and a snapshot reference that cannot be read.
    Retry { code: u16, text: String },
}

impl std::fmt::Display for CollectionSyncError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Conflict { has_more } => write!(f, "conflict (has_more={has_more})"),
            Self::Fatal { code, text } => write!(f, "fatal error {code}: {text}"),
            Self::Retry { code, text } => write!(f, "retryable error {code}: {text}"),
        }
    }
}

/// The two node trees, owned and borrowed, read the same way here.
trait Element: Sized {
    fn tag_name(&self) -> &str;
    fn child(&self, tag: &str) -> Option<&Self>;
    fn child_path(&self, tags: &[&str]) -> Option<&Self>;
    fn kids(&self) -> &[Self];
    fn bytes(&self) -> Option<&[u8]>;
    fn string(&self, key: &str) -> Option<String>;
    fn flag(&self, key: &str) -> bool;
}

impl Element for Node {
    fn tag_name(&self) -> &str {
        &self.tag
    }
    fn child(&self, tag: &str) -> Option<&Self> {
        self.get_optional_child(tag)
    }
    fn child_path(&self, tags: &[&str]) -> Option<&Self> {
        self.get_optional_child_by_tag(tags)
    }
    fn kids(&self) -> &[Self] {
        self.children().unwrap_or_default()
    }
    fn bytes(&self) -> Option<&[u8]> {
        match &self.content {
            Some(wacore_binary::node::NodeContent::Bytes(raw)) => Some(raw),
            _ => None,
        }
    }
    fn string(&self, key: &str) -> Option<String> {
        self.attrs().optional_string(key).map(|s| s.into_owned())
    }
    fn flag(&self, key: &str) -> bool {
        self.attrs().optional_bool(key)
    }
}

impl<'a> Element for NodeRef<'a> {
    fn tag_name(&self) -> &str {
        &self.tag
    }
    fn child(&self, tag: &str) -> Option<&Self> {
        self.get_optional_child(tag)
    }
    fn child_path(&self, tags: &[&str]) -> Option<&Self> {
        self.get_optional_child_by_tag(tags)
    }
    fn kids(&self) -> &[Self] {
        self.children().unwrap_or_default()
    }
    fn bytes(&self) -> Option<&[u8]> {
        self.content_bytes()
    }
    fn string(&self, key: &str) -> Option<String> {
        self.attrs().optional_string(key).map(|s| s.into_owned())
    }
    fn flag(&self, key: &str) -> bool {
        self.attrs().optional_bool(key)
    }
}

/// The first collection of `<…><sync><collection>`.
pub fn parse_patch_list(node: &Node) -> Result<PatchList> {
    collection(
        node.child_path(&["sync", "collection"])
            .ok_or_else(|| anyhow!("missing sync/collection"))?,
    )
}

pub fn parse_patch_list_ref(node: &NodeRef<'_>) -> Result<PatchList> {
    collection(
        node.child_path(&["sync", "collection"])
            .ok_or_else(|| anyhow!("missing sync/collection"))?,
    )
}

/// Every collection of a batched answer, from `<iq><sync>` or a bare `<sync>`.
pub fn parse_patch_lists(node: &Node) -> Result<Vec<PatchList>> {
    collections(node)
}

pub fn parse_patch_lists_ref(node: &NodeRef<'_>) -> Result<Vec<PatchList>> {
    collections(node)
}

fn collections<E: Element>(node: &E) -> Result<Vec<PatchList>> {
    let sync = if node.tag_name() == "sync" {
        node
    } else {
        node.child("sync")
            .ok_or_else(|| anyhow!("missing sync node in response"))?
    };
    sync.kids()
        .iter()
        .filter(|c| c.tag_name() == "collection")
        .map(collection)
        .collect()
}

fn collection<E: Element>(node: &E) -> Result<PatchList> {
    let name = node
        .string("name")
        .ok_or_else(|| anyhow!("collection missing 'name' attribute"))?;
    let has_more_patches = node.flag("has_more_patches");
    let mut error =
        (node.string("type").as_deref() == Some("error")).then(|| collection_error(node));
    // An unreadable snapshot reference must not read as "no snapshot": that
    // would record the collection as synced and empty, for good.
    let mut snapshot_ref = None;
    if let Some(snapshot) = node.child("snapshot") {
        match snapshot
            .bytes()
            .map(waproto::codec::external_blob_reference_decode)
        {
            Some(Ok(reference)) => snapshot_ref = Some(reference),
            _ => {
                error.get_or_insert(CollectionSyncError::Retry {
                    code: 0,
                    text: "unreadable snapshot reference".to_owned(),
                });
            }
        }
    }
    let mut patches = Vec::new();
    for patch in node.child("patches").map(Element::kids).unwrap_or_default() {
        if patch.tag_name() != "patch" {
            continue;
        }
        if let Some(raw) = patch.bytes() {
            patches.push(
                waproto::codec::syncd_patch_decode(raw)
                    .map_err(|e| anyhow!("failed to unmarshal patch: {e}"))?,
            );
        }
    }
    Ok(PatchList {
        name: WAPatchName::from_str(&name).unwrap_or(WAPatchName::Unknown),
        has_more_patches,
        patches,
        snapshot: None,
        snapshot_ref,
        error,
    })
}

fn collection_error<E: Element>(node: &E) -> CollectionSyncError {
    let (code, text) = match node.child("error") {
        Some(e) => (
            e.string("code").and_then(|c| c.parse().ok()).unwrap_or(0),
            e.string("text").unwrap_or_default(),
        ),
        None => (0, "missing <error> child".to_owned()),
    };
    match code {
        409 => CollectionSyncError::Conflict {
            has_more: node.flag("has_more_patches"),
        },
        400 | 404 => CollectionSyncError::Fatal { code, text },
        _ => CollectionSyncError::Retry { code, text },
    }
}
