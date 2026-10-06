//! The voice controller against a fake sidecar (tests/support/fake_voice_sidecar.rs).
use rv_core::voice::{ConnectionState, Ended, Snapshot, VoiceController, VoiceError};
use rv_protocol::voice::VoiceGrant;
use std::path::PathBuf;
use std::time::Duration;

fn fake(args: &[&str]) -> VoiceController {
    VoiceController::with_sidecar(
        PathBuf::from(env!("CARGO_BIN_EXE_fake-voice-sidecar")),
        args.iter().map(|a| a.to_string()).collect(),
    )
}

fn grant(room: &str, url: &str) -> VoiceGrant {
    VoiceGrant {
        room_id: room.into(),
        url: url.into(),
        token: "me".into(),
        expires_at: "2026-10-06T12:05:00Z".into(),
        can_publish: true,
        ring: None,
        e2ee: false,
    }
}

async fn until(voice: &VoiceController, done: impl Fn(&Snapshot) -> bool) -> Snapshot {
    let mut changes = voice.changes();
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let snapshot = voice.snapshot();
            if done(&snapshot) {
                return snapshot;
            }
            let _ = changes.recv().await;
        }
    })
    .await
    .unwrap_or_else(|_| panic!("voice snapshot never matched: {:?}", voice.snapshot()))
}

#[tokio::test]
async fn a_session_reports_participants_choices_and_leaving() {
    let voice = fake(&[]);
    voice.set_microphone(false).await;
    voice.connect(&grant("r1", "wss://lk")).await.unwrap();
    let snapshot = until(&voice, |s| s.state == ConnectionState::Connected && s.participants.len() == 2).await;
    assert_eq!(snapshot.room.as_deref(), Some("r1"));
    assert!(snapshot.can_publish);
    let local = snapshot.local().unwrap();
    assert_eq!(local.identity, "me");
    assert!(local.muted, "the choice made before connecting reaches the sidecar");
    assert!(snapshot.participants.iter().any(|p| !p.local && p.speaking));

    voice.set_microphone(true).await;
    voice.set_deafened(true).await;
    let snapshot = until(&voice, |s| s.local().is_some_and(|p| !p.muted && p.deafened)).await;
    assert!(snapshot.microphone && snapshot.deafened);

    voice.disconnect().await;
    let snapshot = voice.snapshot();
    assert_eq!(snapshot.room, None);
    assert_eq!(snapshot.state, ConnectionState::Disconnected);
    assert!(snapshot.participants.is_empty());
    assert_eq!(snapshot.ended, Some(Ended::Left));
    assert!(snapshot.deafened, "choices outlive the connection");
}

#[tokio::test]
async fn joining_elsewhere_ends_as_moved_to_another_device() {
    let voice = fake(&[]);
    voice.connect(&grant("r1", "fake://moved")).await.unwrap();
    let snapshot = until(&voice, |s| s.ended.is_some()).await;
    assert!(snapshot.moved_elsewhere());
    assert_eq!(snapshot.room, None);
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert_eq!(voice.devices().await.unwrap().0[0].id, "mic-1", "the ended session's sidecar is not asked");
}

#[tokio::test]
async fn a_crashed_or_refused_sidecar_ends_the_session() {
    let voice = fake(&[]);
    voice.connect(&grant("r1", "fake://crash")).await.unwrap();
    let snapshot = until(&voice, |s| s.ended.is_some()).await;
    assert_eq!(snapshot.ended, Some(Ended::Failed("sidecar_exited".into())));
    voice.connect(&grant("r2", "fake://refused")).await.unwrap();
    let snapshot = until(&voice, |s| s.ended.is_some()).await;
    assert_eq!(snapshot.ended, Some(Ended::Failed("connect_failed".into())));
}

#[tokio::test]
async fn a_new_connection_replaces_the_previous_one() {
    let voice = fake(&[]);
    voice.connect(&grant("r1", "wss://lk")).await.unwrap();
    until(&voice, |s| s.state == ConnectionState::Connected).await;
    voice.connect(&grant("r2", "wss://lk")).await.unwrap();
    let snapshot = until(&voice, |s| s.state == ConnectionState::Connected).await;
    assert_eq!(snapshot.room.as_deref(), Some("r2"));
    assert_eq!(snapshot.ended, None, "the old sidecar's farewell is not this session's end");
}

#[tokio::test]
async fn the_handshake_rejects_another_protocol_or_silence() {
    assert_eq!(fake(&["old"]).connect(&grant("r1", "wss://lk")).await, Err(VoiceError::Incompatible));
    let silent = fake(&["silent"]);
    assert_eq!(silent.connect(&grant("r1", "wss://lk")).await, Err(VoiceError::Timeout));
    assert_eq!(silent.snapshot().ended, Some(Ended::Failed("voice_timeout".into())));
    assert_eq!(fake(&["old"]).devices().await, Err(VoiceError::Incompatible));
}

#[tokio::test]
async fn devices_are_listed_with_or_without_a_session_and_choices_kept() {
    let voice = fake(&[]);
    let (inputs, outputs) = voice.devices().await.unwrap();
    assert_eq!(inputs[0].id, "mic-1");
    assert_eq!(outputs[0].id, "spk-1");
    voice.select_input("mic-1").await;
    voice.connect(&grant("r1", "wss://lk")).await.unwrap();
    until(&voice, |s| s.state == ConnectionState::Connected).await;
    assert_eq!(voice.devices().await.unwrap().0[0].name, "Fake microphone");
    assert_eq!(voice.snapshot().error, None, "the kept input was accepted at connection");
    voice.select_output("gone").await;
    until(&voice, |s| s.error.as_deref() == Some("device_not_found")).await;
    assert_eq!(voice.selected_devices(), (Some("mic-1".into()), Some("gone".into())));
    voice.disconnect().await;
}
