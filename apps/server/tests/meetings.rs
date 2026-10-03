use axum::{
    body::{Body, to_bytes},
    http::{Request, StatusCode},
};
use rv_client::{Error, NativeClient};
use rv_protocol::{
    CreateRoom,
    meetings::{JoinMeeting, StartMeeting},
    system::SystemMessage,
};
use rv_server::{App, auth, meetings::Jitsi};
use serde_json::json;
use sqlx::PgPool;
use std::time::Duration;
use tower::ServiceExt;

const SECRET: &str = "native-jitsi-disposable-shared-secret-2026";
const PASSWORD: &str = "native-meetings-disposable-password";

fn jitsi() -> Jitsi {
    let path = std::env::temp_dir().join(format!("rv-jitsi-{}.json", auth::random_token()));
    std::fs::write(
        &path,
        serde_json::to_vec(
            &json!({"url":"https://jitsi.example.test:8443","app_id":"rocketvibe","secret":SECRET}),
        )
        .unwrap(),
    )
    .unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
    }
    let value = Jitsi::from_file(&path).unwrap();
    std::fs::remove_file(path).unwrap();
    value
}
struct Bench {
    app: App,
    base: String,
    task: tokio::task::JoinHandle<()>,
}
impl Drop for Bench {
    fn drop(&mut self) {
        self.task.abort();
    }
}
impl Bench {
    async fn new(pool: PgPool) -> Self {
        let app = App::from_pool(pool)
            .await
            .unwrap()
            .with_jitsi(Some(jitsi()));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let router = app.clone().router();
        let task = tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        });
        Self { app, base, task }
    }
    async fn user(&self, name: &str, admin: bool) -> (NativeClient, String, String) {
        let uid = auth::create_user(&self.app, name, PASSWORD.into(), admin)
            .await
            .unwrap()
            .id;
        let mut c = NativeClient::new(&self.base).unwrap();
        let token = c.login(name, PASSWORD).await.unwrap().token;
        (c, uid, token)
    }
    async fn room(&self, c: &NativeClient) -> String {
        c.create_room(&CreateRoom {
            name: "Private meeting".into(),
            private: true,
            operation_id: Some(auth::random_token()),
        })
        .await
        .unwrap()
        .id
    }
    async fn start_input(&self, c: &NativeClient, room: &str) -> StartMeeting {
        StartMeeting {
            operation_id: auth::random_token(),
            membership_version: c
                .room_read_state(room)
                .await
                .unwrap()
                .membership_version
                .unwrap(),
            data_epoch: c.discover().await.unwrap().data_epoch,
        }
    }
}
fn join(input: &StartMeeting) -> JoinMeeting {
    JoinMeeting {
        membership_version: input.membership_version.clone(),
        data_epoch: input.data_epoch.clone(),
    }
}
fn refused<T>(value: std::result::Result<T, Error>, status: u16, code: &str) {
    match value {
        Err(Error::Server {
            status: s, code: c, ..
        }) => {
            assert_eq!(s, status);
            assert_eq!(c, code)
        }
        _ => panic!("Expected {status} {code}"),
    }
}

#[sqlx::test]
async fn meetings_are_persistent_idempotent_and_jwts_verified_by_the_mobile_transport(
    pool: PgPool,
) {
    let b = Bench::new(pool.clone()).await;
    let (c, _, token) = b.user("meetings-owner", false).await;
    let (other, _, _) = b.user("meetings-admin-outsider", true).await;
    let room = b.room(&c).await;
    let input = b.start_input(&c, &room).await;
    assert!(c.discover().await.unwrap().capabilities.calls);
    let (a, z) = tokio::join!(
        c.start_meeting(&room, &input),
        c.start_meeting(&room, &input)
    );
    let meeting = a.unwrap();
    assert_eq!(meeting, z.unwrap());
    assert!(!meeting.public_url.contains('?'));
    let next = StartMeeting {
        operation_id: auth::random_token(),
        ..input.clone()
    };
    assert_eq!(c.start_meeting(&room, &next).await.unwrap(), meeting);
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT count(*) FROM messages WHERE room_id=$1 AND system->>'kind'='call_started'"
        )
        .bind(&room)
        .fetch_one(&pool)
        .await
        .unwrap(),
        1
    );
    let message = c
        .history(&room, None)
        .await
        .unwrap()
        .messages
        .into_iter()
        .find(
            |m| matches!(&m.system,Some(s) if matches!(s.as_ref(),SystemMessage::CallStarted{..})),
        )
        .unwrap();
    match message.system.unwrap().as_ref() {
        SystemMessage::CallStarted { meeting_id } => assert_eq!(meeting_id, &meeting.id),
        _ => unreachable!(),
    }
    refused(other.meeting(&meeting.id).await, 404, "not_found");
    refused(
        other.join_meeting(&meeting.id, &join(&input)).await,
        404,
        "not_found",
    );
    let second = b.room(&c).await;
    refused(
        c.start_meeting(&second, &input).await,
        409,
        "membership_replaced",
    );
    let mut conflict = b.start_input(&c, &second).await;
    conflict.operation_id = input.operation_id.clone();
    refused(
        c.start_meeting(&second, &conflict).await,
        409,
        "operation_conflict",
    );
    let restarted = App::from_pool(pool.clone())
        .await
        .unwrap()
        .with_jitsi(Some(jitsi()));
    let response = restarted
        .router()
        .oneshot(
            Request::builder()
                .uri(format!("/api/v1/meetings/{}", meeting.id))
                .header("authorization", format!("Bearer {token}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        serde_json::from_slice::<rv_protocol::meetings::Meeting>(
            &to_bytes(response.into_body(), 32 * 1024).await.unwrap()
        )
        .unwrap(),
        meeting
    );
    let output = tokio::process::Command::new("node")
        .arg(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../../scripts/native-meetings-smoke.ts"),
        )
        .env("RV_MEETINGS_SERVER", &b.base)
        .env("RV_MEETINGS_ROOM", &room)
        .env("RV_MEETINGS_PASSWORD", PASSWORD)
        .env("RV_MEETINGS_SECRET", SECRET)
        .output()
        .await
        .unwrap();
    assert!(
        output.status.success(),
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    // A shared link/journal row never inherits the current participant token.
    let payload:String=sqlx::query_scalar("SELECT change::text FROM journal WHERE change->'data'->'system'->>'kind'='call_started' LIMIT 1").fetch_one(&pool).await.unwrap();
    assert!(!payload.contains("jwt"));
    assert!(!payload.contains(SECRET));
}

#[sqlx::test]
async fn revoked_memberships_epochs_read_only_end_and_expiry_refuse_new_credentials(pool: PgPool) {
    let b = Bench::new(pool.clone()).await;
    let (owner, _, owner_token) = b.user("meetings-owner", false).await;
    let (reader, uid, _) = b.user("meetings-reader", false).await;
    let room = b.room(&owner).await;
    let input = b.start_input(&owner, &room).await;
    let meeting = owner.start_meeting(&room, &input).await.unwrap();
    owner.add_member(&room, &uid).await.unwrap();
    let old = b.start_input(&reader, &room).await;
    assert!(reader.join_meeting(&meeting.id, &join(&old)).await.is_ok());
    sqlx::query("UPDATE rooms SET read_only=true,authority_version=$2 WHERE id=$1")
        .bind(&room)
        .bind(auth::random_token())
        .execute(&pool)
        .await
        .unwrap();
    refused(
        reader.start_meeting(&room, &old).await,
        403,
        "permission_denied",
    );
    assert!(reader.join_meeting(&meeting.id, &join(&old)).await.is_ok());
    refused(
        reader.end_meeting(&meeting.id, &join(&old)).await,
        403,
        "permission_denied",
    );
    let removed = reqwest::Client::new()
        .delete(format!("{}/api/v1/rooms/{room}/members/{uid}", b.base))
        .bearer_auth(&owner_token)
        .send()
        .await
        .unwrap();
    assert_eq!(removed.status(), StatusCode::NO_CONTENT);
    refused(
        reader.join_meeting(&meeting.id, &join(&old)).await,
        404,
        "not_found",
    );
    owner.add_member(&room, &uid).await.unwrap();
    refused(
        reader.join_meeting(&meeting.id, &join(&old)).await,
        409,
        "membership_replaced",
    );
    let fresh = b.start_input(&reader, &room).await;
    assert!(
        reader
            .join_meeting(&meeting.id, &join(&fresh))
            .await
            .is_ok()
    );
    let wrong_epoch = JoinMeeting {
        data_epoch: auth::random_token(),
        ..join(&fresh)
    };
    refused(
        reader.join_meeting(&meeting.id, &wrong_epoch).await,
        409,
        "data_epoch_changed",
    );
    sqlx::query(
        "UPDATE meetings SET expires_at=clock_timestamp()+interval '10 seconds' WHERE id=$1",
    )
    .bind(&meeting.id)
    .execute(&pool)
    .await
    .unwrap();
    let joined = reader
        .join_meeting(&meeting.id, &join(&fresh))
        .await
        .unwrap();
    assert!(
        chrono::DateTime::parse_from_rfc3339(&joined.expires_at)
            .unwrap()
            .timestamp()
            <= chrono::Utc::now().timestamp() + 10
    );
    sqlx::query("UPDATE meetings SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1")
        .bind(&meeting.id)
        .execute(&pool)
        .await
        .unwrap();
    refused(
        reader.join_meeting(&meeting.id, &join(&fresh)).await,
        409,
        "meeting_ended",
    );
    assert!(owner.start_meeting(&room, &input).await.unwrap().ended);
    let replacement = owner
        .start_meeting(
            &room,
            &StartMeeting {
                operation_id: auth::random_token(),
                ..input.clone()
            },
        )
        .await
        .unwrap();
    assert_ne!(replacement.id, meeting.id);
    assert!(
        owner
            .end_meeting(&replacement.id, &join(&input))
            .await
            .unwrap()
            .ended
    );
    assert!(
        owner
            .end_meeting(&replacement.id, &join(&input))
            .await
            .unwrap()
            .ended
    );
    refused(
        owner.join_meeting(&replacement.id, &join(&input)).await,
        409,
        "meeting_ended",
    );
    sqlx::query("UPDATE instance SET data_epoch=$1 WHERE singleton")
        .bind(auth::random_token())
        .execute(&pool)
        .await
        .unwrap();
    refused(owner.meeting(&replacement.id).await, 404, "not_found");
    refused(
        owner.start_meeting(&room, &input).await,
        409,
        "data_epoch_changed",
    );
    let unconfigured = App::from_pool(pool).await.unwrap();
    let router = unconfigured.router();
    let response = router
        .oneshot(
            Request::builder()
                .uri("/.well-known/rocketvibe")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let discovery: rv_protocol::Discovery =
        serde_json::from_slice(&to_bytes(response.into_body(), 32 * 1024).await.unwrap()).unwrap();
    assert!(!discovery.capabilities.calls);
}

#[sqlx::test]
async fn start_quota_keeps_receipts_and_read_join_end_available(pool: PgPool) {
    let b = Bench::new(pool.clone()).await;
    let (c, uid, token) = b.user("meetings-owner", false).await;
    let room = b.room(&c).await;
    let input = b.start_input(&c, &room).await;
    let meeting = c.start_meeting(&room, &input).await.unwrap();
    sqlx::query("INSERT INTO meeting_operations(user_id,operation_id,room_id,membership_version,data_epoch,configuration_id,meeting_id) SELECT user_id,'quota-'||n,room_id,membership_version,data_epoch,configuration_id,meeting_id FROM meeting_operations CROSS JOIN generate_series(1,255) n WHERE user_id=$1 AND operation_id=$2")
        .bind(&uid).bind(&input.operation_id).execute(&pool).await.unwrap();
    let response = reqwest::Client::new()
        .post(format!("{}/api/v1/rooms/{room}/meetings", b.base))
        .bearer_auth(&token)
        .json(&StartMeeting {
            operation_id: auth::random_token(),
            ..input.clone()
        })
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(response.headers()["retry-after"], "60");
    assert_eq!(
        response.json::<serde_json::Value>().await.unwrap()["code"],
        "meeting_limit"
    );
    assert_eq!(c.start_meeting(&room, &input).await.unwrap(), meeting);
    assert_eq!(c.meeting(&meeting.id).await.unwrap(), meeting);
    assert!(c.join_meeting(&meeting.id, &join(&input)).await.is_ok());
    assert!(
        c.end_meeting(&meeting.id, &join(&input))
            .await
            .unwrap()
            .ended
    );
    // Receipts survive maintenance and retain the ended result across time.
    sqlx::query("UPDATE meeting_operations SET created_at=clock_timestamp()-interval '2 days' WHERE user_id=$1").bind(&uid).execute(&pool).await.unwrap();
    b.app.cleanup().await.unwrap();
    assert!(c.start_meeting(&room, &input).await.unwrap().ended);
    let replacement = c
        .start_meeting(
            &room,
            &StartMeeting {
                operation_id: auth::random_token(),
                ..input.clone()
            },
        )
        .await
        .unwrap();
    assert_ne!(replacement.id, meeting.id);
    c.logout().await.unwrap();
    refused(
        c.join_meeting(&replacement.id, &join(&input)).await,
        401,
        "session_rejected",
    );
}

#[sqlx::test]
async fn an_unsubmitted_join_response_blocks_end_then_new_joins_are_refused(pool: PgPool) {
    let b = Bench::new(pool).await;
    let (c, _, token) = b.user("meetings-owner", false).await;
    let room = b.room(&c).await;
    let input = b.start_input(&c, &room).await;
    let meeting = c.start_meeting(&room, &input).await.unwrap();
    let response = b
        .app
        .clone()
        .router()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("/api/v1/meetings/{}/join", meeting.id))
                .header("authorization", format!("Bearer {token}"))
                .header("content-type", "application/json")
                .body(Body::from(serde_json::to_vec(&join(&input)).unwrap()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()["cache-control"], "no-store");
    assert_eq!(response.headers()["referrer-policy"], "no-referrer");
    let (copy, id, end_input) = (c.clone(), meeting.id.clone(), join(&input));
    let task = tokio::spawn(async move { copy.end_meeting(&id, &end_input).await });
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(!task.is_finished());
    let joined: rv_protocol::meetings::MeetingJoin =
        serde_json::from_slice(&to_bytes(response.into_body(), 32 * 1024).await.unwrap()).unwrap();
    assert_eq!(joined.meeting.id, meeting.id);
    assert!(
        tokio::time::timeout(Duration::from_secs(2), task)
            .await
            .unwrap()
            .unwrap()
            .unwrap()
            .ended
    );
    refused(
        c.join_meeting(&meeting.id, &join(&input)).await,
        409,
        "meeting_ended",
    );
}
