//! Shared room controls for the existing GTK/SwiftUI views. Only public roster
//! observations leave Rust; previews and the registered installation stay here.
use super::peers::Trust;
use super::*;
use aws_lc_rs::rand::{SecureRandom, SystemRandom};
use rv_crypto::groups::{self, Participant};
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::{Mutex, Weak},
};

fn room_changed() -> Error {
    crate::native::Error::Protocol("crypto_room_changed").into()
}
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Phase {
    Empty,
    NeedsAdmission,
    Acknowledged,
    Pending,
}
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum ReviewKind {
    Create,
    Change,
    Admission,
    Readmission,
    Commit,
}
#[derive(Clone)]
pub struct Device {
    pub user: String,
    pub name: String,
    pub device: String,
    pub incarnation: String,
    pub fingerprint: String,
    pub root_fingerprint: String,
    pub eligible: bool,
    pub own: bool,
    pub trust: Trust,
}
#[derive(Clone)]
pub struct Recipient {
    pub user: String,
    pub name: String,
    pub device: String,
    pub incarnation: String,
    pub root_fingerprint: String,
    pub fingerprint: String,
}
#[derive(Clone)]
pub struct Review {
    pub kind: ReviewKind,
    pub fingerprint: String,
    pub recipients: Vec<Recipient>,
}
#[derive(Clone)]
pub struct View {
    pub revision: u64,
    pub phase: Phase,
    pub epoch: String,
    pub fingerprint: String,
    pub pending_operation: String,
    pub devices: Vec<Device>,
    pub participants: Vec<Recipient>,
    pub can_create: bool,
    pub has_event: bool,
    pub review: Option<Review>,
}
pub struct Target {
    pub user: String,
    pub device: String,
}
enum Preview {
    Create(super::super::GenesisPreview),
    Change(super::super::ChangePreview),
    Event(super::super::EventPreview),
}
impl Preview {
    fn public(&self) -> (ReviewKind, &groups::Preview) {
        match self {
            Self::Create(value) => (ReviewKind::Create, &value.preview),
            Self::Change(value) => (ReviewKind::Change, &value.preview),
            Self::Event(value) => (
                match value.kind {
                    super::super::EventKind::Admission => ReviewKind::Admission,
                    super::super::EventKind::Readmission => ReviewKind::Readmission,
                    super::super::EventKind::Commit => ReviewKind::Commit,
                },
                &value.preview,
            ),
        }
    }
}
struct State {
    revision: u64,
    view: Option<View>,
    preview: Option<Preview>,
    event: Option<http::GroupEvent>,
}
struct Room {
    settings: super::Access,
    crypto: super::super::Access,
    session: Weak<NativeSession>,
    id: String,
    membership: Option<String>,
    projection: u64,
    root: [u8; 32],
    serial: tokio::sync::Mutex<()>,
    state: Mutex<State>,
    closed: AtomicBool,
}
impl Drop for Room {
    fn drop(&mut self) {
        self.crypto.stop();
        self.settings.close();
    }
}
#[derive(Clone)]
pub struct Access(Arc<Room>);
impl super::Access {
    /// A room dialog attaches only an already registered installation. No
    /// identity, peer pin, key package or group is created by opening the view.
    pub async fn room(&self, id: String) -> Result<Access> {
        self.check()?;
        let session = self.0.context.session.upgrade().ok_or_else(room_changed)?;
        if !session.store.rooms().map_err(crate::native::Error::from)?.iter().any(|r| r.id == id) {
            return Err(room_changed());
        }
        let membership =
            session.store.read_state(&id).map_err(crate::native::Error::from)?.and_then(|s| s.membership_version);
        let projection = session.store.projection_token();
        let (_, root) = self.prepared().await?;
        let crypto = self.conversation().await?;
        let access = Access(Arc::new(Room {
            settings: self.clone(),
            crypto,
            session: Arc::downgrade(&session),
            id,
            membership,
            projection,
            root: root.fingerprint()?,
            serial: tokio::sync::Mutex::new(()),
            state: Mutex::new(State { revision: 0, view: None, preview: None, event: None }),
            closed: AtomicBool::new(false),
        }));
        access.check()?;
        Ok(access)
    }
}
impl Access {
    pub fn close(&self) {
        self.0.closed.store(true, Ordering::SeqCst);
        self.0.crypto.stop();
        self.0.settings.close();
        let mut state = self.0.state.lock().unwrap();
        state.view = None;
        state.preview = None;
        state.event = None;
    }
    pub fn check(&self) -> Result<()> {
        let check = || -> Result<()> {
            if self.0.closed.load(Ordering::SeqCst) {
                return Err(room_changed());
            }
            self.0.settings.check()?;
            self.0.crypto.check()?;
            let session = self.0.session.upgrade().ok_or_else(room_changed)?;
            if session.store.projection_token() != self.0.projection
                || !session.store.rooms().map_err(crate::native::Error::from)?.iter().any(|r| r.id == self.0.id)
                || session
                    .store
                    .read_state(&self.0.id)
                    .map_err(crate::native::Error::from)?
                    .and_then(|s| s.membership_version)
                    != self.0.membership
            {
                return Err(room_changed());
            }
            Ok(())
        };
        let result = check();
        if result.is_err() {
            self.close();
        }
        result
    }
    async fn current(&self) -> Result<()> {
        self.check()?;
        let (manager, root) = self.0.settings.prepared().await?;
        if manager.scope() != self.0.crypto.scope() || root.fingerprint()? != self.0.root {
            self.close();
            return Err(room_changed());
        }
        self.check()
    }
    async fn names(&self) -> Result<(BTreeMap<String, String>, bool)> {
        let session = self.0.session.upgrade().ok_or_else(room_changed)?;
        let details = session.room_details(&self.0.id).await?;
        self.check()?;
        let create = details.room.kind == rv_protocol::RoomKind::Direct
            || details.permissions.role == rv_protocol::parity::RoomRole::Owner;
        let mut names = BTreeMap::new();
        let mut after: Option<String> = None;
        let mut visited = BTreeSet::new();
        loop {
            let page = session.room_members(&self.0.id, after.as_deref(), Some(&details.revision)).await?;
            self.check()?;
            for member in page.members {
                if names.len() >= 128 || names.contains_key(&member.user.id) {
                    return Err(room_changed());
                }
                names.insert(
                    member.user.id,
                    if member.user.display_name.is_empty() { member.user.username } else { member.user.display_name },
                );
            }
            match page.next {
                None => break,
                Some(next) if visited.insert(next.clone()) => after = Some(next),
                _ => return Err(room_changed()),
            }
        }
        Ok((names, create))
    }
    fn recipients(participants: &[Participant], names: &BTreeMap<String, String>) -> Vec<Recipient> {
        participants
            .iter()
            .map(|p| Recipient {
                user: p.user.clone(),
                name: names.get(&p.user).cloned().unwrap_or_else(|| p.user.clone()),
                device: p.device.clone(),
                incarnation: hex(&p.incarnation),
                root_fingerprint: hex(&p.root),
                fingerprint: hex(&p.certificate),
            })
            .collect()
    }
    async fn observe(&self, revision: u64) -> Result<(View, Option<http::GroupEvent>)> {
        self.check()?;
        let session = self.0.session.upgrade().ok_or_else(room_changed)?;
        let roster = session.client.crypto_group_roster(&self.0.id).await.map_err(crate::native::Error::from)?;
        self.check()?;
        let account = &self.0.settings.0.account;
        if roster.scope.instance_id != account.instance
            || roster.scope.data_epoch != account.data_epoch
            || roster.room_id != self.0.id
            || roster.members.len() > 128
            || !roster.members.iter().any(|m| m.user_id == account.user)
        {
            return Err(room_changed());
        }
        let local = self.0.crypto.local_group_status(&self.0.id).await?;
        if local.accepted.is_some() && roster.group.is_none() {
            return Err(room_changed());
        }
        let (names, may_create) = self.names().await?;
        let mut users = BTreeSet::new();
        let mut devices = vec![];
        let (manager, _) = self.0.settings.prepared().await?;
        for member in &roster.members {
            if !users.insert(member.user_id.clone()) {
                return Err(room_changed());
            }
            let peer = match self.0.settings.observed_peer(manager.clone(), &member.user_id).await {
                Ok(peer) => Some(peer),
                Err(Error::Session(crate::native::Error::Protocol("crypto_peer_missing"))) => None,
                Err(error) => return Err(error),
            };
            self.check()?;
            let name = names.get(&member.user_id).cloned().unwrap_or_else(|| member.user_id.clone());
            if let Some(peer) = peer {
                for device in peer.devices {
                    if devices.len() >= 256 {
                        return Err(room_changed());
                    }
                    let own = member.user_id == account.user
                        && device.id == self.0.crypto.scope().device
                        && device.incarnation == self.0.crypto.scope().incarnation;
                    let eligible = device.approved
                        && !own
                        && !local.participants.iter().any(|p| {
                            p.user == member.user_id
                                && p.device == device.id
                                && hex(&p.incarnation) == device.incarnation
                        });
                    devices.push(Device {
                        user: member.user_id.clone(),
                        name: name.clone(),
                        device: device.id,
                        incarnation: device.incarnation,
                        fingerprint: device.fingerprint,
                        root_fingerprint: peer.fingerprint.clone(),
                        eligible,
                        own,
                        trust: peer.trust,
                    });
                }
            } else {
                devices.push(Device {
                    user: member.user_id.clone(),
                    name,
                    device: String::new(),
                    incarnation: String::new(),
                    fingerprint: String::new(),
                    root_fingerprint: String::new(),
                    eligible: false,
                    own: false,
                    trust: Trust::Unknown,
                });
            }
        }
        let event = if roster.group.is_some() && local.pending.is_none() {
            self.0.crypto.events(&self.0.id).await?.page.events.into_iter().next()
        } else {
            None
        };
        self.check()?;
        let phase = if local.pending.is_some() {
            Phase::Pending
        } else if local.accepted.is_some() {
            Phase::Acknowledged
        } else if roster.group.is_some() {
            Phase::NeedsAdmission
        } else {
            Phase::Empty
        };
        Ok((
            View {
                revision,
                phase,
                epoch: local.accepted.as_ref().map(|r| r.epoch.to_string()).unwrap_or_default(),
                fingerprint: local.accepted.as_ref().map(|r| hex(&r.fingerprint)).unwrap_or_default(),
                pending_operation: local.pending.map(|p| p.operation).unwrap_or_default(),
                participants: Self::recipients(&local.participants, &names),
                devices,
                can_create: may_create && roster.group.is_none(),
                has_event: event.is_some(),
                review: None,
            },
            event,
        ))
    }
    pub async fn refresh(&self) -> Result<View> {
        self.act(Action::Refresh).await
    }
    pub async fn publish_packages(&self, revision: u64) -> Result<View> {
        self.act(Action::Packages(revision)).await
    }
    pub async fn preview_create(&self, revision: u64, targets: Vec<Target>) -> Result<View> {
        self.act(Action::Create(revision, targets)).await
    }
    pub async fn preview_change(&self, revision: u64, removals: Vec<String>, targets: Vec<Target>) -> Result<View> {
        self.act(Action::Change(revision, removals, targets)).await
    }
    pub async fn preview_event(&self, revision: u64) -> Result<View> {
        self.act(Action::Event(revision)).await
    }
    pub async fn confirm(&self, revision: u64, fingerprint: String) -> Result<View> {
        self.act(Action::Confirm(revision, fingerprint)).await
    }
    pub async fn resume(&self, revision: u64) -> Result<View> {
        self.act(Action::Resume(revision)).await
    }
    pub async fn cancel(&self, revision: u64) -> Result<View> {
        self.act(Action::Cancel(revision)).await
    }
    fn targets(view: &View, targets: Vec<Target>) -> Result<Vec<super::super::Target>> {
        let mut seen = BTreeSet::new();
        targets
            .into_iter()
            .map(|t| {
                if !seen.insert((t.user.clone(), t.device.clone()))
                    || !view.devices.iter().any(|d| d.user == t.user && d.device == t.device && d.eligible)
                {
                    return Err(room_changed());
                }
                Ok(super::super::Target { user: t.user, device: t.device })
            })
            .collect()
    }
    async fn act(&self, action: Action) -> Result<View> {
        let _serial = self.0.serial.lock().await;
        self.check()?;
        let (revision, previous, preview, event) = {
            let mut state = self.0.state.lock().unwrap();
            if action.revision().is_some_and(|r| r != state.revision) {
                return Err(room_changed());
            }
            state.revision += 1;
            (state.revision, state.view.take(), state.preview.take(), state.event.take())
        };
        self.current().await?;
        let crypto = &self.0.crypto;
        let id = &self.0.id;
        let prepared = match action {
            Action::Refresh => None,
            Action::Packages(_) => {
                crypto.publish_packages(self.0.settings.device_revision().await?, 8).await?;
                None
            }
            Action::Create(_, targets) => {
                let previous = previous.as_ref().ok_or_else(room_changed)?;
                if !previous.can_create || previous.phase != Phase::Empty {
                    return Err(room_changed());
                }
                let targets = Self::targets(previous, targets)?;
                let mut incarnation = [0; 16];
                SystemRandom::new().fill(&mut incarnation).map_err(|_| room_changed())?;
                Some(Preview::Create(
                    crypto.preview_genesis(id, incarnation, crate::native::room_operation_id(), targets).await?,
                ))
            }
            Action::Change(_, removals, targets) => {
                let previous = previous.as_ref().ok_or_else(room_changed)?;
                if previous.phase != Phase::Acknowledged || removals.len() > 256 {
                    return Err(room_changed());
                }
                let mut seen = BTreeSet::new();
                if removals
                    .iter()
                    .any(|device| !seen.insert(device) || !previous.participants.iter().any(|p| &p.device == device))
                {
                    return Err(room_changed());
                }
                let targets = Self::targets(previous, targets)?;
                Some(Preview::Change(
                    crypto.preview_change(id, crate::native::room_operation_id(), removals, targets).await?,
                ))
            }
            Action::Event(_) => Some(Preview::Event(crypto.preview_event(event.ok_or_else(room_changed)?).await?)),
            Action::Confirm(_, confirmed) => {
                let preview = preview.ok_or_else(room_changed)?;
                let fingerprint = peers::fingerprint(&confirmed)?;
                if fingerprint != preview.public().1.fingerprint {
                    return Err(room_changed());
                }
                match preview {
                    Preview::Create(value) => {
                        crypto.prepare_genesis(value, fingerprint).await?;
                    }
                    Preview::Change(value) => {
                        crypto.prepare_change(value, fingerprint).await?;
                    }
                    Preview::Event(value) => {
                        crypto.accept_event(value, fingerprint).await?;
                    }
                }
                None
            }
            Action::Resume(_) => {
                if previous.as_ref().is_none_or(|v| v.pending_operation.is_empty()) {
                    return Err(room_changed());
                }
                crypto.resume_group(id).await?;
                None
            }
            Action::Cancel(_) => {
                let operation = previous
                    .as_ref()
                    .map(|v| v.pending_operation.as_str())
                    .filter(|s| !s.is_empty())
                    .ok_or_else(room_changed)?;
                crypto.cancel_group(id, operation).await?;
                None
            }
        };
        self.check()?;
        let (mut view, next) = self.observe(revision).await?;
        if let Some(preview) = &prepared {
            let names = view.devices.iter().map(|d| (d.user.clone(), d.name.clone())).collect();
            let (kind, value) = preview.public();
            view.review = Some(Review {
                kind,
                fingerprint: hex(&value.fingerprint),
                recipients: Self::recipients(&value.recipients, &names),
            });
        }
        self.check()?;
        {
            let mut state = self.0.state.lock().unwrap();
            if self.0.closed.load(Ordering::SeqCst) {
                return Err(room_changed());
            }
            state.view = Some(view.clone());
            state.preview = prepared;
            state.event = next;
        }
        self.check()?;
        Ok(view)
    }
}
enum Action {
    Refresh,
    Packages(u64),
    Create(u64, Vec<Target>),
    Change(u64, Vec<String>, Vec<Target>),
    Event(u64),
    Confirm(u64, String),
    Resume(u64),
    Cancel(u64),
}
impl Action {
    fn revision(&self) -> Option<u64> {
        match self {
            Self::Refresh => None,
            Self::Packages(r)
            | Self::Create(r, ..)
            | Self::Change(r, ..)
            | Self::Event(r)
            | Self::Confirm(r, ..)
            | Self::Resume(r)
            | Self::Cancel(r) => Some(*r),
        }
    }
}
