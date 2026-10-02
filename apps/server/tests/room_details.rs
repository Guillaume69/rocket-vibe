use axum::{
    body::{Body, to_bytes},
    http::Request,
};
use reqwest::{Client, Method, StatusCode};
use rv_client::NativeClient;
use rv_protocol::{
    CreateRoom, SendMessage,
    parity::{ChangeRoomRole, LeaveRoom, RoomDetails, RoomRole, UpdateRoom},
};
use rv_server::{App, auth};
use serde_json::{Value, json};
use sqlx::PgPool;
use std::time::Duration;
use tower::ServiceExt;

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
                .timeout(Duration::from_secs(10))
                .build()
                .unwrap(),
            task,
        }
    }
    async fn user(&self, name: &str, admin: bool) -> (NativeClient, String, String) {
        let user = auth::create_user(&self.app, name, "room-test-password-2026".into(), admin)
            .await
            .unwrap();
        let mut client = NativeClient::new(&self.base).unwrap();
        let session = client.login(name, "room-test-password-2026").await.unwrap();
        (client, user.id, session.token)
    }
    async fn room(&self, client: &NativeClient) -> String {
        client
            .create_room(&CreateRoom {
                name: "Original".into(),
                private: true,
                operation_id: Some("create-room".into()),
            })
            .await
            .unwrap()
            .id
    }
    async fn request(
        &self,
        method: Method,
        token: &str,
        path: &str,
        body: Option<Value>,
    ) -> reqwest::Response {
        let request = self
            .http
            .request(method, format!("{}{path}", self.base))
            .bearer_auth(token);
        let request = match body {
            Some(body) => request.json(&body),
            None => request,
        };
        request.send().await.unwrap()
    }
    async fn invite(&self, token: &str, room: &str, target: &str) {
        assert_eq!(
            self.request(
                Method::POST,
                token,
                &format!("/api/v1/rooms/{room}/members/{target}"),
                Some(json!({}))
            )
            .await
            .status(),
            StatusCode::NO_CONTENT
        );
    }
}
fn settings(details: &RoomDetails, operation: &str) -> UpdateRoom {
    UpdateRoom {
        operation_id: operation.into(),
        expected_revision: details.revision.clone(),
        name: details.room.name.clone(),
        private: matches!(details.room.kind, rv_protocol::RoomKind::Private),
        topic: details.topic.clone(),
        description: details.description.clone(),
        announcement: details.announcement.clone(),
        read_only: details.read_only,
    }
}
fn code<T>(result: Result<T, rv_client::Error>, expected: &str) {
    assert!(matches!(result, Err(rv_client::Error::Server { code, .. }) if code == expected));
}

#[sqlx::test]
async fn actual_mobile_transport_handles_handover_and_receipts_after_self_demotion(pool: PgPool) {
    let bench = Bench::start(pool).await;
    let (owner, _, token) = bench.user("owner", false).await;
    let (_, uid, _) = bench.user("mobile-peer", false).await;
    let room = bench.room(&owner).await;
    bench.invite(&token, &room, &uid).await;
    let script = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../scripts/native-room-details-peer.ts");
    let output = tokio::process::Command::new("node")
        .arg(script)
        .env("RV_ROOM_PEER_URL", &bench.base)
        .env("RV_ROOM_PEER_ROOM", &room)
        .output()
        .await
        .unwrap();
    assert!(
        output.status.success(),
        "mobile room peer failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let result: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(
        result,
        json!({"metadata":true,"handover":true,"selfDemotion":true,"receiptAfterLeave":true,"lastOwnerProtected":true})
    );
    let roster = bench.app.pool.clone();
    let role: String =
        sqlx::query_scalar("SELECT role FROM members WHERE room_id=$1 AND user_id=$2")
            .bind(&room)
            .bind(&uid)
            .fetch_one(&roster)
            .await
            .unwrap();
    assert_eq!(role, "owner");
}

#[sqlx::test]
async fn settings_enforce_privacy_authority_readonly_and_closed_inputs(pool: PgPool) {
    let bench = Bench::start(pool).await;
    let (owner, _, token) = bench.user("owner", false).await;
    let (member, uid, member_token) = bench.user("member", false).await;
    let (admin, _, _) = bench.user("admin", true).await;
    let room = bench.room(&owner).await;
    code(admin.room_details(&room).await, "not_found");
    code(admin.room_members(&room, None, None).await, "not_found");
    bench.invite(&token, &room, &uid).await;
    let before = owner.room_details(&room).await.unwrap();
    assert_eq!(before.member_count, 2);
    let mut update = settings(&before, "settings-one");
    update.name = "  Salon 🚀  ".into();
    update.topic = "Sujet".into();
    update.description = "Description".into();
    update.announcement = "Annonce".into();
    update.read_only = true;
    update.private = false;
    code(
        member.update_room(&room, &update).await,
        "permission_denied",
    );
    let receipt = owner.update_room(&room, &update).await.unwrap();
    let after = member.room_details(&room).await.unwrap();
    assert_eq!(after.revision, receipt.applied_revision);
    assert_eq!(after.room.name, "Salon 🚀");
    assert_eq!(after.topic, "Sujet");
    assert!(!after.permissions.send && !after.permissions.change_settings);
    assert_eq!(
        admin.public_rooms("Salon", None).await.unwrap().rooms.len(),
        1
    );
    code(
        member
            .send(
                &room,
                &SendMessage {
                    operation_id: "denied-send".into(),
                    text: "hello".into(),
                },
            )
            .await,
        "permission_denied",
    );
    owner
        .change_room_role(
            &room,
            &uid,
            &ChangeRoomRole {
                operation_id: "promote-mod".into(),
                expected_revision: after.revision,
                role: RoomRole::Moderator,
            },
        )
        .await
        .unwrap();
    assert!(member.room_details(&room).await.unwrap().permissions.send);
    member
        .send(
            &room,
            &SendMessage {
                operation_id: "mod-send".into(),
                text: "hello".into(),
            },
        )
        .await
        .unwrap();
    let mut hide = settings(&owner.room_details(&room).await.unwrap(), "hide-room");
    hide.private = true;
    owner.update_room(&room, &hide).await.unwrap();
    assert!(
        admin
            .public_rooms("Salon", None)
            .await
            .unwrap()
            .rooms
            .is_empty()
    );
    for (field, value) in [
        ("actor_id", json!(uid)),
        ("role", json!("owner")),
        ("topic", json!("é".repeat(513))),
        ("name", json!("\n")),
        ("description", json!("x\0y")),
    ] {
        let mut input = serde_json::to_value(settings(
            &owner.room_details(&room).await.unwrap(),
            "invalid-command",
        ))
        .unwrap();
        input[field] = value;
        assert_eq!(
            bench
                .request(
                    Method::PATCH,
                    &token,
                    &format!("/api/v1/rooms/{room}"),
                    Some(input)
                )
                .await
                .status(),
            StatusCode::BAD_REQUEST
        );
    }
    let dm = owner.direct(&uid).await.unwrap();
    let direct = owner.room_details(&dm.id).await.unwrap();
    assert!(!direct.permissions.change_settings);
    code(
        owner
            .update_room(&dm.id, &settings(&direct, "dm-settings"))
            .await,
        "permission_denied",
    );
    code(
        member
            .leave_room(
                &dm.id,
                &LeaveRoom {
                    operation_id: "dm-leave".into(),
                    expected_revision: direct.revision,
                },
            )
            .await,
        "permission_denied",
    );
    assert_eq!(
        bench
            .request(
                Method::GET,
                &member_token,
                &format!("/api/v1/rooms/{room}/commands/settings-one"),
                None
            )
            .await
            .status(),
        StatusCode::NOT_FOUND
    );
}

#[sqlx::test]
async fn receipts_survive_restart_and_do_not_restore_old_settings_or_membership(pool: PgPool) {
    let bench = Bench::start(pool.clone()).await;
    let (owner, _, token) = bench.user("owner", false).await;
    let (member, uid, member_token) = bench.user("member", false).await;
    let room = bench.room(&owner).await;
    bench.invite(&token, &room, &uid).await;
    let before = owner.room_details(&room).await.unwrap();
    let mut first = settings(&before, "rename-once");
    first.name = "First".into();
    let receipt = owner.update_room(&room, &first).await.unwrap();
    let mut second = settings(&owner.room_details(&room).await.unwrap(), "rename-next");
    second.name = "Second".into();
    owner.update_room(&room, &second).await.unwrap();
    assert_eq!(owner.update_room(&room, &first).await.unwrap(), receipt);
    assert_eq!(owner.room_details(&room).await.unwrap().room.name, "Second");
    let mut divergent = first.clone();
    divergent.name = "Other".into();
    code(
        owner.update_room(&room, &divergent).await,
        "operation_conflict",
    );
    let leave = LeaveRoom {
        operation_id: "depart-once".into(),
        expected_revision: member.room_details(&room).await.unwrap().revision,
    };
    let left = member.leave_room(&room, &leave).await.unwrap();
    code(member.room_details(&room).await, "not_found");
    assert_eq!(member.leave_room(&room, &leave).await.unwrap(), left);
    bench.invite(&token, &room, &uid).await;
    assert_eq!(member.leave_room(&room, &leave).await.unwrap(), left);
    assert!(member.room_details(&room).await.is_ok());
    code(
        member
            .leave_room(
                &room,
                &LeaveRoom {
                    operation_id: "stale-depart".into(),
                    ..leave
                },
            )
            .await,
        "revision_conflict",
    );
    drop(bench);
    let restarted = Bench::start(pool).await;
    let mut restored = NativeClient::new(&restarted.base).unwrap();
    restored.restore(member_token);
    assert_eq!(
        restored
            .room_command_receipt(&room, "depart-once")
            .await
            .unwrap(),
        left
    );
    assert!(restored.room_details(&room).await.is_ok());
}

#[sqlx::test]
async fn owners_can_handover_but_concurrent_departures_cannot_orphan_a_room(pool: PgPool) {
    let bench = Bench::start(pool).await;
    let (owner, owner_id, token) = bench.user("owner", false).await;
    let (other, uid, _) = bench.user("other", false).await;
    let room = bench.room(&owner).await;
    bench.invite(&token, &room, &uid).await;
    let revision = owner.room_details(&room).await.unwrap().revision;
    code(
        owner
            .change_room_role(
                &room,
                &owner_id,
                &ChangeRoomRole {
                    operation_id: "demote-last".into(),
                    expected_revision: revision.clone(),
                    role: RoomRole::Member,
                },
            )
            .await,
        "last_room_owner",
    );
    code(
        owner
            .leave_room(
                &room,
                &LeaveRoom {
                    operation_id: "leave-last".into(),
                    expected_revision: revision.clone(),
                },
            )
            .await,
        "last_room_owner",
    );
    owner
        .change_room_role(
            &room,
            &uid,
            &ChangeRoomRole {
                operation_id: "handover".into(),
                expected_revision: revision,
                role: RoomRole::Owner,
            },
        )
        .await
        .unwrap();
    let revision = owner.room_details(&room).await.unwrap().revision;
    let a = LeaveRoom {
        operation_id: "owner-depart".into(),
        expected_revision: revision.clone(),
    };
    let b = LeaveRoom {
        operation_id: "other-depart".into(),
        expected_revision: revision,
    };
    let (a, b) = tokio::join!(owner.leave_room(&room, &a), other.leave_room(&room, &b));
    assert_eq!(usize::from(a.is_ok()) + usize::from(b.is_ok()), 1);
    let remaining: i64 =
        sqlx::query_scalar("SELECT count(*) FROM members WHERE room_id=$1 AND role='owner'")
            .bind(&room)
            .fetch_one(&bench.app.pool)
            .await
            .unwrap();
    assert_eq!(remaining, 1);
}

#[sqlx::test]
async fn roster_pages_detect_membership_aba_and_join_broadcasts_a_fresh_revision(pool: PgPool) {
    let bench = Bench::start(pool).await;
    let (owner, owner_id, token) = bench.user("owner", false).await;
    let (joiner, uid, _) = bench.user("joiner", false).await;
    let room = bench.room(&owner).await;
    // Bulk fixtures are members, not login accounts, and exercise real keyset SQL.
    for n in 0..55 {
        let id = format!("roster-{n:03}");
        sqlx::query("INSERT INTO users(id,username,display_name,password_hash) SELECT $1,$1,$1,password_hash FROM users WHERE id=$2").bind(&id).bind(&owner_id).execute(&bench.app.pool).await.unwrap();
        sqlx::query("INSERT INTO members(room_id,user_id,role) VALUES($1,$2,'member')")
            .bind(&room)
            .bind(&id)
            .execute(&bench.app.pool)
            .await
            .unwrap();
    }
    let page = owner.room_members(&room, None, None).await.unwrap();
    assert_eq!(page.members.len(), 50);
    let next = page.next.as_deref().unwrap();
    let last = owner
        .room_members(&room, Some(next), Some(&page.revision))
        .await
        .unwrap();
    assert_eq!(last.members.len(), 6);
    assert!(last.next.is_none());
    assert!(
        page.members
            .iter()
            .all(|a| last.members.iter().all(|b| a.user.id != b.user.id))
    );
    assert_eq!(
        bench
            .request(
                Method::GET,
                &token,
                &format!("/api/v1/rooms/{room}/members?after={next}"),
                None
            )
            .await
            .status(),
        StatusCode::BAD_REQUEST
    );
    bench.invite(&token, &room, &uid).await;
    code(
        owner
            .room_members(&room, Some(next), Some(&page.revision))
            .await,
        "revision_conflict",
    );
    let captured = owner.room_details(&room).await.unwrap();
    assert_eq!(
        bench
            .request(
                Method::DELETE,
                &token,
                &format!("/api/v1/rooms/{room}/members/{uid}"),
                None
            )
            .await
            .status(),
        StatusCode::NO_CONTENT
    );
    bench.invite(&token, &room, &uid).await;
    code(
        owner
            .update_room(&room, &settings(&captured, "roster-aba"))
            .await,
        "revision_conflict",
    );
    let mut public = settings(&owner.room_details(&room).await.unwrap(), "make-public");
    public.private = false;
    owner.update_room(&room, &public).await.unwrap();
    let leave = LeaveRoom {
        operation_id: "before-join".into(),
        expected_revision: joiner.room_details(&room).await.unwrap().revision,
    };
    joiner.leave_room(&room, &leave).await.unwrap();
    let before = owner.room_details(&room).await.unwrap();
    let joined = joiner.join_public(&room).await.unwrap();
    let after = owner.room_details(&room).await.unwrap();
    assert_ne!(before.revision, after.revision);
    assert_eq!(joined.revision, after.room.revision);
    let event: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM journal WHERE room_id=$1 AND recipient_id IS NULL AND position=$2",
    )
    .bind(&room)
    .bind(joined.revision.parse::<i64>().unwrap())
    .fetch_one(&bench.app.pool)
    .await
    .unwrap();
    assert_eq!(event, 1);
}

#[sqlx::test]
async fn concurrent_settings_have_one_winner_and_invalidate_materialized_snapshots(pool: PgPool) {
    let bench = Bench::start(pool).await;
    let (owner, _, token) = bench.user("owner", false).await;
    let room = bench.room(&owner).await;
    let page = bench
        .request(
            Method::POST,
            &token,
            "/api/v1/sync/snapshots",
            Some(json!({})),
        )
        .await;
    assert_eq!(page.status(), StatusCode::OK);
    let _: Value = page.json().await.unwrap();
    let before = owner.room_details(&room).await.unwrap();
    let mut a = settings(&before, "rename-a");
    a.name = "A".into();
    let mut b = settings(&before, "rename-b");
    b.name = "B".into();
    let (a, b) = tokio::join!(owner.update_room(&room, &a), owner.update_room(&room, &b));
    assert_eq!(usize::from(a.is_ok()) + usize::from(b.is_ok()), 1);
    code(if a.is_err() { a } else { b }, "revision_conflict");
    let heads: i64 = sqlx::query_scalar("SELECT count(*) FROM snapshot_heads")
        .fetch_one(&bench.app.pool)
        .await
        .unwrap();
    assert_eq!(heads, 0);
}

#[sqlx::test]
async fn mutation_budget_preserves_receipt_reads_and_global_operation_namespace(pool: PgPool) {
    let bench = Bench::start(pool).await;
    let (owner, _, token) = bench.user("owner", false).await;
    let room = bench.room(&owner).await;
    code(
        owner
            .update_room(
                &room,
                &settings(&owner.room_details(&room).await.unwrap(), "create-room"),
            )
            .await,
        "operation_conflict",
    );
    owner
        .send(
            &room,
            &SendMessage {
                operation_id: "sent-before".into(),
                text: "hello".into(),
            },
        )
        .await
        .unwrap();
    code(
        owner
            .update_room(
                &room,
                &settings(&owner.room_details(&room).await.unwrap(), "sent-before"),
            )
            .await,
        "operation_conflict",
    );
    let original = settings(
        &owner.room_details(&room).await.unwrap(),
        "settings-receipt",
    );
    let receipt = owner.update_room(&room, &original).await.unwrap();
    code(
        owner
            .send(
                &room,
                &SendMessage {
                    operation_id: original.operation_id.clone(),
                    text: "hello".into(),
                },
            )
            .await,
        "operation_conflict",
    );
    code(
        owner
            .create_room(&CreateRoom {
                name: "Other".into(),
                private: true,
                operation_id: Some(original.operation_id.clone()),
            })
            .await,
        "operation_conflict",
    );
    for n in 1..30 {
        owner
            .update_room(
                &room,
                &settings(
                    &owner.room_details(&room).await.unwrap(),
                    &format!("noop-{n}"),
                ),
            )
            .await
            .unwrap();
    }
    let input = settings(&owner.room_details(&room).await.unwrap(), "limited");
    let limited = bench
        .request(
            Method::PATCH,
            &token,
            &format!("/api/v1/rooms/{room}"),
            Some(serde_json::to_value(&input).unwrap()),
        )
        .await;
    assert_eq!(limited.status(), StatusCode::TOO_MANY_REQUESTS);
    assert!(limited.headers().contains_key("retry-after"));
    assert_eq!(owner.update_room(&room, &original).await.unwrap(), receipt);
    assert_eq!(
        owner
            .room_command_receipt(&room, &original.operation_id)
            .await
            .unwrap(),
        receipt
    );
    assert!(owner.room_members(&room, None, None).await.is_ok());
}

#[sqlx::test]
async fn settings_wait_for_the_actual_http_metadata_body_delivery(pool: PgPool) {
    let bench = Bench::start(pool).await;
    let (owner, _, token) = bench.user("owner", false).await;
    let room = bench.room(&owner).await;
    let details = owner.room_details(&room).await.unwrap();
    let response = bench
        .app
        .clone()
        .router()
        .oneshot(
            Request::builder()
                .uri(format!("/api/v1/rooms/{room}"))
                .header("authorization", format!("Bearer {token}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let mut update = settings(&details, "delivery-rename");
    update.name = "After delivery".into();
    let task = tokio::spawn(async move { owner.update_room(&room, &update).await });
    let blocked = tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            let locked: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%FROM rooms WHERE id=%FOR UPDATE%')").fetch_one(&bench.app.pool).await.unwrap();
            if locked { break; } tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }).await;
    assert!(blocked.is_ok());
    assert!(!task.is_finished());
    let body = to_bytes(response.into_body(), 32_768).await.unwrap();
    let delivered: RoomDetails = serde_json::from_slice(&body).unwrap();
    assert_eq!(delivered.room.name, "Original");
    assert!(
        tokio::time::timeout(Duration::from_secs(2), task)
            .await
            .unwrap()
            .unwrap()
            .is_ok()
    );
}
