use reqwest::{Client, Method, StatusCode};
use rv_client::NativeClient;
use rv_protocol::{
    Change, CreateRoom, SendMessage,
    parity::{DeleteMessage, LeaveRoom, MarkRead, SetRoomFavorite},
};
use rv_server::{App, auth};
use serde_json::{Value, json};
use sqlx::PgPool;
struct Bench {
    app: App,
    base: String,
    http: Client,
    task: tokio::task::JoinHandle<()>,
}
impl Drop for Bench {
    fn drop(&mut self) {
        self.task.abort();
    }
}
impl Bench {
    async fn start(pool: PgPool) -> Self {
        let app = App::from_pool(pool).await.unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let router = app.clone().router();
        let task = tokio::spawn(async move {
            axum::serve(
                listener,
                router.into_make_service_with_connect_info::<std::net::SocketAddr>(),
            )
            .await
            .unwrap();
        });
        Self {
            app,
            base,
            http: Client::builder()
                .timeout(std::time::Duration::from_secs(10))
                .build()
                .unwrap(),
            task,
        }
    }
    async fn user(&self, name: &str, admin: bool) -> (NativeClient, String, String) {
        let user = auth::create_user(&self.app, name, "read-test-password-2026".into(), admin)
            .await
            .unwrap();
        let mut client = NativeClient::new(&self.base).unwrap();
        let session = client.login(name, "read-test-password-2026").await.unwrap();
        (client, user.id, session.token)
    }
    async fn request(
        &self,
        method: Method,
        token: &str,
        path: &str,
        body: Value,
    ) -> reqwest::Response {
        self.http
            .request(method, format!("{}{path}", self.base))
            .bearer_auth(token)
            .json(&body)
            .send()
            .await
            .unwrap()
    }
    async fn room(&self, owner: &NativeClient, token: &str, member: &str) -> String {
        let room = owner
            .create_room(&CreateRoom {
                name: "Read room".into(),
                private: true,
                operation_id: Some("room-create".into()),
            })
            .await
            .unwrap();
        assert_eq!(
            self.request(
                Method::POST,
                token,
                &format!("/api/v1/rooms/{}/members/{member}", room.id),
                json!({})
            )
            .await
            .status(),
            StatusCode::NO_CONTENT
        );
        room.id
    }
}
fn mark(root: &str) -> MarkRead {
    MarkRead {
        root_position: root.into(),
        reply_position: "0".into(),
    }
}
fn favorite(revision: &str, id: &str, present: bool) -> SetRoomFavorite {
    SetRoomFavorite {
        operation_id: id.into(),
        expected_revision: revision.into(),
        present,
    }
}

#[sqlx::test(migrations = "./migrations")]
async fn actual_mobile_transport_recovers_lost_favorite_ack_without_a_second_write(pool: PgPool) {
    let b = Bench::start(pool).await;
    let (owner, _, token) = b.user("read-owner", false).await;
    let (_, uid, _) = b.user("read-member", false).await;
    let room = b.room(&owner, &token, &uid).await;
    let script = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../scripts/native-room-reads-peer.ts");
    let mut command = tokio::process::Command::new("node");
    command
        .arg(script)
        .env("RV_ROOM_PEER_URL", &b.base)
        .env("RV_ROOM_PEER_ROOM", &room)
        .kill_on_drop(true);
    let output = tokio::time::timeout(std::time::Duration::from_secs(30), command.output())
        .await
        .expect("Mobile read/favorite peer timed out")
        .unwrap();
    assert!(
        output.status.success(),
        "Mobile read/favorite peer failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let result: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(
        result,
        json!({"unreads":true,"monotone":true,"privateFavorite":true,"lostAckRecovered":true,"noSecondFavorite":true,"oldReplayHarmless":true})
    );
}

#[sqlx::test(migrations = "./migrations")]
async fn reads_are_monotone_across_devices_and_only_other_new_roots_count(pool: PgPool) {
    let b = Bench::start(pool).await;
    let (a, _, at) = b.user("alice", false).await;
    let (reader, uid, _) = b.user("bob", false).await;
    let room = b.room(&a, &at, &uid).await;
    let first = a
        .send(
            &room,
            &SendMessage {
                operation_id: "first-root".into(),
                text: "First".into(),
            },
        )
        .await
        .unwrap();
    let second = a
        .send(
            &room,
            &SendMessage {
                operation_id: "second-root".into(),
                text: "Second".into(),
            },
        )
        .await
        .unwrap();
    assert_eq!(a.room_read_state(&room).await.unwrap().unread_roots, "0");
    assert_eq!(
        reader.room_read_state(&room).await.unwrap().unread_roots,
        "2"
    );
    let mut device = NativeClient::new(&b.base).unwrap();
    device
        .login("bob", "read-test-password-2026")
        .await
        .unwrap();
    let old = mark(&first.position);
    let recent = mark(&second.position);
    let (x, y) = tokio::join!(
        reader.mark_room_read(&room, &old),
        device.mark_room_read(&room, &recent)
    );
    x.unwrap();
    y.unwrap();
    let state = reader.mark_room_read(&room, &old).await.unwrap();
    assert_eq!(state.root_position, second.position);
    assert_eq!(state.unread_roots, "0");
    let sent = reader
        .send(
            &room,
            &SendMessage {
                operation_id: "own-root".into(),
                text: "Own message".into(),
            },
        )
        .await
        .unwrap();
    assert_eq!(
        reader.room_read_state(&room).await.unwrap().unread_roots,
        "0"
    );
    let current = a.room_read_state(&room).await.unwrap();
    assert_eq!(current.unread_roots, "1");
    reader
        .delete_message(
            &sent.id,
            &DeleteMessage {
                operation_id: "own-delete".into(),
                expected_revision: sent.revision,
            },
        )
        .await
        .unwrap();
    let after = a.room_read_state(&room).await.unwrap();
    assert_eq!(after.unread_roots, "0");
    assert_eq!(after.root_position, current.root_position);
    let snapshot = reader.snapshot().await.unwrap();
    let personal = snapshot
        .rooms
        .iter()
        .find(|r| r.id == room)
        .unwrap()
        .read_state
        .as_ref()
        .unwrap();
    assert_eq!(personal.root_position, second.position);
}

#[sqlx::test(migrations = "./migrations")]
async fn private_favorites_have_receipts_and_older_replays_never_restore_a_preference(
    pool: PgPool,
) {
    let b = Bench::start(pool).await;
    let (owner, _, token) = b.user("alice", false).await;
    let (reader, uid, _) = b.user("bob", false).await;
    let room = b.room(&owner, &token, &uid).await;
    let cursor = owner.snapshot().await.unwrap().cursor;
    let original = reader.room_read_state(&room).await.unwrap();
    let input = favorite(&original.revision, "favorite-original", true);
    let receipt = reader.set_room_favorite(&room, &input).await.unwrap();
    assert!(!owner.room_read_state(&room).await.unwrap().favorite);
    assert!(reader.room_read_state(&room).await.unwrap().favorite);
    assert!(
        owner.changes(&cursor).await.unwrap().changes.is_empty(),
        "Personal preference events are not sent to peers"
    );
    let current = reader.room_read_state(&room).await.unwrap();
    reader
        .set_room_favorite(
            &room,
            &favorite(&current.revision, "favorite-remove", false),
        )
        .await
        .unwrap();
    assert_eq!(
        reader.set_room_favorite(&room, &input).await.unwrap(),
        receipt
    );
    assert!(!reader.room_read_state(&room).await.unwrap().favorite);
    let own = reader.snapshot().await.unwrap();
    assert!(
        !own.rooms
            .iter()
            .find(|r| r.id == room)
            .unwrap()
            .read_state
            .as_ref()
            .unwrap()
            .favorite
    );
    let count:i64=sqlx::query_scalar("SELECT count(*) FROM journal WHERE recipient_id=$1 AND change #> '{data,read_state}' IS NOT NULL").bind(&uid).fetch_one(&b.app.pool).await.unwrap();
    assert_eq!(
        count, 0,
        "Private fields are personalized after journal filtering"
    );
    assert_eq!(
        reader
            .room_command_receipt(&room, "favorite-original")
            .await
            .unwrap(),
        receipt
    );
}

#[sqlx::test(migrations = "./migrations")]
async fn withdrawal_rejoin_purges_preferences_and_old_receipts_do_not_restore_them(pool: PgPool) {
    let b = Bench::start(pool).await;
    let (owner, _, token) = b.user("alice", false).await;
    let (reader, uid, _) = b.user("bob", false).await;
    let room = b.room(&owner, &token, &uid).await;
    let state = reader.room_read_state(&room).await.unwrap();
    let input = favorite(&state.revision, "before-leave", true);
    let receipt = reader.set_room_favorite(&room, &input).await.unwrap();
    let detail = reader.room_details(&room).await.unwrap();
    reader
        .leave_room(
            &room,
            &LeaveRoom {
                operation_id: "read-leave".into(),
                expected_revision: detail.revision,
            },
        )
        .await
        .unwrap();
    assert_eq!(
        reader
            .room_command_receipt(&room, "before-leave")
            .await
            .unwrap(),
        receipt
    );
    assert_eq!(
        self_code(reader.room_read_state(&room).await.unwrap_err()),
        "not_found"
    );
    let count: i64 =
        sqlx::query_scalar("SELECT count(*) FROM room_read_states WHERE room_id=$1 AND user_id=$2")
            .bind(&room)
            .bind(&uid)
            .fetch_one(&b.app.pool)
            .await
            .unwrap();
    assert_eq!(count, 0);
    let old = owner
        .send(
            &room,
            &SendMessage {
                operation_id: "while-absent".into(),
                text: "Historical".into(),
            },
        )
        .await
        .unwrap();
    assert_eq!(
        b.request(
            Method::POST,
            &token,
            &format!("/api/v1/rooms/{room}/members/{uid}"),
            json!({})
        )
        .await
        .status(),
        StatusCode::NO_CONTENT
    );
    let fresh = reader.room_read_state(&room).await.unwrap();
    assert!(!fresh.favorite);
    assert_eq!(fresh.unread_roots, "0");
    assert_eq!(fresh.root_position, old.position);
    assert_ne!(fresh.revision, state.revision);
    assert_ne!(fresh.membership_version, state.membership_version);
    assert_eq!(
        reader.set_room_favorite(&room, &input).await.unwrap(),
        receipt
    );
    assert!(!reader.room_read_state(&room).await.unwrap().favorite);
}
fn self_code(error: rv_client::Error) -> String {
    match error {
        rv_client::Error::Server { code, .. } => code,
        _ => panic!("Expected server rejection"),
    }
}

#[sqlx::test(migrations = "./migrations")]
async fn favorite_versions_and_membership_lifetimes_ignore_reads_messages_and_role_changes(
    pool: PgPool,
) {
    let b = Bench::start(pool).await;
    let (owner, _, token) = b.user("alice", false).await;
    let (reader, uid, _) = b.user("bob", false).await;
    let room = b.room(&owner, &token, &uid).await;
    let original = reader.room_read_state(&room).await.unwrap();
    let command = favorite(
        original.favorite_revision.as_deref().unwrap(),
        "independent-favorite",
        true,
    );
    let message = owner
        .send(
            &room,
            &SendMessage {
                operation_id: "read-version-root".into(),
                text: "A message during the favorite form".into(),
            },
        )
        .await
        .unwrap();
    reader
        .mark_room_read(&room, &mark(&message.position))
        .await
        .unwrap();
    let detail = owner.room_details(&room).await.unwrap();
    owner
        .change_room_role(
            &room,
            &uid,
            &rv_protocol::parity::ChangeRoomRole {
                operation_id: "read-role".into(),
                expected_revision: detail.revision,
                role: rv_protocol::parity::RoomRole::Moderator,
            },
        )
        .await
        .unwrap();
    let changed = reader.room_read_state(&room).await.unwrap();
    assert_ne!(changed.revision, original.revision);
    assert_eq!(changed.favorite_revision, original.favorite_revision);
    assert_eq!(changed.membership_version, original.membership_version);
    reader.set_room_favorite(&room, &command).await.unwrap();
    let favorite_state = reader.room_read_state(&room).await.unwrap();
    assert!(favorite_state.favorite);
    assert_ne!(favorite_state.favorite_revision, original.favorite_revision);
    let stale = favorite(
        original.favorite_revision.as_deref().unwrap(),
        "other-device-stale",
        false,
    );
    assert_eq!(
        self_code(reader.set_room_favorite(&room, &stale).await.unwrap_err()),
        "revision_conflict"
    );
    assert_eq!(
        reader
            .set_room_favorite(&room, &command)
            .await
            .unwrap()
            .applied_revision,
        favorite_state.favorite_revision.unwrap()
    );
}

#[sqlx::test(migrations = "./migrations")]
async fn reads_and_preferences_reject_forged_fields_future_positions_and_private_bypasses(
    pool: PgPool,
) {
    let b = Bench::start(pool).await;
    let (owner, _, token) = b.user("alice", false).await;
    let (_, uid, _) = b.user("bob", false).await;
    let (_, _, admin) = b.user("admin", true).await;
    let room = b.room(&owner, &token, &uid).await;
    for payload in [
        json!({"root_position":"1","reply_position":"0"}),
        json!({"root_position":"0","reply_position":"1"}),
        json!({"root_position":"00","reply_position":"0"}),
        json!({"root_position":"0","reply_position":"0","user_id":uid}),
    ] {
        assert!(
            !b.request(
                Method::POST,
                &token,
                &format!("/api/v1/rooms/{room}/read"),
                payload
            )
            .await
            .status()
            .is_success()
        );
    }
    assert_eq!(
        b.request(
            Method::GET,
            &admin,
            &format!("/api/v1/rooms/{room}/read"),
            json!({})
        )
        .await
        .status(),
        StatusCode::NOT_FOUND
    );
    let state = owner.room_read_state(&room).await.unwrap();
    assert_eq!(b.request(Method::PUT,&token,&format!("/api/v1/rooms/{room}/favorite"),json!({"operation_id":"forged","expected_revision":state.revision,"present":true,"user_id":uid})).await.status(),StatusCode::BAD_REQUEST);
    let input = favorite(&state.revision, "favorite-collision", true);
    owner.set_room_favorite(&room, &input).await.unwrap();
    assert!(
        owner
            .send(
                &room,
                &SendMessage {
                    operation_id: input.operation_id,
                    text: "Collision".into()
                }
            )
            .await
            .is_err()
    );
    let cursor = owner.snapshot().await.unwrap().cursor;
    let replay = owner.changes(&cursor).await.unwrap();
    assert!(
        !replay
            .changes
            .iter()
            .any(|c| matches!(c,Change::RoomUpsert(r) if r.id!=room))
    );
}
