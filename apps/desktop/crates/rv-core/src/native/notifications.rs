use super::*;
use crate::notify::{Incoming, wanted};

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
        if current.as_str() != choice.as_str().unwrap() {
            *current = choice.as_str().unwrap().into();
            let _ = self.events.send(());
        }
    }

    pub(super) fn publish_notifications(&self, notifications: Vec<store::Notification>) {
        let preference = self.notification_preference.lock().unwrap().clone();
        for n in notifications {
            if self.is_closed() || !wanted(&preference, &n.incoming) {
                continue;
            }
            let incoming = n.incoming.clone();
            let mut remembered = self.notifications.lock().unwrap();
            remembered.push_back(n);
            while remembered.len() > 256 {
                remembered.pop_front();
            }
            drop(remembered);
            let _ = self.incoming.send(incoming);
        }
    }

    /// OS targets carry a scope key, never a bearer. Another account / restored
    /// epoch cannot interpret an old platform callback as its own room.
    pub fn notification_key(&self, rid: &str) -> String {
        use sha2::{Digest, Sha256};
        let scope = serde_json::to_vec(&(&self.info.base_url, &self.info.user_id, &self.info.native)).unwrap();
        let hash = Sha256::digest(scope);
        let hash = hash.iter().map(|b| format!("{b:02x}")).collect::<String>();
        format!("rv-native:{hash}:{rid}")
    }
    pub fn notification_current(&self, incoming: &Incoming) -> bool {
        if self.is_closed() || !wanted(&self.notification_preference.lock().unwrap(), incoming) {
            return false;
        }
        self.notifications
            .lock()
            .unwrap()
            .iter()
            .find(|n| n.incoming.id == incoming.id && n.incoming.rid == incoming.rid)
            .is_some_and(|n| self.store.notification_valid(n, true).unwrap_or(false))
    }
    pub fn notification_target(&self, key: &str, id: &str) -> Option<(String, Option<String>)> {
        if self.is_closed() {
            return None;
        }
        let remembered = self.notifications.lock().unwrap();
        let n = remembered.iter().find(|n| n.incoming.id == id && self.notification_key(&n.incoming.rid) == key)?;
        self.store.notification_valid(n, false).ok()?.then(|| (n.incoming.rid.clone(), n.reply_to.clone()))
    }
    pub fn reply_notification(&self, key: &str, id: &str, text: &str) -> Result<String, Error> {
        let (rid, root, membership) = {
            let remembered = self.notifications.lock().unwrap();
            let n = remembered
                .iter()
                .find(|n| n.incoming.id == id && self.notification_key(&n.incoming.rid) == key)
                .ok_or(Error::Protocol("delivery_revalidate"))?;
            if self.is_closed() || !self.store.notification_valid(n, false)? {
                return Err(Error::Protocol("delivery_revalidate"));
            }
            (n.incoming.rid.clone(), n.reply_to.clone(), n.membership.clone())
        };
        if let Some(root) = root {
            self.send_reply_from_membership(&rid, &root, text, Some(&membership), &[])
        } else {
            self.send_from_membership(&rid, text, Some(&membership))
        }
    }
    /// Clear delivered notifications when reads, withdrawal or preference changes
    /// make them obsolete. Later clicks also revalidate their original membership.
    pub fn withdrawn_notifications(&self) -> Vec<String> {
        let preference = self.notification_preference.lock().unwrap().clone();
        let mut withdrawn = vec![];
        let mut remembered = self.notifications.lock().unwrap();
        remembered.retain(|n| {
            let keep = !self.is_closed()
                && wanted(&preference, &n.incoming)
                && self.store.notification_valid(n, true).unwrap_or(false);
            if !keep {
                withdrawn.push(self.notification_key(&n.incoming.rid));
            }
            keep
        });
        withdrawn.retain(|key| !remembered.iter().any(|n| self.notification_key(&n.incoming.rid) == *key));
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
        assert_eq!(s.store.pending().unwrap()[0].reply_to.as_deref(), Some("root"));
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
