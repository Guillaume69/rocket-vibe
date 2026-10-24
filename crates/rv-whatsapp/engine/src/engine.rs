//! One linked device: its sealed state, its client and the frames it sends.
//! Never log QR payloads, keys or message bodies.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::Duration;

use serde::Deserialize;
use tokio::sync::{Notify, mpsc, oneshot, watch};
use wacore::store::InMemoryBackend;
use wacore::store::in_memory::InMemorySnapshot;
use whatsapp_rust::bot::{Bot, BotHandle};
use whatsapp_rust::client::Client;
use whatsapp_rust::types::events::{Event, EventHandler};
use whatsapp_rust::{Jid, PresencePolicy};

use crate::content::valid_chat;
use crate::projection::{MAX_CACHED, Projection};
use crate::vault::{Vault, VaultError};
use crate::wire::{Command, Frame};

/// Receives each frame the engine emits, as one JSON object, one at a time.
pub trait Sink: Send + Sync + 'static {
    fn frame(&self, frame: String);
}

#[derive(Debug, thiserror::Error)]
pub enum OpenError {
    #[error("the state is held by another engine")]
    Busy,
    #[error("the state could not be opened")]
    Storage(#[source] VaultError),
    #[error("the engine could not start")]
    Runtime(#[source] std::io::Error),
}

const STATE_VERSION: u32 = 1;

#[derive(Deserialize)]
struct Saved {
    version: u32,
    backend: InMemorySnapshot,
    projection: Projection,
}

/// A call ringing here: how WhatsApp addressed it, to decline it.
pub(crate) struct Ringing {
    pub from: Jid,
    pub creator: Jid,
}

pub(crate) struct Engine {
    sink: Arc<dyn Sink>,
    output: Mutex<()>,
    pub(crate) vault: Vault,
    backend: Arc<InMemoryBackend>,
    state: Mutex<Projection>,
    state_dirty: AtomicBool,
    sealed_projection: Mutex<Vec<u8>>,
    client: RwLock<Option<Arc<Client>>>,
    bot: tokio::sync::Mutex<Option<BotHandle>>,
    pub(crate) stopped: AtomicBool,
    pub(crate) names_dirty: AtomicBool,
    pub(crate) avatar_kick: Notify,
    cancelled: watch::Sender<bool>,
    outgoing: mpsc::Sender<Command>,
    events: mpsc::UnboundedSender<Arc<Event>>,
    pub(crate) calls: Mutex<HashMap<String, Ringing>>,
    pub(crate) acks: Arc<Mutex<HashMap<String, oneshot::Sender<Option<i64>>>>>,
}

/// The device's frames and commands, from the transport's side.
pub struct Device {
    live: Option<(Arc<Engine>, tokio::runtime::Runtime)>,
}

impl Device {
    /// Loads the sealed state at `path` under its lock, with its 32-byte key;
    /// `connect` then reaches WhatsApp. A state held by another engine is refused.
    pub fn open(path: &Path, key: &[u8], sink: Arc<dyn Sink>) -> Result<Self, OpenError> {
        let (vault, plain) = match Vault::open(path, key) {
            Err(VaultError::PreviousEngine) => {
                // The Go helper's database: this engine cannot read it, the device links again.
                std::fs::remove_file(path).map_err(|e| OpenError::Storage(e.into()))?;
                Vault::open(path, key)
            }
            other => other,
        }
        .map_err(|e| match e {
            VaultError::Busy => OpenError::Busy,
            e => OpenError::Storage(e),
        })?;
        let saved = match plain {
            Some(plain) => {
                let saved: Saved = serde_json::from_slice(&plain)
                    .map_err(|_| OpenError::Storage(VaultError::Unreadable))?;
                if saved.version != STATE_VERSION {
                    return Err(OpenError::Storage(VaultError::Unreadable));
                }
                Some(saved)
            }
            None => None,
        };
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(4)
            .thread_name("rv-whatsapp")
            .enable_all()
            .build()
            .map_err(OpenError::Runtime)?;
        let (backend, mut projection) = match saved {
            Some(saved) => (InMemoryBackend::restore(saved.backend), saved.projection),
            None => (InMemoryBackend::new(), Projection::default()),
        };
        // A crash while sending is an uncertain outcome, never an automatic retry.
        projection.interrupt_sends();
        projection.prune(MAX_CACHED);
        let (outgoing, outgoing_rx) = mpsc::channel(256);
        let (events, events_rx) = mpsc::unbounded_channel();
        let engine = Arc::new(Engine {
            sink,
            output: Mutex::new(()),
            vault,
            backend: Arc::new(backend),
            state: Mutex::new(projection),
            state_dirty: AtomicBool::new(true),
            sealed_projection: Mutex::new(Vec::new()),
            client: RwLock::new(None),
            bot: tokio::sync::Mutex::new(None),
            stopped: AtomicBool::new(false),
            names_dirty: AtomicBool::new(false),
            avatar_kick: Notify::new(),
            cancelled: watch::channel(false).0,
            outgoing,
            events,
            calls: Mutex::new(HashMap::new()),
            acks: Arc::new(Mutex::new(HashMap::new())),
        });
        let opened = Arc::clone(&engine);
        runtime.block_on(async move { opened.start(outgoing_rx, events_rx).await });
        Ok(Self {
            live: Some((engine, runtime)),
        })
    }

    /// Reaches WhatsApp: the account's frames when linked, a QR otherwise.
    pub fn connect(&self) {
        if let Some((engine, runtime)) = &self.live {
            let engine = Arc::clone(engine);
            runtime.spawn(async move { engine.connect().await });
        }
    }

    /// Runs one command line; false once the engine ended (a stop, a logout),
    /// after which only `close` is left.
    pub fn handle(&self, line: &str) -> bool {
        let Some((engine, runtime)) = &self.live else {
            return false;
        };
        let Ok(cmd) = serde_json::from_str::<Command>(line) else {
            engine.fail("invalid_command");
            return true;
        };
        let engine = Arc::clone(engine);
        runtime.block_on(async move { engine.handle(cmd).await })
    }

    /// Ends the engine's work without waiting, safe from inside a `Sink`.
    pub fn cancel(&self) {
        if let Some((engine, _)) = &self.live {
            engine.cancelled.send_replace(true);
        }
    }

    /// Checkpoints the state and releases it and its lock; idempotent.
    pub fn close(&mut self) {
        let Some((engine, runtime)) = self.live.take() else {
            return;
        };
        let closing = Arc::clone(&engine);
        runtime.block_on(async move {
            closing.cancelled.send_replace(true);
            closing.disconnect().await;
            if !closing.stopped.load(Ordering::SeqCst) {
                let _ = closing.checkpoint().await;
            }
        });
        // The tasks go with the runtime, and the last of the engine with them: its lock too.
        runtime.shutdown_timeout(Duration::from_secs(5));
        drop(engine);
    }
}

impl Drop for Device {
    fn drop(&mut self) {
        self.close();
    }
}

/// Every client event, queued without blocking the client and handled in order.
struct Queue {
    events: mpsc::UnboundedSender<Arc<Event>>,
    acks: Arc<Mutex<HashMap<String, oneshot::Sender<Option<i64>>>>>,
}

impl EventHandler for Queue {
    fn handle_event(&self, event: Arc<Event>) {
        // A send waits for its server timestamp: settled here, never behind a long history.
        if let Event::ServerAck(ack) = &*event
            && ack.class.as_deref() == Some("message")
        {
            if let Some(waiter) = self.acks.lock().expect("acks").remove(&ack.id) {
                let ts = if ack.error.is_some() {
                    None
                } else {
                    ack.timestamp.map(|t| t.timestamp_millis())
                };
                let _ = waiter.send(ts);
            }
            return;
        }
        let _ = self.events.send(event);
    }
}

pub(crate) fn now() -> i64 {
    wacore::time::now_millis()
}

impl Engine {
    pub(crate) fn emit(&self, frame: Frame) {
        let Ok(json) = serde_json::to_string(&frame) else {
            return;
        };
        let _guard = self.output.lock().expect("output");
        self.sink.frame(json);
    }

    pub(crate) fn fail(&self, code: &str) {
        log::info!("error {code}");
        self.emit(Frame::error(code));
    }

    /// A send that never reached the network: the client keeps its draft.
    pub(crate) fn refuse(&self, id: &str, code: &str) {
        self.emit(Frame::refusal(id, code));
    }

    pub(crate) fn with_state<T>(&self, change: impl FnOnce(&mut Projection) -> T) -> T {
        let mut state = self.state.lock().expect("state");
        self.state_dirty.store(true, Ordering::SeqCst);
        change(&mut state)
    }

    pub(crate) fn read_state<T>(&self, read: impl FnOnce(&Projection) -> T) -> T {
        read(&self.state.lock().expect("state"))
    }

    pub(crate) fn client(&self) -> Option<Arc<Client>> {
        self.client.read().expect("client").clone()
    }

    pub(crate) fn is_cancelled(&self) -> bool {
        *self.cancelled.borrow()
    }

    pub(crate) async fn cancelled(&self) {
        let mut rx = self.cancelled.subscribe();
        let _ = rx.wait_for(|c| *c).await;
    }

    /// The client, when linked and online: what every action needs.
    pub(crate) fn ready(&self) -> Option<Arc<Client>> {
        if self.stopped.load(Ordering::SeqCst) || self.is_cancelled() {
            return None;
        }
        self.client()
            .filter(|c| c.is_logged_in() && c.is_socket_connected())
    }

    async fn start(
        self: &Arc<Self>,
        outgoing: mpsc::Receiver<Command>,
        events: mpsc::UnboundedReceiver<Arc<Event>>,
    ) {
        let replayed = self.replay_frames().await;
        for frame in replayed {
            self.emit(frame);
        }
        self.emit_account().await;
        self.emit(Frame::status("loaded"));
        tokio::spawn(Arc::clone(self).run_events(events));
        tokio::spawn(Arc::clone(self).run_sender(outgoing));
        tokio::spawn(Arc::clone(self).run_avatars());
        tokio::spawn(Arc::clone(self).run_ticker());
    }

    async fn run_events(self: Arc<Self>, mut events: mpsc::UnboundedReceiver<Arc<Event>>) {
        loop {
            tokio::select! {
                _ = self.cancelled() => return,
                event = events.recv() => match event {
                    Some(event) => self.event(event).await,
                    None => return,
                },
            }
        }
    }

    /// My texts, sent in the order they were asked for, off the command loop:
    /// a link's preview takes seconds.
    async fn run_sender(self: Arc<Self>, mut outgoing: mpsc::Receiver<Command>) {
        loop {
            tokio::select! {
                _ = self.cancelled() => return,
                cmd = outgoing.recv() => match cmd {
                    Some(cmd) => self.send(cmd).await,
                    None => return,
                },
            }
        }
    }

    async fn run_ticker(self: Arc<Self>) {
        let mut tick = tokio::time::interval(Duration::from_secs(1));
        for n in 1u64.. {
            tokio::select! {
                _ = self.cancelled() => return,
                _ = tick.tick() => {}
            }
            if self.stopped.load(Ordering::SeqCst) {
                continue;
            }
            if n % 30 == 0 && self.normalize().await {
                self.reload().await;
            }
            if self.names_dirty.swap(false, Ordering::SeqCst) {
                self.emit_names().await;
            }
            if let Err(e) = self.checkpoint().await {
                log::info!("checkpoint failed: {e}");
                self.stop_on_storage_failure().await;
            }
        }
    }

    /// Seals the protocol state and the projection, when either changed.
    pub(crate) async fn checkpoint(&self) -> Result<(), VaultError> {
        if let Some(client) = self.client() {
            let _ = client.flush_pending_signal_state().await;
            let _ = client.persistence_manager().flush().await;
        }
        let backend = serde_json::to_string(&self.backend.snapshot().await)
            .map_err(|_| VaultError::Unreadable)?;
        let mut sealed = self.sealed_projection.lock().expect("sealed");
        if self.state_dirty.swap(false, Ordering::SeqCst) {
            *sealed = self
                .read_state(serde_json::to_vec)
                .map_err(|_| VaultError::Unreadable)?;
        }
        let mut plain = Vec::with_capacity(backend.len() + sealed.len() + 64);
        plain.extend_from_slice(format!("{{\"version\":{STATE_VERSION},\"backend\":").as_bytes());
        plain.extend_from_slice(backend.as_bytes());
        plain.extend_from_slice(b",\"projection\":");
        plain.extend_from_slice(&sealed);
        plain.push(b'}');
        drop(sealed);
        self.vault.seal(&plain)
    }

    pub(crate) async fn stop_on_storage_failure(&self) {
        if self.stopped.swap(true, Ordering::SeqCst) {
            return;
        }
        self.disconnect().await;
        self.fail("secure_storage_failed");
    }

    /// Shuts the client down; a later `connect` builds a new one on the same state.
    pub(crate) async fn disconnect(&self) {
        let handle = self.bot.lock().await.take();
        self.client.write().expect("client").take();
        if let Some(handle) = handle {
            let _ = tokio::time::timeout(Duration::from_secs(10), handle.shutdown()).await;
        }
    }

    pub(crate) async fn connect(self: &Arc<Self>) {
        let mut bot = self.bot.lock().await;
        if self.stopped.load(Ordering::SeqCst) {
            self.fail("session_ended");
            return;
        }
        if let Some(handle) = bot.take() {
            self.client.write().expect("client").take();
            let _ = tokio::time::timeout(Duration::from_secs(10), handle.shutdown()).await;
        }
        self.emit(Frame::status("connecting"));
        let queue = Queue {
            events: self.events.clone(),
            acks: Arc::clone(&self.acks),
        };
        let built = Bot::builder()
            .with_backend_arc(Arc::clone(&self.backend) as Arc<dyn wacore::store::traits::Backend>)
            .with_device_props(
                wacore::store::device::DevicePropsOverride::new().with_os("Rocket Vibe"),
            )
            .with_presence_policy(PresencePolicy::Manual)
            .with_event_handler(queue)
            .build()
            .await;
        let built = match built {
            Ok(built) => built,
            Err(e) => {
                log::info!("connect failed: {e}");
                self.fail("connection_failed");
                return;
            }
        };
        *self.client.write().expect("client") = Some(built.client());
        *bot = Some(built.spawn());
    }

    /// Which WhatsApp account this device is linked to, once it is.
    pub(crate) async fn emit_account(&self) {
        let account = match self.client() {
            Some(client) => client.pn().map(|pn| (pn, client.push_name())),
            None => {
                use wacore::store::traits::DeviceStore as _;
                self.backend
                    .load()
                    .await
                    .ok()
                    .flatten()
                    .and_then(|d| d.pn.map(|pn| (pn, d.push_name)))
            }
        };
        if let Some((pn, name)) = account {
            self.emit(Frame::Account {
                jid: pn.to_non_ad().to_string(),
                name,
            });
        }
    }

    pub(crate) async fn handle(self: &Arc<Self>, cmd: Command) -> bool {
        match cmd.kind.as_str() {
            "connect" => {
                let engine = Arc::clone(self);
                tokio::spawn(async move { engine.connect().await });
            }
            "send" => {
                if let Err(refused) = self.outgoing.try_send(cmd) {
                    let (mpsc::error::TrySendError::Full(cmd)
                    | mpsc::error::TrySendError::Closed(cmd)) = refused;
                    self.refuse(&cmd.id, "not_connected");
                }
            }
            "upload" => self.detach(cmd, |e, c| async move { e.upload(c).await }),
            "react" => self.react(cmd).await,
            "edit" => self.edit(cmd).await,
            "delete" => self.revoke(cmd).await,
            "read" => self.read(cmd).await,
            "search" => self.detach(cmd, |e, c| async move { e.search(c).await }),
            "download" => self.detach(cmd, |e, c| async move { e.download(c).await }),
            "presence" => self.detach(cmd, |e, c| async move { e.presence(c).await }),
            "reject_call" => self.detach(cmd, |e, c| async move { e.reject_call(c).await }),
            "pair_phone" => self.detach(cmd, |e, c| async move { e.pair_phone(c).await }),
            "typing" => self.detach(cmd, |e, c| async move { e.typing(c).await }),
            "replay" => {
                // A client attaching to an engine already running: everything again.
                self.reload().await;
                self.emit_account().await;
            }
            "logout" => return self.logout().await,
            "stop" => return false,
            _ => self.fail("invalid_command"),
        }
        true
    }

    fn detach<F, Fut>(self: &Arc<Self>, cmd: Command, run: F)
    where
        F: FnOnce(Arc<Self>, Command) -> Fut,
        Fut: Future<Output = ()> + Send + 'static,
    {
        tokio::spawn(run(Arc::clone(self), cmd));
    }

    async fn logout(&self) -> bool {
        let Some(client) = self.client() else {
            self.fail("logout_failed");
            return true;
        };
        self.stopped.store(true, Ordering::SeqCst);
        let report = client.logout().await;
        log::info!("logout: {:?}", report.deregistration);
        self.disconnect().await;
        if self.vault.revoke().is_err() {
            self.fail("state_removal_failed");
        }
        self.emit(Frame::status("logged_out"));
        false
    }

    /// The client drops its projection and takes the whole cache again.
    pub(crate) async fn reload(&self) {
        self.emit(Frame::Reload);
        for frame in self.replay_frames().await {
            self.emit(frame);
        }
    }

    /// The whole cache, the names and the end of the replay.
    async fn replay_frames(&self) -> Vec<Frame> {
        let mut frames = self.read_state(Projection::replay);
        frames.push(self.names().await);
        frames.push(Frame::Replayed);
        frames
    }

    /// One person is one JID: the phone number when WhatsApp mapped the LID to it.
    pub(crate) async fn canonical(&self, jid: &Jid) -> Jid {
        let jid = jid.to_non_ad();
        if jid.is_lid()
            && let Some(client) = self.client()
            && let Ok(Some(entry)) = client.get_lid_pn_entry(&jid).await
        {
            return Jid::pn(&*entry.phone_number);
        }
        jid
    }

    /// The other address of a person: the LID of a number, the number of a LID.
    pub(crate) async fn alternate(&self, jid: &str) -> Option<String> {
        let parsed: Jid = jid.parse().ok()?;
        if !parsed.is_lid() && !parsed.is_pn() {
            return None;
        }
        let entry = self.client()?.get_lid_pn_entry(&parsed).await.ok()??;
        Some(
            if parsed.is_lid() {
                Jid::pn(&*entry.phone_number)
            } else {
                Jid::lid(&*entry.lid)
            }
            .to_string(),
        )
    }

    /// "me" for my own messages and reactions, else the canonical sender.
    pub(crate) async fn sender_key(&self, from_me: bool, sender: &Jid) -> String {
        if from_me {
            "me".to_owned()
        } else {
            self.canonical(sender).await.to_string()
        }
    }

    /// Moves what is kept under a LID to its number; true when anything moved.
    pub(crate) async fn normalize(&self) -> bool {
        if self.stopped.load(Ordering::SeqCst) || self.client().is_none() {
            return false;
        }
        let mut mapped = HashMap::new();
        for lid in self.read_state(Projection::lids) {
            if let Some(pn) = self.alternate(&lid).await {
                mapped.insert(lid, pn);
            }
        }
        !mapped.is_empty() && self.with_state(|p| p.normalize(|lid| mapped.get(lid).cloned()))
    }

    /// The names of every chat and sender the cache holds, as one table.
    async fn names(&self) -> Frame {
        let mut names = std::collections::BTreeMap::new();
        for jid in self.read_state(Projection::named) {
            let alt = self.alternate(&jid).await;
            let name = self.read_state(|p| p.name_of(&jid, alt.as_deref()));
            if !name.is_empty() {
                names.insert(jid, name);
            }
        }
        Frame::Names { names }
    }

    pub(crate) async fn emit_names(&self) {
        if !self.stopped.load(Ordering::SeqCst) {
            let names = self.names().await;
            self.emit(names);
        }
    }

    pub(crate) fn emit_stored(&self, message: Option<crate::wire::Message>) {
        if let Some(message) = message {
            self.emit(Frame::Message {
                message: Box::new(message),
            });
        }
    }

    pub(crate) fn media_dir(&self) -> PathBuf {
        self.vault
            .path()
            .parent()
            .unwrap_or_else(|| Path::new("."))
            .join("media")
    }

    /// The latest addressing WhatsApp used for a chat, to send in the same form.
    pub(crate) fn raw_chat_for(&self, chat: &Jid) -> Jid {
        let chat_str = chat.to_string();
        self.read_state(|p| p.raw_chat_for(&chat_str).and_then(valid_chat))
            .unwrap_or_else(|| chat.clone())
    }

    async fn event(self: &Arc<Self>, event: Arc<Event>) {
        if log::log_enabled!(log::Level::Debug) {
            log::debug!("event {}", event_kind(&event));
        }
        match &*event {
            Event::Connected(_) => {
                self.emit(Frame::status("connected"));
                self.names_dirty.store(true, Ordering::SeqCst);
                let engine = Arc::clone(self);
                tokio::spawn(async move { engine.refresh_groups().await });
                self.avatar_kick.notify_one();
            }
            Event::Disconnected(_) => self.emit(Frame::status("offline")),
            Event::PairingQrCode(qr) => self.emit(Frame::Qr {
                code: qr.code.clone(),
                expires_ms: qr.timeout.as_millis() as i64,
            }),
            Event::PairingQrCodesExhausted(_) => self.emit(Frame::status("qr_expired")),
            Event::ClientOutdated(_) => self.fail("client_outdated"),
            Event::PairError(_) => self.fail("pairing_failed"),
            Event::PairSuccess(_) => {
                if self.checkpoint().await.is_err() {
                    self.stop_on_storage_failure().await;
                    return;
                }
                self.emit(Frame::status("paired"));
                self.emit_account().await;
            }
            Event::SelfPushNameUpdated(_) => self.emit_account().await,
            Event::LoggedOut(_) => {
                if self.stopped.swap(true, Ordering::SeqCst) {
                    return;
                }
                if self.vault.revoke().is_err() {
                    self.fail("state_removal_failed");
                }
                self.emit(Frame::status("logged_out"));
            }
            Event::StreamReplaced(_) => self.emit(Frame::status("replaced")),
            Event::Messages(batch) => {
                for inbound in batch.iter() {
                    let chat = self.canonical(&inbound.info.source.chat).await.to_string();
                    if self
                        .receive(
                            inbound.message.as_ref(),
                            &inbound.info,
                            inbound.ephemeral_expiration,
                            "",
                        )
                        .await
                    {
                        let frame = self.with_state(|p| p.set_unread(&chat, 1, false));
                        self.emit(frame);
                    }
                }
            }
            Event::Receipt(receipt) => self.receipt(receipt).await,
            Event::ChatPresence(update) => self.chat_presence(update).await,
            Event::IncomingCall(call) => self.call_event(call).await,
            Event::MarkChatAsReadUpdate(update) => {
                let chat = self.canonical(&update.jid).await.to_string();
                let read = update.action.read.unwrap_or(false);
                if let Some(frame) = self.with_state(|p| p.marked_read(&chat, read)) {
                    self.emit(frame);
                }
            }
            Event::HistorySync(_) => self.history(Arc::clone(&event)).await,
            Event::ContactUpdate(update) => {
                let jid = self.canonical(&update.jid).await.to_string();
                let full = update.action.full_name.clone().unwrap_or_default();
                let first = update.action.first_name.clone().unwrap_or_default();
                if self.with_state(|p| {
                    p.update_contact(&jid, |c| {
                        c.full_name = full;
                        c.first_name = first;
                    })
                }) {
                    self.names_dirty.store(true, Ordering::SeqCst);
                }
            }
            Event::BusinessStatusUpdate(update) => {
                if let Some(name) = update.verified_name.clone() {
                    let jid = self.canonical(&update.jid).await.to_string();
                    if self.with_state(|p| p.update_contact(&jid, |c| c.business_name = name)) {
                        self.names_dirty.store(true, Ordering::SeqCst);
                    }
                }
            }
            Event::GroupUpdate(update) => self.group_update(update).await,
            Event::PictureUpdate(update) => {
                let jid = self.canonical(&update.jid).await.to_string();
                self.with_state(|p| p.invalidate_avatar(&jid));
                self.avatar_kick.notify_one();
            }
            _ => {}
        }
    }
}

/// An event's kind, for the diagnostic log: never its content.
fn event_kind(event: &Event) -> String {
    let debug = format!("{event:?}");
    debug
        .split(['(', ' ', '{'])
        .next()
        .unwrap_or_default()
        .to_owned()
}
