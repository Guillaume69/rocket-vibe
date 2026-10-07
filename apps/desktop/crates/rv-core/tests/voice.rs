//! The voice controller against a fake sidecar (tests/support/fake_voice_sidecar.rs).
use rv_core::voice::{
    ConnectionState, Ended, PersonVolume, ScreenKind, ScreenQuality, Snapshot, VideoSource, VoiceController,
    VoiceError, VoiceKey, VoiceKeys, thumbnail,
};
use rv_protocol::voice::VoiceGrant;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
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
    voice.connect(&grant("r1", "wss://lk"), None, None).await.unwrap();
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
    voice.connect(&grant("r1", "fake://moved"), None, None).await.unwrap();
    let snapshot = until(&voice, |s| s.ended.is_some()).await;
    assert!(snapshot.moved_elsewhere());
    assert_eq!(snapshot.room, None);
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert_eq!(voice.devices().await.unwrap().0[0].id, "mic-1", "the ended session's sidecar is not asked");
}

#[tokio::test]
async fn a_crashed_or_refused_sidecar_ends_the_session() {
    let voice = fake(&[]);
    voice.connect(&grant("r1", "fake://crash"), None, None).await.unwrap();
    let snapshot = until(&voice, |s| s.ended.is_some()).await;
    assert_eq!(snapshot.ended, Some(Ended::Failed("sidecar_exited".into())));
    voice.connect(&grant("r2", "fake://refused"), None, None).await.unwrap();
    let snapshot = until(&voice, |s| s.ended.is_some()).await;
    assert_eq!(snapshot.ended, Some(Ended::Failed("connect_failed".into())));
}

#[tokio::test]
async fn a_new_connection_replaces_the_previous_one() {
    let voice = fake(&[]);
    voice.connect(&grant("r1", "wss://lk"), None, None).await.unwrap();
    until(&voice, |s| s.state == ConnectionState::Connected).await;
    voice.connect(&grant("r2", "wss://lk"), None, None).await.unwrap();
    let snapshot = until(&voice, |s| s.state == ConnectionState::Connected).await;
    assert_eq!(snapshot.room.as_deref(), Some("r2"));
    assert_eq!(snapshot.ended, None, "the old sidecar's farewell is not this session's end");
}

#[tokio::test]
async fn the_handshake_rejects_another_protocol_or_silence() {
    assert_eq!(fake(&["old"]).connect(&grant("r1", "wss://lk"), None, None).await, Err(VoiceError::Incompatible));
    let silent = fake(&["silent"]);
    assert_eq!(silent.connect(&grant("r1", "wss://lk"), None, None).await, Err(VoiceError::Timeout));
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
    voice.connect(&grant("r1", "wss://lk"), None, None).await.unwrap();
    until(&voice, |s| s.state == ConnectionState::Connected).await;
    assert_eq!(voice.devices().await.unwrap().0[0].name, "Fake microphone");
    // Two asking at once (the call menu's two lists) both get them.
    let (first, second) = tokio::join!(voice.devices(), voice.devices());
    assert_eq!((first.unwrap().1[0].id.as_str(), second.unwrap().1[0].id.as_str()), ("spk-1", "spk-1"));
    assert_eq!(voice.snapshot().error, None, "the kept input was accepted at connection");
    voice.select_output("gone").await;
    until(&voice, |s| s.error.as_deref() == Some("device_not_found")).await;
    assert_eq!(voice.selected_devices(), (Some("mic-1".into()), Some("gone".into())));
    voice.disconnect().await;
}

#[tokio::test]
async fn an_encrypted_session_connects_with_its_key_and_follows_new_epochs() {
    let voice = fake(&[]).with_key_refresh(Duration::from_millis(50));
    let encrypted = VoiceGrant { e2ee: true, ..grant("vault", "wss://lk") };
    // Never in clear: an encrypted grant without its key does not connect.
    assert_eq!(voice.connect(&encrypted, None, None).await, Err(VoiceError::Unencrypted));
    assert_eq!(voice.snapshot().room, None);

    let current = Arc::new(Mutex::new(Some(VoiceKey::new(4, b"four"))));
    let source = current.clone();
    let keys: VoiceKeys = Arc::new(move || {
        let key = source.lock().unwrap().clone();
        Box::pin(async move { key })
    });
    let first = current.lock().unwrap().clone();
    voice.connect(&encrypted, first, Some(keys)).await.unwrap();
    let local = |s: &Snapshot| s.local().map(|p| p.identity.clone()).unwrap_or_default();
    let snapshot = until(&voice, |s| s.state == ConnectionState::Connected && !local(s).is_empty()).await;
    assert!(snapshot.encrypted);
    assert_eq!(local(&snapshot), "me#Zm91cg==");
    // Unreadable for a while: the key stays.
    *current.lock().unwrap() = None;
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(local(&voice.snapshot()), "me#Zm91cg==");
    // A new epoch: its key replaces the current one.
    *current.lock().unwrap() = Some(VoiceKey::new(5, b"five"));
    until(&voice, |s| local(s) == "me#Zml2ZQ==").await;
    voice.disconnect().await;

    // A plaintext grant ignores a key: the room is not encrypted.
    voice.connect(&grant("lounge", "wss://lk"), Some(VoiceKey::new(1, b"one")), None).await.unwrap();
    let snapshot = until(&voice, |s| s.state == ConnectionState::Connected && !local(s).is_empty()).await;
    assert!(!snapshot.encrypted);
    assert_eq!(local(&snapshot), "me");
    voice.disconnect().await;
}

async fn until_frame(voice: &VoiceController, identity: &str, source: VideoSource, shown: bool) {
    tokio::time::timeout(Duration::from_secs(10), async {
        while voice.frame(identity, source).is_some() != shown {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap_or_else(|_| panic!("{identity}'s {source:?} never became shown={shown}"));
}

#[tokio::test]
async fn video_frames_reach_the_app_and_end_with_their_track() {
    let voice = fake(&[]);
    // Nothing to wish for outside a session.
    voice.set_camera(true).await;
    assert!(!voice.snapshot().camera);
    voice.connect(&grant("r1", "wss://lk"), None, None).await.unwrap();
    until_frame(&voice, "peer", VideoSource::Camera, true).await;
    let frame = voice.frame("peer", VideoSource::Camera).unwrap();
    assert_eq!((frame.width, frame.height, frame.pixels.len()), (4, 2, 32));

    voice.set_camera(true).await;
    until_frame(&voice, "me", VideoSource::Camera, true).await;
    let snapshot = until(&voice, |s| s.local().is_some_and(|p| p.camera)).await;
    assert!(snapshot.camera);
    voice.set_camera(false).await;
    until_frame(&voice, "me", VideoSource::Camera, false).await;

    voice.start_screen_share(None, None).await;
    until_frame(&voice, "me", VideoSource::Screen, true).await;
    assert!(until(&voice, |s| s.local().is_some_and(|p| p.screen)).await.sharing);
    // Without the call's voices by default (the fake's preview is 2 wide, 4 with them).
    assert_eq!(voice.frame("me", VideoSource::Screen).unwrap().width, 2);
    voice.stop_screen_share().await;
    until_frame(&voice, "me", VideoSource::Screen, false).await;
    voice.set_share_call(true);
    // A window at 1440 lines: the fake's preview is 1440 / 360 = 4 high (2 by default).
    let quality = ScreenQuality { height: 1440, fps: 30 };
    voice.start_screen_share(Some("window:7".into()), Some(quality)).await;
    until_frame(&voice, "me", VideoSource::Screen, true).await;
    let preview = voice.frame("me", VideoSource::Screen).unwrap();
    assert_eq!((preview.width, preview.height), (4, 4));
    voice.set_share_call(false);
    voice.stop_screen_share().await;
    until_frame(&voice, "me", VideoSource::Screen, false).await;
    assert!(!voice.snapshot().sharing);

    // A new session starts with nothing shown, the camera off.
    voice.connect(&grant("r2", "fake://no-screen"), None, None).await.unwrap();
    assert!(voice.frame("me", VideoSource::Camera).is_none() && !voice.snapshot().camera);
    // A closed picker takes the wish back.
    voice.start_screen_share(None, None).await;
    let snapshot = until(&voice, |s| s.error.as_deref() == Some("screen_cancelled")).await;
    assert!(!snapshot.sharing);
    voice.disconnect().await;
    assert!(voice.frame("peer", VideoSource::Camera).is_none());
}

#[tokio::test]
async fn share_sources_and_listening_choices_reach_the_sidecar() {
    let voice = fake(&[]);
    // Nothing to list outside a session.
    assert_eq!(voice.screens().await, Err(VoiceError::Unavailable));
    voice.set_input_volume(1.5).await;
    voice.set_person_volume("peer", PersonVolume { volume: 3.0, muted: true }).await;
    voice.set_noise_suppression(false).await;
    let listening = voice.listening();
    assert_eq!(listening.people["peer"], PersonVolume { volume: 2.0, muted: true }, "clamped to 200 %");
    assert!(!listening.noise_suppression);
    voice.connect(&grant("r1", "wss://lk"), None, None).await.unwrap();
    until(&voice, |s| s.state == ConnectionState::Connected).await;
    // The volume chosen before the session went with it (the fake answers half of it).
    tokio::time::timeout(Duration::from_secs(5), async {
        while voice.input_level() != 0.75 {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("the input volume reached the sidecar at connection");
    let screens = voice.screens().await.unwrap();
    assert_eq!(
        screens.iter().map(|s| (s.id.as_str(), s.kind)).collect::<Vec<_>>(),
        [("screen:0", ScreenKind::Screen), ("window:7", ScreenKind::Window)]
    );
    until_frame(&voice, &thumbnail("window:7"), VideoSource::Screen, true).await;
    voice.disconnect().await;
    assert_eq!(voice.input_level(), 0.0);
    assert_eq!(voice.listening(), listening, "kept for the next session");
}
