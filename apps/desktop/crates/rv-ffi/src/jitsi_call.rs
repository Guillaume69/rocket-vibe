//! A Jitsi Meet call carried natively for the SwiftUI app (Rocket.Chat's Jitsi
//! provider, kChat's kMeet), as GTK's `native_call.rs` does: a voice controller
//! of its own and its `rv-voice` sidecar, audio only. `start_jitsi_call` answers
//! None when the meeting is not a Jitsi one or cannot be joined, and the app then
//! opens the meeting's page.
use crate::native_voice::VoiceMember;
use crate::on_tokio;
use rv_core::voice::{ConnectionState, Ended, VoiceController};
use std::sync::Arc;

#[derive(uniffi::Object)]
pub struct JitsiCallSession {
    voice: VoiceController,
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
        Some(Arc::new(JitsiCallSession { voice }))
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
                        p.name.clone().unwrap_or_else(|| p.identity.clone())
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
