//! Native HTTP transport, ready to be integrated into the desktop provider.
//! No GTK, SQLite, account keychain, or Rocket.Chat dependencies.

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
        let mut response = request.send().await?;
        if !response.status().is_success() {
            let status = response.status().as_u16();
            let retry = retry_after(&response);
            let error: ApiError = response.json().await?;
            if status == 401
                && error.code == "session_rejected"
                && sent.is_some()
                && sent != self.saved_token()
            {
                return Err(Error::Server {
                    status: 409,
                    code: "delivery_revalidate".into(),
                    request_id: Some(error.request_id),
                    retry_after: None,
                });
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
            return Err(Error::Server {
                status,
                code: error.code,
                request_id: Some(error.request_id),
                retry_after: retry,
            });
        }
        if path == "/api/v1/sync/snapshots" || path.starts_with("/api/v1/sync/snapshots/") {
            // Refuse oversized wire bodies before allocating/decoding a page,
            // including whitespace and chunked responses without Content-Length.
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

    fn budget(path: &str, method: &Method) -> Option<&'static str> {
        match path {
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
}

fn path_segment(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
}
