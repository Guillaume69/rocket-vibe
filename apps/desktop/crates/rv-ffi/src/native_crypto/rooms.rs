use super::*;
use peers::NativePeerTrust;
use rv_core::native::crypto::enrollment::rooms;
#[derive(Clone, Copy, uniffi::Enum)]
pub enum NativeGroupPhase {
    Empty,
    NeedsAdmission,
    Acknowledged,
    Pending,
}
#[derive(Clone, Copy, uniffi::Enum)]
pub enum NativeGroupReviewKind {
    Create,
    Change,
    Admission,
    Readmission,
    Commit,
}
#[derive(Clone, uniffi::Record)]
pub struct NativeGroupTarget {
    pub user: String,
    pub device: String,
}
#[derive(Clone, uniffi::Record)]
pub struct NativeGroupDevice {
    pub id: String,
    pub user: String,
    pub name: String,
    pub device: String,
    pub incarnation: String,
    pub fingerprint: String,
    pub root_fingerprint: String,
    pub eligible: bool,
    pub own: bool,
    pub trust: NativePeerTrust,
}
#[derive(Clone, uniffi::Record)]
pub struct NativeGroupRecipient {
    pub id: String,
    pub user: String,
    pub name: String,
    pub device: String,
    pub incarnation: String,
    pub fingerprint: String,
    pub root_fingerprint: String,
}
#[derive(Clone, uniffi::Record)]
pub struct NativeGroupReview {
    pub kind: NativeGroupReviewKind,
    pub fingerprint: String,
    pub recipients: Vec<NativeGroupRecipient>,
}
#[derive(Clone, uniffi::Record)]
pub struct NativeGroupState {
    pub revision: u64,
    pub phase: NativeGroupPhase,
    pub epoch: String,
    pub fingerprint: String,
    pub pending_operation: String,
    pub devices: Vec<NativeGroupDevice>,
    pub participants: Vec<NativeGroupRecipient>,
    pub can_create: bool,
    pub has_event: bool,
    pub review: Option<NativeGroupReview>,
}
fn recipient(p: rooms::Recipient) -> NativeGroupRecipient {
    NativeGroupRecipient {
        id: format!("{}:{}:{}", p.user, p.device, p.incarnation),
        user: p.user,
        name: p.name,
        device: p.device,
        incarnation: p.incarnation,
        fingerprint: p.fingerprint,
        root_fingerprint: p.root_fingerprint,
    }
}
fn display(v: rooms::View) -> NativeGroupState {
    NativeGroupState {
        revision: v.revision,
        phase: match v.phase {
            rooms::Phase::Empty => NativeGroupPhase::Empty,
            rooms::Phase::NeedsAdmission => NativeGroupPhase::NeedsAdmission,
            rooms::Phase::Acknowledged => NativeGroupPhase::Acknowledged,
            rooms::Phase::Pending => NativeGroupPhase::Pending,
        },
        epoch: v.epoch,
        fingerprint: v.fingerprint,
        pending_operation: v.pending_operation,
        can_create: v.can_create,
        has_event: v.has_event,
        devices: v
            .devices
            .into_iter()
            .map(|d| NativeGroupDevice {
                id: format!("{}:{}", d.user, d.device),
                user: d.user,
                name: d.name,
                device: d.device,
                incarnation: d.incarnation,
                fingerprint: d.fingerprint,
                root_fingerprint: d.root_fingerprint,
                eligible: d.eligible,
                own: d.own,
                trust: match d.trust {
                    enrollment::peers::Trust::Unknown => NativePeerTrust::Unknown,
                    enrollment::peers::Trust::Unverified => NativePeerTrust::Unverified,
                    enrollment::peers::Trust::Verified => NativePeerTrust::Verified,
                    enrollment::peers::Trust::Changed => NativePeerTrust::Changed,
                },
            })
            .collect(),
        participants: v.participants.into_iter().map(recipient).collect(),
        review: v.review.map(|r| NativeGroupReview {
            kind: match r.kind {
                rooms::ReviewKind::Create => NativeGroupReviewKind::Create,
                rooms::ReviewKind::Change => NativeGroupReviewKind::Change,
                rooms::ReviewKind::Admission => NativeGroupReviewKind::Admission,
                rooms::ReviewKind::Readmission => NativeGroupReviewKind::Readmission,
                rooms::ReviewKind::Commit => NativeGroupReviewKind::Commit,
            },
            fingerprint: r.fingerprint,
            recipients: r.recipients.into_iter().map(recipient).collect(),
        }),
    }
}
fn targets(values: Vec<NativeGroupTarget>) -> Vec<rooms::Target> {
    values.into_iter().map(|t| rooms::Target { user: t.user, device: t.device }).collect()
}
#[derive(uniffi::Object)]
pub struct NativeCryptoRoom {
    access: rooms::Access,
}
impl NativeCryptoRoom {
    pub(crate) async fn open(
        session: Arc<NativeSession>,
        dirs: Arc<accounts::Dirs>,
        room: String,
    ) -> Result<Arc<Self>, Error> {
        let settings = session
            .crypto_settings(
                Guard::new(),
                dirs.data.join("native-crypto"),
                Arc::new(rv_crypto::protected::system::Keyring),
            )
            .await?;
        Ok(Arc::new(Self { access: settings.room(room).await? }))
    }
    async fn call<F, T>(&self, f: F) -> Result<NativeGroupState, RvError>
    where
        F: FnOnce(rooms::Access) -> T + Send + 'static,
        T: std::future::Future<Output = Result<rooms::View, Error>> + Send + 'static,
    {
        let access = self.access.clone();
        on_tokio(async move { f(access).await }).await.map(display).map_err(error)
    }
}
#[uniffi::export]
impl NativeCryptoRoom {
    pub fn close(&self) {
        self.access.close();
    }
    pub fn is_closed(&self) -> bool {
        self.access.check().is_err()
    }
    pub async fn refresh(&self) -> Result<NativeGroupState, RvError> {
        self.call(|a| async move { a.refresh().await }).await
    }
    pub async fn publish_packages(&self, revision: u64) -> Result<NativeGroupState, RvError> {
        self.call(move |a| async move { a.publish_packages(revision).await }).await
    }
    pub async fn preview_create(
        &self,
        revision: u64,
        devices: Vec<NativeGroupTarget>,
    ) -> Result<NativeGroupState, RvError> {
        self.call(move |a| async move { a.preview_create(revision, targets(devices)).await }).await
    }
    pub async fn preview_change(
        &self,
        revision: u64,
        removals: Vec<String>,
        devices: Vec<NativeGroupTarget>,
    ) -> Result<NativeGroupState, RvError> {
        self.call(move |a| async move { a.preview_change(revision, removals, targets(devices)).await }).await
    }
    pub async fn preview_event(&self, revision: u64) -> Result<NativeGroupState, RvError> {
        self.call(move |a| async move { a.preview_event(revision).await }).await
    }
    pub async fn confirm(&self, revision: u64, fingerprint: String) -> Result<NativeGroupState, RvError> {
        self.call(move |a| async move { a.confirm(revision, fingerprint).await }).await
    }
    pub async fn resume(&self, revision: u64) -> Result<NativeGroupState, RvError> {
        self.call(move |a| async move { a.resume(revision).await }).await
    }
    pub async fn cancel(&self, revision: u64) -> Result<NativeGroupState, RvError> {
        self.call(move |a| async move { a.cancel(revision).await }).await
    }
}
impl Drop for NativeCryptoRoom {
    fn drop(&mut self) {
        self.close();
    }
}
