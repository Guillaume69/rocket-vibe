//! Native HTTP transport, ready to be integrated into the desktop provider.
//! No GTK, SQLite, account keychain, or Rocket.Chat dependencies.

use reqwest::Method;
use rv_protocol::{
    ApiError, CreateRoom, DirectMessage, Discovery, Login, Message, MessagePage, Room, SendMessage,
    Session, Snapshot, SocketTicket, SyncBatch, User,
};
use serde::{Serialize, de::DeserializeOwned};
use std::time::Duration;
use url::Url;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("invalid server URL")]
    InvalidUrl,
    #[error("unsupported RocketVibe protocol")]
    UnsupportedProtocol,
    #[error("session missing")]
    SessionMissing,
    #[error("server refused request ({status}): {code}")]
    Server { status: u16, code: String },
    #[error(transparent)]
    Transport(#[from] reqwest::Error),
}

#[derive(Clone)]
pub struct NativeClient {
    base: String,
    http: reqwest::Client,
    token: Option<String>,
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
            token: None,
        })
    }

    async fn request<T: DeserializeOwned>(
        &self,
        method: Method,
        path: &str,
        input: Option<&impl Serialize>,
        anonymous: bool,
    ) -> Result<T, Error> {
        let mut request = self.http.request(method, format!("{}{path}", self.base));
        if !anonymous {
            request = request.bearer_auth(self.token.as_ref().ok_or(Error::SessionMissing)?);
        }
        if let Some(input) = input {
            request = request.json(input);
        }
        let response = request.send().await?;
        if !response.status().is_success() {
            let status = response.status().as_u16();
            let error: ApiError = response.json().await?;
            return Err(Error::Server {
                status,
                code: error.code,
            });
        }
        Ok(response.json().await?)
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
        self.token = Some(session.token.clone());
        Ok(session)
    }

    pub fn restore(&mut self, token: String) {
        self.token = Some(token);
    }
    pub async fn me(&self) -> Result<User, Error> {
        self.get("/api/v1/me").await
    }
    pub async fn rooms(&self) -> Result<Vec<Room>, Error> {
        self.get("/api/v1/rooms").await
    }
    pub async fn create_room(&self, input: &CreateRoom) -> Result<Room, Error> {
        self.post("/api/v1/rooms", input).await
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
        self.get("/api/v1/sync/snapshot").await
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
