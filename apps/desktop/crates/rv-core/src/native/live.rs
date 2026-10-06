//! An expiring in-memory photo, separate from the durable SQLite projection.
use crate::live::Presence;
use rv_protocol::live::{LiveState, PresenceStatus};
use rv_protocol::voice::{VoiceParticipant, VoiceRing};
use std::time::{Duration, Instant};

#[derive(Default)]
pub(super) struct LiveCache {
    pub state: Option<LiveState>,
    until: Option<Instant>,
}
impl LiveCache {
    pub fn apply(&mut self, state: LiveState, now: Instant) -> bool {
        if state.limited || state.ttl_ms == 0 || state.ttl_ms > 8000 {
            return self.clear();
        }
        let changed = serde_json::to_value(&self.state).ok() != serde_json::to_value(&state).ok();
        self.until = Some(now + Duration::from_millis(state.ttl_ms.into()));
        self.state = Some(state);
        changed
    }
    pub fn clear(&mut self) -> bool {
        self.until = None;
        self.state.take().is_some()
    }
    pub fn expire(&mut self, now: Instant) -> bool {
        if self.until.is_some_and(|t| t <= now) { self.clear() } else { false }
    }
    pub fn typing(&self, room: &str, root: Option<&str>, me: &str, now: Instant) -> Vec<String> {
        if !self.until.is_some_and(|t| t > now) {
            return vec![];
        }
        let mut result: Vec<_> = self
            .state
            .as_ref()
            .into_iter()
            .flat_map(|s| &s.rooms)
            .filter(|r| r.room_id == room)
            .flat_map(|r| &r.typing)
            .filter(|t| t.user.id != me && t.root_id.as_deref() == root)
            .map(|t| t.user.username.clone())
            .collect();
        result.sort();
        result.dedup();
        result
    }
    /// Who the SFU last reported in the room's voice session.
    pub fn voice(&self, room: &str, now: Instant) -> Vec<VoiceParticipant> {
        if !self.until.is_some_and(|t| t > now) {
            return vec![];
        }
        self.state.iter().flat_map(|s| &s.rooms).filter(|r| r.room_id == room).flat_map(|r| r.voice.clone()).collect()
    }
    /// Direct calls ringing or just resolved, where this account is caller or callee.
    pub fn rings(&self, now: Instant) -> Vec<VoiceRing> {
        if !self.until.is_some_and(|t| t > now) {
            return vec![];
        }
        self.state.iter().flat_map(|s| s.rings.clone()).collect()
    }
    pub fn presence(&self, uid: &str, now: Instant) -> Option<Presence> {
        if !self.until.is_some_and(|t| t > now) {
            return None;
        }
        let state = self.state.as_ref()?;
        Some(
            match state.presence.iter().find(|p| p.user.id == uid).map(|p| p.status).unwrap_or(PresenceStatus::Offline)
            {
                PresenceStatus::Online => Presence::Online,
                PresenceStatus::Away => Presence::Away,
                PresenceStatus::Busy => Presence::Busy,
                PresenceStatus::Offline => Presence::Offline,
            },
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rv_protocol::{
        User,
        live::{LiveRoom, PresenceEntry, Typist},
    };
    #[test]
    fn photos_are_scoped_to_composer_and_expire_without_a_stop_frame() {
        let now = Instant::now();
        let mut cache = LiveCache::default();
        let user = User { id: "other".into(), username: "bob".into(), display_name: "Bob".into() };
        let mut state = LiveState {
            emoji_catalog_revision: None,
            profiles: vec![],
            ttl_ms: 8000,
            limited: false,
            presence: vec![PresenceEntry { user: user.clone(), status: PresenceStatus::Busy }],
            rooms: vec![LiveRoom {
                room_id: "room".into(),
                membership_version: "grant".into(),
                direct_peer: None,
                typing: vec![
                    Typist { user: user.clone(), root_id: None },
                    Typist { user: user.clone(), root_id: Some("root".into()) },
                ],
                voice: vec![VoiceParticipant {
                    user: user.clone(),
                    muted: true,
                    deafened: false,
                    camera: false,
                    screen: false,
                }],
            }],
            rings: vec![VoiceRing {
                id: "ring".into(),
                room_id: "room".into(),
                caller: user.clone(),
                callee: user,
                state: rv_protocol::voice::RingState::Ringing,
                expires_in_ms: 30_000,
            }],
        };
        cache.apply(state.clone(), now);
        assert!(cache.voice("room", now)[0].muted);
        assert!(cache.voice("other-room", now).is_empty());
        assert_eq!(cache.rings(now)[0].id, "ring");
        assert!(cache.voice("room", now + Duration::from_secs(8)).is_empty());
        assert!(cache.rings(now + Duration::from_secs(8)).is_empty());
        assert_eq!(cache.typing("room", None, "me", now), ["bob"]);
        assert_eq!(cache.typing("room", Some("root"), "me", now), ["bob"]);
        assert!(cache.typing("room", None, "other", now).is_empty());
        assert_eq!(cache.presence("other", now), Some(Presence::Busy));
        assert_eq!(cache.presence("other", now + Duration::from_secs(8)), None);
        assert!(cache.expire(now + Duration::from_secs(8)));
        assert!(cache.typing("room", None, "me", now + Duration::from_secs(8)).is_empty());
        cache.apply(state.clone(), now);
        state.limited = true;
        cache.apply(state, now);
        assert_eq!(cache.presence("other", now), None);
    }
}
