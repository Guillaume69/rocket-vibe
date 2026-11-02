//! A Jitsi Meet call carried natively for the SwiftUI app (Rocket.Chat's Jitsi
//! provider, kChat's kMeet), as GTK's `native_call.rs` does: a voice controller
//! of its own and its `rv-voice` sidecar, audio only. `start_jitsi_call` answers
//! None when the meeting is not a Jitsi one or cannot be joined, and the app then
//! opens the meeting's page.
use crate::on_tokio;
use rv_core::voice::{ConnectionState, VoiceController};
use std::sync::Arc;

#[derive(uniffi::Object)]
pub struct JitsiCallSession {
    voice: VoiceController,
}

#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct JitsiPerson {
    pub id: String,
    /// The room's display name; None for this side, or a nameless guest.
    pub name: Option<String>,
    pub local: bool,
    pub muted: bool,
    pub speaking: bool,
}

#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct JitsiCallState {
    pub connected: bool,
    /// The call is over: hung up here, or the conference ended it.
    pub ended: bool,
    pub microphone: bool,
    pub deafened: bool,
    pub people: Vec<JitsiPerson>,
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
        JitsiCallState {
            connected: snapshot.state == ConnectionState::Connected,
            ended: snapshot.ended.is_some(),
            microphone: snapshot.microphone,
            deafened: snapshot.deafened,
            people: snapshot
                .participants
                .iter()
                .map(|p| JitsiPerson {
                    id: p.identity.clone(),
                    name: p.name.clone(),
                    local: p.local,
                    muted: p.muted,
                    speaking: p.speaking,
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
