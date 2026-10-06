use rv_client::NativeClient;
use rv_server::{
    App, auth,
    operator::{self, Command, RoomChanges, UserChanges},
};
use serde_json::json;
use sqlx::PgPool;

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
    async fn start(pool: PgPool) -> Self {
        let app = App::from_pool(pool).await.unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let router = app.clone().router();
        let task = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        Self { app, base, task }
    }
    async fn user(&self, name: &str, admin: bool) -> (NativeClient, String) {
        let user = auth::create_user(&self.app, name, "operator-test-password".into(), admin)
            .await
            .unwrap();
        let mut client = NativeClient::new(&self.base).unwrap();
        client.login(name, "operator-test-password").await.unwrap();
        (client, user.id)
    }
}
#[sqlx::test(migrations = "./migrations")]
async fn account_policy_revokes_sessions_and_replay_never_reapplies_an_old_disable(pool: PgPool) {
    let bench = Bench::start(pool.clone()).await;
    let (client, uid) = bench.user("alice", false).await;
    let room = operator::apply(
        &bench.app,
        "create-room",
        Command::CreateRoom {
            owner: uid.clone(),
            name: "Private history".into(),
            private: true,
        },
    )
    .await
    .unwrap();
    let message = client
        .send(
            &room.subject_id,
            &serde_json::from_value(
                json!({"operation_id":"first-message","text":"Preserve this history"}),
            )
            .unwrap(),
        )
        .await
        .unwrap();
    let original_hash: String = sqlx::query_scalar("SELECT password_hash FROM users WHERE id=$1")
        .bind(&uid)
        .fetch_one(&pool)
        .await
        .unwrap();
    let disable = Command::User {
        id: uid.clone(),
        expected: None,
        changes: UserChanges {
            disabled: Some(true),
            ..Default::default()
        },
    };
    let receipt = operator::apply(&bench.app, "disable-account", disable.clone())
        .await
        .unwrap();
    assert!(client.snapshot().await.is_err());
    assert!(
        auth::login(&bench.app, "alice".into(), "operator-test-password".into())
            .await
            .is_err()
    );
    let (devices,cursors,snapshots):(i64,i64,i64)=sqlx::query_as("SELECT (SELECT count(*) FROM session_devices WHERE user_id=$1),(SELECT count(*) FROM sync_cursors WHERE user_id=$1),(SELECT count(*) FROM snapshot_heads WHERE user_id=$1)").bind(&uid).fetch_one(&pool).await.unwrap();
    assert_eq!((devices, cursors, snapshots), (0, 0, 0));
    operator::apply(
        &bench.app,
        "enable-account",
        Command::User {
            id: uid.clone(),
            expected: None,
            changes: UserChanges {
                disabled: Some(false),
                create_public_room: Some(false),
                ..Default::default()
            },
        },
    )
    .await
    .unwrap();
    assert_eq!(
        operator::apply(&bench.app, "disable-account", disable)
            .await
            .unwrap(),
        receipt
    );
    let mut fresh = NativeClient::new(&bench.base).unwrap();
    assert_eq!(
        fresh
            .login("alice", "operator-test-password")
            .await
            .unwrap()
            .user
            .id,
        uid
    );
    assert_eq!(
        fresh
            .history(&room.subject_id, None)
            .await
            .unwrap()
            .messages[0]
            .id,
        message.id
    );
    assert!(client.snapshot().await.is_err());
    assert!(
        !fresh
            .account_permissions()
            .await
            .unwrap()
            .create_public_room
    );
    let stored_hash: String = sqlx::query_scalar("SELECT password_hash FROM users WHERE id=$1")
        .bind(&uid)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(original_hash, stored_hash);
    let rows = operator::audit(&bench.app, None, 100).await.unwrap();
    assert_eq!(
        rows.items
            .iter()
            .filter(|a| a.operation_id.as_deref() == Some("disable-account"))
            .count(),
        1
    );
    let text = serde_json::to_string(&rows).unwrap();
    assert!(
        !text.contains("operator-test-password")
            && !text.contains(&original_hash)
            && !text.contains("token_hash")
    );
    let cursor = operator::audit(&bench.app, None, 1)
        .await
        .unwrap()
        .next
        .unwrap();
    assert!(
        !operator::audit(&bench.app, Some(&cursor), 1)
            .await
            .unwrap()
            .items
            .is_empty()
    );
    assert!(operator::users(&bench.app, None, 101).await.is_err());
    assert!(
        operator::apply(
            &bench.app,
            "disable-account",
            Command::User {
                id: uid,
                expected: None,
                changes: UserChanges {
                    admin: Some(true),
                    ..Default::default()
                }
            }
        )
        .await
        .is_err()
    );
}
#[sqlx::test(migrations = "./migrations")]
async fn room_commands_are_idempotent_revision_checked_and_delivered_to_existing_clients(
    pool: PgPool,
) {
    let bench = Bench::start(pool.clone()).await;
    let (owner, uid) = bench.user("owner", false).await;
    let (admin, other) = bench.user("admin", true).await;
    let command = Command::CreateRoom {
        owner: uid.clone(),
        name: "Operator private room".into(),
        private: true,
    };
    let (a, b) = tokio::join!(
        operator::apply(&bench.app, "new-room", command.clone()),
        operator::apply(&bench.app, "new-room", command)
    );
    let created = a.unwrap();
    assert_eq!(created, b.unwrap());
    let rid = &created.subject_id;
    assert_eq!(
        operator::rooms(&bench.app, None, 50)
            .await
            .unwrap()
            .items
            .len(),
        1
    );
    assert!(
        owner
            .snapshot()
            .await
            .unwrap()
            .rooms
            .iter()
            .any(|r| &r.id == rid)
    );
    assert!(admin.snapshot().await.unwrap().rooms.is_empty());
    assert!(admin.history(rid, None).await.is_err());
    let member = operator::apply(
        &bench.app,
        "add-member",
        Command::Member {
            room: rid.clone(),
            user: other.clone(),
            expected: created.applied_revision.clone(),
            role: Some("member".into()),
        },
    )
    .await
    .unwrap();
    assert_eq!(
        operator::members(&bench.app, rid, None, 50)
            .await
            .unwrap()
            .items
            .len(),
        2
    );
    let before_grant = admin.snapshot().await.unwrap().rooms[0]
        .read_state
        .as_ref()
        .unwrap()
        .membership_version
        .clone();
    let settings = Command::Room {
        id: rid.clone(),
        expected: member.applied_revision.clone(),
        changes: RoomChanges {
            name: Some("Renamed by operator".into()),
            read_only: Some(true),
            topic: Some("New topic".into()),
            ..Default::default()
        },
    };
    let changed = operator::apply(&bench.app, "room-settings", settings.clone())
        .await
        .unwrap();
    let details = owner.room_details(rid).await.unwrap();
    assert_eq!(details.room.name, "Renamed by operator");
    assert!(details.read_only);
    assert_eq!(details.topic, "New topic");
    assert!(
        operator::apply(&bench.app, "stale-room-settings", settings.clone())
            .await
            .is_err()
    );
    let removed = operator::apply(
        &bench.app,
        "remove-member",
        Command::Member {
            room: rid.clone(),
            user: other.clone(),
            expected: changed.applied_revision.clone(),
            role: None,
        },
    )
    .await
    .unwrap();
    assert!(admin.snapshot().await.unwrap().rooms.is_empty());
    assert!(admin.history(rid, None).await.is_err());
    assert_eq!(
        operator::apply(&bench.app, "room-settings", settings)
            .await
            .unwrap(),
        changed
    );
    let last_owner = operator::apply(
        &bench.app,
        "remove-owner",
        Command::Member {
            room: rid.clone(),
            user: uid,
            expected: removed.applied_revision.clone(),
            role: None,
        },
    )
    .await
    .unwrap_err();
    assert_eq!(last_owner.code, "last_room_owner");
    operator::apply(
        &bench.app,
        "re-add-member",
        Command::Member {
            room: rid.clone(),
            user: other,
            expected: removed.applied_revision,
            role: Some("moderator".into()),
        },
    )
    .await
    .unwrap();
    let fresh = admin.snapshot().await.unwrap();
    assert_ne!(
        fresh.rooms[0]
            .read_state
            .as_ref()
            .unwrap()
            .membership_version,
        before_grant
    );
    let withdrawn: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM journal WHERE room_id=$1 AND change->>'type'='room_removed')",
    )
    .bind(rid)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(withdrawn);
}
#[sqlx::test(migrations = "./migrations")]
async fn operator_disable_waits_for_the_existing_delivery_lease(pool: PgPool) {
    let app = App::from_pool(pool.clone()).await.unwrap();
    let user = auth::create_user(&app, "leased", "operator-test-password".into(), false)
        .await
        .unwrap();
    let mut lease = pool.begin().await.unwrap();
    sqlx::query("SELECT activation_version FROM users WHERE id=$1 FOR KEY SHARE")
        .bind(&user.id)
        .execute(&mut *lease)
        .await
        .unwrap();
    let current = app.clone();
    let id = user.id.clone();
    let task = tokio::spawn(async move {
        operator::apply(
            &current,
            "disable-leased",
            Command::User {
                id,
                expected: None,
                changes: UserChanges {
                    disabled: Some(true),
                    ..Default::default()
                },
            },
        )
        .await
    });
    let mut blocked = false;
    for _ in 0..50 {
        blocked=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%activation_version AS revision FROM users%')").fetch_one(&pool).await.unwrap();
        if blocked {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    assert!(
        blocked,
        "The operator must wait on the same account lock used for delivery"
    );
    assert!(!task.is_finished());
    lease.commit().await.unwrap();
    task.await.unwrap().unwrap();
    assert!(operator::users(&app, None, 50).await.unwrap().items[0].disabled);
}
#[sqlx::test(migrations = "./migrations")]
async fn existing_operator_secrets_stay_out_of_the_atomic_audit_and_epoch_replay(pool: PgPool) {
    let app = App::from_pool(pool.clone()).await.unwrap();
    let user = auth::create_user(&app, "audit-user", "operator-test-password".into(), false)
        .await
        .unwrap();
    let invitation = rv_server::invitations::issue(&app, 1).await.unwrap();
    rv_server::invitations::revoke(&app, &invitation.invitation.id)
        .await
        .unwrap();
    rv_server::invitations::revoke(&app, &invitation.invitation.id)
        .await
        .unwrap();
    let recovery = rv_server::recovery::issue(&app, "audit-user", 1)
        .await
        .unwrap();
    rv_server::recovery::revoke(&app, &recovery.recovery.id)
        .await
        .unwrap();
    let records = operator::audit(&app, None, 100).await.unwrap();
    let serialized = serde_json::to_string(&records).unwrap();
    assert!(!serialized.contains(&invitation.token) && !serialized.contains(&recovery.token));
    assert_eq!(
        records
            .items
            .iter()
            .filter(|a| a.action == "invitation.revoked")
            .count(),
        1
    );
    let command = Command::User {
        id: user.id,
        expected: None,
        changes: UserChanges {
            create_private_room: Some(false),
            ..Default::default()
        },
    };
    operator::apply(&app, "epoch-operation", command.clone())
        .await
        .unwrap();
    sqlx::query("UPDATE instance SET data_epoch='restored-epoch' WHERE singleton")
        .execute(&pool)
        .await
        .unwrap();
    assert!(
        operator::apply(&app, "epoch-operation", command)
            .await
            .is_err()
    );
    assert_eq!(
        operator::health(&app).await.unwrap()["data_epoch"],
        "restored-epoch"
    );
}

#[sqlx::test(migrations = "./migrations")]
async fn installed_cli_parses_policy_flags_and_emits_only_operator_metadata(pool: PgPool) {
    let database: String = sqlx::query_scalar("SELECT current_database()")
        .fetch_one(&pool)
        .await
        .unwrap();
    let mut url = reqwest::Url::parse(&std::env::var("DATABASE_URL").unwrap()).unwrap();
    url.set_path(&format!("/{database}"));
    async fn cli(url: &str, args: &[&str], success: bool) -> String {
        let url = url.to_owned();
        let args = args.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        let output = tokio::task::spawn_blocking(move || {
            std::process::Command::new(env!("CARGO_BIN_EXE_rv-server"))
                .args(args)
                .env("DATABASE_URL", url)
                .env("RV_USER_PASSWORD", "operator-test-password")
                .env_remove("RV_AUTH_KEY_FILE")
                .env_remove("RV_SMTP_CONFIG_FILE")
                .output()
                .unwrap()
        })
        .await
        .unwrap();
        assert_eq!(
            output.status.success(),
            success,
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8(output.stdout).unwrap()
    }
    let url = url.as_str();
    cli(url, &["create-user", "cli-user"], true).await;
    let users: serde_json::Value =
        serde_json::from_str(&cli(url, &["list-users", "--limit", "1"], true).await).unwrap();
    let uid = users["items"][0]["id"].as_str().unwrap();
    assert!(!users.to_string().contains("password"));
    let args = [
        "create-room",
        uid,
        "CLI private room",
        "--private",
        "--operation-id",
        "cli-create-room",
    ];
    let created: serde_json::Value = serde_json::from_str(&cli(url, &args, true).await).unwrap();
    assert_eq!(
        created,
        serde_json::from_str::<serde_json::Value>(&cli(url, &args, true).await).unwrap()
    );
    let rid = created["subject_id"].as_str().unwrap();
    let revision = created["applied_revision"].as_str().unwrap();
    cli(
        url,
        &[
            "set-room",
            rid,
            "--revision",
            revision,
            "--read-only",
            "true",
            "--operation-id",
            "cli-read-only",
        ],
        true,
    )
    .await;
    cli(
        url,
        &[
            "set-room",
            rid,
            "--revision",
            revision,
            "--name",
            "Stale name",
        ],
        false,
    )
    .await;
    cli(
        url,
        &[
            "set-user",
            uid,
            "--disabled",
            "true",
            "--operation-id",
            "cli-disable",
        ],
        true,
    )
    .await;
    let users: serde_json::Value =
        serde_json::from_str(&cli(url, &["list-users"], true).await).unwrap();
    assert_eq!(users["items"][0]["disabled"], true);
    let audit = cli(url, &["audit"], true).await;
    assert!(!audit.contains("operator-test-password"));
    let health: serde_json::Value =
        serde_json::from_str(&cli(url, &["health"], true).await).unwrap();
    let latest = sqlx::migrate!()
        .iter()
        .map(|migration| migration.version)
        .max()
        .unwrap();
    assert_eq!(health["migration_version"], latest.to_string());
    cli(url, &["list-users", "--limit", "101"], false).await;
}
