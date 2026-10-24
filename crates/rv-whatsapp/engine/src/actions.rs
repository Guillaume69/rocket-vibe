//! What the client asks the engine to do.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::Duration;

use tokio::sync::oneshot;
use whatsapp_rust::buffa::MessageField;
use whatsapp_rust::client::Client;
use whatsapp_rust::download::{DownloadLimits, DownloadParams, Downloadable, MediaType};
use whatsapp_rust::pair_code::{PairCodeOptions, PairError};
use whatsapp_rust::waproto::{codec, whatsapp as wa};
use whatsapp_rust::{
    EditRequest, Jid, MessageId, MessageRef, PresenceStatus, RevokeType, SendOptions, SendRequest,
    UploadOptions,
};

use crate::content::{
    build, first_link, media_file, ogg_seconds, outgoing_kind, phone_digits, valid_chat,
    with_scheme,
};
use crate::engine::{Engine, now};
use crate::images;
use crate::projection::{Preview, Stored};
use crate::wire::{Call, Command, Frame, Message, Person};

const MAX_TEXT: usize = 20_000;
/// WhatsApp's own windows: recipients ignore later edits and revocations.
const EDIT_WINDOW: i64 = 15 * 60 * 1000;
const REVOKE_WINDOW: i64 = 48 * 3600 * 1000;
/// Read receipts sent for one chat at a time, newest first.
const MAX_READ_IDS: usize = 100;
/// WhatsApp's own ceiling for media; larger files are refused before upload.
const MAX_UPLOAD: u64 = 100 << 20;
/// Files over this size are not fetched by the app.
const MAX_DOWNLOAD: i64 = 200 << 20;
const MAX_FOUND: usize = 30;
const PREVIEW_AGENT: &str = "Mozilla/5.0 (compatible; RocketVibe link preview)";
/// The whole preview, page, image and upload: the send waits for it.
const PREVIEW_TIME: Duration = Duration::from_secs(10);

/// Read receipts for one chat and, in a group, one author.
type ReadBatch = (Jid, Option<Jid>, Vec<String>);

/// A stored message and how WhatsApp addresses it: its chat as WhatsApp
/// wrote it and its own id.
struct Target {
    stored: Stored,
    chat: Jid,
    id: String,
}

fn valid_send_id(id: &str) -> bool {
    (8..=64).contains(&id.len())
}

async fn timed<T>(limit: Duration, work: impl Future<Output = T>) -> Option<T> {
    tokio::time::timeout(limit, work).await.ok()
}

impl Engine {
    /// `<chat>:<id>` into the chat as WhatsApp addressed it and the message id.
    fn target(&self, id: &str) -> Option<Target> {
        let stored = self.read_state(|p| p.load(id).cloned())?;
        let (chat, waid) = crate::projection::cut_id(&stored.message.id)?;
        if waid.is_empty() {
            return None;
        }
        let raw = if stored.raw_chat.is_empty() {
            chat
        } else {
            &stored.raw_chat
        };
        let chat = valid_chat(raw)?;
        let id = waid.to_owned();
        Some(Target { stored, chat, id })
    }

    /// The JID my own messages are keyed under in a chat's addressing.
    fn own_jid(&self, client: &Client, chat: &Jid) -> Option<Jid> {
        if chat.is_lid()
            && let Some(lid) = client.lid()
        {
            return Some(lid.to_non_ad());
        }
        client.pn().map(|pn| pn.to_non_ad())
    }

    /// The key's sender: me, or the author as WhatsApp addressed them.
    fn key_sender(&self, client: &Client, stored: &Stored, chat: &Jid) -> Option<Jid> {
        if stored.message.mine {
            return self.own_jid(client, chat);
        }
        stored
            .raw_sender
            .parse()
            .ok()
            .or_else(|| stored.message.sender.parse().ok())
    }

    /// The quoted message of a send that answers one; `None` refuses the send.
    fn reply_context(
        &self,
        client: &Client,
        cmd: &Command,
        m: &mut Message,
    ) -> Option<Option<wa::ContextInfo>> {
        if cmd.reply.is_empty() {
            return Some(None);
        }
        let quoted = self.target(&cmd.reply)?;
        if quoted.stored.message.chat != cmd.chat || quoted.stored.message.deleted {
            return None;
        }
        m.reply_to = quoted.stored.message.id.clone();
        m.quote_sender = quoted.stored.message.sender.clone();
        m.quote_text = quoted.stored.message.text.clone();
        let participant = self
            .key_sender(client, &quoted.stored, &quoted.chat)
            .map(|j| j.to_string());
        let text = quoted.stored.message.text.clone();
        let group = quoted.chat.server.as_str() == "g.us";
        Some(Some(build(|info: &mut wa::ContextInfo| {
            info.stanza_id = Some(quoted.id);
            info.participant = participant;
            info.quoted_message =
                MessageField::some(build(|q: &mut wa::Message| q.conversation = Some(text)));
            if group {
                info.remote_jid = Some(quoted.chat.to_string());
            }
        })))
    }

    /// Sends and waits for the server's timestamp; `None` when the outcome is unknown.
    async fn deliver(
        &self,
        client: &Client,
        chat: &Jid,
        id: &str,
        content: wa::Message,
    ) -> Option<i64> {
        let (tx, rx) = oneshot::channel();
        self.acks.lock().expect("acks").insert(id.to_owned(), tx);
        let options = SendOptions::default().with_message_id(MessageId::new(id).ok()?);
        let sent = timed(
            Duration::from_secs(45),
            client.send(SendRequest::new(chat, content).with_options(options)),
        )
        .await;
        let result = match sent {
            Some(Ok(_)) => match timed(Duration::from_secs(10), rx).await {
                Some(Ok(Some(ts))) => Some(ts),
                Some(Ok(None)) => None,
                _ => Some(now()),
            },
            _ => None,
        };
        self.acks.lock().expect("acks").remove(id);
        result
    }

    /// Records a send before the network: reopening never replays it.
    async fn record(&self, cmd: &Command, stored: Stored) -> bool {
        let message = stored.message.clone();
        if !self.with_state(|p| p.record(stored)) {
            self.refuse(&cmd.id, "send_already_recorded");
            return false;
        }
        if self.checkpoint().await.is_err() {
            self.stop_on_storage_failure().await;
            return false;
        }
        self.emit(Frame::Message {
            message: Box::new(message),
        });
        true
    }

    async fn settle(&self, cmd: &Command, mut stored: Stored, ts: Option<i64>) {
        match ts {
            Some(ts) => {
                stored.message.status.clear();
                stored.message.ts = ts;
            }
            None => stored.message.status = "uncertain".to_owned(),
        }
        let state = stored.message.status.clone();
        let kept = self.with_state(|p| p.remember(stored));
        self.emit_stored(Some(kept));
        if self.checkpoint().await.is_err() {
            self.stop_on_storage_failure().await;
            return;
        }
        self.emit(Frame::Sent {
            id: cmd.id.clone(),
            state,
        });
    }

    pub(crate) async fn send(&self, cmd: Command) {
        let Some(client) = self.ready() else {
            self.refuse(&cmd.id, "not_connected");
            return;
        };
        let chat = valid_chat(&cmd.chat);
        let Some(chat) = chat.filter(|_| {
            !cmd.text.is_empty() && cmd.text.len() <= MAX_TEXT && valid_send_id(&cmd.id)
        }) else {
            self.refuse(&cmd.id, "invalid_send");
            return;
        };
        let raw = self.raw_chat_for(&chat);
        let mut stored = Stored {
            message: Message {
                id: format!("{}:{}", cmd.chat, cmd.id),
                chat: cmd.chat.clone(),
                name: chat.user.to_string(),
                sender: "me".to_owned(),
                text: cmd.text.clone(),
                ts: now(),
                mine: true,
                status: "sending".to_owned(),
                ..Message::default()
            },
            raw_chat: raw.to_string(),
            ..Stored::default()
        };
        let Some(quote) = self.reply_context(&client, &cmd, &mut stored.message) else {
            self.refuse(&cmd.id, "invalid_send");
            return;
        };
        let mut content = match quote {
            None => build(|m: &mut wa::Message| m.conversation = Some(cmd.text.clone())),
            Some(info) => build(|m: &mut wa::Message| {
                m.extended_text_message =
                    MessageField::some(build(|x: &mut wa::message::ExtendedTextMessage| {
                        x.text = Some(cmd.text.clone());
                        x.context_info = MessageField::some(info);
                    }))
            }),
        };
        if !self.record(&cmd, stored.clone()).await {
            return;
        }
        self.attach_preview(&client, &mut content, &mut stored)
            .await;
        let ts = self.deliver(&client, &raw, &cmd.id, content).await;
        self.settle(&cmd, stored, ts).await;
    }

    /// Adds the preview of the text's first link to my message, as WhatsApp's
    /// own apps make it: the page is fetched once from this device and its
    /// title, description and image travel inside the message.
    async fn attach_preview(
        &self,
        client: &Client,
        content: &mut wa::Message,
        stored: &mut Stored,
    ) {
        let Some(link) = first_link(&stored.message.text).map(str::to_owned) else {
            return;
        };
        let work = async {
            let page = rv_link_preview::collect(&with_scheme(&link), PREVIEW_AGENT)
                .await
                .ok()?;
            let picture = page.image.as_ref().and_then(|i| images::decode(&i.bytes));
            let small = picture
                .as_ref()
                .and_then(|p| images::scaled_jpeg(p, 160, 70))
                .map(|(j, _, _)| j);
            let large = picture
                .as_ref()
                .and_then(|p| images::scaled_jpeg(p, 720, 80));
            let uploaded = match &large {
                Some((jpeg, _, _)) => client
                    .upload(jpeg.clone(), MediaType::LinkThumbnail, UploadOptions::new())
                    .await
                    .ok(),
                None => None,
            };
            Some((page, small, large, uploaded))
        };
        let Some(Some((page, small, large, uploaded))) = timed(PREVIEW_TIME, work).await else {
            return;
        };
        let mut x = content
            .extended_text_message
            .as_option()
            .cloned()
            .unwrap_or_else(|| {
                build(|x: &mut wa::message::ExtendedTextMessage| {
                    x.text = Some(stored.message.text.clone())
                })
            });
        x.matched_text = Some(link);
        x.preview_type = Some(wa::message::extended_text_message::PreviewType::NONE);
        x.title = page.title.clone();
        x.description = page.description.clone();
        x.jpeg_thumbnail = small;
        if let (Some(up), Some((_, w, h))) = (&uploaded, &large) {
            x.thumbnail_direct_path = Some(up.direct_path.clone());
            x.thumbnail_sha256 = Some(up.file_sha256.to_vec());
            x.thumbnail_enc_sha256 = Some(up.file_enc_sha256.to_vec());
            x.media_key = Some(up.media_key.to_vec());
            x.media_key_timestamp = Some(up.media_key_timestamp);
            x.thumbnail_width = Some(*w);
            x.thumbnail_height = Some(*h);
        }
        content.conversation = None;
        content.extended_text_message = MessageField::some(x);
        crate::receive::set_link(stored, content);
        if let Some((jpeg, _, _)) = large {
            self.keep_link_image(&stored.message.id, &jpeg);
        }
    }

    /// Sends a file. The upload comes first: until the message itself is sent
    /// nobody sees anything, so a failed upload is a plain refusal. Then, like
    /// a text, the intent is recorded before the send and never replayed.
    pub(crate) async fn upload(self: Arc<Self>, cmd: Command) {
        let Some(client) = self.ready() else {
            self.refuse(&cmd.id, "not_connected");
            return;
        };
        let chat = valid_chat(&cmd.chat);
        let Some(chat) = chat.filter(|_| {
            valid_send_id(&cmd.id) && cmd.text.len() <= MAX_TEXT && !cmd.path.is_empty()
        }) else {
            self.refuse(&cmd.id, "invalid_send");
            return;
        };
        let size = tokio::fs::metadata(&cmd.path)
            .await
            .map(|m| m.len())
            .unwrap_or(0);
        let data = match (size > 0 && size <= MAX_UPLOAD).then_some(()) {
            Some(()) => tokio::fs::read(&cmd.path).await.ok(),
            None => None,
        };
        let Some(data) = data else {
            self.refuse(&cmd.id, "file_refused");
            return;
        };
        let (kind, media_type) = outgoing_kind(&cmd.mime, cmd.voice);
        let raw = self.raw_chat_for(&chat);
        let file_name = Path::new(&cmd.name)
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or_default()
            .to_owned();
        let mut stored = Stored {
            message: Message {
                id: format!("{}:{}", cmd.chat, cmd.id),
                chat: cmd.chat.clone(),
                name: chat.user.to_string(),
                sender: "me".to_owned(),
                text: cmd.text.clone(),
                ts: now(),
                mine: true,
                status: "sending".to_owned(),
                kind: kind.to_owned(),
                mime: cmd.mime.clone(),
                file_name: file_name.clone(),
                size: data.len() as i64,
                ..Message::default()
            },
            raw_chat: raw.to_string(),
            ..Stored::default()
        };
        let Some(quote) = self.reply_context(&client, &cmd, &mut stored.message) else {
            self.refuse(&cmd.id, "invalid_send");
            return;
        };
        let options = if matches!(kind, "voice" | "audio" | "video") {
            UploadOptions::new().with_streaming_sidecar(true)
        } else {
            UploadOptions::new()
        };
        let uploaded = timed(
            Duration::from_secs(180),
            client.upload(data.clone(), media_type, options),
        )
        .await;
        let Some(Ok(up)) = uploaded else {
            self.refuse(&cmd.id, "upload_failed");
            return;
        };
        let quote = quote.map(MessageField::some).unwrap_or_default();
        let m = &mut stored.message;
        let content = match kind {
            "image" => {
                let (w, h, thumb) = images::preview(&data);
                (m.width, m.height, m.thumb) = (w, h, thumb.clone());
                build(|c: &mut wa::Message| {
                    c.image_message =
                        MessageField::some(build(|x: &mut wa::message::ImageMessage| {
                            x.caption = Some(cmd.text.clone());
                            x.mimetype = Some(cmd.mime.clone());
                            x.url = Some(up.url.clone());
                            x.direct_path = Some(up.direct_path.clone());
                            x.media_key = Some(up.media_key.to_vec());
                            x.file_enc_sha256 = Some(up.file_enc_sha256.to_vec());
                            x.file_sha256 = Some(up.file_sha256.to_vec());
                            x.file_length = Some(up.file_length);
                            x.media_key_timestamp = Some(up.media_key_timestamp);
                            x.width = Some(w as u32);
                            x.height = Some(h as u32);
                            x.jpeg_thumbnail = Some(thumb);
                            x.context_info = quote;
                        }))
                })
            }
            "video" => build(|c: &mut wa::Message| {
                c.video_message = MessageField::some(build(|x: &mut wa::message::VideoMessage| {
                    x.caption = Some(cmd.text.clone());
                    x.mimetype = Some(cmd.mime.clone());
                    x.url = Some(up.url.clone());
                    x.direct_path = Some(up.direct_path.clone());
                    x.media_key = Some(up.media_key.to_vec());
                    x.file_enc_sha256 = Some(up.file_enc_sha256.to_vec());
                    x.file_sha256 = Some(up.file_sha256.to_vec());
                    x.file_length = Some(up.file_length);
                    x.media_key_timestamp = Some(up.media_key_timestamp);
                    x.streaming_sidecar = up.streaming_sidecar.clone();
                    x.context_info = quote;
                }))
            }),
            "voice" | "audio" => {
                m.seconds = ogg_seconds(&data);
                if kind == "voice" {
                    m.mime = "audio/ogg; codecs=opus".to_owned();
                }
                // A voice note carries no caption.
                m.text.clear();
                let (mime, seconds) = (m.mime.clone(), m.seconds);
                build(|c: &mut wa::Message| {
                    c.audio_message =
                        MessageField::some(build(|x: &mut wa::message::AudioMessage| {
                            x.mimetype = Some(mime);
                            x.ptt = Some(kind == "voice");
                            x.seconds = Some(seconds as u32);
                            x.url = Some(up.url.clone());
                            x.direct_path = Some(up.direct_path.clone());
                            x.media_key = Some(up.media_key.to_vec());
                            x.file_enc_sha256 = Some(up.file_enc_sha256.to_vec());
                            x.file_sha256 = Some(up.file_sha256.to_vec());
                            x.file_length = Some(up.file_length);
                            x.media_key_timestamp = Some(up.media_key_timestamp);
                            x.streaming_sidecar = up.streaming_sidecar.clone();
                            x.context_info = quote;
                        }))
                })
            }
            _ => build(|c: &mut wa::Message| {
                c.document_message =
                    MessageField::some(build(|x: &mut wa::message::DocumentMessage| {
                        x.caption = Some(cmd.text.clone());
                        x.mimetype = Some(cmd.mime.clone());
                        x.file_name = Some(file_name.clone());
                        x.title = Some(file_name.clone());
                        x.url = Some(up.url.clone());
                        x.direct_path = Some(up.direct_path.clone());
                        x.media_key = Some(up.media_key.to_vec());
                        x.file_enc_sha256 = Some(up.file_enc_sha256.to_vec());
                        x.file_sha256 = Some(up.file_sha256.to_vec());
                        x.file_length = Some(up.file_length);
                        x.media_key_timestamp = Some(up.media_key_timestamp);
                        x.context_info = quote;
                    }))
            }),
        };
        stored.media = crate::content::attachment_of(&content)
            .map(|(a, _)| a.media)
            .unwrap_or_default();
        if !self.record(&cmd, stored.clone()).await {
            return;
        }
        // My copy, where `download` finds it: the message shows at once.
        let dir = self.media_dir();
        if create_private_dir(&dir).is_ok() {
            let path = dir.join(media_file(
                &stored.message.id,
                kind,
                &stored.message.mime,
                &file_name,
            ));
            let _ = write_private(&path, &data);
        }
        let ts = self.deliver(&client, &raw, &cmd.id, content).await;
        self.settle(&cmd, stored, ts).await;
    }

    /// Reacts with an emoji, or takes my reaction back with an empty one.
    pub(crate) async fn react(&self, cmd: Command) {
        let (client, target) = match (self.ready(), self.target(&cmd.id)) {
            (Some(c), Some(t)) if !t.stored.message.deleted && cmd.text.len() <= 64 => (c, t),
            _ => return self.fail("action_failed"),
        };
        let sender = self.key_sender(&client, &target.stored, &target.chat);
        let Ok(id) = MessageId::new(&target.id) else {
            return self.fail("action_failed");
        };
        let Ok(reference) = MessageRef::new(
            &target.chat,
            id,
            sender.as_ref(),
            target.stored.message.mine,
        ) else {
            return self.fail("action_failed");
        };
        match timed(
            Duration::from_secs(30),
            client.send_reaction(&reference, &cmd.text),
        )
        .await
        {
            Some(Ok(_)) => {
                let message = target.stored.message.id;
                if let Some(kept) =
                    self.with_state(|p| p.store_reaction(&message, "me", &cmd.text, now()))
                {
                    self.emit(Frame::Reaction { reaction: kept });
                }
            }
            _ => self.fail("action_failed"),
        }
    }

    pub(crate) async fn edit(&self, cmd: Command) {
        let (client, target) = match (self.ready(), self.target(&cmd.id)) {
            (Some(c), Some(t))
                if t.stored.message.mine
                    && !t.stored.message.deleted
                    && t.stored.message.status.is_empty()
                    && !cmd.text.is_empty()
                    && cmd.text.len() <= MAX_TEXT =>
            {
                (c, t)
            }
            _ => return self.fail("action_failed"),
        };
        if now() - target.stored.message.ts > EDIT_WINDOW {
            return self.fail("edit_expired");
        }
        let Ok(id) = MessageId::new(&target.id) else {
            return self.fail("action_failed");
        };
        let Ok(reference) = MessageRef::new(&target.chat, id, None, true) else {
            return self.fail("action_failed");
        };
        let content = build(|m: &mut wa::Message| m.conversation = Some(cmd.text.clone()));
        match timed(
            Duration::from_secs(30),
            client.edit_message(EditRequest::new(reference, content)),
        )
        .await
        {
            Some(Ok(_)) => {
                let id = target.stored.message.id;
                let edited = self.with_state(|p| p.mark_edited(&id, &cmd.text, Preview::default()));
                let _ = std::fs::remove_file(self.link_image_path(&id));
                self.emit_stored(edited);
            }
            _ => self.fail("action_failed"),
        }
    }

    /// Deletes my message for everyone.
    pub(crate) async fn revoke(&self, cmd: Command) {
        let (client, target) = match (self.ready(), self.target(&cmd.id)) {
            (Some(c), Some(t))
                if t.stored.message.mine
                    && !t.stored.message.deleted
                    && t.stored.message.status.is_empty() =>
            {
                (c, t)
            }
            _ => return self.fail("action_failed"),
        };
        if now() - target.stored.message.ts > REVOKE_WINDOW {
            return self.fail("delete_expired");
        }
        let sent =
            client.revoke_message_raw(target.chat.clone(), target.id.clone(), RevokeType::Sender);
        match timed(Duration::from_secs(30), sent).await {
            Some(Ok(_)) => {
                let id = target.stored.message.id;
                let deleted = self.with_state(|p| p.mark_deleted(&id));
                self.emit_stored(deleted);
            }
            _ => self.fail("action_failed"),
        }
    }

    /// Reads a chat: the unread messages of others get a read receipt, the
    /// count drops to zero here and on my other devices.
    pub(crate) async fn read(&self, cmd: Command) {
        let Some(chat) = valid_chat(&cmd.chat) else {
            return self.fail("action_failed");
        };
        let chat_str = chat.to_string();
        let unread = self.read_state(|p| p.unread(&chat_str));
        if unread == 0 {
            return;
        }
        let frame = self.with_state(|p| p.set_unread(&chat_str, 0, true));
        self.emit(frame);
        let Some(client) = self.ready() else { return };
        let targets =
            self.read_state(|p| p.unread_messages(&chat_str, (unread as usize).min(MAX_READ_IDS)));
        let mut batches: BTreeMap<(String, String), ReadBatch> = BTreeMap::new();
        for target in targets {
            let Some((_, waid)) = crate::projection::cut_id(&target.id) else {
                continue;
            };
            let to = valid_chat(&target.raw_chat).unwrap_or_else(|| chat.clone());
            let sender = if to.server.as_str() == "g.us" {
                match target.raw_sender.parse::<Jid>() {
                    Ok(sender) => Some(sender),
                    Err(_) => continue,
                }
            } else {
                None
            };
            let key = (
                to.to_string(),
                sender.as_ref().map(|s| s.to_string()).unwrap_or_default(),
            );
            batches
                .entry(key)
                .or_insert_with(|| (to, sender, Vec::new()))
                .2
                .push(waid.to_owned());
        }
        for (to, sender, ids) in batches.into_values() {
            let ids: Vec<&str> = ids.iter().map(String::as_str).collect();
            // A failed receipt leaves the chat read here; the phone still shows it unread.
            let _ = timed(
                Duration::from_secs(30),
                client.mark_as_read(&to, sender.as_ref(), &ids),
            )
            .await;
        }
    }

    /// Online while the app is in front, like WhatsApp Web: WhatsApp then
    /// tells this device who types, and holds the phone's own notifications back.
    pub(crate) async fn presence(self: Arc<Self>, cmd: Command) {
        let Some(client) = self.ready() else { return };
        let status = if cmd.text == "available" {
            PresenceStatus::Available
        } else {
            PresenceStatus::Unavailable
        };
        let _ = timed(Duration::from_secs(15), client.presence().set(status)).await;
    }

    /// Tells a chat I am typing (`composing`) or stopped (`paused`).
    pub(crate) async fn typing(self: Arc<Self>, cmd: Command) {
        let Some(client) = self.ready() else { return };
        let Some(chat) = valid_chat(&cmd.chat) else {
            return;
        };
        let to = self.raw_chat_for(&chat);
        let chatstate = client.chatstate();
        if cmd.text == "composing" {
            let _ = timed(Duration::from_secs(15), chatstate.send_composing(&to)).await;
        } else {
            let _ = timed(Duration::from_secs(15), chatstate.send_paused(&to)).await;
        }
    }

    /// Declines a call ringing here, for all my devices.
    pub(crate) async fn reject_call(self: Arc<Self>, cmd: Command) {
        let ringing = self.calls.lock().expect("calls").remove(&cmd.id);
        let (Some(ringing), Some(client)) = (ringing, self.ready()) else {
            return;
        };
        let voip = client.voip();
        match timed(
            Duration::from_secs(15),
            voip.reject_call(&cmd.id, &ringing.from, &ringing.creator),
        )
        .await
        {
            Some(Ok(())) => {
                let from = self.canonical(&ringing.creator).await.to_string();
                let call = Call {
                    id: cmd.id,
                    from,
                    group: String::new(),
                    video: false,
                    state: "ended".to_owned(),
                };
                self.emit(Frame::Call { call });
            }
            _ => self.fail("action_failed"),
        }
    }

    /// Links with a phone number instead of a QR (a phone cannot scan its own
    /// screen): WhatsApp returns an 8-character code typed on the phone. The
    /// QR attempt must be running, which `connect` starts on an unpaired device.
    pub(crate) async fn pair_phone(self: Arc<Self>, cmd: Command) {
        let client = self
            .client()
            .filter(|c| c.pn().is_none() && c.is_socket_connected());
        let Some(client) = client else {
            return self.fail("pairing_code_failed");
        };
        let options = build(|o: &mut PairCodeOptions| {
            o.phone_number = cmd.text.clone();
            o.show_push_notification = true;
            o.platform_id = Some(wacore::companion_reg::CompanionWebClientType::Chrome);
            o.display_os = Some(display_os().to_owned());
        });
        use wacore::pair_code::PairCodeError as Code;
        match timed(Duration::from_secs(30), client.pair_with_code(options)).await {
            Some(Ok(code)) => {
                let code = if code.len() == 8 {
                    format!("{}-{}", &code[..4], &code[4..])
                } else {
                    code
                };
                self.emit(Frame::PairingCode { code });
            }
            Some(Err(PairError::PairCode(
                Code::PhoneNumberRequired
                | Code::PhoneNumberTooShort
                | Code::PhoneNumberNotInternational,
            ))) => self.fail("phone_invalid"),
            Some(Err(e)) => {
                log::info!("pair phone failed: {e}");
                self.fail("pairing_code_failed")
            }
            None => self.fail("pairing_code_failed"),
        }
    }

    /// People and groups matching the query: the contacts by name or number,
    /// the groups by subject, and a typed number WhatsApp knows.
    pub(crate) async fn search(self: Arc<Self>, cmd: Command) {
        let query = cmd.text.trim().to_lowercase();
        let mut found: Vec<Person> = Vec::new();
        let mut add = |jid: String, name: String| {
            if found.len() < MAX_FOUND && !found.iter().any(|p| p.jid == jid) {
                found.push(Person { jid, name });
            }
        };
        if let (Some(digits), Some(client)) = (phone_digits(&query), self.ready()) {
            let asked = timed(
                Duration::from_secs(15),
                client
                    .contacts()
                    .is_on_whatsapp(&[Jid::pn(digits.as_str())]),
            )
            .await;
            if let Some(Ok(answers)) = asked
                && let [answer] = answers.as_slice()
                && answer.is_registered
            {
                let jid = self.canonical(&answer.jid).await.to_string();
                let alt = self.alternate(&jid).await;
                let name = self.read_state(|p| p.name_of(&jid, alt.as_deref()));
                add(
                    jid,
                    if name.is_empty() {
                        format!("+{digits}")
                    } else {
                        name
                    },
                );
            }
        }
        if !query.is_empty() {
            let contacts: Vec<(String, crate::projection::Contact)> = self.read_state(|p| {
                p.contacts()
                    .map(|(j, c)| (j.to_owned(), c.clone()))
                    .collect()
            });
            let mut matches = Vec::new();
            for (jid, contact) in contacts {
                let Ok(parsed) = jid.parse::<Jid>() else {
                    continue;
                };
                let canonical = self.canonical(&parsed).await;
                if !canonical.is_pn() {
                    continue;
                }
                let canonical = canonical.to_string();
                let alt = self.alternate(&canonical).await;
                let name = self.read_state(|p| p.name_of(&canonical, alt.as_deref()));
                let haystack = [
                    contact.full_name.as_str(),
                    &contact.first_name,
                    &contact.push_name,
                    &contact.business_name,
                    &name,
                    canonical.split('@').next().unwrap_or_default(),
                ]
                .join(" ")
                .to_lowercase();
                if haystack.contains(&query) {
                    matches.push(Person {
                        jid: canonical,
                        name,
                    });
                }
            }
            self.read_state(|p| {
                for (jid, name) in p.group_names() {
                    if name.to_lowercase().contains(&query) {
                        matches.push(Person {
                            jid: jid.to_owned(),
                            name: name.to_owned(),
                        });
                    }
                }
            });
            matches.sort_by_key(|p| p.name.to_lowercase());
            for p in matches {
                if valid_chat(&p.jid).is_some() {
                    add(p.jid, p.name);
                }
            }
        }
        self.emit(Frame::Found {
            id: cmd.id,
            people: found,
        });
    }

    /// Fetches and decrypts a message's attachment into the account's private
    /// folder (gone with the account), and says where; an empty path is a failure.
    pub(crate) async fn download(self: Arc<Self>, cmd: Command) {
        let path = self
            .fetch(&cmd.id)
            .await
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_default();
        self.emit(Frame::File { id: cmd.id, path });
    }

    async fn fetch(&self, id: &str) -> Option<PathBuf> {
        let stored = self.read_state(|p| p.load(id).cloned())?;
        if stored.wire().link_image {
            return self.link_image(&stored).await;
        }
        let m = &stored.message;
        if m.kind.is_empty() || stored.media.is_empty() || m.size > MAX_DOWNLOAD {
            return None;
        }
        let dir = self.media_dir();
        let path = dir.join(media_file(&m.id, &m.kind, &m.mime, &m.file_name));
        if std::fs::metadata(&path).is_ok_and(|meta| meta.len() > 0) {
            return Some(path);
        }
        let client = self.ready()?;
        let wrapped = codec::message_decode(&stored.media).ok()?;
        create_private_dir(&dir).ok()?;
        let partial = path.with_extension("part");
        let file = open_private(&partial).ok()?;
        let target: &dyn Downloadable = match m.kind.as_str() {
            "image" => wrapped.image_message.as_option()?,
            "video" | "gif" => wrapped.video_message.as_option()?,
            "audio" | "voice" => wrapped.audio_message.as_option()?,
            "document" => wrapped.document_message.as_option()?,
            "sticker" => wrapped.sticker_message.as_option()?,
            _ => return None,
        };
        let fetched = timed(
            Duration::from_secs(300),
            client.download_to_writer(target, file, DownloadLimits::default()),
        )
        .await;
        let done = match fetched {
            Some(Ok(file)) => file.sync_all().is_ok() && std::fs::rename(&partial, &path).is_ok(),
            _ => false,
        };
        if !done {
            let _ = std::fs::remove_file(&partial);
            return None;
        }
        Some(path)
    }

    pub(crate) fn link_image_path(&self, id: &str) -> PathBuf {
        self.media_dir()
            .join(media_file(&format!("{id}-link"), "image", "image/jpeg", ""))
    }

    /// Writes a link preview's picture where `link_image` serves it from.
    fn keep_link_image(&self, id: &str, data: &[u8]) -> Option<PathBuf> {
        let path = self.link_image_path(id);
        create_private_dir(&self.media_dir()).ok()?;
        write_private(&path, data).ok()?;
        Some(path)
    }

    /// A link preview's picture: the large one the sender uploaded, else the
    /// small one inline in the message. The small one is not kept when the
    /// large one could not be had, so a later look tries again.
    async fn link_image(&self, stored: &Stored) -> Option<PathBuf> {
        let path = self.link_image_path(&stored.message.id);
        if std::fs::metadata(&path).is_ok_and(|m| m.len() > 0) {
            return Some(path);
        }
        if !stored.media.is_empty()
            && let Some(client) = self.ready()
            && let Some(full) = self.download_link_thumbnail(&client, &stored.media).await
        {
            return self.keep_link_image(&stored.message.id, &full);
        }
        let thumb = &stored.message.thumb;
        if thumb.is_empty() {
            return None;
        }
        if stored.media.is_empty() {
            return self.keep_link_image(&stored.message.id, thumb);
        }
        let inline = path.with_extension("inline.jpg");
        create_private_dir(&self.media_dir()).ok()?;
        write_private(&inline, thumb).ok()?;
        Some(inline)
    }

    async fn download_link_thumbnail(&self, client: &Client, media: &[u8]) -> Option<Vec<u8>> {
        let wrapped = codec::message_decode(media).ok()?;
        let x = wrapped.extended_text_message.as_option()?;
        let params = DownloadParams::encrypted(
            x.thumbnail_direct_path.clone()?,
            x.media_key.as_deref()?,
            x.thumbnail_sha256.as_deref()?,
            x.thumbnail_enc_sha256.as_deref()?,
            0,
            MediaType::LinkThumbnail,
        )
        .ok()?;
        let full = timed(
            Duration::from_secs(60),
            client.download(&params, DownloadLimits::default()),
        )
        .await?
        .ok()?;
        (!full.is_empty()).then_some(full)
    }

    pub(crate) fn is_stopped(&self) -> bool {
        self.stopped.load(Ordering::SeqCst)
    }
}

/// What the phone shows in its linked devices: WhatsApp accepts only a common
/// system here.
fn display_os() -> &'static str {
    if cfg!(target_os = "windows") {
        "Windows"
    } else if cfg!(target_os = "macos") {
        "Mac OS"
    } else {
        "Linux"
    }
}

pub(crate) fn create_private_dir(dir: &Path) -> std::io::Result<()> {
    let mut builder = std::fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    std::os::unix::fs::DirBuilderExt::mode(&mut builder, 0o700);
    builder.create(dir)
}

fn open_private(path: &Path) -> std::io::Result<std::fs::File> {
    let mut options = std::fs::OpenOptions::new();
    options.read(true).write(true).create(true).truncate(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    options.open(path)
}

pub(crate) fn write_private(path: &Path, data: &[u8]) -> std::io::Result<()> {
    use std::io::Write as _;
    let partial = path.with_extension("part");
    let result = open_private(&partial)
        .and_then(|mut f| f.write_all(data))
        .and_then(|()| std::fs::rename(&partial, path));
    if result.is_err() {
        let _ = std::fs::remove_file(&partial);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn send_ids_are_the_clients_own() {
        assert!(valid_send_id("ABCDEF01"));
        assert!(!valid_send_id("short"));
        assert!(!valid_send_id(&"x".repeat(65)));
    }
}
