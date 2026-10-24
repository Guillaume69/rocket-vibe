//! What the engine keeps of the account beside the protocol state: messages,
//! reactions, names, photos and unread counts, as the client is shown them.
//! Ids are `<chat>:<WhatsApp message id>`, the chat in its canonical form
//! (phone number rather than LID when the mapping is known); `raw_chat` and
//! `raw_sender` keep the addressing WhatsApp used, which reactions, edits and
//! revocations must reuse.

use std::collections::{BTreeMap, BTreeSet, HashMap};

use serde::{Deserialize, Serialize};

use crate::wire::{self, Frame, Message, Reaction};

/// Settled messages kept, newest first; older ones are dropped.
pub const MAX_CACHED: usize = 20_000;

const LID_SERVER: &str = "@lid";
const GROUP_SERVER: &str = "@g.us";

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Stored {
    #[serde(flatten)]
    pub message: Message,
    /// The attachment's message as WhatsApp sent it, to download it again.
    #[serde(
        default,
        skip_serializing_if = "Vec::is_empty",
        with = "wire::base64_bytes"
    )]
    pub media: Vec<u8>,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub raw_chat: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub raw_sender: String,
}

impl Stored {
    /// The message as the client gets it.
    pub fn wire(&self) -> Message {
        let mut m = self.message.clone();
        m.link_image = m.kind.is_empty()
            && !m.link_url.is_empty()
            && (!m.thumb.is_empty() || !self.media.is_empty());
        m
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
struct Kept {
    emoji: String,
    ts: i64,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Avatar {
    /// WhatsApp's id of the photo kept, to ask only for a newer one.
    pub picture: String,
    #[serde(
        default,
        skip_serializing_if = "Vec::is_empty",
        with = "wire::base64_bytes"
    )]
    pub data: Vec<u8>,
    /// When it was last asked for, in ms; 0 asks again at the next pass.
    pub checked: i64,
}

/// What WhatsApp tells of a person: the phone's address book, the name they
/// chose, their business name.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Contact {
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub full_name: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub first_name: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub push_name: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub business_name: String,
}

/// A link preview carried by an edit.
#[derive(Clone, Debug, Default)]
pub struct Preview {
    pub url: String,
    pub title: String,
    pub description: String,
    pub thumb: Vec<u8>,
    pub media: Vec<u8>,
}

/// One read receipt to send: the chat and sender as WhatsApp addressed them.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct Unread {
    pub id: String,
    pub raw_chat: String,
    pub raw_sender: String,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Projection {
    messages: HashMap<String, Stored>,
    /// Message id, then sender.
    reactions: BTreeMap<String, BTreeMap<String, Kept>>,
    chat_names: BTreeMap<String, String>,
    avatars: BTreeMap<String, Avatar>,
    unread: BTreeMap<String, i64>,
    #[serde(default)]
    contacts: BTreeMap<String, Contact>,
}

/// `<chat>:<WhatsApp id>` into its two parts.
pub fn cut_id(id: &str) -> Option<(&str, &str)> {
    id.split_once(':')
}

/// How far a receipt went for my message; a receipt never moves it back.
fn receipt_rank(state: &str) -> u8 {
    match state {
        "delivered" => 1,
        "read" => 2,
        "played" => 3,
        _ => 0,
    }
}

impl Projection {
    pub fn load(&self, id: &str) -> Option<&Stored> {
        self.messages.get(id)
    }

    pub fn len(&self) -> usize {
        self.messages.len()
    }

    pub fn is_empty(&self) -> bool {
        self.messages.is_empty()
    }

    /// Records a send before it reaches the network; false when the id is taken.
    pub fn record(&mut self, m: Stored) -> bool {
        if self.messages.contains_key(&m.message.id) {
            return false;
        }
        self.messages.insert(m.message.id.clone(), m);
        true
    }

    /// Stores a received message, or settles a send, and answers what is kept.
    /// A settled message is not rewritten by a later copy (history replays
    /// what live delivered).
    pub fn remember(&mut self, m: Stored) -> Message {
        let id = m.message.id.clone();
        let kept = match self.messages.get_mut(&id) {
            None => self.messages.entry(id).or_insert(m),
            Some(kept) if kept.message.status.is_empty() => kept,
            Some(kept) => {
                kept.message.status = m.message.status;
                kept.message.ts = m.message.ts;
                kept.message.link_url = m.message.link_url;
                kept.message.link_title = m.message.link_title;
                kept.message.link_description = m.message.link_description;
                kept.message.thumb = m.message.thumb;
                kept.media = m.media;
                kept
            }
        };
        kept.wire()
    }

    /// Settles a send: `""` delivered to the server, `uncertain` unanswered.
    pub fn settle(&mut self, id: &str, status: &str) -> Option<Message> {
        let kept = self.messages.get_mut(id)?;
        kept.message.status = status.to_owned();
        Some(kept.wire())
    }

    /// At open: a send the last run never saw answered may or may not have left.
    pub fn interrupt_sends(&mut self) {
        for kept in self.messages.values_mut() {
            if kept.message.status == "sending" {
                kept.message.status = "uncertain".to_owned();
            }
        }
    }

    pub fn mark_deleted(&mut self, id: &str) -> Option<Message> {
        let kept = self.messages.get_mut(id)?;
        kept.message.text.clear();
        kept.message.deleted = true;
        self.reactions.remove(id);
        Some(kept.wire())
    }

    /// An edit replaces the text and, for a text message, its link preview.
    pub fn mark_edited(&mut self, id: &str, text: &str, preview: Preview) -> Option<Message> {
        let kept = self.messages.get_mut(id)?;
        if !kept.message.deleted {
            kept.message.text = text.to_owned();
            kept.message.edited = true;
            kept.message.link_url = preview.url;
            kept.message.link_title = preview.title;
            kept.message.link_description = preview.description;
            if kept.message.kind.is_empty() {
                kept.message.thumb = preview.thumb;
                kept.media = preview.media;
            }
        }
        Some(kept.wire())
    }

    /// The latest addressing WhatsApp used for a chat, to send in the same form.
    pub fn raw_chat_for(&self, chat: &str) -> Option<&str> {
        self.messages
            .values()
            .filter(|m| m.message.chat == chat && !m.raw_chat.is_empty())
            .max_by(|a, b| {
                a.message
                    .ts
                    .cmp(&b.message.ts)
                    .then_with(|| a.message.id.cmp(&b.message.id))
            })
            .map(|m| m.raw_chat.as_str())
    }

    /// Keeps the newest reaction of each sender; an empty emoji takes it back.
    /// Answers what is kept, the emoji empty when none is.
    pub fn store_reaction(
        &mut self,
        target: &str,
        sender: &str,
        emoji: &str,
        ts: i64,
    ) -> Option<Reaction> {
        if target.is_empty() || sender.is_empty() {
            return None;
        }
        let senders = self.reactions.entry(target.to_owned()).or_default();
        match senders.get(sender) {
            Some(kept) if kept.ts > ts => {}
            _ if emoji.is_empty() => {
                senders.remove(sender);
            }
            _ => {
                senders.insert(
                    sender.to_owned(),
                    Kept {
                        emoji: emoji.to_owned(),
                        ts,
                    },
                );
            }
        }
        let kept = senders.get(sender).cloned();
        if senders.is_empty() {
            self.reactions.remove(target);
        }
        let (emoji, ts) = kept.map_or((String::new(), 0), |k| (k.emoji, k.ts));
        Some(Reaction {
            message: target.to_owned(),
            sender: sender.to_owned(),
            emoji,
            ts,
        })
    }

    /// Drops the oldest settled messages past `max`, and the reactions left
    /// without a message. An uncertain or in-flight send stays until it is
    /// settled, whatever its age.
    pub fn prune(&mut self, max: usize) {
        if self.messages.len() > max {
            let mut order: Vec<(i64, &String)> = self
                .messages
                .iter()
                .map(|(id, m)| (m.message.ts, id))
                .collect();
            order.sort_unstable_by(|a, b| b.cmp(a));
            let dropped: Vec<String> = order[max..]
                .iter()
                .filter(|(_, id)| self.messages[*id].message.status.is_empty())
                .map(|(_, id)| (*id).clone())
                .collect();
            for id in dropped {
                self.messages.remove(&id);
            }
        }
        self.reactions
            .retain(|id, _| self.messages.contains_key(id));
    }

    /// Moves conversations and senders kept under a LID to the phone number
    /// WhatsApp has since mapped it to, so one person is one conversation.
    /// Reports whether anything moved: the client then reloads.
    pub fn normalize(&mut self, pn_for_lid: impl Fn(&str) -> Option<String>) -> bool {
        let mut moved = false;
        let chats: BTreeSet<String> = self
            .messages
            .values()
            .map(|m| m.message.chat.clone())
            .filter(|c| c.ends_with(LID_SERVER))
            .collect();
        for old in chats {
            let Some(pn) = pn_for_lid(&old).filter(|pn| *pn != old) else {
                continue;
            };
            let ids: Vec<String> = self
                .messages
                .values()
                .filter(|m| m.message.chat == old)
                .map(|m| m.message.id.clone())
                .collect();
            for id in ids {
                let mut m = self.messages.remove(&id).expect("listed above");
                let new_id = format!("{pn}{}", &id[old.len()..]);
                m.message.id = new_id.clone();
                m.message.chat = pn.clone();
                self.messages.entry(new_id.clone()).or_insert(m);
                if let Some(reactions) = self.reactions.remove(&id) {
                    let kept = self.reactions.entry(new_id).or_default();
                    for (sender, reaction) in reactions {
                        kept.entry(sender).or_insert(reaction);
                    }
                }
            }
            if let Some(unread) = self.unread.remove(&old) {
                let kept = self.unread.entry(pn).or_insert(0);
                *kept = (*kept).max(unread);
            }
            moved = true;
        }
        let senders: BTreeSet<String> = self
            .messages
            .values()
            .map(|m| m.message.sender.clone())
            .chain(self.reactions.values().flat_map(|r| r.keys().cloned()))
            .filter(|s| s.ends_with(LID_SERVER))
            .collect();
        for old in senders {
            let Some(pn) = pn_for_lid(&old).filter(|pn| *pn != old) else {
                continue;
            };
            for m in self
                .messages
                .values_mut()
                .filter(|m| m.message.sender == old)
            {
                m.message.sender = pn.clone();
            }
            for reactions in self.reactions.values_mut() {
                if let Some(reaction) = reactions.remove(&old) {
                    reactions.entry(pn.clone()).or_insert(reaction);
                }
            }
            moved = true;
        }
        moved
    }

    /// Every LID the cache keeps a chat or a sender under.
    pub fn lids(&self) -> BTreeSet<String> {
        self.messages
            .values()
            .flat_map(|m| [&m.message.chat, &m.message.sender])
            .chain(self.reactions.values().flat_map(|r| r.keys()))
            .filter(|jid| jid.ends_with(LID_SERVER))
            .cloned()
            .collect()
    }

    pub fn unread(&self, chat: &str) -> i64 {
        self.unread.get(chat).copied().unwrap_or(0)
    }

    /// Sets a chat's unread count, or adds `value` to it when `set` is false.
    pub fn set_unread(&mut self, chat: &str, value: i64, set: bool) -> Frame {
        let count = self.unread.entry(chat.to_owned()).or_insert(0);
        *count = if set {
            value.max(0)
        } else {
            (*count + value).max(0)
        };
        Frame::Chat {
            jid: chat.to_owned(),
            unread: *count,
        }
    }

    /// A receipt from the recipient of my messages. In a group one reader is
    /// not everyone: only delivery is shown there.
    pub fn receipt(
        &mut self,
        chat: &str,
        ids: &[String],
        state: &str,
        group: bool,
    ) -> Vec<Message> {
        if receipt_rank(state) == 0 || (group && state != "delivered") {
            return Vec::new();
        }
        let mut moved = Vec::new();
        for id in ids {
            let Some(m) = self.messages.get_mut(&format!("{chat}:{id}")) else {
                continue;
            };
            if !m.message.mine || receipt_rank(state) <= receipt_rank(&m.message.receipt) {
                continue;
            }
            m.message.receipt = state.to_owned();
            moved.push(m.wire());
        }
        moved
    }

    /// The phone marked a chat read, or unread (which shows one when none is).
    pub fn marked_read(&mut self, chat: &str, read: bool) -> Option<Frame> {
        if read {
            Some(self.set_unread(chat, 0, true))
        } else if self.unread(chat) == 0 {
            Some(self.set_unread(chat, 1, true))
        } else {
            None
        }
    }

    /// The newest `limit` messages of others in a chat, to send read receipts for.
    pub fn unread_messages(&self, chat: &str, limit: usize) -> Vec<Unread> {
        let mut found: Vec<&Stored> = self
            .messages
            .values()
            .filter(|m| m.message.chat == chat && !m.message.mine && !m.message.deleted)
            .collect();
        found.sort_unstable_by(|a, b| {
            b.message
                .ts
                .cmp(&a.message.ts)
                .then_with(|| b.message.id.cmp(&a.message.id))
        });
        found
            .into_iter()
            .take(limit)
            .map(|m| Unread {
                id: m.message.id.clone(),
                raw_chat: m.raw_chat.clone(),
                raw_sender: m.raw_sender.clone(),
            })
            .collect()
    }

    /// Reports whether the name changed.
    pub fn set_chat_name(&mut self, jid: &str, name: &str) -> bool {
        if name.is_empty() || self.chat_names.get(jid).is_some_and(|kept| kept == name) {
            return false;
        }
        self.chat_names.insert(jid.to_owned(), name.to_owned());
        true
    }

    pub fn chat_name(&self, jid: &str) -> Option<&str> {
        self.chat_names.get(jid).map(String::as_str)
    }

    pub fn group_names(&self) -> impl Iterator<Item = (&str, &str)> {
        self.chat_names
            .iter()
            .filter(|(jid, _)| jid.ends_with(GROUP_SERVER))
            .map(|(j, n)| (j.as_str(), n.as_str()))
    }

    /// Every chat and sender the cache names, for the names table.
    pub fn named(&self) -> BTreeSet<String> {
        self.messages
            .values()
            .flat_map(|m| [m.message.chat.clone(), m.message.sender.clone()])
            .chain(self.reactions.values().flat_map(|r| r.keys().cloned()))
            .chain(self.chat_names.keys().cloned())
            .filter(|jid| jid != "me" && !jid.is_empty())
            .collect()
    }

    /// Changes what is known of a person; reports whether anything changed.
    pub fn update_contact(&mut self, jid: &str, update: impl FnOnce(&mut Contact)) -> bool {
        let contact = self.contacts.entry(jid.to_owned()).or_default();
        let before = contact.clone();
        update(contact);
        let changed = *contact != before;
        if *contact == Contact::default() {
            self.contacts.remove(jid);
        }
        changed
    }

    pub fn contacts(&self) -> impl Iterator<Item = (&str, &Contact)> {
        self.contacts.iter().map(|(jid, c)| (jid.as_str(), c))
    }

    /// The name WhatsApp would show: the phone's address book first, then the
    /// name the person chose, the business name, the conversation's name, and
    /// the number last. `alt` is the person's other address (LID or number).
    /// Empty when nothing better than the JID is known.
    pub fn name_of(&self, jid: &str, alt: Option<&str>) -> String {
        let stored = self.chat_names.get(jid).cloned().unwrap_or_default();
        if jid.ends_with(GROUP_SERVER) {
            return stored;
        }
        let found: Vec<&Contact> = std::iter::once(jid)
            .chain(alt)
            .filter_map(|j| self.contacts.get(j))
            .collect();
        for c in &found {
            if !c.full_name.is_empty() {
                return c.full_name.clone();
            }
            if !c.first_name.is_empty() {
                return c.first_name.clone();
            }
        }
        let pick = |f: fn(&Contact) -> &String| {
            found.iter().map(|c| f(c)).find(|n| !n.is_empty()).cloned()
        };
        if let Some(name) = pick(|c| &c.push_name).or_else(|| pick(|c| &c.business_name)) {
            return name;
        }
        if !stored.is_empty() {
            return stored;
        }
        let number = std::iter::once(jid)
            .chain(alt)
            .find_map(|j| j.strip_suffix("@s.whatsapp.net"));
        number.map(|n| format!("+{n}")).unwrap_or_default()
    }

    pub fn avatar(&self, jid: &str) -> Option<&Avatar> {
        self.avatars.get(jid)
    }

    pub fn keep_avatar(&mut self, jid: &str, avatar: Avatar) -> Frame {
        let frame = avatar_frame(jid, &avatar.data);
        self.avatars.insert(jid.to_owned(), avatar);
        frame
    }

    /// The photo is unchanged: asked again only once it is stale.
    pub fn avatar_checked(&mut self, jid: &str, at: i64) {
        if let Some(avatar) = self.avatars.get_mut(jid) {
            avatar.checked = at;
        }
    }

    /// The person changed their photo: asked again at the next pass.
    pub fn invalidate_avatar(&mut self, jid: &str) {
        self.avatar_checked(jid, 0);
    }

    /// The photos to ask for, most recent conversation first: the `chats`
    /// latest chats, then the authors of the `authors` latest group messages,
    /// leaving out those checked after `fresh`.
    pub fn stale_avatars(&self, chats: usize, authors: usize, fresh: i64) -> Vec<String> {
        let mut latest: HashMap<&str, i64> = HashMap::new();
        for m in self.messages.values() {
            let ts = latest.entry(m.message.chat.as_str()).or_insert(i64::MIN);
            *ts = (*ts).max(m.message.ts);
        }
        let mut wanted: Vec<(&str, i64)> = latest.into_iter().collect();
        wanted.sort_unstable_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(b.0)));
        wanted.truncate(chats);
        let mut group: Vec<&Stored> = self
            .messages
            .values()
            .filter(|m| {
                m.message.chat.ends_with(GROUP_SERVER)
                    && m.message.sender != "me"
                    && !m.message.sender.is_empty()
            })
            .collect();
        group.sort_unstable_by_key(|m| std::cmp::Reverse(m.message.ts));
        let mut recent: HashMap<&str, i64> = wanted.iter().copied().collect();
        for m in group.into_iter().take(authors) {
            let ts = recent.entry(m.message.sender.as_str()).or_insert(i64::MIN);
            *ts = (*ts).max(m.message.ts - 1);
        }
        let mut out: Vec<(&str, i64)> = recent
            .into_iter()
            .filter(|(jid, _)| self.avatars.get(*jid).is_none_or(|a| a.checked <= fresh))
            .collect();
        out.sort_unstable_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(b.0)));
        out.into_iter().map(|(jid, _)| jid.to_owned()).collect()
    }

    /// The whole cache: messages oldest first, then reactions, photos and
    /// unread chats. The names and the end of the replay follow.
    pub fn replay(&self) -> Vec<Frame> {
        let mut messages: Vec<&Stored> = self.messages.values().collect();
        messages.sort_unstable_by(|a, b| {
            a.message
                .ts
                .cmp(&b.message.ts)
                .then_with(|| a.message.id.cmp(&b.message.id))
        });
        let mut reactions: Vec<Reaction> = self
            .reactions
            .iter()
            .flat_map(|(id, senders)| {
                senders.iter().map(|(sender, k)| Reaction {
                    message: id.clone(),
                    sender: sender.clone(),
                    emoji: k.emoji.clone(),
                    ts: k.ts,
                })
            })
            .collect();
        reactions.sort_by_key(|r| r.ts);
        messages
            .into_iter()
            .map(|m| Frame::Message {
                message: Box::new(m.wire()),
            })
            .chain(
                reactions
                    .into_iter()
                    .map(|reaction| Frame::Reaction { reaction }),
            )
            .chain(
                self.avatars
                    .iter()
                    .filter(|(_, a)| !a.data.is_empty())
                    .map(|(jid, a)| avatar_frame(jid, &a.data)),
            )
            .chain(
                self.unread
                    .iter()
                    .filter(|(_, n)| **n > 0)
                    .map(|(jid, n)| Frame::Chat {
                        jid: jid.clone(),
                        unread: *n,
                    }),
            )
            .collect()
    }
}

pub fn avatar_frame(jid: &str, data: &[u8]) -> Frame {
    use base64::Engine as _;
    Frame::Avatar {
        jid: jid.to_owned(),
        data: base64::engine::general_purpose::STANDARD.encode(data),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn message(id: &str, ts: i64, status: &str) -> Stored {
        let (chat, _) = cut_id(id).unwrap();
        Stored {
            message: Message {
                id: id.into(),
                chat: chat.into(),
                sender: "b@s.whatsapp.net".into(),
                text: "hello".into(),
                ts,
                status: status.into(),
                ..Message::default()
            },
            ..Stored::default()
        }
    }

    #[test]
    fn a_settled_message_is_not_rewritten_by_a_later_copy() {
        let mut p = Projection::default();
        p.remember(message("a@s.whatsapp.net:1", 10, ""));
        let mut later = message("a@s.whatsapp.net:1", 99, "");
        later.message.text = "other".into();
        assert_eq!(p.remember(later).ts, 10);
        assert!(p.record(message("a@s.whatsapp.net:2", 20, "sending")));
        assert!(
            !p.record(message("a@s.whatsapp.net:2", 20, "sending")),
            "an id is recorded once"
        );
        let mut settled = message("a@s.whatsapp.net:2", 21, "");
        settled.message.link_url = "https://x".into();
        settled.message.thumb = vec![1];
        let m = p.remember(settled);
        assert_eq!((m.status.as_str(), m.ts, m.link_image), ("", 21, true));
    }

    #[test]
    fn interrupted_sends_turn_uncertain_and_survive_pruning() {
        let mut p = Projection::default();
        p.record(message("a@s.whatsapp.net:old", 1, "sending"));
        for i in 0..5 {
            p.remember(message(&format!("a@s.whatsapp.net:{i}"), 10 + i, ""));
        }
        p.store_reaction("a@s.whatsapp.net:0", "me", "👍", 1);
        p.interrupt_sends();
        p.prune(3);
        assert_eq!(
            p.load("a@s.whatsapp.net:old").unwrap().message.status,
            "uncertain"
        );
        assert!(p.load("a@s.whatsapp.net:1").is_none() && p.load("a@s.whatsapp.net:2").is_some());
        assert!(
            p.replay()
                .iter()
                .all(|f| !matches!(f, Frame::Reaction { .. })),
            "orphan reactions go"
        );
    }

    #[test]
    fn a_reaction_never_goes_back_in_time() {
        let mut p = Projection::default();
        let id = "a@s.whatsapp.net:1";
        assert_eq!(p.store_reaction(id, "me", "👍", 5).unwrap().emoji, "👍");
        assert_eq!(p.store_reaction(id, "me", "❤", 4).unwrap().emoji, "👍");
        assert_eq!(p.store_reaction(id, "me", "", 4).unwrap().emoji, "👍");
        let gone = p.store_reaction(id, "me", "", 6).unwrap();
        assert_eq!((gone.emoji.as_str(), gone.ts), ("", 0));
    }

    #[test]
    fn edits_and_deletions() {
        let mut p = Projection::default();
        let id = "a@s.whatsapp.net:1";
        p.remember(message(id, 1, ""));
        p.store_reaction(id, "me", "👍", 1);
        let preview = Preview {
            url: "https://x".into(),
            thumb: vec![1],
            ..Preview::default()
        };
        let edited = p.mark_edited(id, "new", preview).unwrap();
        assert!(edited.edited && edited.link_image && edited.text == "new");
        let deleted = p.mark_deleted(id).unwrap();
        assert!(deleted.deleted && deleted.text.is_empty());
        assert_eq!(
            p.mark_edited(id, "again", Preview::default()).unwrap().text,
            "",
            "a deleted message stays deleted"
        );
        assert!(
            p.replay()
                .iter()
                .all(|f| !matches!(f, Frame::Reaction { .. }))
        );
    }

    #[test]
    fn receipts_only_move_forward_and_groups_show_delivery_only() {
        let mut p = Projection::default();
        let mut mine = message("a@s.whatsapp.net:1", 1, "");
        mine.message.mine = true;
        p.remember(mine);
        p.remember(message("a@s.whatsapp.net:2", 2, ""));
        let ids = vec!["1".to_string(), "2".to_string()];
        assert_eq!(
            p.receipt("a@s.whatsapp.net", &ids, "read", false).len(),
            1,
            "only mine"
        );
        assert!(
            p.receipt("a@s.whatsapp.net", &ids, "delivered", false)
                .is_empty()
        );
        assert!(p.receipt("g@g.us", &ids, "read", true).is_empty());
    }

    #[test]
    fn a_lid_conversation_moves_to_its_number() {
        let mut p = Projection::default();
        p.remember(message("1@lid:A", 1, ""));
        p.remember(message("2@s.whatsapp.net:A", 1, ""));
        let mut from_lid = message("g@g.us:B", 2, "");
        from_lid.message.sender = "1@lid".into();
        p.remember(from_lid);
        p.store_reaction("1@lid:A", "1@lid", "👍", 3);
        p.set_unread("1@lid", 4, true);
        p.set_unread("2@s.whatsapp.net", 1, true);
        let map = |lid: &str| (lid == "1@lid").then(|| "2@s.whatsapp.net".to_string());
        assert!(p.normalize(map));
        assert!(p.load("1@lid:A").is_none());
        assert_eq!(
            p.load("2@s.whatsapp.net:A").unwrap().message.chat,
            "2@s.whatsapp.net"
        );
        assert_eq!(
            p.load("g@g.us:B").unwrap().message.sender,
            "2@s.whatsapp.net"
        );
        assert_eq!(p.unread("2@s.whatsapp.net"), 4);
        let r = p
            .store_reaction("2@s.whatsapp.net:A", "2@s.whatsapp.net", "", 0)
            .unwrap();
        assert_eq!(r.emoji, "👍");
        assert!(!p.normalize(map), "nothing left to move");
    }

    #[test]
    fn unread_counts_and_read_targets() {
        let mut p = Projection::default();
        assert_eq!(
            p.set_unread("a", -3, false),
            Frame::Chat {
                jid: "a".into(),
                unread: 0
            }
        );
        p.set_unread("a", 2, false);
        assert!(p.marked_read("a", false).is_none(), "already unread");
        assert_eq!(
            p.marked_read("a", true),
            Some(Frame::Chat {
                jid: "a".into(),
                unread: 0
            })
        );
        assert_eq!(
            p.marked_read("a", false),
            Some(Frame::Chat {
                jid: "a".into(),
                unread: 1
            })
        );
        for i in 0..3 {
            p.remember(message(&format!("c@s.whatsapp.net:{i}"), i, ""));
        }
        let ids: Vec<String> = p
            .unread_messages("c@s.whatsapp.net", 2)
            .into_iter()
            .map(|u| u.id)
            .collect();
        assert_eq!(ids, ["c@s.whatsapp.net:2", "c@s.whatsapp.net:1"]);
    }

    #[test]
    fn stale_photos_most_recent_first() {
        let mut p = Projection::default();
        p.remember(message("a@s.whatsapp.net:1", 1, ""));
        let mut in_group = message("g@g.us:2", 5, "");
        in_group.message.sender = "c@s.whatsapp.net".into();
        p.remember(in_group);
        p.keep_avatar(
            "a@s.whatsapp.net",
            Avatar {
                checked: 100,
                ..Avatar::default()
            },
        );
        assert_eq!(
            p.stale_avatars(300, 3000, 50),
            ["g@g.us", "c@s.whatsapp.net"]
        );
        p.invalidate_avatar("a@s.whatsapp.net");
        assert_eq!(p.stale_avatars(300, 3000, 50).len(), 3);
    }

    #[test]
    fn names_as_whatsapp_shows_them() {
        let mut p = Projection::default();
        let pn = "33612345678@s.whatsapp.net";
        assert_eq!(p.name_of(pn, None), "+33612345678");
        assert_eq!(p.name_of("1@lid", None), "");
        assert_eq!(p.name_of("1@lid", Some(pn)), "+33612345678");
        p.set_chat_name(pn, "Chat name");
        assert_eq!(p.name_of(pn, None), "Chat name");
        p.update_contact("1@lid", |c| c.push_name = "Pushed".into());
        assert_eq!(p.name_of(pn, Some("1@lid")), "Pushed");
        assert!(p.update_contact(pn, |c| c.first_name = "Al".into()));
        assert!(!p.update_contact(pn, |c| c.first_name = "Al".into()));
        assert_eq!(p.name_of(pn, Some("1@lid")), "Al");
        p.set_chat_name("g@g.us", "Group");
        assert_eq!(p.name_of("g@g.us", None), "Group");
    }

    #[test]
    fn the_projection_survives_a_round_trip() {
        let mut p = Projection::default();
        let mut m = message("a@s.whatsapp.net:1", 1, "");
        m.media = vec![9, 9];
        m.raw_chat = "1@lid".into();
        m.message.thumb = vec![1];
        p.remember(m);
        p.store_reaction("a@s.whatsapp.net:1", "me", "👍", 1);
        p.set_chat_name("g@g.us", "Group");
        p.keep_avatar(
            "a@s.whatsapp.net",
            Avatar {
                picture: "p".into(),
                data: vec![1],
                checked: 1,
            },
        );
        p.set_unread("a@s.whatsapp.net", 2, true);
        p.update_contact("a@s.whatsapp.net", |c| c.full_name = "A".into());
        let back: Projection = serde_json::from_slice(&serde_json::to_vec(&p).unwrap()).unwrap();
        assert_eq!(back, p);
    }
}
