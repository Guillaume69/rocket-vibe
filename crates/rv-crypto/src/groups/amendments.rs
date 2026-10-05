//! Edits, deletions and reactions applied at projection time
//! (E2EE_AMENDMENTS.md). Views walk their documents newest first, so an
//! amendment is met before its target; amendments are never rows. Only the
//! target's author edits or deletes it; any member reacts.
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
/// One emoji on a message and who currently reacts with it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Reaction {
    pub emoji: String,
    pub users: Vec<String>,
}
/// The latest reaction or withdrawal of one user with one emoji.
#[derive(Clone, Copy)]
struct Reacted {
    present: bool,
    position: u64,
}
#[derive(Default)]
pub(super) struct Amendments {
    deleted: BTreeSet<(String, String)>,
    edited: BTreeMap<(String, String), Edit>,
    /// Target message id, then (emoji, user).
    reacted: BTreeMap<String, BTreeMap<(String, String), Reacted>>,
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
            // The highest position wins: a single walk meets them newest
            // first, but recovered periods are walked one after another.
            packet::Kind::Edit => {
                if self
                    .edited
                    .get(&key)
                    .is_none_or(|kept| kept.position < receipt.position)
                {
                    let (message, observed_at) = load()?;
                    self.edited.insert(
                        key,
                        Edit {
                            text: Zeroizing::new(message.message()?.text),
                            observed_at,
                            position: receipt.position,
                        },
                    );
                }
            }
            packet::Kind::React | packet::Kind::Unreact => {
                let (message, _) = load()?;
                let emoji = message.message()?.text;
                let users = self.reacted.entry(target.clone()).or_default();
                let reacted = Reacted {
                    present: header.kind == packet::Kind::React,
                    position: receipt.position,
                };
                match users.entry((emoji, header.author.clone())) {
                    Entry::Vacant(slot) => {
                        slot.insert(reacted);
                    }
                    Entry::Occupied(mut slot) if slot.get().position < reacted.position => {
                        slot.insert(reacted);
                    }
                    Entry::Occupied(_) => {}
                }
            }
        }
        Ok(true)
    }
    /// The current reactions to this message, in order of their first
    /// remaining reaction, users sorted.
    pub(super) fn reactions(&self, receipt: &packet::Receipt) -> Vec<Reaction> {
        let Some(all) = self.reacted.get(&receipt.message) else {
            return Vec::new();
        };
        let mut grouped: BTreeMap<&str, (u64, Vec<String>)> = BTreeMap::new();
        for ((emoji, user), reacted) in all.iter().filter(|(_, r)| r.present) {
            let entry = grouped
                .entry(emoji)
                .or_insert((reacted.position, Vec::new()));
            entry.0 = entry.0.min(reacted.position);
            entry.1.push(user.clone());
        }
        let mut reactions = grouped.into_iter().collect::<Vec<_>>();
        reactions.sort_by_key(|(_, (first, _))| *first);
        reactions
            .into_iter()
            .map(|(emoji, (_, users))| Reaction {
                emoji: emoji.to_owned(),
                users,
            })
            .collect()
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
        message.reactions = self.reactions(&message.message.receipt);
        message
    }
    pub(super) fn edit(&self, receipt: &packet::Receipt) -> Option<Edit> {
        self.edited.get(&Self::key(receipt)).cloned()
    }
    /// Adds `other`'s amendments to these.
    pub(super) fn absorb(&mut self, other: &Amendments) {
        self.deleted.extend(other.deleted.iter().cloned());
        for (target, users) in &other.reacted {
            let kept = self.reacted.entry(target.clone()).or_default();
            for (key, reacted) in users {
                match kept.get(key) {
                    Some(old) if old.position >= reacted.position => {}
                    _ => {
                        kept.insert(key.clone(), *reacted);
                    }
                }
            }
        }
        for (key, edit) in &other.edited {
            match self.edited.get(key) {
                Some(kept) if kept.position >= edit.position => {}
                _ => {
                    self.edited.insert(key.clone(), edit.clone());
                }
            }
        }
    }
}
