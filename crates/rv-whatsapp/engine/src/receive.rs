//! What WhatsApp tells the engine: messages live and from history, receipts,
//! typing, calls and group names.

use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::Duration;

use wacore::proto_helpers::MessageExt as _;
use whatsapp_rust::Jid;
use whatsapp_rust::types::call::{CallAction, IncomingCall};
use whatsapp_rust::types::events::{ChatPresenceUpdate, Event, GroupUpdate, Receipt};
use whatsapp_rust::types::message::MessageInfo;
use whatsapp_rust::types::presence::{ChatActivity, ReceiptType};
use whatsapp_rust::waproto::whatsapp as wa;

use crate::content::{attachment_of, context_of, is_group, link_of, text_of, valid_chat};
use crate::engine::{Engine, Ringing};
use crate::projection::{MAX_CACHED, Preview, Stored};
use crate::wire::{Call, Frame, Message, Typing};

impl Engine {
    /// Stores a message; true when it is a new message of someone else.
    pub(crate) async fn receive(
        &self,
        message: &wa::Message,
        info: &MessageInfo,
        expiration: Option<u32>,
        name: &str,
    ) -> bool {
        // Not kept: view-once and disappearing content must not outlive WhatsApp's own copy.
        if message.is_ephemeral() || message.is_view_once() || expiration.unwrap_or(0) != 0 {
            return false;
        }
        let base = message.get_base_message();
        if context_of(base).and_then(|c| c.expiration).unwrap_or(0) != 0 {
            return false;
        }
        let source = &info.source;
        let ts = info.timestamp.timestamp_millis();
        if !source.is_from_me {
            self.learn_names(&source.sender, info).await;
        }
        if let Some(reaction) = base.reaction_message.as_option() {
            let chat = self.canonical(&source.chat).await;
            let target = format!(
                "{chat}:{}",
                reaction
                    .key
                    .as_option()
                    .and_then(|k| k.id.as_deref())
                    .unwrap_or_default()
            );
            let sender = self.sender_key(source.is_from_me, &source.sender).await;
            let emoji = reaction.text.clone().unwrap_or_default();
            if let Some(kept) = self.with_state(|p| p.store_reaction(&target, &sender, &emoji, ts))
            {
                self.emit(Frame::Reaction { reaction: kept });
            }
            return false;
        }
        if let Some(protocol) = base.protocol_message.as_option() {
            self.protocol(
                source.is_from_me,
                &source.sender,
                source.is_group,
                &source.chat,
                protocol,
            )
            .await;
            return false;
        }
        let text = text_of(base).to_owned();
        let attachment = attachment_of(base);
        if text.is_empty() && attachment.is_none() {
            return false;
        }
        let raw = source.chat.to_non_ad();
        if valid_chat(&raw.to_string()).is_none() {
            return false;
        }
        let chat = self.canonical(&raw).await;
        let chat_str = chat.to_string();
        if !name.is_empty() && self.with_state(|p| p.set_chat_name(&chat_str, name)) {
            self.names_dirty.store(true, Ordering::SeqCst);
        }
        let id = format!("{chat_str}:{}", info.id.as_str());
        let known = self.read_state(|p| p.load(&id).is_some());
        let mut stored = Stored {
            message: Message {
                id: id.clone(),
                chat: chat_str.clone(),
                name: chat.user.to_string(),
                sender: self.sender_key(source.is_from_me, &source.sender).await,
                author: info.push_name.to_string(),
                text,
                ts,
                mine: source.is_from_me,
                ..Message::default()
            },
            raw_chat: raw.to_string(),
            raw_sender: source.sender.to_non_ad().to_string(),
            ..Stored::default()
        };
        match attachment {
            Some((a, caption)) => {
                let m = &mut stored.message;
                m.text = caption;
                m.kind = a.kind.to_owned();
                m.mime = a.mime;
                m.file_name = a.file_name;
                m.size = a.size;
                m.width = a.width;
                m.height = a.height;
                m.seconds = a.seconds;
                m.thumb = a.thumb;
                stored.media = a.media;
            }
            None => set_link(&mut stored, base),
        }
        self.quoted(&mut stored.message, &chat, context_of(base))
            .await;
        let kept = self.with_state(|p| p.remember(stored));
        self.emit_stored(Some(kept));
        self.names_dirty.store(true, Ordering::SeqCst);
        !known && !source.is_from_me
    }

    /// The names a message tells of its sender: the one they chose, their business.
    async fn learn_names(&self, sender: &Jid, info: &MessageInfo) {
        let jid = self.canonical(sender).await.to_string();
        let push = info.push_name.to_string();
        let business = info
            .verified_name
            .as_ref()
            .and_then(|v| v.name.clone())
            .unwrap_or_default();
        let changed = self.with_state(|p| {
            p.update_contact(&jid, |c| {
                if !push.is_empty() {
                    c.push_name = push;
                }
                if !business.is_empty() {
                    c.business_name = business;
                }
            })
        });
        if changed {
            self.names_dirty.store(true, Ordering::SeqCst);
        }
    }

    /// The message a reply answers, as WhatsApp quoted it.
    async fn quoted(&self, m: &mut Message, chat: &Jid, info: Option<&wa::ContextInfo>) {
        let Some(info) = info else { return };
        let Some(stanza) = info.stanza_id.as_deref().filter(|s| !s.is_empty()) else {
            return;
        };
        m.reply_to = format!("{chat}:{stanza}");
        let quoted = info.quoted_message.as_option();
        m.quote_text = quoted.map(|q| text_of(q).to_owned()).unwrap_or_default();
        if m.quote_text.is_empty()
            && let Some((a, caption)) = quoted.and_then(attachment_of)
        {
            m.quote_text = if caption.is_empty() {
                a.kind.to_owned()
            } else {
                caption
            };
        }
        let participant = info
            .participant
            .as_deref()
            .filter(|p| !p.is_empty())
            .and_then(|p| p.parse::<Jid>().ok());
        if let Some(participant) = participant {
            let sender = self.canonical(&participant).await;
            let me = match self.client().and_then(|c| c.pn()) {
                Some(pn) => Some(self.canonical(&pn).await),
                None => None,
            };
            m.quote_sender = if me.is_some_and(|me| me.user == sender.user) {
                "me".to_owned()
            } else {
                sender.to_string()
            };
        } else if !is_group(&chat.to_string()) {
            m.quote_sender = chat.to_string();
        }
    }

    /// An edit or a revocation, accepted from the author only; in a group an
    /// admin may also revoke someone else's message.
    async fn protocol(
        &self,
        from_me: bool,
        sender: &Jid,
        group: bool,
        chat: &Jid,
        p: &wa::message::ProtocolMessage,
    ) {
        use wa::message::protocol_message::Type;
        let chat = self.canonical(chat).await;
        let target = p
            .key
            .as_option()
            .and_then(|k| k.id.as_deref())
            .unwrap_or_default();
        let id = format!("{chat}:{target}");
        let Some(stored_sender) =
            self.read_state(|s| s.load(&id).map(|m| m.message.sender.clone()))
        else {
            return;
        };
        let author = stored_sender == self.sender_key(from_me, sender).await;
        match p.r#type {
            Some(Type::REVOKE) if author || group => {
                let deleted = self.with_state(|s| s.mark_deleted(&id));
                self.emit_stored(deleted);
            }
            Some(Type::MESSAGE_EDIT) if author => {
                let Some(edited) = p.edited_message.as_option() else {
                    return;
                };
                let text = text_of(edited);
                if text.is_empty() {
                    return;
                }
                let link = link_of(edited);
                let preview = Preview {
                    url: link.url,
                    title: link.title,
                    description: link.description,
                    thumb: link.thumb,
                    media: link.media,
                };
                let changed = self.with_state(|s| s.mark_edited(&id, text, preview));
                // The thumbnail written for the old preview goes with it.
                let _ = std::fs::remove_file(self.link_image_path(&id));
                self.emit_stored(changed);
            }
            _ => {}
        }
    }

    /// History arrives newest first: replayed oldest first so edits and
    /// revocations find their message.
    pub(crate) async fn history(&self, event: Arc<Event>) {
        let decode = move || match &*event {
            Event::HistorySync(lazy) => lazy.get().cloned(),
            _ => None,
        };
        let Ok(Some(history)) = tokio::task::spawn_blocking(decode).await else {
            return;
        };
        use wa::history_sync::HistorySyncType;
        let first_sync = matches!(
            history.sync_type,
            HistorySyncType::INITIAL_BOOTSTRAP | HistorySyncType::FULL
        );
        for pushname in &history.pushnames {
            let (Some(id), Some(name)) = (pushname.id.as_deref(), pushname.pushname.as_deref())
            else {
                continue;
            };
            let Ok(jid) = id.parse::<Jid>() else { continue };
            let jid = self.canonical(&jid).await.to_string();
            let name = name.to_owned();
            self.with_state(|p| p.update_contact(&jid, |c| c.push_name = name));
        }
        let me = self
            .client()
            .and_then(|c| c.pn())
            .map(|pn| pn.to_non_ad())
            .unwrap_or_default();
        for conversation in &history.conversations {
            if conversation.ephemeral_expiration.unwrap_or(0) != 0 {
                continue;
            }
            let Some(jid) = valid_chat(&conversation.id) else {
                continue;
            };
            // The phone's own count, from the first full sync: newer than mine.
            if first_sync {
                let mut unread = i64::from(conversation.unread_count.unwrap_or(0));
                if conversation.marked_as_unread == Some(true) && unread == 0 {
                    unread = 1;
                }
                let chat = self.canonical(&jid).await.to_string();
                let frame = self.with_state(|p| p.set_unread(&chat, unread, true));
                self.emit(frame);
            }
            let name = conversation.name.clone().unwrap_or_default();
            for entry in conversation.messages.iter().rev() {
                let Some(web) = entry.message.as_option() else {
                    continue;
                };
                if let Some((message, info)) = parse_web(&jid, web, &me) {
                    self.receive(&message, &info, None, &name).await;
                }
                self.history_reactions(&jid, web).await;
            }
        }
        if self.normalize().await {
            self.reload().await;
        }
        self.with_state(|p| p.prune(MAX_CACHED));
        self.names_dirty.store(true, Ordering::SeqCst);
        self.avatar_kick.notify_one();
    }

    async fn history_reactions(&self, chat: &Jid, web: &wa::WebMessageInfo) {
        let key = web
            .key
            .as_option()
            .and_then(|k| k.id.as_deref())
            .unwrap_or_default();
        let target = format!("{}:{key}", self.canonical(chat).await);
        for reaction in &web.reactions {
            let Some(key) = reaction.key.as_option() else {
                continue;
            };
            let sender = if key.from_me == Some(true) {
                "me".to_owned()
            } else {
                let from = key
                    .participant
                    .as_deref()
                    .filter(|p| !p.is_empty())
                    .or(key.remote_jid.as_deref());
                let Some(jid) = from.and_then(|f| f.parse::<Jid>().ok()) else {
                    continue;
                };
                self.canonical(&jid).await.to_string()
            };
            let emoji = reaction.text.clone().unwrap_or_default();
            let ts = reaction.sender_timestamp_ms.unwrap_or(0);
            if let Some(kept) = self.with_state(|p| p.store_reaction(&target, &sender, &emoji, ts))
            {
                self.emit(Frame::Reaction { reaction: kept });
            }
        }
    }

    /// A receipt for my messages from their recipient, or my own reading on
    /// another device (the phone): the chat is then read here too.
    pub(crate) async fn receipt(&self, receipt: &Receipt) {
        let chat = self.canonical(&receipt.source.chat).await.to_string();
        if receipt.source.is_from_me {
            if matches!(receipt.r#type, ReceiptType::Read | ReceiptType::ReadSelf) {
                let frame = self.with_state(|p| p.set_unread(&chat, 0, true));
                self.emit(frame);
            }
            return;
        }
        let state = match receipt.r#type {
            ReceiptType::Delivered => "delivered",
            ReceiptType::Read => "read",
            ReceiptType::Played => "played",
            _ => return,
        };
        let ids: Vec<String> = receipt
            .message_ids
            .iter()
            .map(|id| id.as_str().to_owned())
            .collect();
        let moved = self.with_state(|p| p.receipt(&chat, &ids, state, receipt.source.is_group));
        for m in moved {
            self.emit(Frame::Message {
                message: Box::new(m),
            });
        }
    }

    pub(crate) async fn chat_presence(&self, update: &ChatPresenceUpdate) {
        if update.source.is_from_me {
            return;
        }
        let state = match update.state {
            ChatActivity::Typing => "composing",
            ChatActivity::RecordingAudio => "recording",
            _ => "paused",
        };
        let typing = Typing {
            chat: self.canonical(&update.source.chat).await.to_string(),
            sender: self.canonical(&update.source.sender).await.to_string(),
            state: state.to_owned(),
        };
        self.emit(Frame::Typing { typing });
    }

    /// A call ringing here, then ended. Audio and video are not carried: it
    /// can be declined, or answered on the phone.
    pub(crate) async fn call_event(&self, call: &IncomingCall) {
        let (id, creator, state, video, group) = match &call.action {
            CallAction::Offer {
                call_id,
                call_creator,
                is_video,
                group_jid,
                ..
            } => (
                call_id,
                call_creator,
                "ringing",
                *is_video,
                group_jid.clone(),
            ),
            CallAction::OfferNotice {
                call_id,
                call_creator,
                is_video,
                ..
            } => (call_id, call_creator, "ringing", *is_video, None),
            CallAction::Accept {
                call_id,
                call_creator,
                ..
            }
            | CallAction::Reject {
                call_id,
                call_creator,
                ..
            }
            | CallAction::Terminate {
                call_id,
                call_creator,
                ..
            } => (call_id, call_creator, "ended", false, None),
            _ => return,
        };
        if state == "ringing" {
            // A call I place from my phone rings nowhere here.
            if self
                .client()
                .and_then(|c| c.pn())
                .is_some_and(|me| me.user == creator.user)
            {
                return;
            }
            let ringing = Ringing {
                from: call.from.clone(),
                creator: creator.clone(),
            };
            self.calls
                .lock()
                .expect("calls")
                .insert(id.clone(), ringing);
        } else {
            // Answered on another of my devices, declined or over: no longer ringing here.
            self.calls.lock().expect("calls").remove(id);
        }
        let caller = if creator.user.is_empty() {
            &call.from
        } else {
            creator
        };
        let call = Call {
            id: id.clone(),
            from: self.canonical(caller).await.to_string(),
            group: group.map(|g| g.to_string()).unwrap_or_default(),
            video,
            state: state.to_owned(),
        };
        self.emit(Frame::Call { call });
    }

    pub(crate) async fn group_update(&self, update: &GroupUpdate) {
        use wacore::stanza::groups::GroupNotificationAction as Action;
        let jid = self.canonical(&update.group_jid).await.to_string();
        let name = match update.action.as_ref() {
            Action::Subject { subject, .. } => Some(subject.to_string()),
            Action::Create { .. } => self.group_name(&update.group_jid).await,
            Action::Add { participants, .. } => {
                let me = self.client().map(|c| (c.pn(), c.lid())).unwrap_or_default();
                let mine = participants.iter().any(|p| {
                    me.0.as_ref().is_some_and(|pn| pn.user == p.jid.user)
                        || me.1.as_ref().is_some_and(|lid| lid.user == p.jid.user)
                });
                if mine {
                    self.group_name(&update.group_jid).await
                } else {
                    None
                }
            }
            _ => None,
        };
        if let Some(name) = name
            && self.with_state(|p| p.set_chat_name(&jid, &name))
        {
            self.names_dirty.store(true, Ordering::SeqCst);
        }
    }

    async fn group_name(&self, group: &Jid) -> Option<String> {
        let client = self.client()?;
        let metadata = tokio::time::timeout(
            Duration::from_secs(20),
            client.groups().fetch_metadata(group),
        )
        .await
        .ok()?
        .ok()?;
        metadata.subject.filter(|s| !s.is_empty())
    }

    /// Group names come with the group list, once per connection.
    pub(crate) async fn refresh_groups(&self) {
        let Some(client) = self.client() else { return };
        let Ok(Ok(groups)) = tokio::time::timeout(
            Duration::from_secs(30),
            client.groups().list_participating(),
        )
        .await
        else {
            return;
        };
        for group in groups {
            let Some(subject) = group.subject.filter(|s| !s.is_empty()) else {
                continue;
            };
            let jid = self.canonical(&group.id).await.to_string();
            if self.with_state(|p| p.set_chat_name(&jid, &subject)) {
                self.names_dirty.store(true, Ordering::SeqCst);
            }
        }
    }
}

/// A text message's link preview; a large thumbnail the sender uploaded is
/// kept as the message's media, fetched with `download`.
pub(crate) fn set_link(stored: &mut Stored, from: &wa::Message) {
    let link = link_of(from);
    stored.message.link_url = link.url;
    stored.message.link_title = link.title;
    stored.message.link_description = link.description;
    stored.message.thumb = link.thumb;
    stored.media = link.media;
}

/// A history entry as a live message: whatsapp-rust keeps its own parser private.
fn parse_web(chat: &Jid, web: &wa::WebMessageInfo, me: &Jid) -> Option<(wa::Message, MessageInfo)> {
    use whatsapp_rust::types::message::MessageSource;
    let key = web.key.as_option()?;
    let from_me = key.from_me.unwrap_or(false);
    let group = chat.server.as_str() == "g.us";
    let sender: Jid = if from_me {
        me.clone()
    } else if group {
        web.participant
            .as_deref()
            .filter(|p| !p.is_empty())
            .or(key.participant.as_deref())?
            .parse()
            .ok()?
    } else {
        chat.clone()
    };
    let mut info = MessageInfo {
        source: MessageSource {
            chat: chat.clone(),
            sender,
            is_from_me: from_me,
            is_group: group,
            ..Default::default()
        },
        timestamp: wacore::time::from_secs_or_now(web.message_timestamp? as i64),
        push_name: web.push_name.clone().unwrap_or_default().into(),
        ..Default::default()
    };
    info.id = key.id.clone()?.into();
    Some((web.message.as_option()?.clone(), info))
}
