//! Ringing for a call someone starts in a direct room of a Rocket.Chat or
//! Mattermost/kChat server, done by the client from the call message: neither
//! server rings a third-party app (Rocket.Chat only through its licensed
//! direct calls and a DDP method), see brain/decisions.md. The mobile twin is
//! `apps/mobile/lib/callRing.ts`.
//!
//! A call message from the other member of a two-person room, seen live and
//! younger than [`RING_MS`], rings once. Rocket.Chat lets any member post a
//! `videoconf` message, so the server's record of the call
//! (`video-conference.info`) names the caller and says whether it still rings;
//! kChat's post is the record.

use std::collections::VecDeque;

use serde_json::Value;

use crate::normalize::Message;

/// How long a call rings: Rocket.Chat cancels an unanswered direct call after 40 s.
pub const RING_MS: i64 = 40_000;
/// How often the server's record of a ringing call is read again.
pub const RING_CHECK_MS: u64 = 5_000;
const KEPT: usize = 200;
/// Rocket.Chat's `VideoConferenceStatus.EXPIRED`: this and above no longer ring.
const STATUS_EXPIRED: i64 = 2;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CallSignal {
    Call { rid: String, message_id: String, call_id: String, author_id: String, ts: i64 },
    Over { message_id: String },
}

/// The server's record of a call.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CallCheck {
    pub rid: String,
    pub caller_id: String,
    pub caller_name: Option<String>,
    pub over: bool,
    pub joined: Vec<String>,
}

impl CallCheck {
    /// Over, or already answered on another of my devices.
    pub fn ended(&self, me: &str) -> bool {
        self.over || self.joined.iter().any(|id| id == me)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IncomingCall {
    pub message_id: String,
    pub rid: String,
    pub call_id: String,
    pub caller_id: String,
    pub caller_name: Option<String>,
    /// Epoch milliseconds when it stops ringing.
    pub until: i64,
}

pub fn signal_of(message: &Message) -> Option<CallSignal> {
    match message.system_type.as_deref() {
        Some("videoconf") => Some(CallSignal::Call {
            rid: message.rid.clone(),
            message_id: message.id.clone(),
            call_id: message.call_id.clone()?,
            author_id: message.author_id.clone(),
            ts: message.ts,
        }),
        Some("videoconf-ended") => Some(CallSignal::Over { message_id: message.id.clone() }),
        _ => None,
    }
}

/// `video-conference.info` as a [`CallCheck`].
pub fn rocketchat_check(info: &Value) -> Option<CallCheck> {
    let text = |v: Option<&Value>| v.and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_owned);
    let creator = info.get("createdBy");
    Some(CallCheck {
        rid: text(info.get("rid"))?,
        caller_id: text(creator.and_then(|c| c.get("_id")))?,
        caller_name: text(creator.and_then(|c| c.get("name")))
            .or_else(|| text(creator.and_then(|c| c.get("username")))),
        over: info.get("endedAt").is_some_and(|e| !e.is_null())
            || info.get("status").and_then(Value::as_i64).unwrap_or(0) >= STATUS_EXPIRED,
        joined: info
            .get("users")
            .and_then(Value::as_array)
            .map(|users| users.iter().filter_map(|u| text(u.get("_id"))).collect())
            .unwrap_or_default(),
    })
}

/// The rings of one session: which call messages were seen, and the one ringing.
#[derive(Debug, Default)]
pub struct Rings {
    seen: VecDeque<String>,
    over: VecDeque<String>,
    current: Option<IncomingCall>,
}

fn remember(ids: &mut VecDeque<String>, id: &str) {
    ids.push_back(id.to_owned());
    if ids.len() > KEPT {
        ids.pop_front();
    }
}

impl Rings {
    pub fn current(&self) -> Option<&IncomingCall> {
        self.current.as_ref()
    }

    /// A new call message worth asking about: unseen, someone else's, fresh.
    pub fn admit(&mut self, message_id: &str, author_id: &str, ts: i64, me: &str, now: i64) -> bool {
        if self.seen.iter().any(|id| id == message_id) || self.over.iter().any(|id| id == message_id) {
            return false;
        }
        remember(&mut self.seen, message_id);
        author_id != me && (now - ts).abs() <= RING_MS
    }

    /// Rings it when `peer` (the other member of a two-person room) is the
    /// caller, the record agrees and nothing else rings. `check` is None when
    /// the message is the record.
    pub fn decide(
        &mut self,
        signal: &CallSignal,
        peer: Option<(&str, Option<&str>)>,
        check: Option<&CallCheck>,
        me: &str,
        now: i64,
    ) -> Option<IncomingCall> {
        let CallSignal::Call { rid, message_id, call_id, author_id, ts } = signal else { return None };
        let (peer, name) = peer?;
        if self.over.iter().any(|id| id == message_id) || self.current.is_some() {
            return None;
        }
        let caller = check.map_or(author_id.as_str(), |c| c.caller_id.as_str());
        if caller != peer || check.is_some_and(|c| &c.rid != rid || c.ended(me)) {
            return None;
        }
        let call = IncomingCall {
            message_id: message_id.clone(),
            rid: rid.clone(),
            call_id: call_id.clone(),
            caller_id: caller.to_owned(),
            caller_name: check.and_then(|c| c.caller_name.clone()).or_else(|| name.map(str::to_owned)),
            until: (*ts).min(now) + RING_MS,
        };
        self.current = Some(call.clone());
        Some(call)
    }

    /// The call message became an ended call (kChat's edited post). True when it rang.
    pub fn over(&mut self, message_id: &str) -> bool {
        remember(&mut self.over, message_id);
        self.stop_if(|c| c.message_id == message_id)
    }

    /// Stops the ring of this message, when it still rings. True when it rang.
    pub fn stop_if(&mut self, matches: impl Fn(&IncomingCall) -> bool) -> bool {
        let rang = self.current.as_ref().is_some_and(matches);
        if rang {
            self.current = None;
        }
        rang
    }

    pub fn clear(&mut self) {
        *self = Self::default();
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    const NOW: i64 = 1_800_000_000_000;

    fn call(message_id: &str, author: &str, ts: i64) -> CallSignal {
        CallSignal::Call {
            rid: "dm".into(),
            message_id: message_id.into(),
            call_id: "c1".into(),
            author_id: author.into(),
            ts,
        }
    }

    fn check(caller: &str, over: bool, joined: &[&str]) -> CallCheck {
        CallCheck {
            rid: "dm".into(),
            caller_id: caller.into(),
            caller_name: Some("Bob Durand".into()),
            over,
            joined: joined.iter().map(|s| s.to_string()).collect(),
        }
    }

    #[test]
    fn a_fresh_call_from_the_other_member_rings_once() {
        let mut rings = Rings::default();
        assert!(rings.admit("m1", "bob", NOW - 1000, "me", NOW));
        let rang = rings.decide(&call("m1", "bob", NOW - 1000), Some(("bob", Some("Bob"))), None, "me", NOW).unwrap();
        assert_eq!(rang.until, NOW - 1000 + RING_MS);
        assert_eq!(rang.caller_name.as_deref(), Some("Bob"));
        assert!(!rings.admit("m1", "bob", NOW - 1000, "me", NOW));
        assert!(rings.stop_if(|c| c.message_id == "m1"));
        assert_eq!(rings.current(), None);
    }

    #[test]
    fn no_ring_for_my_call_an_old_one_a_group_room_or_a_busy_line() {
        let mut rings = Rings::default();
        assert!(!rings.admit("m1", "me", NOW, "me", NOW));
        assert!(!rings.admit("m2", "bob", NOW - RING_MS - 1, "me", NOW));
        assert!(rings.admit("m3", "bob", NOW, "me", NOW));
        assert_eq!(rings.decide(&call("m3", "bob", NOW), None, None, "me", NOW), None);
        assert!(rings.decide(&call("m3", "bob", NOW), Some(("bob", None)), None, "me", NOW).is_some());
        assert_eq!(rings.decide(&call("m4", "bob", NOW), Some(("bob", None)), None, "me", NOW), None);
    }

    #[test]
    fn the_record_names_the_caller() {
        let signal = call("m1", "jitsi.bot", NOW);
        let rang =
            Rings::default().decide(&signal, Some(("bob", None)), Some(&check("bob", false, &[])), "me", NOW).unwrap();
        assert_eq!(rang.caller_name.as_deref(), Some("Bob Durand"));
        for record in [check("me", false, &[]), check("bob", true, &[]), check("bob", false, &["me"])] {
            assert_eq!(Rings::default().decide(&signal, Some(("bob", None)), Some(&record), "me", NOW), None);
        }
        let mut elsewhere = check("bob", false, &[]);
        elsewhere.rid = "other".into();
        assert_eq!(Rings::default().decide(&signal, Some(("bob", None)), Some(&elsewhere), "me", NOW), None);
    }

    #[test]
    fn an_ended_post_stops_the_ring_and_never_rings_late() {
        let mut rings = Rings::default();
        rings.admit("m1", "bob", NOW, "me", NOW);
        rings.decide(&call("m1", "bob", NOW), Some(("bob", None)), None, "me", NOW);
        assert!(rings.over("m1"));
        let mut late = Rings::default();
        assert!(late.admit("m2", "bob", NOW, "me", NOW));
        late.over("m2");
        assert_eq!(late.decide(&call("m2", "bob", NOW), Some(("bob", None)), None, "me", NOW), None);
    }

    #[test]
    fn rocketchat_info_reads_as_a_check() {
        let info = json!({"rid": "dm", "status": 1, "createdBy": {"_id": "bob", "username": "bob"}, "users": [{"_id": "bob"}]});
        assert_eq!(
            rocketchat_check(&info),
            Some(CallCheck {
                rid: "dm".into(),
                caller_id: "bob".into(),
                caller_name: Some("bob".into()),
                over: false,
                joined: vec!["bob".into()]
            })
        );
        assert!(rocketchat_check(&json!({"rid": "dm", "status": 3, "createdBy": {"_id": "bob"}})).unwrap().over);
        assert!(
            rocketchat_check(&json!({"rid": "dm", "endedAt": "2026-10-10T00:00:00Z", "createdBy": {"_id": "bob"}}))
                .unwrap()
                .over
        );
        assert_eq!(rocketchat_check(&json!({"rid": "dm"})), None);
    }

    #[test]
    fn signals_from_messages() {
        let message = Message {
            id: "m1".into(),
            rid: "dm".into(),
            ts: NOW,
            author_id: "bob".into(),
            system_type: Some("videoconf".into()),
            call_id: Some("c1".into()),
            ..Message::default()
        };
        assert_eq!(signal_of(&message), Some(call("m1", "bob", NOW)));
        let ended = Message { system_type: Some("videoconf-ended".into()), call_id: None, ..message.clone() };
        assert_eq!(signal_of(&ended), Some(CallSignal::Over { message_id: "m1".into() }));
        assert_eq!(signal_of(&Message { system_type: None, ..message }), None);
    }
}
