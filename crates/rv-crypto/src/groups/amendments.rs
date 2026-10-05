//! Edits and deletions applied at projection time (E2EE_AMENDMENTS.md). Views
//! walk their documents newest first, so an amendment is met before its target;
//! amendments are never rows, and only the target's author amends it.
use super::journal::ProjectedMessage;
use super::*;
use rv_crypto_public::messages as packet;
use std::collections::{BTreeSet, btree_map::Entry};
use zeroize::Zeroizing;

/// The latest edit of a message by its author.
#[derive(Clone)]
pub struct Edit {
    pub text: Zeroizing<String>,
    /// When this device (or the sharing device) observed the edit.
    pub observed_at: u64,
    position: u64,
}
#[derive(Default)]
pub(super) struct Amendments {
    deleted: BTreeSet<(String, String)>,
    edited: BTreeMap<(String, String), Edit>,
}
impl Amendments {
    /// Notes `receipt` if it is an amendment, met newest first, and says so: an
    /// amendment is never shown as a row. `load` reads its document for an edit.
    pub(super) fn observe(
        &mut self,
        receipt: &packet::Receipt,
        load: impl FnOnce() -> Result<(ClearMessage, u64)>,
    ) -> Result<bool> {
        let header = &receipt.header;
        let Some(target) = &header.target else {
            return Ok(false);
        };
        let key = (target.clone(), header.author.clone());
        match header.kind {
            packet::Kind::Chat => return Err(Error::Changed),
            packet::Kind::Delete => {
                self.deleted.insert(key);
            }
            packet::Kind::Edit => {
                if let Entry::Vacant(slot) = self.edited.entry(key) {
                    let (message, observed_at) = load()?;
                    slot.insert(Edit {
                        text: Zeroizing::new(message.message()?.text),
                        observed_at,
                        position: receipt.position,
                    });
                }
            }
        }
        Ok(true)
    }
    fn key(receipt: &packet::Receipt) -> (String, String) {
        (receipt.message.clone(), receipt.header.author.clone())
    }
    /// The author deleted this message: it leaves the views.
    pub(super) fn deleted(&self, receipt: &packet::Receipt) -> bool {
        self.deleted.contains(&Self::key(receipt))
    }
    /// The message with its author's latest edit, if any.
    pub(super) fn apply(&self, mut message: ProjectedMessage) -> ProjectedMessage {
        message.edit = self.edit(&message.message.receipt);
        message
    }
    pub(super) fn edit(&self, receipt: &packet::Receipt) -> Option<Edit> {
        self.edited.get(&Self::key(receipt)).cloned()
    }
    /// Adds `other`'s amendments to these.
    pub(super) fn absorb(&mut self, other: &Amendments) {
        self.deleted.extend(other.deleted.iter().cloned());
        for (key, edit) in &other.edited {
            match self.edited.get(key) {
                Some(kept) if kept.position >= edit.position => {}
                _ => {
                    self.edited.insert(key.clone(), edit.clone());
                }
            }
        }
    }
    /// Amendments met in another walk (recovered history) also apply here.
    #[allow(dead_code)]
    pub(super) fn merge(&mut self, other: Amendments) {
        self.deleted.extend(other.deleted);
        for (key, edit) in other.edited {
            match self.edited.get(&key) {
                Some(kept) if kept.position >= edit.position => {}
                _ => {
                    self.edited.insert(key, edit);
                }
            }
        }
    }
}
