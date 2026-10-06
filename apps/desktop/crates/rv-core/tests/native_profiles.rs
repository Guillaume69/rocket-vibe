mod common;
use common::{FakeHttp, respond};
use rv_core::{
    native::{
        Identity, NativeSession,
        store::{NativeStore, ProfileOperation},
    },
    session::{Connection, SessionInfo},
};
use rv_protocol::{
    Snapshot,
    profiles::{ProfileReceipt, ProfileStamp, UpdateProfile},
};
use serde_json::{Value, json};
use std::{
    path::Path,
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};
fn fixture() -> Value {
    serde_json::from_str(include_str!("../../../../../docs/protocol/v1.fixture.json")).unwrap()
}
fn identity() -> Identity {
    Identity { instance_id: "fixture-instance".into(), data_epoch: "fixture-epoch".into() }
}
fn snapshot() -> Snapshot {
    Snapshot { protocol_version: 1, rooms: vec![], messages: vec![], cursor: "original".into() }
}
fn command(id: &str, revision: &str) -> ProfileOperation {
    ProfileOperation::Profile {
        input: UpdateProfile {
            operation_id: id.into(),
            expected_revision: revision.into(),
            username: "alice".into(),
            display_name: "Alice".into(),
            bio: "Desired bio".into(),
            status: rv_protocol::live::PresenceStatus::Busy,
            status_text: "Working".into(),
        },
    }
}
#[test]
fn profile_forms_survive_reopen_and_normal_reset_but_never_cross_authority() {
    let path = std::env::temp_dir().join(format!("rv-profile-{:032x}.sqlite", fastrand::u128(..)));
    let store = NativeStore::open(&path, identity()).unwrap();
    store.snapshot(&snapshot()).unwrap();
    store.stage_profile_operation(command("original", "original-revision")).unwrap();
    drop(store);
    let store = NativeStore::open(&path, identity()).unwrap();
    let saved = store.stage_profile_operation(command("replacement", "newer-revision")).unwrap().unwrap();
    assert_eq!(saved.command.id(), "original");
    assert_eq!(saved.command.revision(), "original-revision");
    store.snapshot(&snapshot()).unwrap();
    assert!(store.profile_operation("profile").unwrap().is_some());
    assert!(!store.dismiss_profile_operation("profile", "original").unwrap());
    store.mark_profile_operation(&saved, "proof", Some("reauthentication_required")).unwrap();
    assert!(store.pending_profile_operations().unwrap().is_empty());
    store.mark_profile_operation(&saved, "failed", Some("profile_conflict")).unwrap();
    assert!(store.stage_profile_operation(command("other", "fresh")).unwrap().is_none());
    assert!(store.dismiss_profile_operation("profile", "original").unwrap());
    store.stage_profile_operation(command("next", "fresh")).unwrap();
    store
        .confirm_profile_operation(
            &saved,
            &ProfileReceipt { operation_id: "original".into(), applied_revision: "applied".into() },
            || true,
        )
        .unwrap();
    assert_eq!(store.profile_operation("profile").unwrap().unwrap().command.id(), "next");
    drop(store);
    let store = NativeStore::open(&path, Identity { data_epoch: "new-generation".into(), ..identity() }).unwrap();
    assert!(store.profile_operation("profile").unwrap().is_none());
    store.snapshot(&snapshot()).unwrap();
    assert!(store.profile_operation("profile").unwrap().is_none());
    drop(store);
    std::fs::remove_file(path).unwrap();
}
#[test]
fn public_identity_changes_refresh_names_without_mutating_journal_positions_or_receipts() {
    let store = NativeStore::open(Path::new(":memory:"), identity()).unwrap();
    let f = fixture();
    store
        .snapshot(&Snapshot {
            protocol_version: 1,
            rooms: vec![serde_json::from_value(f["room"].clone()).unwrap()],
            messages: vec![serde_json::from_value(f["message"].clone()).unwrap()],
            cursor: "original".into(),
        })
        .unwrap();
    let uid = f["message"]["author"]["id"].as_str().unwrap();
    let room = f["room"]["id"].as_str().unwrap();
    let before = store.messages(room, 50).unwrap();
    let mut stamp: ProfileStamp = serde_json::from_value(f["own_profile"]["profile"].clone()).unwrap();
    stamp.user.id = uid.into();
    stamp.user.username = "current-name".into();
    stamp.revision = "public-revision".into();
    stamp.avatar_file_id = Some("a".repeat(64));
    store.profile_identities(&[stamp.clone()], || true).unwrap();
    let version = store.profile_version().unwrap();
    store.profile_identities(&[stamp], || true).unwrap();
    assert_eq!(store.profile_version().unwrap(), version);
    let after = store.messages(room, 50).unwrap();
    assert_eq!(after[0].author, "current-name");
    assert_eq!(after[0].position, before[0].position);
    assert_eq!(store.cursor().unwrap().as_deref(), Some("original"));
    assert!(store.avatar_current(&"a".repeat(64)).unwrap());
    let saved = store.stage_profile_operation(command("original", "revision")).unwrap().unwrap();
    let alive = AtomicUsize::new(0);
    assert!(
        store
            .confirm_profile_operation(
                &saved,
                &ProfileReceipt { operation_id: "original".into(), applied_revision: "applied".into() },
                || alive.fetch_add(1, Ordering::SeqCst) == 0
            )
            .is_err()
    );
    assert!(store.profile_operation("profile").unwrap().is_some());
}
#[test]
fn direct_peer_identity_survives_offline_and_tracks_profile_changes_only_for_current_membership() {
    let path = std::env::temp_dir().join(format!("rv-direct-peer-{:032x}.sqlite", fastrand::u128(..)));
    let store = NativeStore::open(&path, identity()).unwrap();
    let f = fixture();
    let mut room: rv_protocol::Room = serde_json::from_value(f["room"].clone()).unwrap();
    room.kind = rv_protocol::RoomKind::Direct;
    let mut read: rv_protocol::parity::ReadState = serde_json::from_value(f["parity"]["read_state"].clone()).unwrap();
    read.membership_version = Some("first-grant".into());
    room.read_state = Some(Box::new(read));
    let mut snap =
        Snapshot { protocol_version: 1, rooms: vec![room.clone()], messages: vec![], cursor: "original".into() };
    store.snapshot(&snap).unwrap();
    let mut stamp: ProfileStamp = serde_json::from_value(f["own_profile"]["profile"].clone()).unwrap();
    stamp.avatar_file_id = Some("a".repeat(64));
    let frame = rv_protocol::live::LiveState {
        emoji_catalog_revision: None,
        profiles: vec![stamp.clone()],
        ttl_ms: 8000,
        limited: false,
        presence: vec![],
        rooms: vec![rv_protocol::live::LiveRoom {
            room_id: room.id.clone(),
            membership_version: "first-grant".into(),
            direct_peer: Some(stamp.user.clone()),
            typing: vec![],
            voice: vec![],
        }],
        rings: vec![],
    };
    // A response cancelled during the transaction cannot partially publish a peer or avatar.
    let alive = AtomicUsize::new(0);
    assert!(store.live_profiles(&frame, || alive.fetch_add(1, Ordering::SeqCst) == 0).is_err());
    assert!(store.direct_peer(&room.id).unwrap().is_none());
    assert!(!store.avatar_current(&"a".repeat(64)).unwrap());
    let mut changes = store.changes();
    store.live_profiles(&frame, || true).unwrap();
    assert!(changes.try_recv().is_ok(), "a new peer is a change");
    let peer = store.direct_peer(&room.id).unwrap().unwrap();
    assert_eq!(peer.user.id, stamp.user.id);
    assert_eq!(peer.avatar_file_id, stamp.avatar_file_id);
    // The same frame again (live frames repeat every few seconds) changes nothing,
    // so nothing reloads: an open encrypted room would decrypt its history again.
    store.live_profiles(&frame, || true).unwrap();
    assert!(changes.try_recv().is_err(), "a repeated live frame is not a change");
    drop(store);
    let store = NativeStore::open(&path, identity()).unwrap();
    store.snapshot(&snap).unwrap();
    assert_eq!(store.direct_peer(&room.id).unwrap().unwrap().user.id, stamp.user.id);
    stamp.user.username = "renamed".into();
    stamp.user.display_name = "New display name".into();
    stamp.revision = "new-profile".into();
    stamp.avatar_file_id = None;
    store.profile_identities(&[stamp.clone()], || true).unwrap();
    let peer = store.direct_peer(&room.id).unwrap().unwrap();
    assert_eq!(peer.user.username, "renamed");
    assert_eq!(peer.user.display_name, "New display name");
    assert!(peer.avatar_file_id.is_none());
    assert!(!store.avatar_current(&"a".repeat(64)).unwrap());
    assert_eq!(store.read_state(&room.id).unwrap(), room.read_state.as_deref().cloned());
    assert_eq!(store.cursor().unwrap().as_deref(), Some("original"));
    let next = snap.rooms[0].read_state.as_mut().unwrap();
    next.membership_version = Some("second-grant".into());
    next.revision = "9007199254740994".into();
    store.snapshot(&snap).unwrap();
    assert!(store.direct_peer(&room.id).unwrap().is_none());
    assert!(store.live_profiles(&frame, || true).is_err());
    assert!(store.direct_peer(&room.id).unwrap().is_none());
    let mut new_frame = frame;
    new_frame.rooms[0].membership_version = "second-grant".into();
    store.live_profiles(&new_frame, || true).unwrap();
    drop(store);
    let store = NativeStore::open(&path, Identity { data_epoch: "other-authority".into(), ..identity() }).unwrap();
    assert!(store.direct_peer(&room.id).unwrap().is_none());
    store.snapshot(&snap).unwrap();
    assert!(store.direct_peer(&room.id).unwrap().is_none());
    drop(store);
    std::fs::remove_file(path).unwrap();
}
#[tokio::test]
async fn native_profile_replay_retains_the_original_form_and_reads_current_private_data() {
    let f = fixture();
    let mut discovery = f["discovery"].clone();
    discovery["capabilities"]["profiles"] = json!(true);
    discovery["capabilities"]["presence"] = json!(false);
    discovery["capabilities"]["typing"] = json!(false);
    let current = Arc::new(Mutex::new(f["own_profile"].clone()));
    let writes = Arc::new(Mutex::new(Vec::<Value>::new()));
    let (data, posted) = (current.clone(), writes.clone());
    let server = FakeHttp::start(move |request| match (request.method.as_str(), request.path()) {
        (_, "/.well-known/rocketvibe") => respond(200, &discovery.to_string()),
        ("GET", "/api/v1/me") => respond(200, &f["session"]["user"].to_string()),
        (_, "/api/v1/sync/changes") => {
            respond(200, &json!({"protocol_version":1,"changes":[],"cursor":"original","has_more":false}).to_string())
        }
        (_, "/api/v1/sync/ticket") => respond(200, &f["socket_ticket"].to_string()),
        (_, "/api/v1/sync/socket") => common::Response { websocket: true, ..Default::default() },
        ("GET", "/api/v1/me/profile") => respond(200, &data.lock().unwrap().to_string()),
        ("PATCH", "/api/v1/me") => {
            assert_eq!(request.headers.get("authorization").map(String::as_str), Some("Bearer fixture-token"));
            let value: Value = serde_json::from_str(&request.body).unwrap();
            let mut attempts = posted.lock().unwrap();
            attempts.push(value.clone());
            if attempts.len() == 1 {
                let mut own = data.lock().unwrap();
                own["profile"]["revision"] = json!("newer");
                own["profile"]["bio"] = json!("Newer remote bio");
                common::dropped()
            } else {
                assert_eq!(value, attempts[0]);
                respond(
                    200,
                    &json!({"operation_id":value["operation_id"],"applied_revision":"original-application"})
                        .to_string(),
                )
            }
        }
        _ => respond(404, r#"{"code":"not_found","request_id":"fixture"}"#),
    })
    .await;
    let path = std::env::temp_dir().join(format!("rv-profile-http-{:032x}.sqlite", fastrand::u128(..)));
    let store = NativeStore::open(&path, identity()).unwrap();
    store.snapshot(&snapshot()).unwrap();
    drop(store);
    let session = NativeSession::start(
        SessionInfo {
            base_url: server.url.to_string(),
            user_id: "alice-id".into(),
            username: "alice".into(),
            auth_token: "fixture-token".into(),
            native: Some(identity()),
        },
        &path,
    )
    .unwrap();
    tokio::time::timeout(Duration::from_secs(5), async {
        while session.status().connection != Connection::Online {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    let own = session.own_profile().await.unwrap();
    assert_eq!(own.email, current.lock().unwrap()["email"].as_str().map(String::from));
    let failed = session.change_profile(command("original", "original-revision")).await;
    assert!(failed.is_err());
    tokio::time::timeout(Duration::from_secs(6), async {
        while session.store.profile_operation("profile").unwrap().is_some() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    assert_eq!(session.store.profile_identity("alice-id").unwrap().unwrap().revision, "newer");
    assert_eq!(session.resume_profile_operation("profile").await.unwrap().profile.bio, "Newer remote bio");
    assert!(writes.lock().unwrap().len() >= 2);
    common::close_native(session).await;
    std::fs::remove_file(path).unwrap();
}
