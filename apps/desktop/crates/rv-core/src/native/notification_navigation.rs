//! The latest explicit OS click, durable before account resume. A reservation
//! fences slow keyring callbacks; acknowledgement never removes a newer click.
use super::{Error, NativeSession, SessionInfo, notifications, store};
use crate::notify::Incoming;
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Navigation {
    pub id: String,
    pub key: String,
    pub message: String,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Destination {
    version: u8,
    key: String,
    message: String,
    room: String,
    root: Option<String>,
    membership: String,
    position: String,
}

#[derive(Clone)]
pub struct NavigationQueue {
    path: PathBuf,
}

impl NavigationQueue {
    pub fn new(config: &Path) -> Self {
        Self { path: config.join("notification-navigation.sqlite") }
    }

    fn open(&self) -> Result<Connection, Error> {
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent).map_err(|_| Error::Protocol("delivery_revalidate"))?;
        }
        let conn = Connection::open(&self.path)?;
        conn.busy_timeout(std::time::Duration::from_secs(2))?;
        conn.execute_batch("CREATE TABLE IF NOT EXISTS navigation(singleton INTEGER PRIMARY KEY CHECK(singleton=1),request TEXT NOT NULL,payload TEXT)")?;
        Ok(conn)
    }

    /// Reserve synchronously, before any credentials await. A late capture of
    /// an older action can only update its own reservation, never a new one.
    pub fn begin(&self) -> Result<String, Error> {
        let id = format!("{:032x}", fastrand::u128(..));
        self.open()?.execute("INSERT INTO navigation VALUES(1,?1,NULL) ON CONFLICT(singleton) DO UPDATE SET request=excluded.request,payload=NULL", [&id])?;
        Ok(id)
    }

    pub fn cancel(&self) -> Result<(), Error> {
        if self.path.exists() {
            self.open()?.execute("DELETE FROM navigation", [])?;
        }
        Ok(())
    }

    pub fn clear(&self, id: &str) -> Result<bool, Error> {
        if !self.path.exists() {
            return Ok(false);
        }
        Ok(self.open()?.execute("DELETE FROM navigation WHERE request=?1", [id])? == 1)
    }

    fn record(&self) -> Result<Option<(Navigation, Destination)>, Error> {
        if !self.path.exists() {
            return Ok(None);
        }
        let row = self.open()?.query_row("SELECT request,CASE WHEN length(payload)<=8192 THEN payload ELSE '' END FROM navigation WHERE payload IS NOT NULL", [], |r| Ok((r.get::<_,String>(0)?, r.get::<_,String>(1)?))).optional()?;
        let Some((id, payload)) = row else { return Ok(None) };
        let destination: Destination =
            serde_json::from_str(&payload).map_err(|_| Error::Protocol("delivery_revalidate"))?;
        let identifier = |s: &str| {
            !s.is_empty() && s.len() <= 128 && s.bytes().all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
        };
        if id.len() != 32
            || !id.bytes().all(|b| b.is_ascii_hexdigit())
            || destination.version != 1
            || !identifier(&destination.room)
            || !identifier(&destination.membership)
            || destination.root.as_deref().is_some_and(|r| !identifier(r))
            || destination.position.is_empty()
            || !destination.position.bytes().all(|b| b.is_ascii_digit())
            || destination.position.parse::<u128>().is_err()
            || notifications::notification_url(&destination.key, &destination.message).is_none()
            || !destination.key.ends_with(&format!(":{}", destination.room))
        {
            return Err(Error::Protocol("delivery_revalidate"));
        }
        Ok(Some((Navigation { id, key: destination.key.clone(), message: destination.message.clone() }, destination)))
    }

    pub fn pending(&self) -> Result<Option<Navigation>, Error> {
        Ok(self.record()?.map(|(navigation, _)| navigation))
    }

    pub fn current(&self, id: &str) -> Result<bool, Error> {
        Ok(self.pending()?.is_some_and(|n| n.id == id))
    }

    pub fn capture_saved(
        &self,
        id: &str,
        info: &SessionInfo,
        path: &Path,
        key: &str,
        message: &str,
    ) -> Result<bool, Error> {
        if !path.exists() {
            return Err(Error::Protocol("delivery_revalidate"));
        }
        let identity = info.native.clone().ok_or(Error::Protocol("delivery_revalidate"))?;
        self.capture(id, info, &store::NativeStore::open(path, identity)?, key, message)
    }

    pub fn capture(
        &self,
        id: &str,
        info: &SessionInfo,
        cache: &store::NativeStore,
        key: &str,
        message: &str,
    ) -> Result<bool, Error> {
        let n = cache.remembered_notification(message)?.ok_or(Error::Protocol("delivery_revalidate"))?;
        let identity = info.native.as_ref().ok_or(Error::Protocol("delivery_revalidate"))?;
        if notifications::notification_key(info, &n.incoming.rid) != key
            || !cache.notification_capturable(&n, identity)?
        {
            return Err(Error::Protocol("delivery_revalidate"));
        }
        let destination = Destination {
            version: 1,
            key: key.into(),
            message: n.incoming.id,
            room: n.incoming.rid,
            root: n.reply_to,
            membership: n.membership,
            position: n.position,
        };
        let payload = serde_json::to_string(&destination).map_err(|_| Error::Protocol("delivery_revalidate"))?;
        Ok(self.open()?.execute("UPDATE navigation SET payload=?2 WHERE request=?1", params![id, payload])? == 1)
    }
}

impl NativeSession {
    /// Keep captured membership even after the OS toast / ledger is withdrawn.
    /// Transient failures keep the destination; permanent refusal retires only
    /// this request. The UI acknowledges after opening, not before HTTP.
    pub async fn resolve_notification_navigation(
        &self,
        queue: &NavigationQueue,
        id: &str,
    ) -> Result<crate::links::RoomLink, Error> {
        let (navigation, destination) =
            queue.record()?.filter(|(n, _)| n.id == id).ok_or(Error::Protocol("delivery_revalidate"))?;
        if self.notification_key(&destination.room) != navigation.key {
            return Err(Error::Protocol("delivery_revalidate"));
        }
        let projection = self.store.projection_token();
        let result = if self.is_closed() || self.status().error.as_deref() == Some("server_identity_changed") {
            Err(Error::Protocol("session_rejected"))
        } else {
            let target = store::Notification {
                incoming: Incoming {
                    id: destination.message,
                    rid: destination.room,
                    author: String::new(),
                    room_name: String::new(),
                    body: None,
                    direct: false,
                    mentions_me: false,
                    ..Default::default()
                },
                reply_to: destination.root,
                membership: destination.membership,
                position: destination.position,
            };
            self.resolve_notification_record(&target).await
        };
        if let Err(error) = &result
            && (error.terminal()
                || super::permanent_command_error(error)
                || matches!(error, Error::Protocol("message_deleted" | "invalid_link"))
                || matches!(error, Error::Protocol("delivery_revalidate"))
                    && projection == self.store.projection_token())
        {
            queue.clear(id)?;
        }
        if result.is_ok() && !queue.current(id)? {
            return Err(Error::Protocol("delivery_revalidate"));
        }
        result
    }
}
