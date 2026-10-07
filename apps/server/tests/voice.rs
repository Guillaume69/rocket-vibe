//! Voice sessions against a fake LiveKit RoomService (Twirp over HTTP).
use axum::{
    Json, Router,
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::post,
};
use data_encoding::BASE64URL_NOPAD;
use hmac::{Hmac, Mac};
use rv_client::{Error, NativeClient};
use rv_protocol::{
    CreateRoom,
    live::LiveFrame,
    voice::{AnswerRing, JoinVoice, RingState},
};
use rv_server::{App, auth, livekit::LiveKit};
use serde_json::{Value, json};
use sha2::Sha256;
use sqlx::PgPool;
use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex},
    time::Duration,
};

const SECRET: &str = "native-livekit-disposable-shared-secret-2026";
const PASSWORD: &str = "native-voice-disposable-password";

#[derive(Default)]
struct Sfu {
    rooms: BTreeMap<String, Vec<Value>>,
    removed: Vec<(String, String)>,
    /// (room, identity, sources) of each UpdateParticipant, sources sorted.
    permissions: Vec<(String, String, Vec<String>)>,
}
type Shared = Arc<Mutex<Sfu>>;

fn claims(token: &str) -> Value {
    let parts: Vec<_> = token.split('.').collect();
    assert_eq!(parts.len(), 3);
    let mut mac = Hmac::<Sha256>::new_from_slice(SECRET.as_bytes()).unwrap();
    mac.update(format!("{}.{}", parts[0], parts[1]).as_bytes());
    assert_eq!(
        BASE64URL_NOPAD.encode(&mac.finalize().into_bytes()),
        parts[2],
        "token signed with the shared secret"
    );
    serde_json::from_slice(&BASE64URL_NOPAD.decode(parts[1].as_bytes()).unwrap()).unwrap()
}

async fn twirp(
    State(sfu): State<Shared>,
    Path(method): Path<String>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    let bearer = headers["authorization"].to_str().unwrap();
    let admin = claims(bearer.strip_prefix("Bearer ").unwrap());
    assert_eq!(admin["video"]["roomAdmin"], true);
    let mut sfu = sfu.lock().unwrap();
    let room = body["room"].as_str().unwrap_or_default().to_owned();
    if method != "ListRooms" {
        assert_eq!(
            admin["video"]["room"], room,
            "admin token scoped to the room"
        );
    }
    match method.as_str() {
        "ListRooms" => {
            Json(json!({"rooms": sfu.rooms.keys().map(|name| json!({"name": name})).collect::<Vec<_>>()}))
                .into_response()
        }
        "ListParticipants" => match sfu.rooms.get(&room) {
            Some(list) => Json(json!({"participants": list})).into_response(),
            None => (StatusCode::NOT_FOUND, Json(json!({"code":"not_found"}))).into_response(),
        },
        "RemoveParticipant" => {
            let identity = body["identity"].as_str().unwrap().to_owned();
            if let Some(list) = sfu.rooms.get_mut(&room) {
                list.retain(|p| p["identity"] != identity.as_str());
            }
            sfu.removed.push((room, identity));
            Json(json!({})).into_response()
        }
        "UpdateParticipant" => {
            let identity = body["identity"].as_str().unwrap().to_owned();
            let mut sources: Vec<String> = body["permission"]["can_publish_sources"]
                .as_array()
                .unwrap()
                .iter()
                .map(|v| v.as_str().unwrap().to_owned())
                .collect();
            sources.sort();
            assert_eq!(body["permission"]["can_publish"], !sources.is_empty());
            if let Some(p) = sfu
                .rooms
                .get_mut(&room)
                .and_then(|list| list.iter_mut().find(|p| p["identity"] == identity.as_str()))
            {
                p["permission"] = json!({"can_publish": !sources.is_empty(), "can_publish_sources": sources});
            }
            sfu.permissions.push((room, identity, sources));
            Json(json!({})).into_response()
        }
        _ => StatusCode::NOT_IMPLEMENTED.into_response(),
    }
}

fn participant(identity: &str, muted: bool, deafened: bool) -> Value {
    let mut p = json!({"identity": identity, "permission": {"canPublish": true, "canPublishSources": ["MICROPHONE", "CAMERA"]},
        "tracks": [{"source": "MICROPHONE", "type": "AUDIO", "muted": muted}]});
    if deafened {
        p["attributes"] = json!({"rv.deafened": "1"});
    }
    p
}

struct Bench {
    app: App,
    base: String,
    sfu: Shared,
    tasks: Vec<tokio::task::JoinHandle<()>>,
}
impl Drop for Bench {
    fn drop(&mut self) {
        self.tasks.iter().for_each(|t| t.abort());
    }
}
impl Bench {
    async fn new(pool: PgPool) -> Self {
        let sfu = Shared::default();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let api = format!("http://{}", listener.local_addr().unwrap());
        let fake = Router::new()
            .route("/twirp/livekit.RoomService/{method}", post(twirp))
            .with_state(sfu.clone());
        let sfu_task = tokio::spawn(async move { axum::serve(listener, fake).await.unwrap() });
        let config = json!({"url":"ws://127.0.0.1:7880","api_url":api,"api_key":"rocketvibe","api_secret":SECRET});
        let livekit = LiveKit::parse(&serde_json::to_vec(&config).unwrap()).unwrap();
        let app = App::from_pool(pool)
            .await
            .unwrap()
            .with_livekit(Some(livekit));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let router = app.clone().router();
        let task = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        Self {
            app,
            base,
            sfu,
            tasks: vec![sfu_task, task],
        }
    }
    async fn user(&self, name: &str) -> (NativeClient, String) {
        let uid = auth::create_user(&self.app, name, PASSWORD.into(), false)
            .await
            .unwrap()
            .id;
        let mut c = NativeClient::new(&self.base).unwrap();
        c.login(name, PASSWORD).await.unwrap();
        (c, uid)
    }
    async fn room(&self, c: &NativeClient, voice: bool) -> String {
        c.create_room(&CreateRoom {
            name: "Lounge".into(),
            private: true,
            operation_id: Some(auth::random_token()),
            voice,
        })
        .await
        .unwrap()
        .id
    }
    async fn input(&self, c: &NativeClient, room: &str, ring: bool) -> JoinVoice {
        JoinVoice {
            membership_version: c
                .room_read_state(room)
                .await
                .unwrap()
                .membership_version
                .unwrap(),
            data_epoch: c.discover().await.unwrap().data_epoch,
            ring,
            e2ee: false,
        }
    }
    async fn epoch(&self, c: &NativeClient) -> String {
        c.discover().await.unwrap().data_epoch
    }
    fn connect(&self, room: &str, p: Value) {
        self.sfu
            .lock()
            .unwrap()
            .rooms
            .entry(room.into())
            .or_default()
            .push(p);
    }
    fn disconnect(&self, room: &str, identity: &str) {
        if let Some(list) = self.sfu.lock().unwrap().rooms.get_mut(room) {
            list.retain(|p| p["identity"] != identity);
        }
    }
    async fn reconcile(&self) {
        rv_server::voice::reconcile(&self.app).await.unwrap();
    }
}

async fn live(c: &NativeClient) -> rv_protocol::live::LiveState {
    let LiveFrame::Live(state) = c.live_state().await.unwrap();
    state
}
fn refused<T>(value: std::result::Result<T, Error>, status: u16, code: &str) {
    match value {
        Err(Error::Server {
            status: s, code: c, ..
        }) => {
            assert_eq!((s, c.as_str()), (status, code));
        }
        _ => panic!("expected {status} {code}"),
    }
}

#[sqlx::test]
async fn members_get_a_microphone_grant_and_the_worker_mirrors_the_sfu(pool: PgPool) {
    let b = Bench::new(pool).await;
    let (alice, alice_id) = b.user("voice-alice").await;
    let (bob, bob_id) = b.user("voice-bob").await;
    assert!(alice.discover().await.unwrap().capabilities.voice);
    let room = b.room(&alice, true).await;
    assert!(alice.room_details(&room).await.unwrap().voice);

    let grant = alice
        .join_voice(&room, &b.input(&alice, &room, false).await)
        .await
        .unwrap();
    let epoch = b.epoch(&alice).await;
    let sfu_room = format!("rv:{epoch}:{room}");
    let token = claims(&grant.token);
    assert_eq!(grant.url, "ws://127.0.0.1:7880");
    assert!(grant.can_publish && grant.ring.is_none());
    assert_eq!(token["sub"], alice_id.as_str());
    assert_eq!(token["iss"], "rocketvibe");
    assert_eq!(token["video"]["room"], sfu_room.as_str());
    assert_eq!(
        token["video"]["canPublishSources"],
        json!(["microphone", "camera"])
    );
    assert_eq!(token["video"]["canPublishData"], false);

    // A non-member gets nothing; stale grants are refused.
    refused(
        bob.join_voice(&room, &b.input(&alice, &room, false).await)
            .await,
        404,
        "not_found",
    );
    let mut stale = b.input(&alice, &room, false).await;
    stale.membership_version = "stale".into();
    refused(
        alice.join_voice(&room, &stale).await,
        409,
        "membership_replaced",
    );
    let mut stale = b.input(&alice, &room, false).await;
    stale.data_epoch = "stale".into();
    refused(
        alice.join_voice(&room, &stale).await,
        409,
        "data_epoch_changed",
    );

    // Joining is not being there: only what the SFU reports shows.
    b.reconcile().await;
    assert!(live(&alice).await.rooms[0].voice.is_empty());
    b.connect(&sfu_room, participant(&alice_id, false, true));
    // Bob is no member: the worker removes him from the SFU.
    b.connect(&sfu_room, participant(&bob_id, false, false));
    b.reconcile().await;
    let state = live(&alice).await;
    let voice = &state
        .rooms
        .iter()
        .find(|r| r.room_id == room)
        .unwrap()
        .voice;
    assert_eq!(voice.len(), 1);
    assert_eq!(voice[0].user.id, alice_id);
    assert!(!voice[0].muted && voice[0].deafened);
    assert!(
        b.sfu
            .lock()
            .unwrap()
            .removed
            .contains(&(sfu_room.clone(), bob_id.clone()))
    );

    // Leaving the SFU ends the session.
    b.disconnect(&sfu_room, &alice_id);
    b.reconcile().await;
    assert!(live(&alice).await.rooms.iter().all(|r| r.voice.is_empty()));
}

#[sqlx::test]
async fn joining_another_room_moves_the_account_and_read_only_rooms_listen(pool: PgPool) {
    let b = Bench::new(pool).await;
    let (alice, alice_id) = b.user("move-alice").await;
    let (bob, bob_id) = b.user("move-bob").await;
    let first = b.room(&alice, true).await;
    let second = b.room(&alice, false).await;
    alice.add_member(&second, &bob_id).await.unwrap();
    let epoch = b.epoch(&alice).await;
    alice
        .join_voice(&first, &b.input(&alice, &first, false).await)
        .await
        .unwrap();
    b.connect(
        &format!("rv:{epoch}:{first}"),
        participant(&alice_id, false, false),
    );
    b.reconcile().await;
    alice
        .join_voice(&second, &b.input(&alice, &second, false).await)
        .await
        .unwrap();
    // The SFU missed the immediate eviction? The worker repeats it.
    b.connect(
        &format!("rv:{epoch}:{first}"),
        participant(&alice_id, false, false),
    );
    b.reconcile().await;
    tokio::time::sleep(Duration::from_millis(200)).await;
    let removed = b.sfu.lock().unwrap().removed.clone();
    assert!(removed.contains(&(format!("rv:{epoch}:{first}"), alice_id.clone())));

    // A read-only room: a plain member listens, the worker revokes publishing.
    let details = alice.room_details(&second).await.unwrap();
    alice
        .update_room(
            &second,
            &rv_protocol::parity::UpdateRoom {
                operation_id: auth::random_token(),
                expected_revision: details.revision,
                name: details.room.name,
                private: true,
                topic: details.topic,
                description: details.description,
                announcement: details.announcement,
                read_only: true,
                voice: None,
            },
        )
        .await
        .unwrap();
    let grant = bob
        .join_voice(&second, &b.input(&bob, &second, false).await)
        .await
        .unwrap();
    assert!(!grant.can_publish);
    assert_eq!(claims(&grant.token)["video"]["canPublish"], false);
    b.connect(
        &format!("rv:{epoch}:{second}"),
        participant(&bob_id, true, false),
    );
    b.reconcile().await;
    let permissions = b.sfu.lock().unwrap().permissions.clone();
    assert!(permissions.contains(&(format!("rv:{epoch}:{second}"), bob_id.clone(), vec![])));
    // The settings change kept the voice flag of a room that never had one.
    assert!(!alice.room_details(&second).await.unwrap().voice);
}

#[sqlx::test]
async fn direct_calls_ring_and_their_row_carries_the_outcome(pool: PgPool) {
    let b = Bench::new(pool.clone()).await;
    let (alice, alice_id) = b.user("ring-alice").await;
    let (bob, bob_id) = b.user("ring-bob").await;
    let direct = alice.direct(&bob_id).await.unwrap().id;
    let epoch = b.epoch(&alice).await;
    let sfu_room = format!("rv:{epoch}:{direct}");
    sqlx::query("INSERT INTO push_devices(device_id,user_id,data_epoch,token) SELECT s.device_id,s.user_id,$2,'fcm-token' FROM sessions s WHERE s.user_id=$1")
        .bind(&bob_id).bind(&epoch).execute(&pool).await.unwrap();

    // Declined.
    let grant = alice
        .join_voice(&direct, &b.input(&alice, &direct, true).await)
        .await
        .unwrap();
    let ring = grant.ring.unwrap();
    assert_eq!(
        (ring.state, ring.callee.id.as_str()),
        (RingState::Ringing, bob_id.as_str())
    );
    assert!(ring.expires_in_ms > 25_000);
    assert_eq!(live(&bob).await.rings[0].id, ring.id);
    assert_eq!(bob.voice_ring(&ring.id).await.unwrap().caller.id, alice_id);
    let pushes: i64 =
        sqlx::query_scalar("SELECT count(*) FROM voice_pushes WHERE ring_id=$1 AND kind='ring'")
            .bind(&ring.id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(pushes, 1);
    refused(alice.decline_ring(&ring.id).await, 403, "permission_denied");
    bob.decline_ring(&ring.id).await.unwrap();
    let call = |page: rv_protocol::MessagePage, id: &str| {
        page.messages
            .into_iter()
            .find(|m| matches!(m.system.as_deref(), Some(rv_protocol::system::SystemMessage::CallStarted { meeting_id }) if meeting_id == id))
            .unwrap()
            .call
            .unwrap()
    };
    assert_eq!(
        call(bob.history(&direct, None).await.unwrap(), &ring.id).state,
        RingState::Declined
    );
    assert_eq!(live(&alice).await.rings[0].state, RingState::Declined);
    let ends: i64 =
        sqlx::query_scalar("SELECT count(*) FROM voice_pushes WHERE ring_id=$1 AND kind='end'")
            .bind(&ring.id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(ends, 1);

    // Missed.
    alice.leave_voice().await.unwrap();
    let ring = alice
        .join_voice(&direct, &b.input(&alice, &direct, true).await)
        .await
        .unwrap()
        .ring
        .unwrap();
    b.connect(&sfu_room, participant(&alice_id, false, false));
    sqlx::query("UPDATE voice_rings SET expires_at=clock_timestamp() WHERE id=$1")
        .bind(&ring.id)
        .execute(&pool)
        .await
        .unwrap();
    b.reconcile().await;
    assert_eq!(
        call(alice.history(&direct, None).await.unwrap(), &ring.id).state,
        RingState::Missed
    );

    // Cancelled: the caller leaves first.
    let ring = alice
        .join_voice(&direct, &b.input(&alice, &direct, true).await)
        .await
        .unwrap()
        .ring
        .unwrap();
    b.disconnect(&sfu_room, &alice_id);
    alice.leave_voice().await.unwrap();
    assert_eq!(
        bob.voice_ring(&ring.id).await.unwrap().state,
        RingState::Cancelled
    );

    // Answered, then over: the row gets the call's duration.
    let ring = alice
        .join_voice(&direct, &b.input(&alice, &direct, true).await)
        .await
        .unwrap()
        .ring
        .unwrap();
    b.connect(&sfu_room, participant(&alice_id, false, false));
    let answer = AnswerRing {
        membership_version: b.input(&bob, &direct, false).await.membership_version,
        data_epoch: epoch.clone(),
        e2ee: false,
    };
    let grant = bob.accept_ring(&ring.id, &answer).await.unwrap();
    assert_eq!(grant.ring.unwrap().state, RingState::Answered);
    refused(bob.accept_ring(&ring.id, &answer).await, 409, "ring_ended");
    b.connect(&sfu_room, participant(&bob_id, true, false));
    b.reconcile().await;
    assert_eq!(
        *call(alice.history(&direct, None).await.unwrap(), &ring.id),
        rv_protocol::voice::CallSummary {
            state: RingState::Answered,
            duration_seconds: None
        }
    );
    sqlx::query("UPDATE voice_rings SET answered_at=answered_at-interval '75 seconds' WHERE id=$1")
        .bind(&ring.id)
        .execute(&pool)
        .await
        .unwrap();
    b.disconnect(&sfu_room, &alice_id);
    b.disconnect(&sfu_room, &bob_id);
    b.reconcile().await;
    let summary = call(alice.history(&direct, None).await.unwrap(), &ring.id);
    assert_eq!(summary.state, RingState::Answered);
    assert!(
        summary
            .duration_seconds
            .is_some_and(|d| (75..80).contains(&d))
    );
}

#[sqlx::test]
async fn calling_back_answers_and_a_busy_callee_gets_no_push(pool: PgPool) {
    let b = Bench::new(pool.clone()).await;
    let (alice, _) = b.user("back-alice").await;
    let (bob, bob_id) = b.user("back-bob").await;
    let direct = alice.direct(&bob_id).await.unwrap().id;
    let epoch = b.epoch(&alice).await;
    sqlx::query("UPDATE users SET chosen_status='busy' WHERE id=$1")
        .bind(&bob_id)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO push_devices(device_id,user_id,data_epoch,token) SELECT s.device_id,s.user_id,$2,'fcm-token' FROM sessions s WHERE s.user_id=$1")
        .bind(&bob_id).bind(&epoch).execute(&pool).await.unwrap();
    let ring = alice
        .join_voice(&direct, &b.input(&alice, &direct, true).await)
        .await
        .unwrap()
        .ring
        .unwrap();
    let pushes: i64 = sqlx::query_scalar("SELECT count(*) FROM voice_pushes WHERE ring_id=$1")
        .bind(&ring.id)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(pushes, 0);
    // Bob calls back while it rings: that answers Alice's call, no second ring.
    let grant = bob
        .join_voice(&direct, &b.input(&bob, &direct, true).await)
        .await
        .unwrap();
    let answered = grant.ring.unwrap();
    assert_eq!(
        (answered.id, answered.state),
        (ring.id, RingState::Answered)
    );
}

#[sqlx::test]
async fn voice_flag_follows_settings_and_old_commands_keep_it(pool: PgPool) {
    let b = Bench::new(pool).await;
    let (alice, _) = b.user("flag-alice").await;
    let room = b.room(&alice, false).await;
    let details = alice.room_details(&room).await.unwrap();
    let mut update = rv_protocol::parity::UpdateRoom {
        operation_id: auth::random_token(),
        expected_revision: details.revision,
        name: details.room.name,
        private: true,
        topic: details.topic,
        description: details.description,
        announcement: details.announcement,
        read_only: false,
        voice: Some(true),
    };
    alice.update_room(&room, &update).await.unwrap();
    let details = alice.room_details(&room).await.unwrap();
    assert!(details.voice && details.room.voice);
    // A client predating voice sends no flag: the channel stays a voice channel.
    update.operation_id = auth::random_token();
    update.expected_revision = details.revision;
    update.topic = "Lo-fi".into();
    update.voice = None;
    alice.update_room(&room, &update).await.unwrap();
    assert!(alice.room_details(&room).await.unwrap().voice);
    // A replayed creation must ask for the same kind of room.
    let create = CreateRoom {
        name: "Replay".into(),
        private: true,
        operation_id: Some(auth::random_token()),
        voice: true,
    };
    let created = alice.create_room(&create).await.unwrap();
    assert!(created.voice);
    refused(
        alice
            .create_room(&CreateRoom {
                voice: false,
                ..create
            })
            .await,
        409,
        "operation_conflict",
    );
}

#[sqlx::test]
async fn one_screen_share_per_room_and_the_sfu_follows_the_claim(pool: PgPool) {
    let b = Bench::new(pool).await;
    let (alice, alice_id) = b.user("screen-alice").await;
    let (bob, bob_id) = b.user("screen-bob").await;
    let room = b.room(&alice, true).await;
    alice.add_member(&room, &bob_id).await.unwrap();
    let epoch = b.epoch(&alice).await;
    let sfu_room = format!("rv:{epoch}:{room}");
    // Only a connected session shares.
    refused(alice.claim_screen().await, 409, "voice_not_connected");
    for (client, id) in [(&alice, &alice_id), (&bob, &bob_id)] {
        client
            .join_voice(&room, &b.input(client, &room, false).await)
            .await
            .unwrap();
        let mut p = participant(id, false, false);
        if id == &alice_id {
            p["tracks"]
                .as_array_mut()
                .unwrap()
                .push(json!({"source": "CAMERA", "type": "VIDEO"}));
        }
        b.connect(&sfu_room, p);
    }
    b.reconcile().await;
    alice.claim_screen().await.unwrap();
    let share = vec![
        "CAMERA".to_owned(),
        "MICROPHONE".into(),
        "SCREEN_SHARE".into(),
        "SCREEN_SHARE_AUDIO".into(),
    ];
    assert!(b.sfu.lock().unwrap().permissions.contains(&(
        sfu_room.clone(),
        alice_id.clone(),
        share.clone()
    )));
    // Claiming again is harmless; the live snapshot shows who shares and who films.
    alice.claim_screen().await.unwrap();
    b.reconcile().await;
    let shares = |state: &rv_protocol::live::LiveState, id: &str| {
        let voice = &state
            .rooms
            .iter()
            .find(|r| r.room_id == room)
            .unwrap()
            .voice;
        voice
            .iter()
            .find(|v| v.user.id == id)
            .map(|v| (v.screen, v.camera))
    };
    let state = live(&bob).await;
    assert_eq!(shares(&state, &alice_id), Some((true, true)));
    assert_eq!(shares(&state, &bob_id), Some((false, false)));
    // A new share replaces the current one: alice's screen source goes at once.
    bob.claim_screen().await.unwrap();
    let permissions = b.sfu.lock().unwrap().permissions.clone();
    assert!(permissions.contains(&(
        sfu_room.clone(),
        alice_id.clone(),
        vec!["CAMERA".into(), "MICROPHONE".into()]
    )));
    assert!(permissions.contains(&(sfu_room.clone(), bob_id.clone(), share.clone())));
    let state = live(&bob).await;
    assert_eq!(shares(&state, &alice_id), Some((false, true)));
    assert_eq!(shares(&state, &bob_id), Some((true, false)));
    // Releasing someone else's share is not a thing: alice's release is hers only.
    alice.release_screen().await.unwrap();
    assert_eq!(shares(&live(&bob).await, &bob_id), Some((true, false)));
    // Leaving drops the claim.
    bob.leave_voice().await.unwrap();
    b.disconnect(&sfu_room, &bob_id);
    b.reconcile().await;
    alice.claim_screen().await.unwrap();
}

#[sqlx::test]
async fn an_encrypted_room_takes_only_encrypted_voice(pool: PgPool) {
    let b = Bench::new(pool.clone()).await;
    let (alice, alice_id) = b.user("crypt-alice").await;
    let (_bob, bob_id) = b.user("crypt-bob").await;
    let room = b.room(&alice, true).await;
    alice.add_member(&room, &bob_id).await.unwrap();
    let epoch = b.epoch(&alice).await;
    sqlx::query("INSERT INTO e2ee_groups(room_id,data_epoch,incarnation,revision,epoch,fingerprint,transition,tree,receipt) VALUES($1,$2,'i',1,1,'f',$3,$3,'{}')")
        .bind(&room).bind(&epoch).bind(vec![0u8]).execute(&pool).await.unwrap();
    // A client that cannot encrypt its frames stays out.
    refused(
        alice
            .join_voice(&room, &b.input(&alice, &room, false).await)
            .await,
        403,
        "voice_encrypted_room",
    );
    let mut input = b.input(&alice, &room, false).await;
    input.e2ee = true;
    let grant = alice.join_voice(&room, &input).await.unwrap();
    assert!(grant.e2ee, "the client is told to encrypt");
    // The encrypted session has its own LiveKit room, which the worker keeps.
    let sfu_room = format!("rve:{epoch}:{room}");
    assert_eq!(claims(&grant.token)["video"]["room"], sfu_room.as_str());
    b.connect(&sfu_room, participant(&alice_id, false, false));
    // A plaintext participant left from before the group existed is evicted.
    let plain = format!("rv:{epoch}:{room}");
    b.connect(&plain, participant(&bob_id, false, false));
    b.reconcile().await;
    let removed = b.sfu.lock().unwrap().removed.clone();
    assert!(!removed.iter().any(|(_, id)| id == &alice_id));
    assert!(removed.contains(&(plain, bob_id.clone())));
    let voice = live(&alice)
        .await
        .rooms
        .into_iter()
        .find(|r| r.room_id == room)
        .unwrap()
        .voice;
    assert_eq!(voice.len(), 1);
    assert_eq!(voice[0].user.id, alice_id);
}
