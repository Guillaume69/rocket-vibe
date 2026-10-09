//! Native HTTP transport, ready to be integrated into the desktop provider.
//! No GTK, SQLite, account keychain, or Rocket.Chat dependencies.

/// Construct a streamed upload without coupling providers to our HTTP version.
pub use reqwest::Body as UploadBody;
use reqwest::Method;
use rv_protocol::{
    ApiError, CreateRoom, DirectMessage, Discovery, Login, Message, MessagePage, Room, SendMessage,
    Session, Snapshot, SnapshotPage, SocketTicket, SyncBatch, User,
};
use serde::{Serialize, de::DeserializeOwned};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use url::Url;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("invalid server URL")]
    InvalidUrl,
    #[error("unsupported RocketVibe protocol")]
    UnsupportedProtocol,
    #[error("invalid or oversized native snapshot")]
    InvalidSnapshot,
    #[error("invalid or oversized native crypto response")]
    InvalidCrypto,
    #[error("invalid or oversized native avatar")]
    InvalidAvatar,
    #[error("invalid native emoji catalogue or image")]
    InvalidEmoji,
    #[error("invalid native link preview image")]
    InvalidPreview,
    #[error("session missing")]
    SessionMissing,
    #[error("server refused request ({status}): {code}")]
    Server {
        status: u16,
        code: String,
        request_id: Option<String>,
        retry_after: Option<u64>,
    },
    #[error(transparent)]
    Transport(#[from] reqwest::Error),
}

#[derive(Clone)]
pub struct NativeClient {
    base: String,
    http: reqwest::Client,
    token: Arc<Mutex<Option<String>>>,
    cooldowns: Arc<Mutex<HashMap<&'static str, Cooldown>>>,
    snapshot_paging: Arc<Mutex<Option<bool>>>,
}

struct Cooldown {
    until: Instant,
    code: String,
    request_id: String,
}

fn retry_after(response: &reqwest::Response) -> Option<u64> {
    response
        .headers()
        .get(reqwest::header::RETRY_AFTER)
        .and_then(|h| h.to_str().ok())
        .and_then(|v| v.parse::<u64>().ok())
        .map(|n| n.clamp(1, 300))
        .or_else(|| (response.status().as_u16() == 429).then_some(1))
}

impl NativeClient {
    pub async fn crypto_group_roster(
        &self,
        room: &str,
    ) -> Result<rv_protocol::e2ee::GroupRoster, Error> {
        if !path_segment(room) {
            return Err(Error::InvalidUrl);
        }
        self.get(&format!("/api/v1/e2ee/rooms/{room}/roster")).await
    }
    pub async fn submit_crypto_group(
        &self,
        room: &str,
        input: &rv_protocol::e2ee::GroupSubmission,
    ) -> Result<rv_protocol::e2ee::GroupReceipt, Error> {
        if !path_segment(room) {
            return Err(Error::InvalidUrl);
        }
        self.post(&format!("/api/v1/e2ee/rooms/{room}/transitions"), input)
            .await
    }
    pub async fn crypto_group_state(
        &self,
        room: &str,
    ) -> Result<rv_protocol::e2ee::GroupState, Error> {
        if !path_segment(room) {
            return Err(Error::InvalidUrl);
        }
        self.get(&format!("/api/v1/e2ee/rooms/{room}/state")).await
    }
    pub async fn crypto_group_events(
        &self,
        room: &str,
        after: &str,
    ) -> Result<rv_protocol::e2ee::GroupEventPage, Error> {
        if !path_segment(room) || after.is_empty() || !after.bytes().all(|b| b.is_ascii_digit()) {
            return Err(Error::InvalidUrl);
        }
        self.get(&format!("/api/v1/e2ee/rooms/{room}/events?after={after}"))
            .await
    }
    pub async fn crypto_group_operation(
        &self,
        room: &str,
        operation: &str,
    ) -> Result<rv_protocol::e2ee::GroupReceipt, Error> {
        if !path_segment(room) || !path_segment(operation) {
            return Err(Error::InvalidUrl);
        }
        self.get(&format!("/api/v1/e2ee/rooms/{room}/operations/{operation}"))
            .await
    }
    pub async fn cancel_crypto_group(
        &self,
        room: &str,
        input: &rv_protocol::e2ee::GroupSubmission,
    ) -> Result<rv_protocol::e2ee::GroupSettlement, Error> {
        if !path_segment(room) || !path_segment(&input.operation_id) {
            return Err(Error::InvalidUrl);
        }
        self.post(
            &format!(
                "/api/v1/e2ee/rooms/{room}/operations/{}/cancel",
                input.operation_id
            ),
            input,
        )
        .await
    }
    pub async fn submit_crypto_message(
        &self,
        room: &str,
        input: &rv_protocol::e2ee::ApplicationSubmission,
    ) -> Result<rv_protocol::e2ee::ApplicationReceipt, Error> {
        if !path_segment(room) {
            return Err(Error::InvalidUrl);
        }
        self.post(&format!("/api/v1/e2ee/rooms/{room}/messages"), input)
            .await
    }
    pub async fn crypto_message_operation(
        &self,
        room: &str,
        operation: &str,
    ) -> Result<rv_protocol::e2ee::ApplicationReceipt, Error> {
        if !path_segment(room) || !path_segment(operation) {
            return Err(Error::InvalidUrl);
        }
        self.get(&format!(
            "/api/v1/e2ee/rooms/{room}/message-operations/{operation}"
        ))
        .await
    }
    /// Serialize abandonment with any concurrent submission of these exact bytes.
    pub async fn cancel_crypto_message(
        &self,
        room: &str,
        input: &rv_protocol::e2ee::ApplicationSubmission,
    ) -> Result<rv_protocol::e2ee::ApplicationSettlement, Error> {
        if !path_segment(room) || !path_segment(&input.operation_id) {
            return Err(Error::InvalidUrl);
        }
        self.post(
            &format!(
                "/api/v1/e2ee/rooms/{room}/message-operations/{}/cancel",
                input.operation_id
            ),
            input,
        )
        .await
    }
    /// Complete ordered crypto pages; this transport grants no MLS permission.
    pub async fn crypto_delivery(
        &self,
        room: &str,
        after: &str,
        through: Option<&str>,
    ) -> Result<rv_protocol::e2ee::DeliveryPage, Error> {
        let position = |value: &str| {
            value
                .parse::<i64>()
                .is_ok_and(|v| v >= 0 && v.to_string() == value)
        };
        if !path_segment(room) || !position(after) || through.is_some_and(|v| !position(v)) {
            return Err(Error::InvalidUrl);
        }
        self.get(&format!(
            "/api/v1/e2ee/rooms/{room}/delivery?after={after}{}",
            through.map(|v| format!("&through={v}")).unwrap_or_default()
        ))
        .await
    }
    /// Observation only: the package is claimed with the accepted group transition.
    pub async fn available_crypto_key_package(
        &self,
        room: &str,
        user: &str,
        device: &str,
    ) -> Result<rv_protocol::e2ee::AvailableKeyPackage, Error> {
        if !path_segment(room) || !path_segment(user) || !path_segment(device) {
            return Err(Error::InvalidUrl);
        }
        self.get(&format!(
            "/api/v1/e2ee/rooms/{room}/key-packages/{user}/{device}"
        ))
        .await
    }
    pub async fn register_crypto_device(
        &self,
        input: &rv_protocol::e2ee::RegisterDevice,
    ) -> Result<rv_protocol::e2ee::OperationReceipt, Error> {
        self.post("/api/v1/e2ee/devices", input).await
    }
    pub async fn revoke_crypto_device(
        &self,
        input: &rv_protocol::e2ee::RevokeDevice,
    ) -> Result<rv_protocol::e2ee::OperationReceipt, Error> {
        self.post("/api/v1/e2ee/revocations", input).await
    }
    /// Opaque encrypted root only; recovery codes never enter this transport.
    pub async fn crypto_root_backup(&self) -> Result<rv_protocol::e2ee::RootBackupState, Error> {
        self.get("/api/v1/e2ee/root-backup").await
    }
    pub async fn cancel_crypto_root_backup(
        &self,
        input: &rv_protocol::e2ee::PublishRootBackup,
    ) -> Result<rv_protocol::e2ee::RootBackupSettlement, Error> {
        if !path_segment(&input.operation_id) {
            return Err(Error::InvalidUrl);
        }
        self.post(
            &format!(
                "/api/v1/e2ee/root-backup/operations/{}/cancel",
                input.operation_id
            ),
            input,
        )
        .await
    }
    pub async fn publish_crypto_root_backup(
        &self,
        input: &rv_protocol::e2ee::PublishRootBackup,
    ) -> Result<rv_protocol::e2ee::RootBackupReceipt, Error> {
        self.post("/api/v1/e2ee/root-backup", input).await
    }
    pub async fn crypto_root_backup_operation(
        &self,
        operation: &str,
    ) -> Result<rv_protocol::e2ee::RootBackupReceipt, Error> {
        if !path_segment(operation) {
            return Err(Error::InvalidUrl);
        }
        self.get(&format!("/api/v1/e2ee/root-backup/operations/{operation}"))
            .await
    }
    /// History shares (E2EE_HISTORY.md): signed opaque bytes only. The engine
    /// verifies every request, share and record against its own directory.
    pub async fn publish_crypto_history_request(
        &self,
        input: &rv_protocol::e2ee::PublishHistoryRequest,
    ) -> Result<rv_protocol::e2ee::HistoryRequestEntry, Error> {
        self.post("/api/v1/e2ee/history/requests", input).await
    }
    pub async fn crypto_history_requests(
        &self,
    ) -> Result<rv_protocol::e2ee::HistoryRequests, Error> {
        self.get("/api/v1/e2ee/history/requests").await
    }
    pub async fn upload_crypto_history_records(
        &self,
        request: &str,
        input: &rv_protocol::e2ee::UploadHistoryRecords,
    ) -> Result<rv_protocol::e2ee::HistoryRecordsReceipt, Error> {
        if !path_segment(request) {
            return Err(Error::InvalidUrl);
        }
        self.request(
            Method::PUT,
            &format!("/api/v1/e2ee/history/requests/{request}/records"),
            Some(input),
            false,
        )
        .await
    }
    pub async fn commit_crypto_history_share(
        &self,
        request: &str,
        input: &rv_protocol::e2ee::CommitHistoryShare,
    ) -> Result<rv_protocol::e2ee::HistoryShareState, Error> {
        if !path_segment(request) {
            return Err(Error::InvalidUrl);
        }
        self.post(
            &format!("/api/v1/e2ee/history/requests/{request}/share"),
            input,
        )
        .await
    }
    pub async fn crypto_history_share(
        &self,
        request: &str,
    ) -> Result<rv_protocol::e2ee::HistoryShareState, Error> {
        if !path_segment(request) {
            return Err(Error::InvalidUrl);
        }
        self.get(&format!("/api/v1/e2ee/history/requests/{request}/share"))
            .await
    }
    pub async fn crypto_history_records(
        &self,
        request: &str,
        period: u32,
        after: &str,
    ) -> Result<rv_protocol::e2ee::HistoryRecordsPage, Error> {
        if !path_segment(request) || !after.bytes().all(|b| b.is_ascii_digit()) || after.is_empty()
        {
            return Err(Error::InvalidUrl);
        }
        self.get(&format!(
            "/api/v1/e2ee/history/requests/{request}/records?period={period}&after={after}"
        ))
        .await
    }
    pub async fn acknowledge_crypto_history(&self, request: &str) -> Result<(), Error> {
        if !path_segment(request) {
            return Err(Error::InvalidUrl);
        }
        self.empty(
            Method::POST,
            &format!("/api/v1/e2ee/history/requests/{request}/ack"),
            false,
        )
        .await
    }
    /// History backup (E2EE_HISTORY_BACKUP.md): the key package sealed under the
    /// history code and periods of signed records. No code or key travels here.
    pub async fn crypto_history_key(&self) -> Result<rv_protocol::e2ee::HistoryKeyState, Error> {
        self.get("/api/v1/e2ee/history-backup").await
    }
    pub async fn publish_crypto_history_key(
        &self,
        input: &rv_protocol::e2ee::PublishHistoryKey,
    ) -> Result<rv_protocol::e2ee::HistoryKeyReceipt, Error> {
        self.post("/api/v1/e2ee/history-backup", input).await
    }
    pub async fn crypto_history_key_operation(
        &self,
        operation: &str,
    ) -> Result<rv_protocol::e2ee::HistoryKeyReceipt, Error> {
        if !path_segment(operation) {
            return Err(Error::InvalidUrl);
        }
        self.get(&format!(
            "/api/v1/e2ee/history-backup/operations/{operation}"
        ))
        .await
    }
    pub async fn cancel_crypto_history_key(
        &self,
        input: &rv_protocol::e2ee::PublishHistoryKey,
    ) -> Result<rv_protocol::e2ee::HistoryKeySettlement, Error> {
        if !path_segment(&input.operation_id) {
            return Err(Error::InvalidUrl);
        }
        self.post(
            &format!(
                "/api/v1/e2ee/history-backup/operations/{}/cancel",
                input.operation_id
            ),
            input,
        )
        .await
    }
    pub async fn crypto_history_backup_periods(
        &self,
        generation: &str,
        after: Option<&str>,
    ) -> Result<rv_protocol::e2ee::HistoryBackupPeriods, Error> {
        if !path_segment(generation) || after.is_some_and(|a| !path_segment(a)) {
            return Err(Error::InvalidUrl);
        }
        let after = after.map(|a| format!("&after={a}")).unwrap_or_default();
        self.get(&format!(
            "/api/v1/e2ee/history-backup/periods?generation={generation}{after}"
        ))
        .await
    }
    pub async fn upload_crypto_history_backup(
        &self,
        period: &str,
        input: &rv_protocol::e2ee::UploadHistoryBackup,
    ) -> Result<rv_protocol::e2ee::HistoryBackupReceipt, Error> {
        if !path_segment(period) {
            return Err(Error::InvalidUrl);
        }
        self.request(
            Method::PUT,
            &format!("/api/v1/e2ee/history-backup/periods/{period}/records"),
            Some(input),
            false,
        )
        .await
    }
    pub async fn crypto_history_backup_records(
        &self,
        period: &str,
        after: &str,
    ) -> Result<rv_protocol::e2ee::HistoryBackupPage, Error> {
        if !path_segment(period) || after.is_empty() || !after.bytes().all(|b| b.is_ascii_digit()) {
            return Err(Error::InvalidUrl);
        }
        self.get(&format!(
            "/api/v1/e2ee/history-backup/periods/{period}/records?after={after}"
        ))
        .await
    }
    pub async fn publish_key_packages(
        &self,
        input: &rv_protocol::e2ee::PublishKeyPackages,
    ) -> Result<rv_protocol::e2ee::OperationReceipt, Error> {
        self.post("/api/v1/e2ee/key-packages", input).await
    }
    /// Transport only. Verify signatures, scope, pins and explicit consent in the engine.
    pub async fn crypto_directory(
        &self,
        user: &str,
        after: Option<&str>,
    ) -> Result<rv_protocol::e2ee::Directory, Error> {
        if !path_segment(user)
            || after.is_some_and(|v| v.is_empty() || !v.bytes().all(|b| b.is_ascii_digit()))
        {
            return Err(Error::InvalidUrl);
        }
        self.get(&format!(
            "/api/v1/e2ee/users/{user}{}",
            after.map(|v| format!("?after={v}")).unwrap_or_default()
        ))
        .await
    }
    pub async fn crypto_operation(
        &self,
        operation: &str,
    ) -> Result<rv_protocol::e2ee::OperationReceipt, Error> {
        if !path_segment(operation) {
            return Err(Error::InvalidUrl);
        }
        self.get(&format!("/api/v1/e2ee/operations/{operation}"))
            .await
    }
    /// A LiveKit grant for the room's voice session (docs/protocol/VOICE.md).
    pub async fn join_voice(
        &self,
        room: &str,
        input: &rv_protocol::voice::JoinVoice,
    ) -> Result<rv_protocol::voice::VoiceGrant, Error> {
        if !path_segment(room) {
            return Err(Error::InvalidUrl);
        }
        self.request(
            Method::POST,
            &format!("/api/v1/rooms/{room}/voice/join"),
            Some(input),
            false,
        )
        .await
    }
    pub async fn leave_voice(&self) -> Result<(), Error> {
        self.empty(Method::POST, "/api/v1/voice/leave", false).await
    }
    /// Claims the room's one screen share (`409 screen_taken` while another holds it).
    pub async fn claim_screen(&self) -> Result<(), Error> {
        self.empty(Method::POST, "/api/v1/voice/screen", false)
            .await
    }
    pub async fn release_screen(&self) -> Result<(), Error> {
        self.empty(Method::DELETE, "/api/v1/voice/screen", false)
            .await
    }
    pub async fn voice_ring(&self, id: &str) -> Result<rv_protocol::voice::VoiceRing, Error> {
        if !path_segment(id) {
            return Err(Error::InvalidUrl);
        }
        self.get(&format!("/api/v1/voice/rings/{id}")).await
    }
    pub async fn accept_ring(
        &self,
        id: &str,
        input: &rv_protocol::voice::AnswerRing,
    ) -> Result<rv_protocol::voice::VoiceGrant, Error> {
        if !path_segment(id) {
            return Err(Error::InvalidUrl);
        }
        self.request(
            Method::POST,
            &format!("/api/v1/voice/rings/{id}/accept"),
            Some(input),
            false,
        )
        .await
    }
    pub async fn decline_ring(&self, id: &str) -> Result<(), Error> {
        if !path_segment(id) {
            return Err(Error::InvalidUrl);
        }
        self.empty(
            Method::POST,
            &format!("/api/v1/voice/rings/{id}/decline"),
            false,
        )
        .await
    }
    pub fn new(base: &str) -> Result<Self, Error> {
        let parsed = Url::parse(base).map_err(|_| Error::InvalidUrl)?;
        if !matches!(parsed.scheme(), "http" | "https")
            || parsed.host_str().is_none()
            || !parsed.username().is_empty()
            || parsed.password().is_some()
            || parsed.query().is_some()
            || parsed.fragment().is_some()
        {
            return Err(Error::InvalidUrl);
        }
        Ok(Self {
            base: parsed.as_str().trim_end_matches('/').into(),
            http: reqwest::Client::builder()
                .timeout(Duration::from_secs(15))
                .redirect(reqwest::redirect::Policy::none())
                .build()?,
            token: Arc::default(),
            cooldowns: Arc::default(),
            snapshot_paging: Arc::default(),
        })
    }

    async fn request<T: DeserializeOwned>(
        &self,
        method: Method,
        path: &str,
        input: Option<&impl Serialize>,
        anonymous: bool,
    ) -> Result<T, Error> {
        let budget = Self::budget(path, &method);
        self.check_cooldown(budget)?;
        let sent = if anonymous {
            None
        } else {
            Some(self.saved_token().ok_or(Error::SessionMissing)?)
        };
        let mut request = self.http.request(method, format!("{}{path}", self.base));
        if !anonymous {
            request = request.bearer_auth(sent.as_ref().expect("authenticated credential"));
        }
        if let Some(input) = input {
            request = request.json(input);
        }
        let response = request.send().await?;
        if path.starts_with("/api/v1/e2ee/") {
            return self.crypto_json(response, budget, sent).await;
        }
        let mut response = self.accepted(response, budget, sent).await?;
        if path == "/api/v1/sync/snapshots" || path.starts_with("/api/v1/sync/snapshots/") {
            // Bound page bodies before parsing, including chunked responses.
            const MAX: usize = 1024 * 1024;
            if response.content_length().is_some_and(|n| n > MAX as u64) {
                return Err(Error::InvalidSnapshot);
            }
            let mut bytes = Vec::new();
            while let Some(chunk) = response.chunk().await? {
                if bytes.len() + chunk.len() > MAX {
                    return Err(Error::InvalidSnapshot);
                }
                bytes.extend_from_slice(&chunk);
            }
            return serde_json::from_slice(&bytes).map_err(|_| Error::InvalidSnapshot);
        }
        Ok(response.json().await?)
    }

    async fn accepted(
        &self,
        response: reqwest::Response,
        budget: Option<&'static str>,
        sent: Option<String>,
    ) -> Result<reqwest::Response, Error> {
        if !response.status().is_success() {
            let status = response.status().as_u16();
            let retry = retry_after(&response);
            let error: ApiError = response.json().await?;
            return Err(self.server_error(status, retry, budget, sent, error));
        }
        Ok(response)
    }

    fn server_error(
        &self,
        status: u16,
        retry: Option<u64>,
        budget: Option<&'static str>,
        sent: Option<String>,
        error: ApiError,
    ) -> Error {
        if status == 401
            && error.code == "session_rejected"
            && sent.is_some()
            && sent != self.saved_token()
        {
            return Error::Server {
                status: 409,
                code: "delivery_revalidate".into(),
                request_id: Some(error.request_id),
                retry_after: None,
            };
        }
        if status == 429
            && let Some(key) = budget
        {
            self.cooldowns.lock().expect("native cooldown lock").insert(
                key,
                Cooldown {
                    until: Instant::now() + Duration::from_secs(retry.unwrap_or(1)),
                    code: error.code.clone(),
                    request_id: error.request_id.clone(),
                },
            );
        }
        Error::Server {
            status,
            code: error.code,
            request_id: Some(error.request_id),
            retry_after: retry,
        }
    }

    async fn crypto_json<T: DeserializeOwned>(
        &self,
        mut response: reqwest::Response,
        budget: Option<&'static str>,
        sent: Option<String>,
    ) -> Result<T, Error> {
        // The largest group page is ~3 MiB after base64. Bound the body before
        // Serde, including chunked input and error responses from a peer server.
        const LIMIT: usize = 4 * 1024 * 1024;
        let status = response.status();
        let retry = retry_after(&response);
        if response.content_length().is_some_and(|n| n > LIMIT as u64) {
            return Err(Error::InvalidCrypto);
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await? {
            if chunk.len() > LIMIT - bytes.len() {
                return Err(Error::InvalidCrypto);
            }
            bytes.extend_from_slice(&chunk);
        }
        if !status.is_success() {
            let error = serde_json::from_slice(&bytes).map_err(|_| Error::InvalidCrypto)?;
            return Err(self.server_error(status.as_u16(), retry, budget, sent, error));
        }
        serde_json::from_slice(&bytes).map_err(|_| Error::InvalidCrypto)
    }

    fn budget(path: &str, method: &Method) -> Option<&'static str> {
        match path {
            "/api/v1/me" | "/api/v1/me/preferences" if *method == Method::PATCH => Some("profile"),
            "/api/v1/auth/login"
            | "/api/v1/auth/start"
            | "/api/v1/auth/factors/verify"
            | "/api/v1/auth/invitations/accept"
            | "/api/v1/auth/recovery"
            | "/api/v1/me/reauth/start"
            | "/api/v1/me/reauth/finish" => Some("login"),
            "/api/v1/me/email/verification/start"
            | "/api/v1/auth/factors/email/start"
            | "/api/v1/me/reauth/email/start" => Some("email_delivery"),
            "/api/v1/auth/recovery/email/start" => Some("email_recovery"),
            "/api/v1/auth/renew" => Some("session_rotation"),
            "/api/v1/sync/ticket" => Some("ticket"),
            "/api/v1/sync/snapshots" => Some("snapshot"),
            "/api/v1/e2ee/devices"
            | "/api/v1/e2ee/key-packages"
            | "/api/v1/e2ee/revocations"
            | "/api/v1/e2ee/root-backup"
            | "/api/v1/e2ee/history/requests"
            | "/api/v1/e2ee/history-backup"
                if *method == Method::POST =>
            {
                Some("crypto")
            }
            _ if (path.starts_with("/api/v1/e2ee/root-backup/operations/")
                || path.starts_with("/api/v1/e2ee/history-backup/operations/"))
                && path.ends_with("/cancel")
                && *method == Method::POST =>
            {
                Some("crypto")
            }
            _ if path.starts_with("/api/v1/messages/")
                && matches!(*method, Method::PATCH | Method::DELETE | Method::PUT) =>
            {
                Some("message_action")
            }
            _ if path.starts_with("/api/v1/rooms/")
                && *method == Method::POST
                && path.ends_with("/read") =>
            {
                Some("room_read")
            }
            _ if path.starts_with("/api/v1/rooms/")
                && (*method == Method::PATCH
                    || *method == Method::PUT
                        && (path.ends_with("/role") || path.ends_with("/favorite"))
                    || *method == Method::POST && path.ends_with("/leave")) =>
            {
                Some("room_command")
            }
            _ => None,
        }
    }

    fn check_cooldown(&self, budget: Option<&'static str>) -> Result<(), Error> {
        if let Some(key) = budget
            && let Some(cooldown) = self
                .cooldowns
                .lock()
                .expect("native cooldown lock")
                .get(key)
            && cooldown.until > Instant::now()
        {
            return Err(Error::Server {
                status: 429,
                code: cooldown.code.clone(),
                request_id: Some(cooldown.request_id.clone()),
                retry_after: Some(
                    cooldown
                        .until
                        .saturating_duration_since(Instant::now())
                        .as_secs()
                        .saturating_add(1)
                        .clamp(1, 300),
                ),
            });
        }
        Ok(())
    }

    async fn get<T: DeserializeOwned>(&self, path: &str) -> Result<T, Error> {
        self.request(Method::GET, path, None::<&()>, false).await
    }
    async fn post<T: DeserializeOwned>(
        &self,
        path: &str,
        input: &impl Serialize,
    ) -> Result<T, Error> {
        self.request(Method::POST, path, Some(input), false).await
    }

    pub async fn discover(&self) -> Result<Discovery, Error> {
        let info: Discovery = self
            .request(Method::GET, "/.well-known/rocketvibe", None::<&()>, true)
            .await?;
        if info.product != "rocketvibe"
            || !info.protocol_versions.contains(&rv_protocol::VERSION)
            || info.api_path != "/api/v1"
        {
            return Err(Error::UnsupportedProtocol);
        }
        *self.snapshot_paging.lock().expect("native discovery lock") =
            Some(info.capabilities.snapshot_paging);
        Ok(info)
    }

    pub async fn login(&mut self, username: &str, password: &str) -> Result<Session, Error> {
        let session: Session = self
            .request(
                Method::POST,
                "/api/v1/auth/login",
                Some(&Login {
                    username: username.into(),
                    password: password.into(),
                }),
                true,
            )
            .await?;
        self.update_token(session.token.clone());
        Ok(session)
    }

    pub fn restore(&mut self, token: String) {
        self.update_token(token);
    }

    pub async fn register_push(
        &self,
        token: &str,
    ) -> Result<rv_protocol::push::PushRegistration, Error> {
        self.request(
            Method::PUT,
            "/api/v1/me/push",
            Some(&rv_protocol::push::RegisterPush {
                token: token.into(),
            }),
            false,
        )
        .await
    }
    pub async fn unregister_push(&self) -> Result<(), Error> {
        self.empty(Method::DELETE, "/api/v1/me/push", false).await
    }
    pub async fn push_content(&self, id: &str) -> Result<rv_protocol::push::PushContent, Error> {
        if !path_segment(id) {
            return Err(Error::InvalidUrl);
        }
        self.request(
            Method::GET,
            &format!("/api/v1/push/notifications/{id}"),
            None::<&()>,
            false,
        )
        .await
    }

    /// Does not replace an active credential. The account coordinator must pin
    /// discovery and commit the resulting session to secure storage first.
    pub async fn start_login(
        &self,
        username: &str,
        password: &str,
    ) -> Result<rv_protocol::parity::AuthenticationStep, Error> {
        self.request(
            Method::POST,
            "/api/v1/auth/start",
            Some(&Login {
                username: username.into(),
                password: password.into(),
            }),
            true,
        )
        .await
    }
    pub async fn finish_factor(
        &self,
        input: &rv_protocol::parity::FinishFactor,
    ) -> Result<Session, Error> {
        self.request(
            Method::POST,
            "/api/v1/auth/factors/verify",
            Some(input),
            true,
        )
        .await
    }
    pub async fn factor_status(&self) -> Result<rv_protocol::parity::FactorStatus, Error> {
        self.get("/api/v1/me/factors").await
    }
    pub async fn enable_email_factor(
        &self,
        input: &rv_protocol::parity::ChangeEmailFactor,
    ) -> Result<rv_protocol::parity::EmailFactorChange, Error> {
        self.post("/api/v1/me/factors/email/enable", input).await
    }
    pub async fn disable_email_factor(
        &self,
        input: &rv_protocol::parity::ChangeEmailFactor,
    ) -> Result<rv_protocol::parity::EmailFactorChange, Error> {
        self.post("/api/v1/me/factors/email/disable", input).await
    }
    pub async fn begin_factor_email(
        &self,
        input: &rv_protocol::parity::RequestFactorEmail,
    ) -> Result<rv_protocol::parity::FactorEmailDelivery, Error> {
        self.request(
            Method::POST,
            "/api/v1/auth/factors/email/start",
            Some(input),
            true,
        )
        .await
    }
    pub async fn resume_factor_email(
        &self,
        input: &rv_protocol::parity::RequestFactorEmail,
    ) -> Result<rv_protocol::parity::FactorEmailDelivery, Error> {
        self.request(
            Method::POST,
            "/api/v1/auth/factors/email/resume",
            Some(input),
            true,
        )
        .await
    }
    pub async fn begin_reauthentication_email(
        &self,
        input: &rv_protocol::parity::RequestFactorEmail,
    ) -> Result<rv_protocol::parity::FactorEmailDelivery, Error> {
        self.post("/api/v1/me/reauth/email/start", input).await
    }
    pub async fn resume_reauthentication_email(
        &self,
        input: &rv_protocol::parity::RequestFactorEmail,
    ) -> Result<rv_protocol::parity::FactorEmailDelivery, Error> {
        self.post("/api/v1/me/reauth/email/resume", input).await
    }
    pub async fn email_status(&self) -> Result<rv_protocol::parity::EmailStatus, Error> {
        self.get("/api/v1/me/email").await
    }
    pub async fn begin_email_verification(
        &self,
        input: &rv_protocol::parity::BeginEmailVerification,
    ) -> Result<rv_protocol::parity::EmailVerificationStep, Error> {
        self.post("/api/v1/me/email/verification/start", input)
            .await
    }
    pub async fn resume_email_verification(
        &self,
        input: &rv_protocol::parity::ResumeEmailVerification,
    ) -> Result<rv_protocol::parity::EmailVerificationStep, Error> {
        self.post("/api/v1/me/email/verification/resume", input)
            .await
    }
    pub async fn confirm_email_verification(
        &self,
        input: &rv_protocol::parity::ConfirmEmailVerification,
    ) -> Result<rv_protocol::parity::EmailVerificationStep, Error> {
        self.post("/api/v1/me/email/verification/confirm", input)
            .await
    }
    pub async fn retire_email_verification(
        &self,
        input: &rv_protocol::parity::RetireEmailVerification,
    ) -> Result<rv_protocol::parity::EmailStatus, Error> {
        self.post("/api/v1/me/email/verification/retire", input)
            .await
    }
    pub async fn begin_factor_setup(
        &self,
        input: &rv_protocol::parity::BeginFactorSetup,
    ) -> Result<rv_protocol::parity::FactorSetup, Error> {
        self.post("/api/v1/me/factors/totp/setup", input).await
    }
    pub async fn remove_verified_email(
        &self,
        input: &rv_protocol::parity::RemoveVerifiedEmail,
    ) -> Result<rv_protocol::parity::EmailRemovalReceipt, Error> {
        self.post("/api/v1/me/email/removal/start", input).await
    }
    pub async fn resume_email_removal(
        &self,
        input: &rv_protocol::parity::ResumeEmailRemoval,
    ) -> Result<rv_protocol::parity::EmailRemovalReceipt, Error> {
        self.post("/api/v1/me/email/removal/resume", input).await
    }
    pub async fn enable_factor(
        &self,
        input: &rv_protocol::parity::EnableFactor,
    ) -> Result<rv_protocol::parity::FactorBackupCodes, Error> {
        self.post("/api/v1/me/factors/totp/enable", input).await
    }
    pub async fn retire_email_removal(
        &self,
        input: &rv_protocol::parity::RetireEmailRemoval,
    ) -> Result<rv_protocol::parity::EmailStatus, Error> {
        self.post("/api/v1/me/email/removal/retire", input).await
    }
    pub async fn disable_factor(
        &self,
        input: &rv_protocol::parity::DisableFactor,
    ) -> Result<(), Error> {
        self.empty_input(Method::POST, "/api/v1/me/factors/totp/disable", Some(input))
            .await
    }
    pub async fn regenerate_factor_backups(
        &self,
        input: &rv_protocol::parity::RegenerateFactorBackups,
    ) -> Result<rv_protocol::parity::FactorBackupCodes, Error> {
        self.post("/api/v1/me/factors/recovery/regenerate", input)
            .await
    }
    pub async fn begin_reauthentication(
        &self,
        input: &rv_protocol::parity::BeginReauthentication,
    ) -> Result<rv_protocol::parity::ReauthenticationStep, Error> {
        self.post("/api/v1/me/reauth/start", input).await
    }
    pub async fn reauthentication_status(
        &self,
    ) -> Result<rv_protocol::parity::ReauthenticationStatus, Error> {
        self.request(
            reqwest::Method::GET,
            "/api/v1/me/reauth",
            None::<&()>,
            false,
        )
        .await
    }
    pub async fn finish_reauthentication(
        &self,
        input: &rv_protocol::parity::FinishReauthentication,
    ) -> Result<rv_protocol::parity::ReauthenticationGrant, Error> {
        self.post("/api/v1/me/reauth/finish", input).await
    }
    pub async fn resume_reauthentication(
        &self,
        input: &rv_protocol::parity::ResumeReauthentication,
    ) -> Result<rv_protocol::parity::ReauthenticationStep, Error> {
        self.post("/api/v1/me/reauth/resume", input).await
    }
    pub async fn retire_reauthentication(
        &self,
        input: &rv_protocol::parity::RetireReauthentication,
    ) -> Result<rv_protocol::parity::ReauthenticationStatus, Error> {
        self.post("/api/v1/me/reauth/retire", input).await
    }
    /// Clones share one account's rotating credential.
    pub fn update_token(&self, token: String) {
        *self.token.lock().expect("native credential lock") = Some(token);
    }
    pub fn saved_token(&self) -> Option<String> {
        self.token.lock().expect("native credential lock").clone()
    }
    pub async fn renew(&self, input: &rv_protocol::parity::RenewSession) -> Result<Session, Error> {
        self.post("/api/v1/auth/renew", input).await
    }
    pub async fn device_sessions(&self) -> Result<Vec<rv_protocol::parity::DeviceSession>, Error> {
        self.get("/api/v1/me/sessions").await
    }
    pub async fn rename_device(
        &self,
        id: &str,
        input: &rv_protocol::parity::RenameDevice,
    ) -> Result<(), Error> {
        if !path_segment(id) {
            return Err(Error::InvalidUrl);
        }
        self.empty_input(
            Method::PATCH,
            &format!("/api/v1/me/sessions/{id}"),
            Some(input),
        )
        .await
    }
    pub async fn revoke_device(&self, id: &str) -> Result<(), Error> {
        if !path_segment(id) {
            return Err(Error::InvalidUrl);
        }
        self.empty(Method::DELETE, &format!("/api/v1/me/sessions/{id}"), false)
            .await
    }
    pub async fn accept_invitation(
        &self,
        input: &rv_protocol::parity::AcceptInvitation,
    ) -> Result<User, Error> {
        self.request(
            Method::POST,
            "/api/v1/auth/invitations/accept",
            Some(input),
            true,
        )
        .await
    }

    pub async fn recover_account(
        &self,
        input: &rv_protocol::parity::RecoverAccount,
    ) -> Result<User, Error> {
        self.request(Method::POST, "/api/v1/auth/recovery", Some(input), true)
            .await
    }

    pub async fn request_email_recovery(
        &self,
        input: &rv_protocol::parity::RequestEmailRecovery,
    ) -> Result<rv_protocol::parity::EmailRecoveryRequested, Error> {
        self.request(
            Method::POST,
            "/api/v1/auth/recovery/email/start",
            Some(input),
            true,
        )
        .await
    }

    pub async fn me(&self) -> Result<User, Error> {
        self.get("/api/v1/me").await
    }

    pub async fn own_profile(&self) -> Result<rv_protocol::profiles::OwnProfile, Error> {
        self.get("/api/v1/me/profile").await
    }
    pub async fn prepare_upload(
        &self,
        input: &rv_protocol::parity::PrepareUpload,
    ) -> Result<rv_protocol::parity::Upload, Error> {
        self.post("/api/v1/uploads", input).await
    }
    pub async fn upload_status(&self, id: &str) -> Result<rv_protocol::parity::Upload, Error> {
        self.get(&format!("/api/v1/uploads/{}", encode(id))).await
    }
    /// Body can be a stream; the account token is sent only to the pinned server.
    pub async fn upload_bytes(
        &self,
        id: &str,
        body: reqwest::Body,
    ) -> Result<rv_protocol::parity::Upload, Error> {
        let sent = self.saved_token().ok_or(Error::SessionMissing)?;
        let response = self
            .http
            .put(format!("{}/api/v1/uploads/{}/bytes", self.base, encode(id)))
            .timeout(Duration::from_secs(150))
            .bearer_auth(&sent)
            .header(reqwest::header::CONTENT_TYPE, "application/octet-stream")
            .body(body)
            .send()
            .await?;
        Ok(self
            .accepted(response, None, Some(sent))
            .await?
            .json()
            .await?)
    }
    pub async fn complete_upload(
        &self,
        id: &str,
        input: &rv_protocol::parity::CompleteUpload,
    ) -> Result<Message, Error> {
        self.post(&format!("/api/v1/uploads/{}/complete", encode(id)), input)
            .await
    }
    pub async fn cancel_upload(&self, id: &str) -> Result<rv_protocol::parity::Upload, Error> {
        self.request(
            Method::DELETE,
            &format!("/api/v1/uploads/{}", encode(id)),
            None::<&()>,
            false,
        )
        .await
    }
    /// Consume chunks into private local storage, rather than buffering a file.
    pub async fn file_response(
        &self,
        id: &str,
        range: Option<&str>,
    ) -> Result<reqwest::Response, Error> {
        let sent = self.saved_token().ok_or(Error::SessionMissing)?;
        let mut request = self
            .http
            .get(format!("{}/api/v1/files/{}", self.base, encode(id)))
            .timeout(Duration::from_secs(150))
            .bearer_auth(&sent);
        if let Some(range) = range {
            request = request.header(reqwest::header::RANGE, range);
        }
        self.accepted(request.send().await?, None, Some(sent)).await
    }
    pub async fn user_profile(&self, id: &str) -> Result<rv_protocol::parity::UserProfile, Error> {
        self.get(&format!("/api/v1/users/{}", encode(id))).await
    }
    pub async fn lookup_profile(
        &self,
        username: &str,
    ) -> Result<rv_protocol::parity::UserProfile, Error> {
        self.get(&format!(
            "/api/v1/users/lookup?username={}",
            encode(username)
        ))
        .await
    }
    pub async fn update_profile(
        &self,
        input: &rv_protocol::profiles::UpdateProfile,
    ) -> Result<rv_protocol::profiles::ProfileReceipt, Error> {
        self.request(Method::PATCH, "/api/v1/me", Some(input), false)
            .await
    }
    pub async fn update_preferences(
        &self,
        input: &rv_protocol::profiles::UpdatePreferences,
    ) -> Result<rv_protocol::profiles::ProfileReceipt, Error> {
        self.request(Method::PATCH, "/api/v1/me/preferences", Some(input), false)
            .await
    }
    pub async fn set_avatar(
        &self,
        input: &rv_protocol::profiles::AvatarCommand,
        upload: Option<(&str, Vec<u8>)>,
    ) -> Result<rv_protocol::profiles::ProfileReceipt, Error> {
        self.check_cooldown(Some("profile"))?;
        let sent = self.saved_token().ok_or(Error::SessionMissing)?;
        let path = format!(
            "/api/v1/me/avatar?operation_id={}&expected_revision={}",
            encode(&input.operation_id),
            encode(&input.expected_revision)
        );
        let method = if upload.is_some() {
            Method::PUT
        } else {
            Method::DELETE
        };
        let mut request = self
            .http
            .request(method, format!("{}{path}", self.base))
            .bearer_auth(&sent);
        if let Some((mime, bytes)) = upload {
            if bytes.len() > rv_protocol::bots::AVATAR_BYTES {
                return Err(Error::InvalidAvatar);
            }
            request = request
                .header(reqwest::header::CONTENT_TYPE, mime)
                .body(bytes);
        }
        let response = self
            .accepted(request.send().await?, Some("profile"), Some(sent))
            .await?;
        Ok(response.json().await?)
    }
    pub async fn avatar_bytes(&self, id: &str) -> Result<Vec<u8>, Error> {
        let sent = self.saved_token().ok_or(Error::SessionMissing)?;
        let response = self
            .http
            .get(format!("{}/api/v1/avatars/{}", self.base, encode(id)))
            .bearer_auth(&sent)
            .send()
            .await?;
        let mut response = self.accepted(response, None, Some(sent)).await?;
        if response
            .content_length()
            .is_some_and(|n| n > 2 * 1024 * 1024)
            || response
                .headers()
                .get(reqwest::header::CONTENT_TYPE)
                .and_then(|v| v.to_str().ok())
                != Some("image/png")
        {
            return Err(Error::InvalidAvatar);
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await? {
            if bytes.len() + chunk.len() > 2 * 1024 * 1024 {
                return Err(Error::InvalidAvatar);
            }
            bytes.extend_from_slice(&chunk);
        }
        Ok(bytes)
    }
    pub async fn emoji_catalog(&self) -> Result<rv_protocol::custom_emojis::EmojiCatalog, Error> {
        let sent = self.saved_token().ok_or(Error::SessionMissing)?;
        let mut response = self
            .accepted(
                self.http
                    .get(format!("{}/api/v1/emoji", self.base))
                    .bearer_auth(&sent)
                    .send()
                    .await?,
                None,
                Some(sent),
            )
            .await?;
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await? {
            if bytes.len() + chunk.len() > 1024 * 1024 {
                return Err(Error::InvalidEmoji);
            }
            bytes.extend_from_slice(&chunk);
        }
        let catalog = serde_json::from_slice(&bytes).map_err(|_| Error::InvalidEmoji)?;
        if !rv_protocol::custom_emojis::validate(&catalog) {
            return Err(Error::InvalidEmoji);
        }
        Ok(catalog)
    }
    pub async fn emoji_bytes(
        &self,
        image: &rv_protocol::custom_emojis::CustomEmoji,
    ) -> Result<Vec<u8>, Error> {
        let sent = self.saved_token().ok_or(Error::SessionMissing)?;
        let mut response = self
            .accepted(
                self.http
                    .get(format!(
                        "{}/api/v1/emoji/files/{}",
                        self.base,
                        encode(&image.file_id)
                    ))
                    .bearer_auth(&sent)
                    .send()
                    .await?,
                None,
                Some(sent),
            )
            .await?;
        if response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            != Some(image.media_type.as_str())
            || response.content_length() != image.bytes.parse::<u64>().ok()
        {
            return Err(Error::InvalidEmoji);
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await? {
            if bytes.len() + chunk.len() > 1024 * 1024 {
                return Err(Error::InvalidEmoji);
            }
            bytes.extend_from_slice(&chunk);
        }
        use sha2::{Digest, Sha256};
        let hash = Sha256::digest(&bytes)
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>();
        if bytes.len().to_string() != image.bytes || hash != image.sha256 {
            return Err(Error::InvalidEmoji);
        }
        Ok(bytes)
    }
    /// The resource path is derived locally; no third-party URL can receive
    /// this bearer. Providers additionally fence the current message revision.
    pub async fn preview_image(
        &self,
        message: &str,
        image: &rv_protocol::link_previews::PreviewImage,
    ) -> Result<Vec<u8>, Error> {
        if !path_segment(message) || !rv_protocol::link_previews::validate_image(image) {
            return Err(Error::InvalidPreview);
        }
        let sent = self.saved_token().ok_or(Error::SessionMissing)?;
        let mut response = self
            .accepted(
                self.http
                    .get(format!(
                        "{}/api/v1/messages/{}/previews/{}",
                        self.base,
                        encode(message),
                        encode(&image.file_id)
                    ))
                    .bearer_auth(&sent)
                    .send()
                    .await?,
                None,
                Some(sent.clone()),
            )
            .await?;
        if response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|h| h.to_str().ok())
            != Some("image/png")
            || response.content_length() != image.bytes.parse::<u64>().ok()
        {
            return Err(Error::InvalidPreview);
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await? {
            if bytes.len() + chunk.len() > 4 * 1024 * 1024 {
                return Err(Error::InvalidPreview);
            }
            bytes.extend_from_slice(&chunk);
        }
        use sha2::{Digest, Sha256};
        if self.saved_token().as_deref() != Some(sent.as_str()) {
            return Err(Error::SessionMissing);
        }
        if bytes.len().to_string() != image.bytes
            || format!("{:x}", Sha256::digest(&bytes)) != image.sha256
            || bytes.len() < 33
            || !bytes.starts_with(b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR")
            || u32::from_be_bytes(bytes[16..20].try_into().unwrap()) != image.width
            || u32::from_be_bytes(bytes[20..24].try_into().unwrap()) != image.height
        {
            return Err(Error::InvalidPreview);
        }
        Ok(bytes)
    }
    pub async fn users(&self) -> Result<Vec<User>, Error> {
        self.get("/api/v1/users").await
    }

    pub async fn account_permissions(
        &self,
    ) -> Result<rv_protocol::parity::AccountPermissions, Error> {
        self.get("/api/v1/me/permissions").await
    }
    pub async fn room_permissions(
        &self,
        room: &str,
    ) -> Result<rv_protocol::parity::RoomPermissions, Error> {
        if !path_segment(room) {
            return Err(Error::InvalidUrl);
        }
        self.get(&format!("/api/v1/rooms/{room}/permissions")).await
    }
    pub async fn room_details(
        &self,
        room: &str,
    ) -> Result<rv_protocol::parity::RoomDetails, Error> {
        if !path_segment(room) {
            return Err(Error::InvalidUrl);
        }
        self.get(&format!("/api/v1/rooms/{room}")).await
    }
    pub async fn room_members(
        &self,
        room: &str,
        after: Option<&str>,
        revision: Option<&str>,
    ) -> Result<rv_protocol::parity::RoomMemberPage, Error> {
        if !path_segment(room)
            || after.is_some_and(|s| !path_segment(s))
            || revision.is_some_and(|s| !path_segment(s))
            || after.is_some() && revision.is_none()
        {
            return Err(Error::InvalidUrl);
        }
        let mut url = Url::parse(&format!("{}/api/v1/rooms/{room}/members", self.base))
            .map_err(|_| Error::InvalidUrl)?;
        if let Some(after) = after {
            url.query_pairs_mut().append_pair("after", after);
        }
        if let Some(revision) = revision {
            url.query_pairs_mut().append_pair("revision", revision);
        }
        self.get(
            url.as_str()
                .strip_prefix(&self.base)
                .ok_or(Error::InvalidUrl)?,
        )
        .await
    }
    pub async fn room_read_state(
        &self,
        room: &str,
    ) -> Result<rv_protocol::parity::ReadState, Error> {
        if !path_segment(room) {
            return Err(Error::InvalidUrl);
        }
        self.get(&format!("/api/v1/rooms/{room}/read")).await
    }
    pub async fn mark_room_read(
        &self,
        room: &str,
        input: &rv_protocol::parity::MarkRead,
    ) -> Result<rv_protocol::parity::ReadState, Error> {
        if !path_segment(room) {
            return Err(Error::InvalidUrl);
        }
        self.post(&format!("/api/v1/rooms/{room}/read"), input)
            .await
    }
    pub async fn set_room_favorite(
        &self,
        room: &str,
        input: &rv_protocol::parity::SetRoomFavorite,
    ) -> Result<rv_protocol::parity::RoomCommandReceipt, Error> {
        if !path_segment(room) {
            return Err(Error::InvalidUrl);
        }
        self.request(
            Method::PUT,
            &format!("/api/v1/rooms/{room}/favorite"),
            Some(input),
            false,
        )
        .await
    }
    pub async fn update_room(
        &self,
        room: &str,
        input: &rv_protocol::parity::UpdateRoom,
    ) -> Result<rv_protocol::parity::RoomCommandReceipt, Error> {
        if !path_segment(room) {
            return Err(Error::InvalidUrl);
        }
        self.request(
            Method::PATCH,
            &format!("/api/v1/rooms/{room}"),
            Some(input),
            false,
        )
        .await
    }
    pub async fn change_room_role(
        &self,
        room: &str,
        user: &str,
        input: &rv_protocol::parity::ChangeRoomRole,
    ) -> Result<rv_protocol::parity::RoomCommandReceipt, Error> {
        if !path_segment(room) || !path_segment(user) {
            return Err(Error::InvalidUrl);
        }
        self.request(
            Method::PUT,
            &format!("/api/v1/rooms/{room}/members/{user}/role"),
            Some(input),
            false,
        )
        .await
    }
    pub async fn leave_room(
        &self,
        room: &str,
        input: &rv_protocol::parity::LeaveRoom,
    ) -> Result<rv_protocol::parity::RoomCommandReceipt, Error> {
        if !path_segment(room) {
            return Err(Error::InvalidUrl);
        }
        self.post(&format!("/api/v1/rooms/{room}/leave"), input)
            .await
    }
    pub async fn room_command_receipt(
        &self,
        room: &str,
        operation: &str,
    ) -> Result<rv_protocol::parity::RoomCommandReceipt, Error> {
        if !path_segment(room) || !path_segment(operation) {
            return Err(Error::InvalidUrl);
        }
        self.get(&format!("/api/v1/rooms/{room}/commands/{operation}"))
            .await
    }
    pub async fn message_permissions(
        &self,
        message: &str,
    ) -> Result<rv_protocol::parity::MessagePermissions, Error> {
        if !path_segment(message) {
            return Err(Error::InvalidUrl);
        }
        self.get(&format!("/api/v1/messages/{message}/permissions"))
            .await
    }
    pub async fn message(&self, id: &str) -> Result<Message, Error> {
        if !path_segment(id) {
            return Err(Error::InvalidUrl);
        }
        self.get(&format!("/api/v1/messages/{id}")).await
    }
    pub async fn edit_message(
        &self,
        id: &str,
        input: &rv_protocol::parity::EditMessage,
    ) -> Result<Message, Error> {
        if !path_segment(id) {
            return Err(Error::InvalidUrl);
        }
        self.request(
            Method::PATCH,
            &format!("/api/v1/messages/{id}"),
            Some(input),
            false,
        )
        .await
    }
    pub async fn delete_message(
        &self,
        id: &str,
        input: &rv_protocol::parity::DeleteMessage,
    ) -> Result<Message, Error> {
        if !path_segment(id) {
            return Err(Error::InvalidUrl);
        }
        self.request(
            Method::DELETE,
            &format!("/api/v1/messages/{id}"),
            Some(input),
            false,
        )
        .await
    }
    pub async fn set_reaction(
        &self,
        id: &str,
        input: &rv_protocol::parity::SetReaction,
    ) -> Result<Message, Error> {
        if !path_segment(id) {
            return Err(Error::InvalidUrl);
        }
        self.request(
            Method::PUT,
            &format!("/api/v1/messages/{id}/reactions"),
            Some(input),
            false,
        )
        .await
    }
    /// The slash commands the server offers (`rv_protocol::commands`).
    pub async fn commands(&self) -> Result<rv_protocol::commands::CommandList, Error> {
        self.get("/api/v1/commands").await
    }
    /// The commands of a room: the core ones and the workflows offered there.
    pub async fn room_commands(
        &self,
        room: &str,
    ) -> Result<rv_protocol::commands::CommandList, Error> {
        if !path_segment(room) {
            return Err(Error::InvalidUrl);
        }
        self.get(&format!("/api/v1/commands?room={room}")).await
    }
    /// Runs a server-side slash command; text commands never come here.
    pub async fn run_command(
        &self,
        input: &rv_protocol::commands::RunCommand,
    ) -> Result<(), Error> {
        self.empty_input(Method::POST, "/api/v1/commands/run", Some(input))
            .await
    }
    pub async fn add_member(&self, room: &str, user: &str) -> Result<(), Error> {
        if !path_segment(room) || !path_segment(user) {
            return Err(Error::InvalidUrl);
        }
        self.empty(
            Method::POST,
            &format!("/api/v1/rooms/{room}/members/{user}"),
            true,
        )
        .await
    }
    pub async fn set_mark(
        &self,
        id: &str,
        input: &rv_protocol::parity::SetMark,
        starred: bool,
    ) -> Result<Message, Error> {
        if !path_segment(id) {
            return Err(Error::InvalidUrl);
        }
        let kind = if starred { "star" } else { "pin" };
        self.request(
            Method::PUT,
            &format!("/api/v1/messages/{id}/{kind}"),
            Some(input),
            false,
        )
        .await
    }
    pub async fn marked(
        &self,
        room: &str,
        starred: bool,
        before: Option<&str>,
    ) -> Result<MessagePage, Error> {
        if !path_segment(room)
            || before.is_some_and(|p| p.is_empty() || !p.bytes().all(|b| b.is_ascii_digit()))
        {
            return Err(Error::InvalidUrl);
        }
        let kind = if starred { "stars" } else { "pins" };
        let mut path = format!("/api/v1/rooms/{room}/{kind}?limit=100");
        if let Some(before) = before {
            path.push_str(&format!("&before={before}"));
        }
        self.get(&path).await
    }
    /// Instance counts and versions; requires `users.admin`.
    pub async fn admin_overview(&self) -> Result<rv_protocol::admin::AdminOverview, Error> {
        self.get("/api/v1/admin/overview").await
    }
    /// Accounts by username, deleted ones excluded; `q` is a literal substring.
    pub async fn admin_users(
        &self,
        after: Option<&str>,
        limit: Option<u32>,
        q: Option<&str>,
    ) -> Result<rv_protocol::admin::AdminUserPage, Error> {
        self.get(&self.admin_page("/api/v1/admin/users", after, limit, q)?)
            .await
    }
    pub async fn update_admin_user(
        &self,
        id: &str,
        input: &rv_protocol::admin::UpdateAdminUser,
    ) -> Result<rv_protocol::admin::AdminUser, Error> {
        if !path_segment(id) {
            return Err(Error::InvalidUrl);
        }
        self.request(
            Method::PATCH,
            &format!("/api/v1/admin/users/{id}"),
            Some(input),
            false,
        )
        .await
    }
    /// Tombstones the account; its messages stay, shown as a deleted user.
    pub async fn delete_admin_user(
        &self,
        id: &str,
        input: &rv_protocol::admin::DeleteAdminUser,
    ) -> Result<(), Error> {
        if !path_segment(id) {
            return Err(Error::InvalidUrl);
        }
        self.empty_input(
            Method::POST,
            &format!("/api/v1/admin/users/{id}/delete"),
            Some(input),
        )
        .await
    }
    /// Signs in as a bot with one of its keys (RFC 0003); nothing is renewed.
    pub fn with_bot_key(&mut self, key: String) -> Result<(), Error> {
        if !rv_protocol::bots::is_key(&key) {
            return Err(Error::SessionMissing);
        }
        self.update_token(key);
        Ok(())
    }
    /// The routes a key may call, by scope, as the server enforces them.
    pub async fn bot_reference(&self) -> Result<rv_protocol::bots::BotReference, Error> {
        self.get("/api/v1/bots/reference").await
    }
    /// My bots, or every bot with `all` for an administrator.
    pub async fn bots(&self, all: bool) -> Result<rv_protocol::bots::BotList, Error> {
        self.get(if all {
            "/api/v1/bots?all=true"
        } else {
            "/api/v1/bots"
        })
        .await
    }
    pub async fn create_bot(
        &self,
        input: &rv_protocol::bots::CreateBot,
    ) -> Result<rv_protocol::bots::Bot, Error> {
        self.post("/api/v1/bots", input).await
    }
    pub async fn update_bot(
        &self,
        id: &str,
        input: &rv_protocol::bots::UpdateBot,
    ) -> Result<rv_protocol::bots::Bot, Error> {
        if !path_segment(id) {
            return Err(Error::InvalidUrl);
        }
        self.request(
            Method::PATCH,
            &format!("/api/v1/bots/{id}"),
            Some(input),
            false,
        )
        .await
    }
    /// Sets (PNG or JPEG) or, with `None`, removes the bot's photo.
    pub async fn set_bot_avatar(
        &self,
        id: &str,
        upload: Option<(&str, Vec<u8>)>,
    ) -> Result<rv_protocol::bots::Bot, Error> {
        if !path_segment(id) {
            return Err(Error::InvalidUrl);
        }
        self.check_cooldown(Some("profile"))?;
        let sent = self.saved_token().ok_or(Error::SessionMissing)?;
        let method = if upload.is_some() {
            Method::PUT
        } else {
            Method::DELETE
        };
        let mut request = self
            .http
            .request(method, format!("{}/api/v1/bots/{id}/avatar", self.base))
            .bearer_auth(&sent);
        if let Some((mime, bytes)) = upload {
            if bytes.len() > rv_protocol::bots::AVATAR_BYTES {
                return Err(Error::InvalidAvatar);
            }
            request = request
                .header(reqwest::header::CONTENT_TYPE, mime)
                .body(bytes);
        }
        let response = self
            .accepted(request.send().await?, Some("profile"), Some(sent))
            .await?;
        Ok(response.json().await?)
    }
    /// Tombstones the bot and revokes its keys; repeating it is harmless.
    pub async fn delete_bot(&self, id: &str) -> Result<(), Error> {
        if !path_segment(id) {
            return Err(Error::InvalidUrl);
        }
        self.empty(Method::DELETE, &format!("/api/v1/bots/{id}"), false)
            .await
    }
    pub async fn bot_keys(&self, id: &str) -> Result<rv_protocol::bots::BotKeyList, Error> {
        if !path_segment(id) {
            return Err(Error::InvalidUrl);
        }
        self.get(&format!("/api/v1/bots/{id}/keys")).await
    }
    /// The only answer that carries the key. Needs a recent sign-in.
    pub async fn create_bot_key(
        &self,
        id: &str,
        input: &rv_protocol::bots::CreateBotKey,
    ) -> Result<rv_protocol::bots::BotKeyCreated, Error> {
        if !path_segment(id) {
            return Err(Error::InvalidUrl);
        }
        self.post(&format!("/api/v1/bots/{id}/keys"), input).await
    }
    pub async fn revoke_bot_key(&self, id: &str, key: &str) -> Result<(), Error> {
        if !path_segment(id) || !path_segment(key) {
            return Err(Error::InvalidUrl);
        }
        self.empty(
            Method::DELETE,
            &format!("/api/v1/bots/{id}/keys/{key}"),
            false,
        )
        .await
    }
    /// My workflows, or every workflow with `all` for an administrator.
    pub async fn workflows(
        &self,
        all: bool,
    ) -> Result<rv_protocol::workflows::WorkflowList, Error> {
        self.get(if all {
            "/api/v1/workflows?all=true"
        } else {
            "/api/v1/workflows"
        })
        .await
    }
    pub async fn workflow(&self, id: &str) -> Result<rv_protocol::workflows::Workflow, Error> {
        if !path_segment(id) {
            return Err(Error::InvalidUrl);
        }
        self.get(&format!("/api/v1/workflows/{id}")).await
    }
    pub async fn create_workflow(
        &self,
        input: &rv_protocol::workflows::CreateWorkflow,
    ) -> Result<rv_protocol::workflows::Workflow, Error> {
        self.post("/api/v1/workflows", input).await
    }
    pub async fn update_workflow(
        &self,
        id: &str,
        input: &rv_protocol::workflows::UpdateWorkflow,
    ) -> Result<rv_protocol::workflows::Workflow, Error> {
        if !path_segment(id) {
            return Err(Error::InvalidUrl);
        }
        self.request(
            Method::PUT,
            &format!("/api/v1/workflows/{id}"),
            Some(input),
            false,
        )
        .await
    }
    pub async fn delete_workflow(&self, id: &str) -> Result<(), Error> {
        if !path_segment(id) {
            return Err(Error::InvalidUrl);
        }
        self.empty(Method::DELETE, &format!("/api/v1/workflows/{id}"), false)
            .await
    }
    /// Owner or administrator: stops it and its unfinished runs.
    pub async fn disable_workflow(
        &self,
        id: &str,
    ) -> Result<rv_protocol::workflows::Workflow, Error> {
        if !path_segment(id) {
            return Err(Error::InvalidUrl);
        }
        self.post(&format!("/api/v1/workflows/{id}/disable"), &())
            .await
    }
    /// A new webhook secret, the only answer that carries it.
    pub async fn workflow_webhook(
        &self,
        id: &str,
    ) -> Result<rv_protocol::workflows::WebhookSecret, Error> {
        if !path_segment(id) {
            return Err(Error::InvalidUrl);
        }
        self.post(&format!("/api/v1/workflows/{id}/webhook"), &())
            .await
    }
    pub async fn workflow_runs(
        &self,
        id: &str,
    ) -> Result<rv_protocol::workflows::WorkflowRunList, Error> {
        if !path_segment(id) {
            return Err(Error::InvalidUrl);
        }
        self.get(&format!("/api/v1/workflows/{id}/runs")).await
    }
    pub async fn test_workflow(
        &self,
        id: &str,
    ) -> Result<rv_protocol::workflows::RunStarted, Error> {
        if !path_segment(id) {
            return Err(Error::InvalidUrl);
        }
        self.post(&format!("/api/v1/workflows/{id}/test"), &())
            .await
    }
    /// Answers a form a workflow posted in a message.
    pub async fn answer_form(
        &self,
        message: &str,
        input: &rv_protocol::workflows::AnswerForm,
    ) -> Result<(), Error> {
        if !path_segment(message) {
            return Err(Error::InvalidUrl);
        }
        self.empty_input(
            Method::POST,
            &format!("/api/v1/forms/{message}/answer"),
            Some(input),
        )
        .await
    }
    /// Adds a custom emoji (raw PNG, JPEG or GIF); answers the new catalogue.
    pub async fn admin_create_emoji(
        &self,
        name: &str,
        input: &rv_protocol::custom_emojis::CreateEmoji,
        image: Vec<u8>,
    ) -> Result<rv_protocol::custom_emojis::EmojiCatalog, Error> {
        if image.len() > 1024 * 1024 {
            return Err(Error::InvalidEmoji);
        }
        let sent = self.saved_token().ok_or(Error::SessionMissing)?;
        let path = format!(
            "/api/v1/admin/emoji/{}?operation_id={}&aliases={}",
            encode(name),
            encode(&input.operation_id),
            encode(&input.aliases)
        );
        let request = self
            .http
            .put(format!("{}{path}", self.base))
            .bearer_auth(&sent)
            .header(reqwest::header::CONTENT_TYPE, "application/octet-stream")
            .body(image);
        let response = self
            .accepted(request.send().await?, None, Some(sent))
            .await?;
        Ok(response.json().await?)
    }
    pub async fn admin_remove_emoji(
        &self,
        name: &str,
        input: &rv_protocol::custom_emojis::RemoveEmoji,
    ) -> Result<rv_protocol::custom_emojis::EmojiCatalog, Error> {
        let path = format!(
            "/api/v1/admin/emoji/{}?operation_id={}&expected_revision={}",
            encode(name),
            encode(&input.operation_id),
            encode(&input.expected_revision)
        );
        self.request(Method::DELETE, &path, None::<&()>, false)
            .await
    }
    pub async fn instance_settings(&self) -> Result<rv_protocol::bots::InstanceSettings, Error> {
        self.get("/api/v1/admin/settings").await
    }
    pub async fn update_instance_settings(
        &self,
        input: &rv_protocol::bots::UpdateInstanceSettings,
    ) -> Result<rv_protocol::bots::InstanceSettings, Error> {
        self.request(Method::PATCH, "/api/v1/admin/settings", Some(input), false)
            .await
    }
    /// Every room, direct conversations included; metadata and counts only.
    pub async fn admin_rooms(
        &self,
        after: Option<&str>,
        limit: Option<u32>,
        q: Option<&str>,
    ) -> Result<rv_protocol::admin::AdminRoomPage, Error> {
        self.get(&self.admin_page("/api/v1/admin/rooms", after, limit, q)?)
            .await
    }
    pub async fn admin_reported_messages(
        &self,
        after: Option<&str>,
        limit: Option<u32>,
    ) -> Result<rv_protocol::admin::AdminReportedMessagePage, Error> {
        self.get(&self.admin_page("/api/v1/admin/reports/messages", after, limit, None)?)
            .await
    }
    pub async fn admin_reported_users(
        &self,
        after: Option<&str>,
        limit: Option<u32>,
    ) -> Result<rv_protocol::admin::AdminReportedUserPage, Error> {
        self.get(&self.admin_page("/api/v1/admin/reports/users", after, limit, None)?)
            .await
    }
    pub async fn dismiss_message_reports(
        &self,
        message: &str,
        input: &rv_protocol::admin::AdminOperation,
    ) -> Result<(), Error> {
        self.admin_resolution(&format!("messages/{message}/dismiss"), message, input)
            .await
    }
    /// Tombstones a reported message and closes its reports.
    pub async fn delete_reported_message(
        &self,
        message: &str,
        input: &rv_protocol::admin::AdminOperation,
    ) -> Result<(), Error> {
        self.admin_resolution(&format!("messages/{message}/delete"), message, input)
            .await
    }
    pub async fn dismiss_user_reports(
        &self,
        user: &str,
        input: &rv_protocol::admin::AdminOperation,
    ) -> Result<(), Error> {
        self.admin_resolution(&format!("users/{user}/dismiss"), user, input)
            .await
    }
    async fn admin_resolution(
        &self,
        route: &str,
        subject: &str,
        input: &rv_protocol::admin::AdminOperation,
    ) -> Result<(), Error> {
        if !path_segment(subject) {
            return Err(Error::InvalidUrl);
        }
        self.empty_input(
            Method::POST,
            &format!("/api/v1/admin/reports/{route}"),
            Some(input),
        )
        .await
    }
    /// Reports a message of a room I can read to the administrators.
    pub async fn report_message(
        &self,
        message: &str,
        input: &rv_protocol::admin::ReportInput,
    ) -> Result<(), Error> {
        if !path_segment(message) {
            return Err(Error::InvalidUrl);
        }
        self.empty_input(
            Method::POST,
            &format!("/api/v1/messages/{message}/report"),
            Some(input),
        )
        .await
    }
    pub async fn report_user(
        &self,
        user: &str,
        input: &rv_protocol::admin::ReportInput,
    ) -> Result<(), Error> {
        if !path_segment(user) {
            return Err(Error::InvalidUrl);
        }
        self.empty_input(
            Method::POST,
            &format!("/api/v1/users/{user}/report"),
            Some(input),
        )
        .await
    }
    fn admin_page(
        &self,
        path: &str,
        after: Option<&str>,
        limit: Option<u32>,
        q: Option<&str>,
    ) -> Result<String, Error> {
        // Cursors are opaque: hexadecimal sort keys or report IDs, never a path.
        let cursor = |s: &str| {
            !s.is_empty()
                && s.len() <= 1100
                && s.bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
        };
        if after.is_some_and(|s| !cursor(s)) || limit.is_some_and(|n| !(1..=100).contains(&n)) {
            return Err(Error::InvalidUrl);
        }
        let mut url = Url::parse(&format!("{}{path}", self.base)).map_err(|_| Error::InvalidUrl)?;
        if let Some(after) = after {
            url.query_pairs_mut().append_pair("after", after);
        }
        if let Some(limit) = limit {
            url.query_pairs_mut()
                .append_pair("limit", &limit.to_string());
        }
        if let Some(q) = q.filter(|q| !q.trim().is_empty()) {
            url.query_pairs_mut().append_pair("q", q);
        }
        url.as_str()
            .strip_prefix(&self.base)
            .map(str::to_owned)
            .ok_or(Error::InvalidUrl)
    }
    pub async fn logout(&self) -> Result<(), Error> {
        self.empty(Method::POST, "/api/v1/auth/logout", true).await
    }
    async fn empty(&self, method: Method, path: &str, body: bool) -> Result<(), Error> {
        self.empty_input(method, path, body.then_some(&())).await
    }
    async fn empty_input(
        &self,
        method: Method,
        path: &str,
        input: Option<&impl Serialize>,
    ) -> Result<(), Error> {
        let sent = self.saved_token().ok_or(Error::SessionMissing)?;
        let mut request = self
            .http
            .request(method, format!("{}{path}", self.base))
            .bearer_auth(&sent);
        if let Some(input) = input {
            request = request.json(input);
        }
        let response = request.send().await?;
        if !response.status().is_success() {
            let status = response.status().as_u16();
            let retry = retry_after(&response);
            let error: ApiError = response.json().await?;
            if status == 401
                && error.code == "session_rejected"
                && self.saved_token().as_deref() != Some(sent.as_str())
            {
                return Err(Error::Server {
                    status: 409,
                    code: "delivery_revalidate".into(),
                    request_id: Some(error.request_id),
                    retry_after: None,
                });
            }
            return Err(Error::Server {
                status,
                code: error.code,
                request_id: Some(error.request_id),
                retry_after: retry,
            });
        }
        Ok(())
    }
    pub async fn rooms(&self) -> Result<Vec<Room>, Error> {
        self.get("/api/v1/rooms").await
    }
    pub async fn create_room(&self, input: &CreateRoom) -> Result<Room, Error> {
        self.post("/api/v1/rooms", input).await
    }
    pub async fn public_rooms(
        &self,
        query: &str,
        after: Option<&str>,
    ) -> Result<rv_protocol::PublicRoomPage, Error> {
        let mut url = Url::parse(&format!("{}/api/v1/rooms/public", self.base))
            .map_err(|_| Error::InvalidUrl)?;
        url.query_pairs_mut().append_pair("q", query);
        if let Some(after) = after {
            url.query_pairs_mut().append_pair("after", after);
        }
        self.get(&format!("{}?{}", url.path(), url.query().unwrap_or("")))
            .await
    }
    pub async fn join_public(&self, room: &str) -> Result<Room, Error> {
        if !path_segment(room) {
            return Err(Error::InvalidUrl);
        }
        self.post(&format!("/api/v1/rooms/{room}/join"), &()).await
    }
    pub async fn direct(&self, user_id: &str) -> Result<Room, Error> {
        self.post(
            "/api/v1/direct-messages",
            &DirectMessage {
                user_id: user_id.into(),
            },
        )
        .await
    }
    pub async fn send(&self, room: &str, input: &SendMessage) -> Result<Message, Error> {
        if !path_segment(room) {
            return Err(Error::InvalidUrl);
        }
        self.post(&format!("/api/v1/rooms/{room}/messages"), input)
            .await
    }
    pub async fn history(&self, room: &str, before: Option<&str>) -> Result<MessagePage, Error> {
        if !path_segment(room)
            || before.is_some_and(|p| p.is_empty() || !p.bytes().all(|b| b.is_ascii_digit()))
        {
            return Err(Error::InvalidUrl);
        }
        self.get(&format!(
            "/api/v1/rooms/{room}/messages{}",
            before.map(|p| format!("?before={p}")).unwrap_or_default()
        ))
        .await
    }
    pub async fn search_messages(
        &self,
        room: &str,
        query: &str,
        before: Option<&str>,
    ) -> Result<rv_protocol::search::SearchPage, Error> {
        if !path_segment(room) {
            return Err(Error::InvalidUrl);
        }
        let mut url = Url::parse(&format!(
            "{}/api/v1/rooms/{room}/messages/search",
            self.base
        ))
        .map_err(|_| Error::InvalidUrl)?;
        url.query_pairs_mut().append_pair("q", query);
        if let Some(before) = before {
            url.query_pairs_mut().append_pair("before", before);
        }
        self.get(&format!("{}?{}", url.path(), url.query().unwrap_or("")))
            .await
    }
    pub async fn thread(
        &self,
        root: &str,
        before: Option<&str>,
    ) -> Result<rv_protocol::ThreadPage, Error> {
        if !path_segment(root)
            || before.is_some_and(|p| p.is_empty() || !p.bytes().all(|b| b.is_ascii_digit()))
        {
            return Err(Error::InvalidUrl);
        }
        self.get(&format!(
            "/api/v1/messages/{root}/thread{}",
            before.map(|p| format!("?before={p}")).unwrap_or_default()
        ))
        .await
    }
    pub async fn mark_thread_read(
        &self,
        root: &str,
        input: &rv_protocol::MarkThreadRead,
    ) -> Result<rv_protocol::ThreadReadState, Error> {
        if !path_segment(root) {
            return Err(Error::InvalidUrl);
        }
        self.post(&format!("/api/v1/messages/{root}/thread/read"), input)
            .await
    }
    pub async fn snapshot(&self) -> Result<Snapshot, Error> {
        if self.saved_token().is_none() {
            return Err(Error::SessionMissing);
        }
        let mut paging = *self.snapshot_paging.lock().expect("native discovery lock");
        if paging.is_none() {
            paging = Some(self.discover().await?.capabilities.snapshot_paging);
        }
        if paging != Some(true) {
            return self.get("/api/v1/sync/snapshot").await;
        }
        let started = Instant::now();
        let mut page: SnapshotPage = self.post("/api/v1/sync/snapshots", &()).await?;
        let id = page.snapshot_id.clone();
        let mut snapshot = Snapshot {
            protocol_version: rv_protocol::VERSION,
            rooms: Vec::new(),
            messages: Vec::new(),
            cursor: String::new(),
        };
        let mut total = 0;
        let mut room_ids = std::collections::HashSet::new();
        let mut message_ids = std::collections::HashSet::new();
        let mut tokens = std::collections::HashSet::new();
        for index in 0..128 {
            let bytes = serde_json::to_vec(&page)
                .map_err(|_| Error::InvalidSnapshot)?
                .len();
            total += bytes;
            if page.protocol_version != rv_protocol::VERSION
                || page.snapshot_id != id
                || id.is_empty()
                || page.page_index != index
                || bytes > 1024 * 1024
                || total > 64 * 1024 * 1024
                || started.elapsed() > Duration::from_secs(300)
                || page.rooms.iter().any(|r| !room_ids.insert(r.id.clone()))
                || page
                    .messages
                    .iter()
                    .any(|m| !message_ids.insert(m.id.clone()))
            {
                return Err(Error::InvalidSnapshot);
            }
            snapshot.rooms.extend(page.rooms);
            snapshot.messages.extend(page.messages);
            match (page.next, page.cursor) {
                (None, Some(cursor)) if !cursor.is_empty() => {
                    if snapshot
                        .messages
                        .iter()
                        .any(|m| !room_ids.contains(&m.room_id))
                    {
                        return Err(Error::InvalidSnapshot);
                    }
                    snapshot.cursor = cursor;
                    return Ok(snapshot);
                }
                (Some(next), None) if path_segment(&next) && tokens.insert(next.clone()) => {
                    page = self.get(&format!("/api/v1/sync/snapshots/{next}")).await?;
                }
                _ => return Err(Error::InvalidSnapshot),
            }
        }
        Err(Error::InvalidSnapshot)
    }
    pub async fn changes(&self, cursor: &str) -> Result<SyncBatch, Error> {
        if !path_segment(cursor) {
            return Err(Error::InvalidUrl);
        }
        self.get(&format!("/api/v1/sync/changes?cursor={cursor}"))
            .await
    }
    pub async fn socket_url(&self, cursor: &str) -> Result<Url, Error> {
        if !path_segment(cursor) {
            return Err(Error::InvalidUrl);
        }
        let ticket: SocketTicket = self.post("/api/v1/sync/ticket", &()).await?;
        let mut url = Url::parse(&format!("{}/api/v1/sync/socket", self.base))
            .map_err(|_| Error::InvalidUrl)?;
        let scheme = if url.scheme() == "https" { "wss" } else { "ws" };
        url.set_scheme(scheme).map_err(|_| Error::InvalidUrl)?;
        url.query_pairs_mut()
            .append_pair("ticket", &ticket.ticket)
            .append_pair("cursor", cursor);
        Ok(url)
    }
    pub async fn live_socket_url(&self, cursor: &str) -> Result<Url, Error> {
        let mut url = self.socket_url(cursor).await?;
        url.query_pairs_mut().append_pair("live", "true");
        Ok(url)
    }
    pub async fn live_state(&self) -> Result<rv_protocol::live::LiveFrame, Error> {
        self.get("/api/v1/live").await
    }
    pub async fn set_presence(
        &self,
        status: rv_protocol::live::PresenceStatus,
    ) -> Result<(), Error> {
        self.request(
            Method::PUT,
            "/api/v1/me/presence",
            Some(&rv_protocol::live::SetPresence { status }),
            false,
        )
        .await
    }
    pub async fn set_typing(
        &self,
        room: &str,
        input: &rv_protocol::live::SetTyping,
    ) -> Result<(), Error> {
        if !path_segment(room) {
            return Err(Error::InvalidUrl);
        }
        self.request(
            Method::PUT,
            &format!("/api/v1/rooms/{room}/typing"),
            Some(input),
            false,
        )
        .await
    }
}

fn encode(value: &str) -> String {
    url::form_urlencoded::byte_serialize(value.as_bytes()).collect()
}

fn path_segment(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
}

#[cfg(test)]
mod crypto_tests;
