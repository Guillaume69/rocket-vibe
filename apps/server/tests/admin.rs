use rv_client::{Error, NativeClient};
use rv_protocol::{
    CreateRoom, RoomKind, SendMessage,
    admin::{AdminOperation, DeleteAdminUser, ReportInput, UpdateAdminUser},
    live::PresenceStatus,
};
use rv_server::{App, auth, operator};
use sqlx::PgPool;

const PASSWORD: &str = "administration-test-password";

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
        let user = auth::create_user(&self.app, name, PASSWORD.into(), admin)
            .await
            .unwrap();
        (self.login(name).await.unwrap(), user.id)
    }
    async fn login(&self, name: &str) -> Result<NativeClient, Error> {
        let mut client = NativeClient::new(&self.base).unwrap();
        client.login(name, PASSWORD).await?;
        Ok(client)
    }
    async fn revision(&self, admin: &NativeClient, id: &str) -> String {
        let page = admin.admin_users(None, Some(100), None).await.unwrap();
        page.items
            .into_iter()
            .find(|u| u.id == id)
            .expect("listed account")
            .revision
    }
}

fn refused(result: Result<impl std::fmt::Debug, Error>) -> (u16, String) {
    match result {
        Err(Error::Server { status, code, .. }) => (status, code),
        other => panic!("expected a refusal, got {other:?}"),
    }
}
fn send(text: &str, operation: &str) -> SendMessage {
    serde_json::from_value(serde_json::json!({"operation_id":operation,"text":text})).unwrap()
}
fn room(name: &str, private: bool, operation: &str) -> CreateRoom {
    CreateRoom {
        name: name.into(),
        private,
        operation_id: Some(operation.into()),
        voice: false,
    }
}
fn operation(id: &str) -> AdminOperation {
    AdminOperation {
        operation_id: id.into(),
    }
}
fn report(id: &str, reason: &str) -> ReportInput {
    ReportInput {
        operation_id: id.into(),
        reason: reason.into(),
    }
}

#[sqlx::test(migrations = "./migrations")]
async fn members_are_refused_and_the_overview_counts_the_instance(pool: PgPool) {
    let bench = Bench::start(pool).await;
    let (root, _) = bench.user("root", true).await;
    let (alice, _) = bench.user("alice", false).await;
    let (bob, bob_id) = bench.user("bob", false).await;
    let (_, carol_id) = bench.user("carol", false).await;
    assert_eq!(
        refused(alice.admin_overview().await),
        (403, "permission_denied".into())
    );
    assert_eq!(refused(alice.admin_users(None, None, None).await).0, 403);
    assert_eq!(refused(alice.admin_rooms(None, None, None).await).0, 403);
    assert_eq!(
        refused(alice.admin_reported_messages(None, None).await).0,
        403
    );
    let carol_revision = bench.revision(&root, &carol_id).await;
    let forbidden = UpdateAdminUser {
        operation_id: "member-disables".into(),
        revision: carol_revision.clone(),
        admin: None,
        disabled: Some(true),
    };
    assert_eq!(
        refused(alice.update_admin_user(&carol_id, &forbidden).await).0,
        403
    );

    let team = alice
        .create_room(&room("Team", false, "team"))
        .await
        .unwrap();
    alice
        .send(&team.id, &send("public one", "p1"))
        .await
        .unwrap();
    alice
        .send(&team.id, &send("public two", "p2"))
        .await
        .unwrap();
    let secret = alice
        .create_room(&room("Secret", true, "secret"))
        .await
        .unwrap();
    alice
        .send(&secret.id, &send("private", "s1"))
        .await
        .unwrap();
    let direct = alice.direct(&bob_id).await.unwrap();
    bob.send(&direct.id, &send("direct", "d1")).await.unwrap();
    bob.set_presence(PresenceStatus::Busy).await.unwrap();
    root.update_admin_user(
        &carol_id,
        &UpdateAdminUser {
            operation_id: "suspend-carol".into(),
            revision: carol_revision,
            admin: None,
            disabled: Some(true),
        },
    )
    .await
    .unwrap();

    let overview = root.admin_overview().await.unwrap();
    assert_eq!(overview.server_version, env!("CARGO_PKG_VERSION"));
    assert!(chrono::DateTime::parse_from_rfc3339(&overview.started_at).is_ok());
    assert_eq!(overview.migration_version.as_deref(), Some("50"));
    assert!(!overview.postgres_version.is_empty());
    let users = overview.users;
    assert_eq!(
        (users.total, users.active, users.deactivated, users.admins),
        (4, 3, 1, 1)
    );
    assert_eq!(
        (users.busy, users.online + users.away + users.offline),
        (1, 2)
    );
    let rooms = overview.rooms;
    assert_eq!(
        (rooms.total, rooms.public, rooms.private, rooms.direct),
        (3, 1, 1, 1)
    );
    let messages = overview.messages;
    assert_eq!(
        (messages.public, messages.private, messages.direct),
        (2, 1, 1)
    );
    assert_eq!(messages.total, 4 + messages.encrypted);
    assert_eq!((overview.reports.messages, overview.reports.users), (0, 0));
}

#[sqlx::test(migrations = "./migrations")]
async fn the_account_list_searches_and_pages_by_username(pool: PgPool) {
    let bench = Bench::start(pool.clone()).await;
    let (root, root_id) = bench.user("root", true).await;
    for name in ["anna", "annabel", "bruno", "zoe"] {
        auth::create_user(&bench.app, name, PASSWORD.into(), false)
            .await
            .unwrap();
    }
    sqlx::query("UPDATE users SET display_name='Zoé Annick' WHERE username='zoe'")
        .execute(&pool)
        .await
        .unwrap();
    let first = root.admin_users(None, Some(2), None).await.unwrap();
    assert_eq!(
        first
            .items
            .iter()
            .map(|u| u.username.as_str())
            .collect::<Vec<_>>(),
        ["anna", "annabel"]
    );
    let second = root
        .admin_users(first.next.as_deref(), Some(2), None)
        .await
        .unwrap();
    assert_eq!(
        second
            .items
            .iter()
            .map(|u| u.username.as_str())
            .collect::<Vec<_>>(),
        ["bruno", "root"]
    );
    let last = root
        .admin_users(second.next.as_deref(), Some(2), None)
        .await
        .unwrap();
    assert_eq!(last.items.len(), 1);
    assert!(last.next.is_none());
    let me = second.items.iter().find(|u| u.id == root_id).unwrap();
    assert!(me.admin && !me.disabled && me.created_at.is_some() && me.last_seen_at.is_some());
    let found = root.admin_users(None, None, Some("ANN")).await.unwrap();
    assert_eq!(
        found
            .items
            .iter()
            .map(|u| u.username.as_str())
            .collect::<Vec<_>>(),
        ["anna", "annabel", "zoe"]
    );
    assert!(
        root.admin_users(None, None, Some("%"))
            .await
            .unwrap()
            .items
            .is_empty()
    );
    assert!(matches!(
        root.admin_users(None, Some(0), None).await,
        Err(Error::InvalidUrl)
    ));
}

#[sqlx::test(migrations = "./migrations")]
async fn rights_and_activation_need_the_revision_and_replay_without_reapplying(pool: PgPool) {
    let bench = Bench::start(pool.clone()).await;
    let (root, root_id) = bench.user("root", true).await;
    let (_, alice_id) = bench.user("alice", false).await;
    let (bob, bob_id) = bench.user("bob", false).await;
    let revision = bench.revision(&root, &alice_id).await;
    let grant = UpdateAdminUser {
        operation_id: "grant-alice".into(),
        revision: revision.clone(),
        admin: Some(true),
        disabled: None,
    };
    let granted = root.update_admin_user(&alice_id, &grant).await.unwrap();
    assert!(granted.admin && granted.revision != revision);
    // A replay answers the current state, even after the revision moved on.
    assert_eq!(
        root.update_admin_user(&alice_id, &grant).await.unwrap(),
        granted
    );
    let stale = UpdateAdminUser {
        operation_id: "stale".into(),
        revision,
        admin: Some(false),
        disabled: None,
    };
    assert_eq!(
        refused(root.update_admin_user(&alice_id, &stale).await),
        (409, "revision_conflict".into())
    );
    let reused = UpdateAdminUser {
        admin: Some(false),
        ..grant.clone()
    };
    assert_eq!(
        refused(root.update_admin_user(&alice_id, &reused).await),
        (409, "operation_conflict".into())
    );
    let alice = bench.login("alice").await.unwrap();
    assert!(alice.admin_overview().await.is_ok());

    let suspend = UpdateAdminUser {
        operation_id: "suspend-bob".into(),
        revision: bench.revision(&root, &bob_id).await,
        admin: None,
        disabled: Some(true),
    };
    let suspended = root.update_admin_user(&bob_id, &suspend).await.unwrap();
    assert!(suspended.disabled && suspended.avatar_file_id.is_none());
    assert_eq!(refused(bob.me().await).0, 401);
    assert!(bench.login("bob").await.is_err());
    let devices: i64 = sqlx::query_scalar("SELECT count(*) FROM session_devices WHERE user_id=$1")
        .bind(&bob_id)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(devices, 0);
    root.update_admin_user(
        &bob_id,
        &UpdateAdminUser {
            operation_id: "restore-bob".into(),
            revision: suspended.revision.clone(),
            admin: None,
            disabled: Some(false),
        },
    )
    .await
    .unwrap();
    // Replaying the old suspension does not suspend the account again.
    assert!(
        !root
            .update_admin_user(&bob_id, &suspend)
            .await
            .unwrap()
            .disabled
    );
    assert!(bench.login("bob").await.is_ok());

    let own = bench.revision(&root, &root_id).await;
    let myself = UpdateAdminUser {
        operation_id: "drop-mine".into(),
        revision: own.clone(),
        admin: Some(false),
        disabled: None,
    };
    assert_eq!(
        refused(root.update_admin_user(&root_id, &myself).await),
        (409, "self_administration".into())
    );
    assert_eq!(
        refused(
            root.delete_admin_user(
                &root_id,
                &DeleteAdminUser {
                    operation_id: "delete-mine".into(),
                    revision: own,
                },
            )
            .await
        ),
        (409, "self_administration".into())
    );

    // Two administrators demoting each other at once: one of them stays.
    let (root_revision, alice_revision) = (
        bench.revision(&root, &root_id).await,
        bench.revision(&root, &alice_id).await,
    );
    let demote_alice = UpdateAdminUser {
        operation_id: "demote-alice".into(),
        revision: alice_revision,
        admin: Some(false),
        disabled: None,
    };
    let demote_root = UpdateAdminUser {
        operation_id: "demote-root".into(),
        revision: root_revision,
        admin: Some(false),
        disabled: None,
    };
    let (left, right) = tokio::join!(
        root.update_admin_user(&alice_id, &demote_alice),
        alice.update_admin_user(&root_id, &demote_root)
    );
    assert!(left.is_ok() != right.is_ok());
    let admins: i64 = sqlx::query_scalar("SELECT count(*) FROM users WHERE admin AND NOT disabled")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(admins, 1);

    let audit = operator::audit(&bench.app, None, 100).await.unwrap();
    let policy = audit
        .items
        .iter()
        .filter(|a| a.action == "user.policy")
        .collect::<Vec<_>>();
    assert!(!policy.is_empty());
    assert!(
        policy
            .iter()
            .all(|a| a.actor_id.is_some() && a.operation_id.is_some())
    );
    assert!(
        policy
            .iter()
            .any(|a| a.actor_id.as_deref() == Some(root_id.as_str())
                && a.operation_id.as_deref() == Some("grant-alice"))
    );
}

#[sqlx::test(migrations = "./migrations")]
async fn deletion_tombstones_the_account_and_keeps_its_messages(pool: PgPool) {
    let bench = Bench::start(pool.clone()).await;
    let (root, _) = bench.user("root", true).await;
    let (alice, alice_id) = bench.user("alice", false).await;
    let (bob, bob_id) = bench.user("bob", false).await;
    let team = alice
        .create_room(&room("Team", false, "team"))
        .await
        .unwrap();
    bob.join_public(&team.id).await.unwrap();
    let kept = alice
        .send(&team.id, &send("Keep me", "keep"))
        .await
        .unwrap();
    let direct = alice.direct(&bob_id).await.unwrap();
    alice
        .send(&direct.id, &send("Hello Bob", "hello"))
        .await
        .unwrap();
    bob.report_user(&alice_id, &report("bob-reports-alice", "Spam"))
        .await
        .unwrap();

    // A verified address, an e-mail factor and its backup codes, to be erased.
    for query in [
        "INSERT INTO account_emails(user_id,address,verified_at) VALUES($1,'alice@example.org',now())",
        "INSERT INTO user_email_factors(user_id,version,email_version,key_check_cipher) SELECT id,'factor',email_version,decode('00','hex') FROM users WHERE id=$1",
        "INSERT INTO factor_backup_codes(token_hash,user_id) VALUES(repeat('0',64),$1)",
    ] {
        sqlx::query(query)
            .bind(&alice_id)
            .execute(&pool)
            .await
            .unwrap();
    }
    let revision = bench.revision(&root, &alice_id).await;
    let stale = DeleteAdminUser {
        operation_id: "stale-delete".into(),
        revision: "outdated".into(),
    };
    assert_eq!(
        refused(root.delete_admin_user(&alice_id, &stale).await),
        (409, "revision_conflict".into())
    );
    let delete = DeleteAdminUser {
        operation_id: "delete-alice".into(),
        revision,
    };
    root.delete_admin_user(&alice_id, &delete).await.unwrap();
    root.delete_admin_user(&alice_id, &delete).await.unwrap();

    let history = bob.history(&team.id, None).await.unwrap();
    let message = history.messages.iter().find(|m| m.id == kept.id).unwrap();
    assert!(message.author.deleted && !message.deleted);
    assert_eq!(message.author.id, alice_id);
    assert_eq!(message.author.username, format!("deleted-{alice_id}"));
    assert_eq!(message.author.display_name, "");
    assert_eq!(message.text, "Keep me");
    let encoded = serde_json::to_value(&message.author).unwrap();
    assert_eq!(encoded["deleted"], true);
    // The remaining member inherits the ownerless room.
    assert_eq!(
        bob.room_details(&team.id).await.unwrap().permissions.role,
        rv_protocol::parity::RoomRole::Owner
    );
    let dm = bob.history(&direct.id, None).await.unwrap();
    assert!(dm.messages.iter().any(|m| m.author.deleted));
    let rooms = root.admin_rooms(None, None, None).await.unwrap();
    let pair = &rooms.items.iter().find(|r| r.id == direct.id).unwrap();
    assert_eq!(pair.member_count, 1);
    assert!(
        pair.direct_members
            .iter()
            .any(|u| u.id == alice_id && u.deleted)
    );

    let (members, devices, deleted, password): (i64, i64, bool, String) = sqlx::query_as("SELECT (SELECT count(*) FROM members WHERE user_id=$1),(SELECT count(*) FROM session_devices WHERE user_id=$1),deleted,password_hash FROM users WHERE id=$1")
        .bind(&alice_id)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        (members, devices, deleted, password.as_str()),
        (0, 0, true, "")
    );
    let secrets: i64 = sqlx::query_scalar("SELECT (SELECT count(*) FROM account_emails WHERE user_id=$1)+(SELECT count(*) FROM user_email_factors WHERE user_id=$1)+(SELECT count(*) FROM factor_backup_codes WHERE user_id=$1)")
        .bind(&alice_id)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(secrets, 0);
    assert_eq!(refused(alice.me().await).0, 401);
    assert!(bench.login("alice").await.is_err());
    assert!(bench.login(&format!("deleted-{alice_id}")).await.is_err());
    let listed = root.admin_users(None, None, None).await.unwrap();
    assert!(listed.items.iter().all(|u| u.id != alice_id));
    assert!(bob.users().await.unwrap().iter().all(|u| u.id != alice_id));
    assert_eq!(root.admin_overview().await.unwrap().users.total, 2);
    assert!(
        root.admin_reported_users(None, None)
            .await
            .unwrap()
            .items
            .is_empty()
    );
    assert_eq!(
        refused(
            root.update_admin_user(
                &alice_id,
                &UpdateAdminUser {
                    operation_id: "revive".into(),
                    revision: "any".into(),
                    admin: None,
                    disabled: Some(false),
                },
            )
            .await
        ),
        (404, "not_found".into())
    );

    // The name is free again; `deleted-` names stay reserved.
    let again = auth::create_user(&bench.app, "alice", PASSWORD.into(), false)
        .await
        .unwrap();
    assert_ne!(again.id, alice_id);
    assert!(
        auth::create_user(&bench.app, "Deleted-someone", PASSWORD.into(), false)
            .await
            .is_err()
    );
    let profile = bob.own_profile().await.unwrap().profile;
    let rename = rv_protocol::profiles::UpdateProfile {
        operation_id: "rename".into(),
        expected_revision: profile.revision,
        username: "deleted-bob".into(),
        display_name: "Bob".into(),
        bio: String::new(),
        status: PresenceStatus::Online,
        status_text: String::new(),
    };
    assert_eq!(refused(bob.update_profile(&rename).await).0, 400);
    let audit = operator::audit(&bench.app, None, 100).await.unwrap();
    assert!(
        audit
            .items
            .iter()
            .any(|a| a.action == "user.deleted" && a.subject == alice_id && a.actor_id.is_some())
    );
}

#[sqlx::test(migrations = "./migrations")]
async fn rooms_include_direct_conversations_with_their_counts(pool: PgPool) {
    let bench = Bench::start(pool).await;
    let (root, _) = bench.user("root", true).await;
    let (alice, alice_id) = bench.user("alice", false).await;
    let (bob, bob_id) = bench.user("bob", false).await;
    let team = alice
        .create_room(&room("Team", false, "team"))
        .await
        .unwrap();
    alice.send(&team.id, &send("one", "one")).await.unwrap();
    alice.send(&team.id, &send("two", "two")).await.unwrap();
    let direct = alice.direct(&bob_id).await.unwrap();
    bob.send(&direct.id, &send("hi", "hi")).await.unwrap();

    let page = root.admin_rooms(None, None, None).await.unwrap();
    assert_eq!(page.items.len(), 2);
    let dm = page.items.iter().find(|r| r.id == direct.id).unwrap();
    assert_eq!(dm.kind, RoomKind::Direct);
    assert_eq!((dm.member_count, dm.message_count), (2, 1));
    assert!(dm.last_message_at.is_some() && dm.created_at.is_some());
    let mut pair = dm
        .direct_members
        .iter()
        .map(|u| u.id.clone())
        .collect::<Vec<_>>();
    pair.sort();
    let mut expected = vec![alice_id, bob_id];
    expected.sort();
    assert_eq!(pair, expected);
    let shared = page.items.iter().find(|r| r.id == team.id).unwrap();
    assert_eq!(
        (shared.kind, shared.member_count, shared.message_count),
        (RoomKind::Public, 1, 2)
    );
    assert!(shared.direct_members.is_empty() && shared.topic.is_none());

    let first = root.admin_rooms(None, Some(1), None).await.unwrap();
    assert_eq!(first.items.len(), 1);
    let rest = root
        .admin_rooms(first.next.as_deref(), Some(1), None)
        .await
        .unwrap();
    assert_eq!(rest.items.len(), 1);
    assert_ne!(rest.items[0].id, first.items[0].id);
    assert!(rest.next.is_none());
    let found = root.admin_rooms(None, None, Some("tea")).await.unwrap();
    assert_eq!(found.items.len(), 1);
    assert_eq!(found.items[0].id, team.id);
}

#[sqlx::test(migrations = "./migrations")]
async fn reports_reach_the_administrators_who_dismiss_or_delete(pool: PgPool) {
    let bench = Bench::start(pool).await;
    let (root, root_id) = bench.user("root", true).await;
    let (alice, alice_id) = bench.user("alice", false).await;
    let (bob, bob_id) = bench.user("bob", false).await;
    let (carol, _) = bench.user("carol", false).await;
    let team = alice
        .create_room(&room("Team", true, "team"))
        .await
        .unwrap();
    alice.add_member(&team.id, &bob_id).await.unwrap();
    let offending = bob.send(&team.id, &send("Offending", "m1")).await.unwrap();
    let other = bob.send(&team.id, &send("Borderline", "m2")).await.unwrap();

    // Reporting needs read access, never one's own message, and a real reason.
    assert_eq!(
        refused(
            carol
                .report_message(&offending.id, &report("c1", "Spam"))
                .await
        ),
        (404, "not_found".into())
    );
    assert_eq!(
        refused(
            bob.report_message(&offending.id, &report("b1", "Spam"))
                .await
        ),
        (409, "self_report".into())
    );
    assert_eq!(
        refused(
            alice
                .report_message(&offending.id, &report("a0", "   "))
                .await
        )
        .0,
        400
    );
    assert_eq!(
        refused(
            alice
                .report_message(&offending.id, &report("a0", &"x".repeat(1001)))
                .await
        )
        .0,
        400
    );
    alice
        .report_message(&offending.id, &report("a1", "Spam"))
        .await
        .unwrap();
    alice
        .report_message(&offending.id, &report("a1", "Spam"))
        .await
        .unwrap();
    assert_eq!(
        refused(
            alice
                .report_message(&offending.id, &report("a1", "Other"))
                .await
        ),
        (409, "operation_conflict".into())
    );
    alice
        .report_message(&offending.id, &report("a2", "  Abuse  "))
        .await
        .unwrap();
    alice
        .report_message(&other.id, &report("a3", "Unsure"))
        .await
        .unwrap();
    alice
        .report_user(&bob_id, &report("a4", "Rude"))
        .await
        .unwrap();
    assert_eq!(
        refused(alice.report_user(&alice_id, &report("a5", "Me")).await),
        (409, "self_report".into())
    );

    let overview = root.admin_overview().await.unwrap();
    assert_eq!((overview.reports.messages, overview.reports.users), (2, 1));
    let page = root.admin_reported_messages(None, Some(1)).await.unwrap();
    assert_eq!(page.items.len(), 1);
    assert_eq!(page.items[0].message_id, other.id);
    let page = root
        .admin_reported_messages(page.next.as_deref(), Some(1))
        .await
        .unwrap();
    let item = &page.items[0];
    assert_eq!(item.message_id, offending.id);
    assert_eq!((item.report_count, item.reports.len()), (1, 1));
    assert_eq!(item.reports[0].reason, "Abuse");
    assert_eq!(item.reports[0].reporter.id, alice_id);
    assert_eq!(
        (item.text.as_str(), item.room_name.as_str()),
        ("Offending", "Team")
    );
    assert_eq!(
        (item.room_kind, item.author.id.as_str()),
        (RoomKind::Private, bob_id.as_str())
    );
    assert!(page.next.is_none());
    let users = root.admin_reported_users(None, None).await.unwrap();
    assert_eq!(users.items[0].user.id, bob_id);
    assert_eq!(users.items[0].reports[0].reason, "Rude");
    assert_eq!(refused(alice.admin_reported_users(None, None).await).0, 403);

    // Moderation deletes only a reported message, which an admin cannot read otherwise.
    let unreported = bob.send(&team.id, &send("Fine", "m3")).await.unwrap();
    assert_eq!(
        refused(
            root.delete_reported_message(&unreported.id, &operation("d0"))
                .await
        ),
        (404, "not_found".into())
    );
    assert_eq!(refused(root.history(&team.id, None).await).0, 404);
    root.delete_reported_message(&offending.id, &operation("d1"))
        .await
        .unwrap();
    root.delete_reported_message(&offending.id, &operation("d1"))
        .await
        .unwrap();
    let history = alice.history(&team.id, None).await.unwrap();
    let tombstone = history
        .messages
        .iter()
        .find(|m| m.id == offending.id)
        .unwrap();
    assert!(tombstone.deleted && tombstone.text.is_empty());
    assert!(
        history
            .messages
            .iter()
            .any(|m| m.id == unreported.id && !m.deleted)
    );
    root.dismiss_message_reports(&other.id, &operation("d2"))
        .await
        .unwrap();
    assert!(!alice.message(&other.id).await.unwrap().deleted);
    assert!(
        root.admin_reported_messages(None, None)
            .await
            .unwrap()
            .items
            .is_empty()
    );
    assert_eq!(
        refused(
            root.dismiss_message_reports(&other.id, &operation("d3"))
                .await
        )
        .0,
        404
    );
    root.dismiss_user_reports(&bob_id, &operation("d4"))
        .await
        .unwrap();
    assert!(
        root.admin_reported_users(None, None)
            .await
            .unwrap()
            .items
            .is_empty()
    );
    assert_eq!(
        refused(root.dismiss_user_reports(&bob_id, &operation("d5")).await).0,
        404
    );

    let audit = operator::audit(&bench.app, None, 100).await.unwrap();
    let actor = |action: &str| {
        audit
            .items
            .iter()
            .filter(|a| a.action == action)
            .map(|a| a.actor_id.clone().unwrap_or_default())
            .collect::<Vec<_>>()
    };
    assert_eq!(actor("message.reported").len(), 3);
    assert!(actor("message.reported").iter().all(|id| *id == alice_id));
    assert_eq!(actor("user.reported"), std::slice::from_ref(&alice_id));
    assert_eq!(actor("message.moderated"), std::slice::from_ref(&root_id));
    assert_eq!(
        actor("message.reports_closed"),
        std::slice::from_ref(&root_id)
    );
    assert_eq!(actor("user.reports_closed"), [root_id]);
}
