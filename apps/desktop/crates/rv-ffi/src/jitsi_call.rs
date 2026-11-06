//! A call carried natively for the SwiftUI app (Rocket.Chat's Jitsi provider,
//! kChat's kMeet, Slack's huddles), as GTK's `native_call.rs` does: a voice
//! controller of its own and its `rv-voice` sidecar, audio only. `start_jitsi_call`
//! and `Chat::start_huddle_call` answer None when the call cannot be joined, and
//! the app then opens its page.
use crate::native_voice::VoiceMember;
use crate::on_tokio;
use rv_core::session::Session;
use rv_core::voice::{ConnectionState, Ended, VoiceController};
use std::collections::HashSet;
use std::sync::{Arc, Mutex};

#[derive(uniffi::Object)]
pub struct JitsiCallSession {
    voice: VoiceController,
    /// The account of a call whose provider sends only ids (a Slack huddle), which names them.
    naming: Option<Arc<Session>>,
    asked: Mutex<HashSet<String>>,
}

/// Joins a Slack huddle, starting it when none runs; None to open its page instead.
pub(crate) async fn start_huddle(
    session: Arc<Session>,
    call_url: String,
    title: String,
) -> Option<Arc<JitsiCallSession>> {
    if !rv_core::voice::available() {
        return None;
    }
    on_tokio(async move {
        let call = session.join_huddle(&call_url).await.ok()?;
        let voice = VoiceController::new();
        voice.connect_chime(&title, &call).await.ok()?;
        Some(Arc::new(JitsiCallSession { voice, naming: Some(session), asked: Mutex::default() }))
    })
    .await
}

#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct JitsiCallState {
    pub connected: bool,
    /// The sidecar lost the call and is joining it again.
    pub reconnecting: bool,
    /// The call is over: hung up here, or lost for good.
    pub ended: bool,
    /// Why it ended, in words; None while it lives or when hung up here.
    pub ended_reason: Option<String>,
    pub microphone: bool,
    pub deafened: bool,
    /// Everyone in the call, as the Vibez voice page shows them (no photos).
    pub members: Vec<VoiceMember>,
}

/// Joins the conference at `meeting_url` (kMeet's `?jwt=` included) as
/// `display_name`; None to open the meeting's page instead.
#[uniffi::export]
pub async fn start_jitsi_call(
    meeting_url: String,
    display_name: String,
    title: String,
) -> Option<Arc<JitsiCallSession>> {
    on_tokio(async move {
        let call = rv_core::voice::discover_jitsi(&meeting_url, &display_name).await?;
        let voice = VoiceController::new();
        voice.connect_jitsi(&title, &call).await.ok()?;
        Some(Arc::new(JitsiCallSession { voice, naming: None, asked: Mutex::default() }))
    })
    .await
}

#[uniffi::export]
impl JitsiCallSession {
    pub fn state(&self) -> JitsiCallState {
        let snapshot = self.voice.snapshot();
        let ended_reason = snapshot.ended.as_ref().filter(|e| **e != Ended::Left).map(|e| match e.explained() {
            (key, Some(reason)) => rv_core::i18n::tf(key, &[("reason", reason)]),
            (key, None) => rv_core::i18n::t(key).to_owned(),
        });
        JitsiCallState {
            connected: snapshot.state == ConnectionState::Connected,
            reconnecting: snapshot.state == ConnectionState::Reconnecting,
            ended: snapshot.ended.is_some(),
            ended_reason,
            microphone: snapshot.microphone,
            deafened: snapshot.deafened,
            members: snapshot
                .participants
                .iter()
                .map(|p| VoiceMember {
                    id: p.identity.clone(),
                    name: if p.local {
                        rv_core::i18n::t("call.you").to_owned()
                    } else {
                        p.name.clone().or_else(|| self.named(&p.identity)).unwrap_or_else(|| p.identity.clone())
                    },
                    local: p.local,
                    muted: p.muted,
                    deafened: p.deafened,
                    speaking: p.speaking,
                    camera: false,
                    screen: false,
                    muted_here: false,
                    avatar: None,
                })
                .collect(),
        }
    }

    pub async fn set_microphone(&self, enabled: bool) {
        let voice = self.voice.clone();
        on_tokio(async move { voice.set_microphone(enabled).await }).await
    }

    pub async fn set_deafened(&self, deafened: bool) {
        let voice = self.voice.clone();
        on_tokio(async move { voice.set_deafened(deafened).await }).await
    }

    pub async fn leave(&self) {
        let voice = self.voice.clone();
        on_tokio(async move { voice.disconnect().await }).await
    }
}

impl JitsiCallSession {
    /// Who this id is, once known; the first time an unknown one is seen, reads it.
    fn named(&self, identity: &str) -> Option<String> {
        let session = self.naming.as_ref()?;
        let name = session.huddle_person_name(identity);
        if name.is_none() && self.asked.lock().unwrap().insert(identity.to_owned()) {
            let (session, id) = (session.clone(), identity.to_owned());
            crate::runtime().spawn(async move { session.ensure_huddle_people(vec![id]).await });
        }
        name
    }
}
