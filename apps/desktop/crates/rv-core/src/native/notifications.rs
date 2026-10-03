use super::*;
use crate::notify::{Incoming, wanted};

/// Stable OS scope; usable before starting a session, without exposing a bearer.
pub fn notification_key(info: &SessionInfo, rid: &str) -> String {
    use sha2::{Digest, Sha256};
    let scope = serde_json::to_vec(&(&info.base_url, &info.user_id, &info.native)).unwrap();
    let hash = Sha256::digest(scope).iter().map(|b| format!("{b:02x}")).collect::<String>();
    format!("rv-native:{hash}:{rid}")
}
pub fn notification_account(key: &str, accounts: &[SessionInfo]) -> Option<usize> {
    let rid = key.strip_prefix("rv-native:")?.split_once(':')?.1;
    if rid.is_empty() || rid.len() > 128 || !rid.bytes().all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b)) {
        return None;
    }
    let mut matches =
        accounts.iter().enumerate().filter(|(_, s)| s.native.is_some() && notification_key(s, rid) == key);
    let index = matches.next()?.0;
    matches.next().is_none().then_some(index)
}
pub fn notification_url(key: &str, message: &str) -> Option<String> {
    let mut url = url::Url::parse("rocketvibe://notification").ok()?;
    url.query_pairs_mut().append_pair("key", key).append_pair("msg", message);
    parse_notification_url(url.as_str()).map(|_| url.into())
}
pub fn parse_notification_url(value: &str) -> Option<(String, String)> {
    if value.len() > 8192 {
        return None;
    }
    let url = url::Url::parse(value).ok()?;
    if url.scheme() != "rocketvibe"
        || url.host_str() != Some("notification")
        || !url.path().is_empty()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
        || url.fragment().is_some()
    {
        return None;
    }
    let mut key = None;
    let mut message = None;
    for (name, value) in url.query_pairs() {
        match name.as_ref() {
            "key" if key.is_none() => key = Some(value.into_owned()),
            "msg" if message.is_none() => message = Some(value.into_owned()),
            _ => return None,
        }
    }
    let (key, message) = (key?, message?);
    let (hash, rid) = key.strip_prefix("rv-native:")?.split_once(':')?;
    let id =
        |s: &str| !s.is_empty() && s.len() <= 128 && s.bytes().all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b));
    if hash.len() != 64
        || !hash.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        || !id(rid)
        || !id(&message)
    {
        return None;
    }
    Some((key, message))
}

/// Persist a cold response before resuming its account or making HTTP calls.
/// The SQLite cache contains the captured target; no bearer enters this queue.
pub fn save_notification_reply(
    info: &SessionInfo,
    path: &std::path::Path,
    key: &str,
    message: &str,
    text: &str,
) -> Result<String, Error> {
    let identity = info.native.clone().ok_or(Error::Protocol("delivery_revalidate"))?;
    if !path.exists() {
        return Err(Error::Protocol("delivery_revalidate"));
    }
    enqueue_reply(&store::NativeStore::open(path, identity)?, info, key, message, text)
}

fn enqueue_reply(
    store: &store::NativeStore,
    info: &SessionInfo,
    key: &str,
    message: &str,
    text: &str,
) -> Result<String, Error> {
    let text = text.trim();
    if text.is_empty() || text.len() > 32768 {
        return Err(Error::Protocol("invalid_message"));
    }
    let n = store.remembered_notification(message)?.ok_or(Error::Protocol("delivery_revalidate"))?;
    if notification_key(info, &n.incoming.rid) != key {
        return Err(Error::Protocol("delivery_revalidate"));
    }
    store.enqueue_notification_reply(&n, text, &info.username)?.ok_or(Error::Protocol("delivery_revalidate"))
}

impl NativeSession {
    pub fn incoming(&self) -> broadcast::Receiver<Incoming> {
        self.incoming.subscribe()
    }

    pub(super) async fn refresh_notification_settings(&self) -> Result<(), Error> {
        // A transient settings failure keeps chat usable, with no notifications
        // until the first preference is known. Retry once a minute, not per message.
        let Ok(own) = self.client.own_profile().await else { return Ok(()) };
        if own.profile.user.id != self.info.user_id {
            return Err(Error::Protocol("session_rejected"));
        }
        self.identity().await?;
        self.update_notification_preference(&own);
        Ok(())
    }

    pub(super) fn update_notification_preference(&self, own: &rv_protocol::profiles::OwnProfile) {
        let choice = serde_json::to_value(own.preferences.desktop_notifications).unwrap();
        let mut current = self.notification_preference.lock().unwrap();
        let changed = current.as_str() != choice.as_str().unwrap();
        if changed {
            *current = choice.as_str().unwrap().into();
        }
        if !self.notification_settings_known.swap(true, Ordering::SeqCst) || changed {
            let _ = self.events.send(());
        }
    }

    pub(super) fn publish_notifications(&self, notifications: Vec<store::Notification>) {
        let preference = self.notification_preference.lock().unwrap().clone();
        for n in notifications {
            if self.is_closed() || !wanted(&preference, &n.incoming) {
                continue;
            }
            if self.store.remember_notification(&n).unwrap_or(false) {
                let _ = self.incoming.send(n.incoming);
            }
        }
    }

    /// OS targets carry a scope key, never a bearer. Another account / restored
    /// epoch cannot interpret an old platform callback as its own room.
    pub fn notification_key(&self, rid: &str) -> String {
        notification_key(&self.info, rid)
    }
    pub fn notification_current(&self, incoming: &Incoming) -> bool {
        if self.is_closed() || !wanted(&self.notification_preference.lock().unwrap(), incoming) {
            return false;
        }
        self.store
            .remembered_notification(&incoming.id)
            .ok()
            .flatten()
            .is_some_and(|n| n.incoming.rid == incoming.rid && self.store.notification_valid(&n, true).unwrap_or(false))
    }
    pub fn notification_target(&self, key: &str, id: &str) -> Option<(String, Option<String>)> {
        if self.is_closed() {
            return None;
        }
        let n = self.store.remembered_notification(id).ok()??;
        (self.notification_key(&n.incoming.rid) == key && self.store.notification_valid(&n, false).ok()?)
            .then_some((n.incoming.rid, n.reply_to))
    }
    /// Cold callbacks wait for catch-up, then revalidate against the server. A
    /// replaced membership cannot be converted into a fresh public permalink.
    pub async fn resolve_notification(&self, key: &str, id: &str) -> Result<crate::links::RoomLink, Error> {
        let n = self.store.remembered_notification(id)?.ok_or(Error::Protocol("delivery_revalidate"))?;
        if self.notification_key(&n.incoming.rid) != key {
            return Err(Error::Protocol("delivery_revalidate"));
        }
        self.resolve_notification_record(&n).await
    }
    async fn resolve_notification_record(&self, n: &store::Notification) -> Result<crate::links::RoomLink, Error> {
        self.ready()?;
        if self.store.read_state(&n.incoming.rid)?.and_then(|s| s.membership_version).as_deref() != Some(&n.membership)
        {
            return Err(Error::Protocol("delivery_revalidate"));
        }
        let projection = self.store.projection_token();
        let link = crate::links::RoomLink {
            rid: n.incoming.rid.clone(),
            host: crate::links::service_url(&self.info.base_url),
            native: self.info.native.clone(),
            user_id: Some(self.info.user_id.clone()),
            message: Some(n.incoming.id.clone()),
            root: n.reply_to.clone(),
        };
        let link = self.resolve_room_link(link).await?;
        if let Some(root) = &link.root {
            let message = self.client.message(root).await?;
            if message.room_id != link.rid || message.deleted || message.reply_to.is_some() {
                return Err(Error::Protocol("delivery_revalidate"));
            }
            self.identity().await?;
            self.ready()?;
            if self.store.read_state(&link.rid)?.and_then(|s| s.membership_version).as_deref() != Some(&n.membership)
                || !self.store.ingest_at(&[message], projection)?
            {
                return Err(Error::Protocol("delivery_revalidate"));
            }
        }
        if !self.store.notification_valid(n, false)? || projection != self.store.projection_token() {
            return Err(Error::Protocol("delivery_revalidate"));
        }
        Ok(link)
    }
    pub fn reply_notification(&self, key: &str, id: &str, text: &str) -> Result<String, Error> {
        if self.is_closed() || self.status().error.as_deref() == Some("server_identity_changed") {
            return Err(Error::Protocol("delivery_revalidate"));
        }
        let id = enqueue_reply(&self.store, &self.info, key, id, text)?;
        self.wake.notify_one();
        Ok(id)
    }

    pub(super) async fn flush_notification_replies(&self) -> Result<(), Error> {
        for reply in self.store.pending_notification_replies()? {
            let projection = self.store.projection_token();
            let result = self.deliver_notification_reply(&reply, projection).await;
            if let Err(error) = result {
                let permanent = super::permanent_command_error(&error)
                    || matches!(&error, Error::Protocol("message_deleted" | "invalid_link" | "invalid_message"))
                    || matches!(&error, Error::Protocol("delivery_revalidate"))
                        && projection == self.store.projection_token();
                if permanent {
                    self.store.fail(&reply.pending.id, error.code())?;
                } else {
                    return Err(error);
                }
            }
        }
        Ok(())
    }

    async fn deliver_notification_reply(&self, reply: &store::NotificationReply, projection: u64) -> Result<(), Error> {
        self.ready()?;
        if !self.store.notification_reply_current(reply, projection, false)? {
            return Err(Error::Protocol("delivery_revalidate"));
        }
        // A response lost after commit can be confirmed without trying to reply
        // again to a notification target that has since been deleted.
        if reply.attempted {
            match self.client.message(&reply.pending.id).await {
                Ok(message) => {
                    if message.id != reply.pending.id
                        || message.room_id != reply.pending.room_id
                        || message.author.id != self.info.user_id
                        || message.reply_to != reply.pending.reply_to
                    {
                        return Err(Error::Protocol("invalid_message"));
                    }
                    self.identity().await?;
                    self.ready()?;
                    if !self.store.notification_reply_current(reply, projection, false)?
                        || !self.store.ingest_at(&[message], projection)?
                    {
                        return Err(Error::Protocol("delivery_revalidate"));
                    }
                    return Ok(());
                }
                Err(rv_client::Error::Server { status: 404, .. }) => (),
                Err(error) => return Err(error.into()),
            }
        }
        self.resolve_notification_record(&reply.target).await?;
        self.ready()?;
        if self.store.notification_reply_current(reply, projection, true)? {
            self.deliver_pending(reply.pending.clone()).await?;
        }
        Ok(())
    }
    /// Clear delivered notifications when reads, withdrawal or preference changes
    /// make them obsolete. Later clicks also revalidate their original membership.
    pub fn withdrawn_notifications(&self) -> Vec<String> {
        if self.is_closed() || !self.notification_settings_known.load(Ordering::SeqCst) {
            return vec![];
        }
        let preference = self.notification_preference.lock().unwrap().clone();
        let mut withdrawn = vec![];
        let Ok(remembered) = self.store.remembered_notifications() else { return vec![] };
        let mut retained = vec![];
        for n in &remembered {
            let keep = wanted(&preference, &n.incoming) && self.store.notification_valid(n, true).unwrap_or(false);
            if !keep {
                withdrawn.push(self.notification_key(&n.incoming.rid));
                let _ = self.store.forget_notification(&n.incoming.id);
            } else {
                retained.push(self.notification_key(&n.incoming.rid));
            }
        }
        withdrawn.retain(|key| !retained.contains(key));
        withdrawn.sort();
        withdrawn.dedup();
        withdrawn
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rv_protocol::{Change, Message, Room, Snapshot, SyncBatch};
    use serde_json::json;

    #[tokio::test]
    async fn native_notification_actions_reopen_and_deduplicate_without_crossing_memberships() {
        let f: Value = serde_json::from_str(include_str!("../../../../../../docs/protocol/v1.fixture.json")).unwrap();
        let info = SessionInfo {
            base_url: "http://127.0.0.1:9/native".into(),
            user_id: "bob".into(),
            username: "bob".into(),
            auth_token: "fixture-token".into(),
            native: Some(Identity { instance_id: "fixture-instance".into(), data_epoch: "fixture-epoch".into() }),
        };
        let path = std::env::temp_dir().join(format!("rv-notification-{:032x}.sqlite", fastrand::u128(..)));
        let s = NativeSession::start(info.clone(), &path).unwrap();
        s.suspend();
        let mut room: Room = serde_json::from_value(f["room"].clone()).unwrap();
        room.read_state=Some(Box::new(serde_json::from_value(json!({"room_id":room.id,"membership_version":"original","revision":"1","root_position":"0","reply_position":"0","unread_roots":"0","unread_replies":"0","mentions":"0","group_mentions":"0","favorite":false})).unwrap()));
        s.store
            .snapshot(&Snapshot {
                protocol_version: 1,
                rooms: vec![room.clone()],
                messages: vec![],
                cursor: "initial".into(),
            })
            .unwrap();
        let mut own: rv_protocol::profiles::OwnProfile = serde_json::from_value(f["own_profile"].clone()).unwrap();
        own.preferences.desktop_notifications = rv_protocol::profiles::DesktopNotifications::All;
        s.update_notification_preference(&own);
        let mut root: Message = serde_json::from_value(f["message"].clone()).unwrap();
        root.id = "cold-root".into();
        root.position = "2".into();
        root.revision = "2".into();
        root.personal_mention = Some(true);
        let mut reply = root.clone();
        reply.id = "cold-reply".into();
        reply.position = "3".into();
        reply.revision = "3".into();
        reply.reply_to = Some(root.id.clone());
        let batch = SyncBatch {
            protocol_version: 1,
            changes: vec![Change::MessageUpsert(root), Change::MessageUpsert(reply.clone())],
            cursor: "three".into(),
            has_more: false,
        };
        s.publish_notifications(s.store.batch_notifying(&batch, Some("bob")).unwrap());
        let key = s.notification_key(&room.id);
        let url = notification_url(&key, &reply.id).unwrap();
        assert_eq!(parse_notification_url(&url), Some((key.clone(), reply.id.clone())));
        assert!(parse_notification_url(&(url.clone() + "&msg=other")).is_none());
        assert!(notification_url("rv-native:bad:room", &reply.id).is_none());
        let sent = s.reply_notification(&key, &reply.id, "  same response  ").unwrap();
        s.shutdown();
        drop(s);
        assert_eq!(save_notification_reply(&info, &path, &key, &reply.id, "same response").unwrap(), sent);
        let s = NativeSession::start(info.clone(), &path).unwrap();
        s.suspend();
        // Unknown startup preferences do not erase persisted OS actions.
        assert!(s.withdrawn_notifications().is_empty());
        assert_eq!(s.notification_target(&key, &reply.id), Some((room.id.clone(), Some("cold-root".into()))));
        assert_eq!(s.reply_notification(&key, &reply.id, "same response").unwrap(), sent);
        assert!(s.store.pending().unwrap().is_empty());
        assert_eq!(s.store.pending_notification_replies().unwrap().len(), 1);
        s.retry(&sent).unwrap();
        assert!(s.store.pending().unwrap().is_empty());
        let metadata = s.store.remembered_notifications().unwrap();
        assert!(metadata.iter().all(|n| n.incoming.body.is_none() && n.incoming.author.is_empty()));
        let mut wrong = info.clone();
        wrong.user_id = "alice".into();
        let mut restored = info.clone();
        restored.native.as_mut().unwrap().data_epoch = "restored".into();
        let mut legacy = info.clone();
        legacy.native = None;
        assert_eq!(notification_account(&key, &[wrong, restored, legacy, info.clone()]), Some(3));
        assert_eq!(notification_account(&key, &[info.clone(), info.clone()]), None);
        room.read_state.as_mut().unwrap().membership_version = Some("replacement".into());
        room.read_state.as_mut().unwrap().revision = "10".into();
        s.store
            .batch(&SyncBatch {
                protocol_version: 1,
                changes: vec![Change::RoomUpsert(room)],
                cursor: "replacement".into(),
                has_more: false,
            })
            .unwrap();
        assert!(s.notification_target(&key, &reply.id).is_none());
        assert!(s.reply_notification(&key, &reply.id, "same response").is_err());
        // Reusing room/message/member identifiers in a restored database must
        // not revive the previous epoch's notification ledger.
        let restored = store::NativeStore::open(
            &path,
            Identity { instance_id: "fixture-instance".into(), data_epoch: "restored".into() },
        )
        .unwrap();
        restored
            .snapshot(&Snapshot { protocol_version: 1, rooms: vec![], messages: vec![], cursor: "restored".into() })
            .unwrap();
        assert!(restored.remembered_notifications().unwrap().is_empty());
        drop(restored);
        s.store.clear().unwrap();
        assert!(s.store.remembered_notifications().unwrap().is_empty());
        s.shutdown();
        drop(s);
        let _ = std::fs::remove_file(path);
    }

    #[tokio::test]
    async fn native_preferences_thread_replies_and_account_scope_survive_dispatch() {
        let f: Value = serde_json::from_str(include_str!("../../../../../../docs/protocol/v1.fixture.json")).unwrap();
        let info = SessionInfo {
            base_url: "http://127.0.0.1:9/native".into(),
            user_id: "bob".into(),
            username: "bob".into(),
            auth_token: "fixture-token".into(),
            native: Some(Identity { instance_id: "fixture-instance".into(), data_epoch: "fixture-epoch".into() }),
        };
        let s = NativeSession::start(info, Path::new(":memory:")).unwrap();
        s.suspend();
        let mut room: Room = serde_json::from_value(f["room"].clone()).unwrap();
        room.revision = "1".into();
        room.read_state=Some(Box::new(serde_json::from_value(json!({"room_id":room.id,"membership_version":"grant","revision":"1","root_position":"0","reply_position":"0","unread_roots":"0","unread_replies":"0","mentions":"0","group_mentions":"0","favorite":false})).unwrap()));
        s.store
            .snapshot(&Snapshot {
                protocol_version: 1,
                rooms: vec![room.clone()],
                messages: vec![],
                cursor: "initial".into(),
            })
            .unwrap();
        let mut incoming = s.incoming();
        let mut own: rv_protocol::profiles::OwnProfile = serde_json::from_value(f["own_profile"].clone()).unwrap();
        own.preferences.desktop_notifications = rv_protocol::profiles::DesktopNotifications::All;
        s.update_notification_preference(&own);
        let publish = |id: &str, position: &str, mentioned: bool, root: Option<&str>| {
            let mut m: Message = serde_json::from_value(f["message"].clone()).unwrap();
            m.id = id.into();
            m.position = position.into();
            m.revision = position.into();
            m.personal_mention = Some(mentioned);
            m.reply_to = root.map(str::to_owned);
            let b = SyncBatch {
                protocol_version: 1,
                changes: vec![Change::MessageUpsert(m)],
                cursor: position.into(),
                has_more: false,
            };
            s.publish_notifications(s.store.batch_notifying(&b, Some("bob")).unwrap());
        };
        publish("all", "2", false, None);
        let n = incoming.try_recv().unwrap();
        assert!(s.notification_current(&n));
        own.preferences.desktop_notifications = rv_protocol::profiles::DesktopNotifications::Nothing;
        s.update_notification_preference(&own);
        assert!(!s.notification_current(&n));
        assert_eq!(s.withdrawn_notifications(), vec![s.notification_key(&room.id)]);
        own.preferences.desktop_notifications = rv_protocol::profiles::DesktopNotifications::Mention;
        s.update_notification_preference(&own);
        publish("silent", "3", false, None);
        assert!(incoming.try_recv().is_err());
        publish("root", "4", true, None);
        incoming.try_recv().unwrap();
        publish("reply", "5", true, Some("root"));
        let reply = incoming.try_recv().unwrap();
        let key = s.notification_key(&room.id);
        assert_eq!(s.notification_target(&key, &reply.id).unwrap().1.as_deref(), Some("root"));
        s.reply_notification(&key, &reply.id, "persisted thread response").unwrap();
        assert_eq!(s.store.pending_notification_replies().unwrap()[0].pending.reply_to.as_deref(), Some("root"));
        let mut other = s.info.clone();
        other.native.as_mut().unwrap().data_epoch = "restored".into();
        let other = NativeSession::start(other, Path::new(":memory:")).unwrap();
        other.suspend();
        assert_ne!(key, other.notification_key(&room.id));
        other.shutdown();
        room.read_state.as_mut().unwrap().root_position = "4".into();
        room.read_state.as_mut().unwrap().revision = "6".into();
        s.store
            .batch(&SyncBatch {
                protocol_version: 1,
                changes: vec![Change::RoomUpsert(room.clone())],
                cursor: "read-root".into(),
                has_more: false,
            })
            .unwrap();
        assert!(s.notification_current(&reply));
        room.read_state.as_mut().unwrap().reply_position = "5".into();
        room.read_state.as_mut().unwrap().revision = "7".into();
        s.store
            .batch(&SyncBatch {
                protocol_version: 1,
                changes: vec![Change::RoomUpsert(room)],
                cursor: "read-reply".into(),
                has_more: false,
            })
            .unwrap();
        assert!(!s.notification_current(&reply));
        s.shutdown();
    }
}
