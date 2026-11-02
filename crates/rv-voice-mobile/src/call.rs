//! A Jitsi Meet call's signalling for the Android voice engine (rv-call, as the
//! desktop sidecar runs it), over JNI. `com.rocketvibe.voice.JitsiCall` starts one
//! from a meeting URL and its host's `config.js`, reads the session's events as
//! JSON on a thread of its own, and hands back libwebrtc's answer, candidates and
//! the microphone's state. The peer connection itself stays on the Kotlin side.
use std::collections::HashMap;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Duration;

use jni::JNIEnv;
use jni::objects::{JClass, JString};
use jni::sys::{jboolean, jlong, jstring};
use rv_call::jitsi::{Config, Session};
use rv_call::{CallSignaling, Candidate, Event};
use serde_json::{Value, json};
use tokio::sync::mpsc as async_mpsc;

enum Command {
    Answer(String),
    Candidate(Candidate),
    Muted(bool),
    Leave,
}

/// The calls the Kotlin side holds, by handle: a late call after `free` finds nothing.
static CALLS: LazyLock<Mutex<HashMap<jlong, Arc<Call>>>> = LazyLock::new(Mutex::default);
static NEXT: AtomicI64 = AtomicI64::new(1);

fn call(handle: jlong) -> Option<Arc<Call>> {
    CALLS.lock().ok()?.get(&handle).cloned()
}

pub struct Call {
    runtime: tokio::runtime::Runtime,
    commands: async_mpsc::UnboundedSender<Command>,
    events: Mutex<mpsc::Receiver<String>>,
}

/// The event as the Kotlin side reads it.
pub fn event_json(event: &Event) -> Value {
    match event {
        Event::IceServers(servers) => json!({
            "type": "ice",
            "servers": servers.iter().map(|s| json!({"urls": s.urls, "username": s.username, "credential": s.credential})).collect::<Vec<_>>(),
        }),
        Event::Offer { sdp } => json!({"type": "offer", "sdp": sdp}),
        Event::RemoteCandidate(c) => json!({"type": "candidate", "mid": c.mid, "line": c.line}),
        Event::Roster(members) => json!({
            "type": "roster",
            "members": members.iter().map(|m| json!({"id": m.id, "name": m.name, "muted": m.muted})).collect::<Vec<_>>(),
        }),
        Event::Ended(reason) => json!({"type": "ended", "reason": reason}),
    }
}

impl Call {
    /// Joins the conference; `None` when the meeting is not a Jitsi one or the join fails.
    pub fn start(
        meeting: &str,
        config_js: &str,
        display_name: &str,
        token: Option<String>,
    ) -> Option<Call> {
        if !Config::is_jitsi(config_js) {
            return None;
        }
        let config = Config::from_meeting(meeting, config_js, display_name, token)?;
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .ok()?;
        let session = runtime.block_on(rv_call::jitsi::join(config)).ok()?;
        let (commands, command_rx) = async_mpsc::unbounded_channel();
        let (event_tx, events) = mpsc::channel();
        let local = session.local_id().to_owned();
        let _ = event_tx.send(json!({"type": "local", "id": local}).to_string());
        runtime.spawn(drive(session, command_rx, event_tx));
        Some(Call {
            runtime,
            commands,
            events: Mutex::new(events),
        })
    }

    /// The next event, waiting up to `timeout`; `None` on timeout, `"{\"type\":\"gone\"}"` once over.
    pub fn next(&self, timeout: Duration) -> Option<String> {
        match self.events.lock().ok()?.recv_timeout(timeout) {
            Ok(event) => Some(event),
            Err(mpsc::RecvTimeoutError::Timeout) => None,
            Err(mpsc::RecvTimeoutError::Disconnected) => Some(json!({"type": "gone"}).to_string()),
        }
    }

    fn send(&self, command: Command) {
        let _ = self.commands.send(command);
    }
}

async fn drive(
    mut session: Session,
    mut commands: async_mpsc::UnboundedReceiver<Command>,
    events: mpsc::Sender<String>,
) {
    loop {
        tokio::select! {
            event = session.next_event() => match event {
                Some(event) => {
                    let ended = matches!(event, Event::Ended(_));
                    if events.send(event_json(&event).to_string()).is_err() || ended {
                        break;
                    }
                }
                None => break,
            },
            command = commands.recv() => match command {
                Some(Command::Answer(sdp)) => {
                    if let Err(e) = session.answer(&sdp).await {
                        let _ = events.send(json!({"type": "error", "message": e.to_string()}).to_string());
                    }
                }
                Some(Command::Candidate(c)) => {
                    let _ = session.local_candidate(c).await;
                }
                Some(Command::Muted(muted)) => {
                    let _ = session.set_muted(muted).await;
                }
                Some(Command::Leave) | None => {
                    session.leave().await;
                    break;
                }
            },
        }
    }
}

fn text(env: &mut JNIEnv, value: &JString) -> Option<String> {
    if value.is_null() {
        return None;
    }
    env.get_string(value).ok().map(Into::into)
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_com_rocketvibe_voice_JitsiCall_start(
    mut env: JNIEnv,
    _class: JClass,
    meeting: JString,
    config_js: JString,
    display_name: JString,
    token: JString,
) -> jlong {
    let (Some(meeting), Some(config_js)) = (text(&mut env, &meeting), text(&mut env, &config_js))
    else {
        return 0;
    };
    let display_name = text(&mut env, &display_name).unwrap_or_default();
    let token = text(&mut env, &token).filter(|t| !t.is_empty());
    match Call::start(&meeting, &config_js, &display_name, token) {
        Some(call) => {
            let handle = NEXT.fetch_add(1, Ordering::Relaxed);
            CALLS
                .lock()
                .map(|mut calls| calls.insert(handle, Arc::new(call)))
                .map_or(0, |_| handle)
        }
        None => 0,
    }
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_com_rocketvibe_voice_JitsiCall_next(
    env: JNIEnv,
    _class: JClass,
    handle: jlong,
    timeout_ms: jlong,
) -> jstring {
    let Some(call) = call(handle) else {
        return std::ptr::null_mut();
    };
    match call.next(Duration::from_millis(timeout_ms.max(0) as u64)) {
        Some(event) => env
            .new_string(event)
            .map(|s| s.into_raw())
            .unwrap_or(std::ptr::null_mut()),
        None => std::ptr::null_mut(),
    }
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_com_rocketvibe_voice_JitsiCall_answer(
    mut env: JNIEnv,
    _class: JClass,
    handle: jlong,
    sdp: JString,
) {
    if let (Some(call), Some(sdp)) = (call(handle), text(&mut env, &sdp)) {
        call.send(Command::Answer(sdp));
    }
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_com_rocketvibe_voice_JitsiCall_candidate(
    mut env: JNIEnv,
    _class: JClass,
    handle: jlong,
    mid: JString,
    line: JString,
) {
    if let (Some(call), Some(mid), Some(line)) =
        (call(handle), text(&mut env, &mid), text(&mut env, &line))
    {
        call.send(Command::Candidate(Candidate { mid, line }));
    }
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_com_rocketvibe_voice_JitsiCall_muted(
    _env: JNIEnv,
    _class: JClass,
    handle: jlong,
    muted: jboolean,
) {
    if let Some(call) = call(handle) {
        call.send(Command::Muted(muted != 0));
    }
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_com_rocketvibe_voice_JitsiCall_leave(
    _env: JNIEnv,
    _class: JClass,
    handle: jlong,
) {
    if let Some(call) = call(handle) {
        call.send(Command::Leave);
    }
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_com_rocketvibe_voice_JitsiCall_free(
    _env: JNIEnv,
    _class: JClass,
    handle: jlong,
) {
    let Some(call) = CALLS
        .lock()
        .ok()
        .and_then(|mut calls| calls.remove(&handle))
    else {
        return;
    };
    call.send(Command::Leave);
    // The last holder shuts the runtime down; a call still running a command finishes first.
    if let Ok(call) = Arc::try_unwrap(call) {
        call.runtime.shutdown_timeout(Duration::from_secs(2));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn events_read_as_the_kotlin_side_expects() {
        let ice = event_json(&Event::IceServers(vec![rv_call::IceServer {
            urls: vec!["turns:t.example:443?transport=tcp".into()],
            username: "u".into(),
            credential: "c".into(),
        }]));
        assert_eq!(ice["type"], "ice");
        assert_eq!(
            ice["servers"][0]["urls"][0],
            "turns:t.example:443?transport=tcp"
        );
        let roster = event_json(&Event::Roster(vec![rv_call::Member {
            id: "e1".into(),
            name: "Ana".into(),
            muted: true,
        }]));
        assert_eq!(
            roster["members"][0],
            json!({"id": "e1", "name": "Ana", "muted": true})
        );
        let candidate = event_json(&Event::RemoteCandidate(Candidate {
            mid: "audio".into(),
            line: "candidate:1".into(),
        }));
        assert_eq!(
            candidate,
            json!({"type": "candidate", "mid": "audio", "line": "candidate:1"})
        );
        assert_eq!(
            event_json(&Event::Ended("terminated".into())),
            json!({"type": "ended", "reason": "terminated"})
        );
    }

    #[test]
    fn a_page_that_is_not_jitsi_starts_nothing() {
        assert!(Call::start("https://example.com/room", "var config = {};", "Ana", None).is_none());
    }
}
