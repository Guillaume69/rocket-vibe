use futures_util::StreamExt;
use reqwest::{Client, StatusCode};
use rv_protocol::{
    Change, Discovery, Message, MessagePage, Room, Session, Snapshot, SnapshotPage, SocketTicket,
    SyncBatch,
};
use rv_server::{App, auth};
use serde_json::{Value, json};
use sqlx::PgPool;
use std::time::Duration;

struct Server {
    base: String,
    client: Client,
    task: tokio::task::JoinHandle<()>,
}

impl Drop for Server {
    fn drop(&mut self) {
        self.task.abort();
    }
}

impl Server {
    async fn start(pool: PgPool) -> Self {
        let app = App::from_pool(pool).await.unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let task = tokio::spawn(async move {
            axum::serve(
                listener,
                app.router()
                    .into_make_service_with_connect_info::<std::net::SocketAddr>(),
            )
            .await
            .unwrap();
        });
        Self {
            base,
            client: Client::builder()
                .timeout(Duration::from_secs(10))
                .build()
                .unwrap(),
            task,
        }
    }
    async fn login(&self, username: &str) -> Session {
        self.client
            .post(format!("{}/api/v1/auth/login", self.base))
            .json(&json!({"username":username,"password":"test-password-2026"}))
            .send()
            .await
            .unwrap()
            .error_for_status()
            .unwrap()
            .json()
            .await
            .unwrap()
    }
    async fn get(&self, token: &str, path: &str) -> reqwest::Response {
        self.client
            .get(format!("{}{path}", self.base))
            .bearer_auth(token)
            .send()
            .await
            .unwrap()
    }
    async fn post(&self, token: &str, path: &str, body: Value) -> reqwest::Response {
        self.client
            .post(format!("{}{path}", self.base))
            .bearer_auth(token)
            .json(&body)
            .send()
            .await
            .unwrap()
    }
    async fn snapshot(&self, token: &str) -> Snapshot {
        self.get(token, "/api/v1/sync/snapshot")
            .await
            .error_for_status()
            .unwrap()
            .json()
            .await
            .unwrap()
    }
    async fn put(&self, token: &str, path: &str, body: Value) -> reqwest::Response {
        self.client
            .put(format!("{}{path}", self.base))
            .bearer_auth(token)
            .json(&body)
            .send()
            .await
            .unwrap()
    }
    async fn changes(&self, token: &str, cursor: &str) -> SyncBatch {
        self.get(token, &format!("/api/v1/sync/changes?cursor={cursor}"))
            .await
            .error_for_status()
            .unwrap()
            .json()
            .await
            .unwrap()
    }
}

async fn user(app: &App, username: &str) -> rv_protocol::User {
    auth::create_user(app, username, "test-password-2026".into(), false)
        .await
        .unwrap()
}

#[sqlx::test]
async fn reaction_states_deduplicate_aliases_and_replay_without_reverting_later_intentions(
    pool: PgPool,
) {
    let app = App::from_pool(pool.clone()).await.unwrap();
    let alice_user = user(&app, "alice").await;
    let bob_user = user(&app, "bob").await;
    user(&app, "outsider").await;
    let server = Server::start(pool.clone()).await;
    let alice = server.login("alice").await;
    let bob = server.login("bob").await;
    let outsider = server.login("outsider").await;
    let room: Room = server
        .post(
            &alice.token,
            "/api/v1/rooms",
            json!({"name":"Reactions","private":true}),
        )
        .await
        .json()
        .await
        .unwrap();
    assert_eq!(
        server
            .post(
                &alice.token,
                &format!("/api/v1/rooms/{}/members/{}", room.id, bob_user.id),
                json!(null)
            )
            .await
            .status(),
        StatusCode::NO_CONTENT
    );
    let original: Message = server
        .post(
            &alice.token,
            &format!("/api/v1/rooms/{}/messages", room.id),
            json!({"operation_id":"reaction-target","text":"React without editing"}),
        )
        .await
        .json()
        .await
        .unwrap();
    let page: SnapshotPage = server
        .post(&alice.token, "/api/v1/sync/snapshots", json!(null))
        .await
        .json()
        .await
        .unwrap();
    let path = format!("/api/v1/messages/{}/reactions", original.id);
    let add = json!({"operation_id":"alice-add","emoji":":+1:","present":true});
    let added: Message = server
        .put(&alice.token, &path, add.clone())
        .await
        .json()
        .await
        .unwrap();
    assert_eq!(added.position, original.position);
    assert_eq!(added.text, original.text);
    assert_eq!(added.edited_at, None);
    assert_eq!(
        added.reactions[0].emoji,
        rv_protocol::emojis::canonical("+1").unwrap()
    );
    assert_eq!(added.reactions[0].users[0].id, alice_user.id);
    let (one, two) = tokio::join!(
        server.put(
            &bob.token,
            &path,
            json!({"operation_id":"bob-add","emoji":"thumbsup","present":true})
        ),
        server.put(
            &bob.token,
            &path,
            json!({"operation_id":"bob-add","emoji":":thumbsup:","present":true})
        )
    );
    let one: Message = one.json().await.unwrap();
    let two: Message = two.json().await.unwrap();
    assert_eq!(one, two);
    assert_eq!(one.reactions[0].users.len(), 2);
    let replay: Message = server
        .put(&alice.token, &path, add.clone())
        .await
        .json()
        .await
        .unwrap();
    assert_eq!(replay, one);
    assert_eq!(
        server
            .put(
                &alice.token,
                &path,
                json!({"operation_id":"alice-add","emoji":"thumbsup","present":false})
            )
            .await
            .status(),
        StatusCode::CONFLICT
    );
    let removed: Message = server
        .put(
            &alice.token,
            &path,
            json!({"operation_id":"alice-remove","emoji":"+1","present":false}),
        )
        .await
        .json()
        .await
        .unwrap();
    assert_eq!(removed.reactions[0].users.len(), 1);
    assert_eq!(removed.reactions[0].users[0].id, bob_user.id);
    assert_eq!(
        server
            .put(&alice.token, &path, add.clone())
            .await
            .json::<Message>()
            .await
            .unwrap(),
        removed
    );
    let changes = server
        .changes(&alice.token, page.cursor.as_deref().unwrap())
        .await;
    assert!(changes.changes.iter().any(|change|matches!(change,Change::MessageUpsert(message) if message.reactions==removed.reactions)));
    assert!(
        page.messages
            .iter()
            .all(|message| message.reactions.is_empty()),
        "the fixed snapshot retains its pre-reaction cut"
    );
    assert_eq!(
        server
            .put(&outsider.token, &path, add.clone())
            .await
            .status(),
        StatusCode::NOT_FOUND
    );
    drop(server);
    let restarted = Server::start(pool.clone()).await;
    assert_eq!(
        restarted
            .put(&alice.token, &path, add)
            .await
            .json::<Message>()
            .await
            .unwrap(),
        removed
    );
    sqlx::query("UPDATE rooms SET read_only=true WHERE id=$1")
        .bind(&room.id)
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(
        restarted
            .put(
                &bob.token,
                &path,
                json!({"operation_id":"bob-remove","emoji":"thumbsup","present":false})
            )
            .await
            .status(),
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        restarted
            .put(
                &bob.token,
                &path,
                json!({"operation_id":"bob-add","emoji":"thumbsup","present":true})
            )
            .await
            .status(),
        StatusCode::OK,
        "old receipts remain readable when writing is revoked"
    );
    let current: Message = restarted
        .get(&alice.token, &format!("/api/v1/messages/{}", original.id))
        .await
        .json()
        .await
        .unwrap();
    let deleted: Message = restarted
        .client
        .delete(format!(
            "{}/api/v1/messages/{}",
            restarted.base, original.id
        ))
        .bearer_auth(&alice.token)
        .json(&json!({"operation_id":"delete-reacted","expected_revision":current.revision}))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(deleted.deleted && deleted.reactions.is_empty());
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM message_reactions WHERE message_id=$1")
            .bind(&original.id)
            .fetch_one(&pool)
            .await
            .unwrap(),
        0
    );
    assert_eq!(
        restarted
            .put(
                &alice.token,
                &path,
                json!({"operation_id":"alice-add","emoji":"thumbsup","present":true})
            )
            .await
            .json::<Message>()
            .await
            .unwrap(),
        deleted
    );
    assert_eq!(
        restarted
            .put(
                &alice.token,
                &path,
                json!({"operation_id":"after-delete","emoji":"rocket","present":true})
            )
            .await
            .status(),
        StatusCode::GONE
    );
    let payloads: Vec<sqlx::types::Json<Change>> =
        sqlx::query_scalar("SELECT change FROM journal WHERE change #>> '{data,id}'=$1")
            .bind(&original.id)
            .fetch_all(&pool)
            .await
            .unwrap();
    assert!(payloads.iter().all(|change| matches!(&change.0,Change::MessageUpsert(message) if message.deleted && message.text.is_empty() && message.reactions.is_empty())));
}

#[sqlx::test]
async fn reaction_limits_forged_fields_and_action_quotas_are_enforced(pool: PgPool) {
    let app = App::from_pool(pool.clone()).await.unwrap();
    let account = user(&app, "alice").await;
    let server = Server::start(pool.clone()).await;
    let alice = server.login("alice").await;
    let room: Room = server
        .post(
            &alice.token,
            "/api/v1/rooms",
            json!({"name":"Bounded reactions","private":true}),
        )
        .await
        .json()
        .await
        .unwrap();
    let message: Message = server
        .post(
            &alice.token,
            &format!("/api/v1/rooms/{}/messages", room.id),
            json!({"operation_id":"bounded-target","text":"Bounded metadata"}),
        )
        .await
        .json()
        .await
        .unwrap();
    let path = format!("/api/v1/messages/{}/reactions", message.id);
    assert_eq!(server.put(&alice.token,&path,json!({"operation_id":"forged","emoji":"rocket","present":true,"user_id":"someone-else"})).await.status(),StatusCode::BAD_REQUEST);
    assert_eq!(
        server
            .put(
                &alice.token,
                &path,
                json!({"operation_id":"unknown","emoji":"not_a_real_emoji","present":true})
            )
            .await
            .status(),
        StatusCode::UNPROCESSABLE_ENTITY
    );
    assert_eq!(
        server
            .put(
                &alice.token,
                &path,
                json!({"operation_id":"bounded-target","emoji":"rocket","present":true})
            )
            .await
            .status(),
        StatusCode::CONFLICT
    );
    let aliases: std::collections::HashMap<String, String> = serde_json::from_str(include_str!(
        "../../../crates/rv-protocol/data/emoji-aliases.json"
    ))
    .unwrap();
    let codes: Vec<_> = aliases
        .into_values()
        .collect::<std::collections::BTreeSet<_>>()
        .into_iter()
        .take(17)
        .collect();
    for (index, code) in codes.iter().take(16).enumerate() {
        assert_eq!(
            server
                .put(
                    &alice.token,
                    &path,
                    json!({"operation_id":format!("bounded-{index}"),"emoji":code,"present":true})
                )
                .await
                .status(),
            StatusCode::OK
        );
    }
    assert_eq!(
        server
            .put(
                &alice.token,
                &path,
                json!({"operation_id":"too-many","emoji":codes[16],"present":true})
            )
            .await
            .status(),
        StatusCode::UNPROCESSABLE_ENTITY
    );
    sqlx::query("UPDATE message_action_windows SET attempts=30 WHERE user_id=$1")
        .bind(&account.id)
        .execute(&pool)
        .await
        .unwrap();
    let limited = server
        .put(
            &alice.token,
            &path,
            json!({"operation_id":"limited","emoji":codes[0],"present":false}),
        )
        .await;
    assert_eq!(limited.status(), StatusCode::TOO_MANY_REQUESTS);
    assert!(
        limited.headers()["retry-after"]
            .to_str()
            .unwrap()
            .parse::<u64>()
            .unwrap()
            > 0
    );
    let error: Value = limited.json().await.unwrap();
    assert_eq!(error["code"], "message_action_limit");
    assert!(error["request_id"].is_string());
    drop(server);
    let restarted = Server::start(pool.clone()).await;
    assert_eq!(
        restarted
            .put(
                &alice.token,
                &path,
                json!({"operation_id":"limited","emoji":codes[0],"present":false})
            )
            .await
            .status(),
        StatusCode::TOO_MANY_REQUESTS
    );
    assert_eq!(
        restarted
            .put(
                &alice.token,
                &path,
                json!({"operation_id":"bounded-0","emoji":codes[0],"present":true})
            )
            .await
            .status(),
        StatusCode::OK
    );
    sqlx::query("UPDATE message_action_windows SET expires_at=clock_timestamp()-interval '1 second' WHERE user_id=$1").bind(&account.id).execute(&pool).await.unwrap();
    assert_eq!(
        restarted
            .put(
                &alice.token,
                &path,
                json!({"operation_id":"limited","emoji":codes[0],"present":false})
            )
            .await
            .status(),
        StatusCode::OK
    );
}

#[sqlx::test]
async fn authority_hints_match_enforced_creation_and_read_only_policies(pool: PgPool) {
    use rv_protocol::parity::{AccountPermissions, MessagePermissions, RoomPermissions, RoomRole};
    let app = App::from_pool(pool.clone()).await.unwrap();
    let owner = user(&app, "owner").await;
    let member = user(&app, "member").await;
    let admin = auth::create_user(&app, "admin", "test-password-2026".into(), true)
        .await
        .unwrap();
    let server = Server::start(pool.clone()).await;
    let owner_session = server.login("owner").await;
    let member_session = server.login("member").await;
    let admin_session = server.login("admin").await;
    let mut native = rv_client::NativeClient::new(&server.base).unwrap();
    native.restore(owner_session.token.clone());
    assert!(
        native
            .account_permissions()
            .await
            .unwrap()
            .create_private_room
    );
    let room: Room = server
        .post(
            &owner_session.token,
            "/api/v1/rooms",
            json!({"name":"Policies","private":true,"operation_id":"policy-room"}),
        )
        .await
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    server
        .post(
            &owner_session.token,
            &format!("/api/v1/rooms/{}/members/{}", room.id, member.id),
            json!({}),
        )
        .await
        .error_for_status()
        .unwrap();
    let path = format!("/api/v1/rooms/{}/permissions", room.id);
    let original: RoomPermissions = server
        .get(&member_session.token, &path)
        .await
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(original.role, RoomRole::Member);
    assert!(
        original.read
            && original.send
            && !original.invite
            && !original.remove_member
            && !original.pin
    );
    assert_eq!(
        server.get(&admin_session.token, &path).await.status(),
        StatusCode::NOT_FOUND,
        "admin authority never grants private room access"
    );
    let message: Message = server
        .post(
            &owner_session.token,
            &format!("/api/v1/rooms/{}/messages", room.id),
            json!({"operation_id":"policy-message","text":"Original"}),
        )
        .await
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    let mp = format!("/api/v1/messages/{}/permissions", message.id);
    let author: MessagePermissions = server
        .get(&owner_session.token, &mp)
        .await
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(author.edit && author.delete && author.pin && author.star);
    assert_eq!(
        native.message_permissions(&message.id).await.unwrap(),
        author
    );
    assert_eq!(
        native.room_permissions(&room.id).await.unwrap().role,
        RoomRole::Owner
    );
    let other: MessagePermissions = server
        .get(&member_session.token, &mp)
        .await
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(!other.edit && !other.delete && !other.pin);
    assert_eq!(
        server.get(&admin_session.token, &mp).await.status(),
        StatusCode::NOT_FOUND
    );
    sqlx::query("UPDATE rooms SET read_only=true WHERE id=$1")
        .bind(&room.id)
        .execute(&pool)
        .await
        .unwrap();
    let restricted: RoomPermissions = server
        .get(&member_session.token, &path)
        .await
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(!restricted.send && !restricted.upload && !restricted.start_call);
    assert_ne!(restricted.revision, original.revision);
    assert_eq!(
        server
            .post(
                &member_session.token,
                &format!("/api/v1/rooms/{}/messages", room.id),
                json!({"operation_id":"blocked-member","text":"Refused"})
            )
            .await
            .status(),
        StatusCode::FORBIDDEN
    );
    sqlx::query("UPDATE members SET role='moderator' WHERE room_id=$1 AND user_id=$2")
        .bind(&room.id)
        .bind(&member.id)
        .execute(&pool)
        .await
        .unwrap();
    let moderator: RoomPermissions = server
        .get(&member_session.token, &path)
        .await
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(moderator.role, RoomRole::Moderator);
    assert!(moderator.send && moderator.pin && !moderator.invite && !moderator.change_settings);
    assert_ne!(moderator.revision, restricted.revision);
    server
        .post(
            &member_session.token,
            &format!("/api/v1/rooms/{}/messages", room.id),
            json!({"operation_id":"moderator-message","text":"Allowed"}),
        )
        .await
        .error_for_status()
        .unwrap();
    let moderator_message: MessagePermissions = server
        .get(&member_session.token, &mp)
        .await
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(!moderator_message.edit && moderator_message.delete);
    sqlx::query("UPDATE messages SET created_at=now()-interval '16 minutes' WHERE id=$1")
        .bind(&message.id)
        .execute(&pool)
        .await
        .unwrap();
    let expired: MessagePermissions = server
        .get(&owner_session.token, &mp)
        .await
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(
        !expired.edit && expired.delete,
        "owners moderate but cannot edit beyond the author's time window"
    );
    sqlx::query("UPDATE users SET create_public_room=false,create_private_room=false WHERE id=$1")
        .bind(&owner.id)
        .execute(&pool)
        .await
        .unwrap();
    let permissions: AccountPermissions = server
        .get(&owner_session.token, "/api/v1/me/permissions")
        .await
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(
        !permissions.create_public_room
            && !permissions.create_private_room
            && !permissions.manage_accounts
    );
    for private in [true, false] {
        assert_eq!(
            server
                .post(
                    &owner_session.token,
                    "/api/v1/rooms",
                    json!({"name":"Refused","private":private})
                )
                .await
                .status(),
            StatusCode::FORBIDDEN
        );
    }
    let replay: Room = server
        .post(
            &owner_session.token,
            "/api/v1/rooms",
            json!({"name":"Policies","private":true,"operation_id":"policy-room"}),
        )
        .await
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(
        replay.id, room.id,
        "an existing receipt can still be reconciled without another creation"
    );
    let administrator: AccountPermissions = server
        .get(&admin_session.token, "/api/v1/me/permissions")
        .await
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(administrator.manage_accounts && administrator.manage_instance);
    assert_eq!(admin.id, admin_session.user.id);
    let public: Room = server
        .post(
            &member_session.token,
            "/api/v1/rooms",
            json!({"name":"Discover alias","private":false}),
        )
        .await
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    let alias: rv_protocol::PublicRoomPage = server
        .get(&owner_session.token, "/api/v1/rooms/discover?q=Discover")
        .await
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(alias.rooms.iter().any(|entry| entry.room.id == public.id));
}

#[sqlx::test]
async fn edit_delete_receipts_revisions_and_erasure_survive_restart(pool: PgPool) {
    use rv_protocol::parity::{DeleteMessage, EditMessage, MessageContent, MessagePermissions};
    let app = App::from_pool(pool.clone()).await.unwrap();
    user(&app, "alice").await;
    user(&app, "bob").await;
    let server = Server::start(pool.clone()).await;
    let alice = server.login("alice").await;
    let bob = server.login("bob").await;
    let mut client = rv_client::NativeClient::new(&server.base).unwrap();
    client.restore(alice.token.clone());
    let room = client
        .create_room(&rv_protocol::CreateRoom {
            name: "Actions".into(),
            private: true,
            operation_id: Some("actions-room".into()),
        })
        .await
        .unwrap();
    client.add_member(&room.id, &bob.user.id).await.unwrap();
    let original = rv_protocol::SendMessage {
        operation_id: "reserved-message".into(),
        text: "Original secret".into(),
    };
    let message = client.send(&room.id, &original).await.unwrap();
    let cursor = client.snapshot().await.unwrap().cursor;
    let view: SnapshotPage = server
        .post(&alice.token, "/api/v1/sync/snapshots", json!({}))
        .await
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    let page_token: String =
        sqlx::query_scalar("SELECT token FROM snapshot_pages WHERE snapshot_id=$1 LIMIT 1")
            .bind(&view.snapshot_id)
            .fetch_one(&pool)
            .await
            .unwrap();
    let edit = EditMessage {
        operation_id: "edit-intent".into(),
        expected_revision: message.revision.clone(),
        content: MessageContent::Plain {
            markdown: "Edited secret".into(),
            mentions: vec![],
            quotes: vec![],
            files: vec![],
        },
    };
    let edited = client.edit_message(&message.id, &edit).await.unwrap();
    assert_eq!(edited.position, message.position);
    assert_ne!(edited.revision, message.revision);
    assert_eq!(edited.text, "Edited secret");
    assert!(edited.edited_at.is_some());
    assert_eq!(
        client.send(&room.id, &original).await.unwrap(),
        edited,
        "the original intent still reconciles after editing"
    );
    assert_eq!(
        server
            .get(
                &alice.token,
                &format!("/api/v1/sync/snapshots/{page_token}")
            )
            .await
            .status(),
        StatusCode::CONFLICT,
        "an immutable pre-edit page is invalidated"
    );
    let second = EditMessage {
        operation_id: "second-edit".into(),
        expected_revision: edited.revision.clone(),
        content: MessageContent::Plain {
            markdown: "Latest secret".into(),
            mentions: vec![],
            quotes: vec![],
            files: vec![],
        },
    };
    let competing = EditMessage {
        operation_id: "competing-edit".into(),
        expected_revision: edited.revision.clone(),
        content: MessageContent::Plain {
            markdown: "Competing secret".into(),
            mentions: vec![],
            quotes: vec![],
            files: vec![],
        },
    };
    let (a, b) = tokio::join!(
        client.edit_message(&message.id, &second),
        client.edit_message(&message.id, &competing)
    );
    let winner = match (a, b) {
        (
            Ok(message),
            Err(rv_client::Error::Server {
                status: 409, code, ..
            }),
        )
        | (
            Err(rv_client::Error::Server {
                status: 409, code, ..
            }),
            Ok(message),
        ) => {
            assert_eq!(code, "revision_conflict");
            message
        }
        _ => panic!("exactly one revision-checked concurrent edit must commit"),
    };
    assert_eq!(
        client.edit_message(&message.id, &edit).await.unwrap(),
        winner,
        "an old receipt returns current authoritative content"
    );
    let conflict = EditMessage {
        operation_id: edit.operation_id.clone(),
        expected_revision: message.revision.clone(),
        content: MessageContent::Plain {
            markdown: "Forged replacement".into(),
            mentions: vec![],
            quotes: vec![],
            files: vec![],
        },
    };
    assert!(
        matches!(client.edit_message(&message.id,&conflict).await,Err(rv_client::Error::Server{status:409,code,..}) if code=="operation_conflict")
    );
    let delete = DeleteMessage {
        operation_id: "delete-intent".into(),
        expected_revision: winner.revision.clone(),
    };
    let tombstone = client.delete_message(&message.id, &delete).await.unwrap();
    assert!(tombstone.deleted && tombstone.text.is_empty());
    assert_eq!(tombstone.position, message.position);
    assert_eq!(
        client.send(&room.id, &original).await.unwrap(),
        tombstone,
        "a deleted send ID remains reserved without resurrection"
    );
    assert_eq!(
        client.edit_message(&message.id, &edit).await.unwrap(),
        tombstone
    );
    let rights: MessagePermissions = server
        .get(
            &alice.token,
            &format!("/api/v1/messages/{}/permissions", message.id),
        )
        .await
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(!rights.edit && !rights.delete && !rights.react && !rights.pin && !rights.star);
    let batch = client.changes(&cursor).await.unwrap();
    assert!(batch.changes.iter().all(|change| match change {
        Change::MessageUpsert(m) => m.deleted && m.text.is_empty(),
        _ => true,
    }));
    let stored: String = sqlx::query_scalar("SELECT text FROM messages WHERE id=$1")
        .bind(&message.id)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert!(stored.is_empty());
    let journal: Vec<Value> = sqlx::query_scalar("SELECT change FROM journal WHERE room_id=$1")
        .bind(&room.id)
        .fetch_all(&pool)
        .await
        .unwrap();
    assert!(
        journal
            .iter()
            .all(|entry| !entry.to_string().contains("secret")),
        "prior message payloads are redacted"
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM snapshot_heads WHERE $1=ANY(room_ids)")
            .bind(&room.id)
            .fetch_one(&pool)
            .await
            .unwrap(),
        0
    );
    let restarted = Server::start(pool.clone()).await;
    let mut resumed = rv_client::NativeClient::new(&restarted.base).unwrap();
    resumed.restore(alice.token.clone());
    assert_eq!(
        resumed.delete_message(&message.id, &delete).await.unwrap(),
        tombstone
    );
    assert_eq!(resumed.message(&message.id).await.unwrap(), tombstone);
    for operation in ["edit-intent", "delete-intent"] {
        assert!(matches!(
            resumed
                .send(
                    &room.id,
                    &rv_protocol::SendMessage {
                        operation_id: operation.into(),
                        text: "Wrong command kind".into()
                    }
                )
                .await,
            Err(rv_client::Error::Server { status: 409, .. })
        ));
        assert!(matches!(
            resumed
                .create_room(&rv_protocol::CreateRoom {
                    name: "Wrong kind".into(),
                    private: true,
                    operation_id: Some(operation.into())
                })
                .await,
            Err(rv_client::Error::Server { status: 409, .. })
        ));
    }
    let collision = server
        .post(
            &bob.token,
            &format!("/api/v1/rooms/{}/messages", room.id),
            json!({"operation_id":message.id,"text":"Must not reuse a deleted ID"}),
        )
        .await;
    assert_eq!(collision.status(), StatusCode::CONFLICT);
}

#[sqlx::test]
async fn message_commands_enforce_membership_author_deadlines_and_read_only(pool: PgPool) {
    use rv_protocol::parity::{DeleteMessage, EditMessage, MessageContent};
    let app = App::from_pool(pool.clone()).await.unwrap();
    user(&app, "owner").await;
    let member = user(&app, "member").await;
    let server = Server::start(pool.clone()).await;
    let owner = server.login("owner").await;
    let login = server.login("member").await;
    let mut owner_client = rv_client::NativeClient::new(&server.base).unwrap();
    owner_client.restore(owner.token.clone());
    let mut member_client = rv_client::NativeClient::new(&server.base).unwrap();
    member_client.restore(login.token.clone());
    let room = owner_client
        .create_room(&rv_protocol::CreateRoom {
            name: "Authority".into(),
            private: true,
            operation_id: None,
        })
        .await
        .unwrap();
    owner_client.add_member(&room.id, &member.id).await.unwrap();
    let message = member_client
        .send(
            &room.id,
            &rv_protocol::SendMessage {
                operation_id: "member-message".into(),
                text: "Author body".into(),
            },
        )
        .await
        .unwrap();
    let edit = EditMessage {
        operation_id: "restricted-edit".into(),
        expected_revision: message.revision.clone(),
        content: MessageContent::Plain {
            markdown: "New body".into(),
            mentions: vec![],
            quotes: vec![],
            files: vec![],
        },
    };
    assert!(
        matches!(
            owner_client.edit_message(&message.id, &edit).await,
            Err(rv_client::Error::Server { status: 403, .. })
        ),
        "ownership does not grant editing another author's words"
    );
    sqlx::query("UPDATE rooms SET read_only=true WHERE id=$1")
        .bind(&room.id)
        .execute(&pool)
        .await
        .unwrap();
    assert!(matches!(
        member_client.edit_message(&message.id, &edit).await,
        Err(rv_client::Error::Server { status: 403, .. })
    ));
    sqlx::query("UPDATE rooms SET read_only=false WHERE id=$1")
        .bind(&room.id)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("UPDATE messages SET created_at=now()-interval '16 minutes' WHERE id=$1")
        .bind(&message.id)
        .execute(&pool)
        .await
        .unwrap();
    assert!(matches!(
        member_client.edit_message(&message.id, &edit).await,
        Err(rv_client::Error::Server { status: 403, .. })
    ));
    let delete = DeleteMessage {
        operation_id: "delete-expired".into(),
        expected_revision: message.revision.clone(),
    };
    assert!(matches!(
        member_client.delete_message(&message.id, &delete).await,
        Err(rv_client::Error::Server { status: 403, .. })
    ));
    let removed = server
        .client
        .delete(format!(
            "{}/api/v1/rooms/{}/members/{}",
            server.base, room.id, member.id
        ))
        .bearer_auth(&owner.token)
        .send()
        .await
        .unwrap();
    assert_eq!(removed.status(), StatusCode::NO_CONTENT);
    assert!(matches!(
        member_client.message(&message.id).await,
        Err(rv_client::Error::Server { status: 404, .. })
    ));
    assert!(matches!(
        member_client.edit_message(&message.id, &edit).await,
        Err(rv_client::Error::Server { status: 404, .. })
    ));
    assert!(matches!(
        member_client.delete_message(&message.id, &delete).await,
        Err(rv_client::Error::Server { status: 404, .. })
    ));
    let forged=server.client.patch(format!("{}/api/v1/messages/{}",server.base,message.id)).bearer_auth(&owner.token).json(&json!({"operation_id":"forged","expected_revision":message.revision,"content":{"kind":"plain","markdown":"Forged","mentions":[],"quotes":[],"files":[]},"edit":true})).send().await.unwrap();
    assert_eq!(forged.status(), StatusCode::BAD_REQUEST);
    assert!(
        owner_client
            .delete_message(&message.id, &delete)
            .await
            .unwrap()
            .deleted
    );
}

#[sqlx::test]
async fn room_creation_replays_after_restart_without_duplicate_events(pool: PgPool) {
    let app = App::from_pool(pool.clone()).await.unwrap();
    user(&app, "alice").await;
    let server = Server::start(pool.clone()).await;
    let alice = server.login("alice").await;
    let input = json!({"operation_id":"create-intent","name":"  Durable room  ","private":true});
    // Ignore the response: the client cannot know the committed room ID.
    assert_eq!(
        server
            .post(&alice.token, "/api/v1/rooms", input.clone())
            .await
            .status(),
        StatusCode::OK
    );
    drop(server);
    let server = Server::start(pool.clone()).await;
    let replies = futures_util::future::join_all(
        (0..4).map(|_| server.post(&alice.token, "/api/v1/rooms", input.clone())),
    )
    .await;
    let mut ids = std::collections::HashSet::new();
    for reply in replies {
        ids.insert(
            reply
                .error_for_status()
                .unwrap()
                .json::<Room>()
                .await
                .unwrap()
                .id,
        );
    }
    assert_eq!(ids.len(), 1);
    let count: (i64, i64) =
        sqlx::query_as("SELECT (SELECT count(*) FROM rooms),(SELECT count(*) FROM journal)")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(count, (1, 1));
    for body in [
        json!({"operation_id":"create-intent","name":"Other","private":true}),
        json!({"operation_id":"create-intent","name":"Durable room","private":false}),
    ] {
        assert_eq!(
            server
                .post(&alice.token, "/api/v1/rooms", body)
                .await
                .status(),
            StatusCode::CONFLICT
        );
    }
    let id = ids.into_iter().next().unwrap();
    assert_eq!(
        server
            .post(
                &alice.token,
                &format!("/api/v1/rooms/{id}/messages"),
                json!({"operation_id":"create-intent","text":"Collision"})
            )
            .await
            .status(),
        StatusCode::CONFLICT
    );
    server
        .post(
            &alice.token,
            &format!("/api/v1/rooms/{id}/messages"),
            json!({"operation_id":"send-intent","text":"Original"}),
        )
        .await
        .error_for_status()
        .unwrap();
    assert_eq!(
        server
            .post(
                &alice.token,
                "/api/v1/rooms",
                json!({"operation_id":"send-intent","name":"Collision","private":true})
            )
            .await
            .status(),
        StatusCode::CONFLICT
    );
}

#[sqlx::test]
async fn public_directory_pages_and_join_preserve_privacy_and_roles(pool: PgPool) {
    let app = App::from_pool(pool.clone()).await.unwrap();
    let alice_user = user(&app, "alice").await;
    user(&app, "bob").await;
    let server = Server::start(pool.clone()).await;
    let alice = server.login("alice").await;
    let bob = server.login("bob").await;
    let private: Room = server
        .post(
            &alice.token,
            "/api/v1/rooms",
            json!({"name":"Secret directory name","private":true}),
        )
        .await
        .json()
        .await
        .unwrap();
    let direct: Room = server
        .post(
            &bob.token,
            "/api/v1/direct-messages",
            json!({"user_id":alice_user.id}),
        )
        .await
        .json()
        .await
        .unwrap();
    let mut public_ids = std::collections::HashSet::new();
    for index in 0..25 {
        let room: Room = server
            .post(
                &alice.token,
                "/api/v1/rooms",
                json!({"name":format!("Directory {index}%"),"private":false}),
            )
            .await
            .json()
            .await
            .unwrap();
        public_ids.insert(room.id);
    }
    let mut after = None;
    let mut discovered = std::collections::HashSet::new();
    loop {
        let path = format!(
            "/api/v1/rooms/public?q={}",
            after
                .as_ref()
                .map(|id| format!("&after={id}"))
                .unwrap_or_default()
        );
        let page: rv_protocol::PublicRoomPage = server
            .get(&bob.token, &path)
            .await
            .error_for_status()
            .unwrap()
            .json()
            .await
            .unwrap();
        assert!(page.rooms.len() <= 20);
        for hit in page.rooms {
            assert!(!hit.joined);
            assert_eq!(hit.room.kind, rv_protocol::RoomKind::Public);
            assert!(discovered.insert(hit.room.id));
        }
        after = page.next;
        if after.is_none() {
            break;
        }
    }
    assert_eq!(discovered, public_ids);
    let absent: rv_protocol::PublicRoomPage = server
        .get(&bob.token, "/api/v1/rooms/public?q=Secret")
        .await
        .json()
        .await
        .unwrap();
    assert!(absent.rooms.is_empty());
    let literal: rv_protocol::PublicRoomPage = server
        .get(&bob.token, "/api/v1/rooms/public?q=%25")
        .await
        .json()
        .await
        .unwrap();
    assert_eq!(literal.rooms.len(), 20);
    for id in [private.id, direct.id, "absent".into()] {
        assert_eq!(
            server
                .post(&bob.token, &format!("/api/v1/rooms/{id}/join"), json!({}))
                .await
                .status(),
            StatusCode::NOT_FOUND
        );
    }
    let id = public_ids.into_iter().min().unwrap();
    assert_eq!(
        server
            .get(&bob.token, &format!("/api/v1/rooms/{id}/messages"))
            .await
            .status(),
        StatusCode::NOT_FOUND
    );
    let snapshot = server.snapshot(&bob.token).await;
    for _ in 0..2 {
        server
            .post(&bob.token, &format!("/api/v1/rooms/{id}/join"), json!({}))
            .await
            .error_for_status()
            .unwrap();
    }
    let replay = server.changes(&bob.token, &snapshot.cursor).await;
    assert_eq!(replay.changes.len(), 1);
    assert!(matches!(&replay.changes[0],Change::RoomUpsert(r) if r.id==id));
    server
        .post(&alice.token, &format!("/api/v1/rooms/{id}/join"), json!({}))
        .await
        .error_for_status()
        .unwrap();
    let owner: String =
        sqlx::query_scalar("SELECT role FROM members WHERE room_id=$1 AND user_id=$2")
            .bind(&id)
            .bind(&alice_user.id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(owner, "owner");
    let page: rv_protocol::PublicRoomPage = server
        .get(&bob.token, "/api/v1/rooms/public?q=Directory")
        .await
        .json()
        .await
        .unwrap();
    assert!(
        page.rooms
            .iter()
            .find(|hit| hit.room.id == id)
            .unwrap()
            .joined
    );
    let underscore: rv_protocol::PublicRoomPage = server
        .get(&bob.token, "/api/v1/rooms/public?q=Directory%202_")
        .await
        .json()
        .await
        .unwrap();
    assert!(
        underscore.rooms.is_empty(),
        "directory wildcards must be literal"
    );
    assert_eq!(
        server.get("invalid", "/api/v1/rooms/public").await.status(),
        StatusCode::UNAUTHORIZED
    );
}

#[sqlx::test]
async fn sends_and_direct_creation_allow_foreign_key_checks(pool: PgPool) {
    let app = App::from_pool(pool.clone()).await.unwrap();
    let alice = user(&app, "alice").await;
    let bob = user(&app, "bob").await;
    let server = Server::start(pool.clone()).await;
    let session = server.login("alice").await;
    let room: Room = server
        .post(
            &session.token,
            "/api/v1/rooms",
            json!({"name":"Lock regression","private":true}),
        )
        .await
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();

    for direct in [false, true] {
        // Hold the journal counter so the HTTP operation keeps its domain locks.
        let mut blocker = pool.begin().await.unwrap();
        sqlx::query("SELECT position FROM instance WHERE singleton FOR UPDATE")
            .execute(&mut *blocker)
            .await
            .unwrap();
        let path = if direct {
            "/api/v1/direct-messages".into()
        } else {
            format!("/api/v1/rooms/{}/messages", room.id)
        };
        let body = if direct {
            json!({"user_id":bob.id})
        } else {
            json!({"operation_id":"lock-regression-send","text":"Concurrent membership"})
        };
        let request = server
            .client
            .post(format!("{}{path}", server.base))
            .bearer_auth(&session.token)
            .json(&body);
        let pending = tokio::spawn(async move { request.send().await.unwrap() });
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let waiting: bool = sqlx::query_scalar(
                    "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'UPDATE instance SET position=position+1%')",
                )
                .fetch_one(&pool)
                .await
                .unwrap();
                if waiting {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("operation should reach the blocked journal counter");

        // Membership/message/journal foreign keys use KEY SHARE on users. A
        // stronger FOR UPDATE lock would deadlock with a concurrent room change.
        let compatible = sqlx::query("SELECT id FROM users WHERE id=ANY($1) FOR KEY SHARE NOWAIT")
            .bind(vec![alice.id.clone(), bob.id.clone()])
            .execute(&pool)
            .await;
        blocker.rollback().await.unwrap();
        let response = pending.await.unwrap();
        assert!(
            compatible.is_ok(),
            "domain locks must allow foreign-key checks"
        );
        assert_eq!(response.status(), StatusCode::OK);
    }
}

#[sqlx::test]
async fn exchange_replay_restart_and_privacy(pool: PgPool) {
    let app = App::from_pool(pool.clone()).await.unwrap();
    user(&app, "alice").await;
    let bob = user(&app, "bob").await;
    user(&app, "mallory").await;
    let server = Server::start(pool.clone()).await;
    let alice_session = server.login("alice").await;
    let bob_session = server.login("bob").await;
    let mallory_session = server.login("mallory").await;
    let bob_initial = server.snapshot(&bob_session.token).await;
    let mallory_initial = server.snapshot(&mallory_session.token).await;
    let room: Room = server
        .post(
            &alice_session.token,
            "/api/v1/rooms",
            json!({"name":"Private test","private":true}),
        )
        .await
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(
        server
            .post(
                &alice_session.token,
                &format!("/api/v1/rooms/{}/members/{}", room.id, bob.id),
                json!({})
            )
            .await
            .status(),
        StatusCode::NO_CONTENT
    );
    let path = format!("/api/v1/rooms/{}/messages", room.id);
    let intention = json!({"operation_id":"00112233445566778899aabb","text":"Hello from Android"});
    let (first, replay) = tokio::join!(
        server.post(&alice_session.token, &path, intention.clone()),
        server.post(&alice_session.token, &path, intention.clone())
    );
    let first: Message = first.error_for_status().unwrap().json().await.unwrap();
    let replay: Message = replay.error_for_status().unwrap().json().await.unwrap();
    assert_eq!(first, replay);
    let mut different = intention.clone();
    different["text"] = json!("Changed intention");
    assert_eq!(
        server
            .post(&alice_session.token, &path, different)
            .await
            .status(),
        StatusCode::CONFLICT
    );
    let page: MessagePage = server
        .get(&bob_session.token, &path)
        .await
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(page.messages, vec![first.clone()]);
    let batch = server
        .changes(&bob_session.token, &bob_initial.cursor)
        .await;
    assert!(
        batch
            .changes
            .iter()
            .any(|c| matches!(c,Change::MessageUpsert(m) if m==&first))
    );
    assert!(
        server
            .changes(&mallory_session.token, &mallory_initial.cursor)
            .await
            .changes
            .is_empty()
    );
    assert_eq!(
        server.get(&mallory_session.token, &path).await.status(),
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        server
            .post(&mallory_session.token, &path, intention.clone())
            .await
            .status(),
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        server
            .get(
                &mallory_session.token,
                &format!("/api/v1/sync/changes?cursor={}", bob_initial.cursor)
            )
            .await
            .status(),
        StatusCode::CONFLICT
    );
    let identity: Discovery = server
        .client
        .get(format!("{}/.well-known/rocketvibe", server.base))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    drop(server);
    let restarted = Server::start(pool).await;
    let after: Message = restarted
        .post(&alice_session.token, &path, intention)
        .await
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(first, after);
    let after_identity: Discovery = restarted
        .client
        .get(format!("{}/.well-known/rocketvibe", restarted.base))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(identity.instance_id, after_identity.instance_id);
    assert_eq!(identity.data_epoch, after_identity.data_epoch);
    assert_eq!(
        restarted.snapshot(&bob_session.token).await.messages,
        vec![first]
    );
}

#[sqlx::test]
async fn sockets_resume_tickets_are_single_use_and_logout_revokes(pool: PgPool) {
    let app = App::from_pool(pool.clone()).await.unwrap();
    user(&app, "alice").await;
    let bob = user(&app, "bob").await;
    let server = Server::start(pool).await;
    let alice = server.login("alice").await;
    let bob_session = server.login("bob").await;
    let room: Room = server
        .post(
            &alice.token,
            "/api/v1/direct-messages",
            json!({"user_id":bob.id}),
        )
        .await
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    let snapshot = server.snapshot(&bob_session.token).await;
    let ticket: SocketTicket = server
        .post(&bob_session.token, "/api/v1/sync/ticket", json!({}))
        .await
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    let url = format!(
        "{}/api/v1/sync/socket?ticket={}&cursor={}",
        server.base.replace("http://", "ws://"),
        ticket.ticket,
        snapshot.cursor
    );
    let (mut socket, _) = tokio_tungstenite::connect_async(&url).await.unwrap();
    assert!(tokio_tungstenite::connect_async(&url).await.is_err());
    let path = format!("/api/v1/rooms/{}/messages", room.id);
    let first: Message = server
        .post(
            &alice.token,
            &path,
            json!({"operation_id":"socket-first","text":"live"}),
        )
        .await
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    let wire = tokio::time::timeout(Duration::from_secs(5), socket.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    let batch: SyncBatch = serde_json::from_str(wire.to_text().unwrap()).unwrap();
    assert!(
        batch
            .changes
            .iter()
            .any(|c| matches!(c,Change::MessageUpsert(m) if m.id==first.id))
    );
    socket.close(None).await.unwrap();
    server
        .post(
            &alice.token,
            &path,
            json!({"operation_id":"socket-offline","text":"while disconnected"}),
        )
        .await
        .error_for_status()
        .unwrap();
    let ticket: SocketTicket = server
        .post(&bob_session.token, "/api/v1/sync/ticket", json!({}))
        .await
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    let (mut resumed, _) = tokio_tungstenite::connect_async(format!(
        "{}/api/v1/sync/socket?ticket={}&cursor={}",
        server.base.replace("http://", "ws://"),
        ticket.ticket,
        batch.cursor
    ))
    .await
    .unwrap();
    let wire = tokio::time::timeout(Duration::from_secs(5), resumed.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    let resumed_batch: SyncBatch = serde_json::from_str(wire.to_text().unwrap()).unwrap();
    assert!(
        resumed_batch
            .changes
            .iter()
            .any(|c| matches!(c,Change::MessageUpsert(m) if m.id=="socket-offline"))
    );
    assert_eq!(
        server
            .post(&bob_session.token, "/api/v1/auth/logout", json!({}))
            .await
            .status(),
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        server.get(&bob_session.token, "/api/v1/me").await.status(),
        StatusCode::UNAUTHORIZED
    );
    let close = tokio::time::timeout(Duration::from_secs(5), resumed.next())
        .await
        .unwrap();
    assert!(close.is_none() || close.unwrap().unwrap().is_close());
}

#[sqlx::test]
async fn removal_filters_replay_and_prevents_writes(pool: PgPool) {
    let app = App::from_pool(pool.clone()).await.unwrap();
    user(&app, "alice").await;
    let bob = user(&app, "bob").await;
    let server = Server::start(pool).await;
    let alice = server.login("alice").await;
    let bob_session = server.login("bob").await;
    let room: Room = server
        .post(
            &alice.token,
            "/api/v1/rooms",
            json!({"name":"secret","private":true}),
        )
        .await
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    let member = format!("/api/v1/rooms/{}/members/{}", room.id, bob.id);
    server
        .post(&alice.token, &member, json!({}))
        .await
        .error_for_status()
        .unwrap();
    let snapshot = server.snapshot(&bob_session.token).await;
    let path = format!("/api/v1/rooms/{}/messages", room.id);
    server
        .post(
            &alice.token,
            &path,
            json!({"operation_id":"before-removal","text":"secret"}),
        )
        .await
        .error_for_status()
        .unwrap();
    server
        .client
        .delete(format!("{}{member}", server.base))
        .bearer_auth(&alice.token)
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap();
    let replay = server.changes(&bob_session.token, &snapshot.cursor).await;
    assert_eq!(
        replay.changes,
        vec![Change::RoomRemoved {
            room_id: room.id.clone()
        }]
    );
    assert_eq!(
        server.get(&bob_session.token, &path).await.status(),
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        server
            .post(
                &bob_session.token,
                &path,
                json!({"operation_id":"after-removal","text":"no"})
            )
            .await
            .status(),
        StatusCode::NOT_FOUND
    );
    assert!(server.snapshot(&bob_session.token).await.rooms.is_empty());
}

#[sqlx::test]
async fn active_socket_never_sends_room_payload_after_its_withdrawal(pool: PgPool) {
    let app = App::from_pool(pool.clone()).await.unwrap();
    user(&app, "alice").await;
    user(&app, "bob").await;
    let server = Server::start(pool).await;
    let alice = server.login("alice").await;
    let bob = server.login("bob").await;
    let mut rooms = Vec::new();
    for name in ["withdrawn", "still-authorized"] {
        let room: Room = server
            .post(
                &alice.token,
                "/api/v1/rooms",
                json!({"name":name,"private":true}),
            )
            .await
            .error_for_status()
            .unwrap()
            .json()
            .await
            .unwrap();
        server
            .post(
                &alice.token,
                &format!("/api/v1/rooms/{}/members/{}", room.id, bob.user.id),
                json!({}),
            )
            .await
            .error_for_status()
            .unwrap();
        rooms.push(room);
    }
    let snapshot = server.snapshot(&bob.token).await;
    let ticket: SocketTicket = server
        .post(&bob.token, "/api/v1/sync/ticket", json!({}))
        .await
        .json()
        .await
        .unwrap();
    let (mut ws, _) = tokio_tungstenite::connect_async(format!(
        "{}/api/v1/sync/socket?ticket={}&cursor={}",
        server.base.replace("http://", "ws://"),
        ticket.ticket,
        snapshot.cursor
    ))
    .await
    .unwrap();
    let public_path = format!("/api/v1/rooms/{}/messages", rooms[1].id);
    server
        .post(
            &alice.token,
            &public_path,
            json!({"operation_id":"socket-ready","text":"ready"}),
        )
        .await
        .error_for_status()
        .unwrap();
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            let frame = ws.next().await.unwrap().unwrap();
            if let Ok(text) = frame.to_text() {
                let batch: SyncBatch = serde_json::from_str(text).unwrap();
                if batch
                    .changes
                    .iter()
                    .any(|c| matches!(c,Change::MessageUpsert(m) if m.id=="socket-ready"))
                {
                    break;
                }
            }
        }
    })
    .await
    .unwrap();
    let private_path = format!("/api/v1/rooms/{}/messages", rooms[0].id);
    let sends = futures_util::future::join_all((0..8).map(|n| {
        server.post(
            &alice.token,
            &private_path,
            json!({"operation_id":format!("racing-{n}"),"text":"private during withdrawal"}),
        )
    }));
    let withdrawal = server
        .client
        .delete(format!(
            "{}/api/v1/rooms/{}/members/{}",
            server.base, rooms[0].id, bob.user.id
        ))
        .bearer_auth(&alice.token)
        .send();
    let (sends, withdrawal) = tokio::join!(sends, withdrawal);
    for response in sends {
        response.error_for_status().unwrap();
    }
    withdrawal.unwrap().error_for_status().unwrap();
    // Keep using the same live socket. Its other room continues to work.
    server
        .post(
            &alice.token,
            &private_path,
            json!({"operation_id":"strictly-after-withdrawal","text":"must remain private"}),
        )
        .await
        .error_for_status()
        .unwrap();
    server
        .post(
            &alice.token,
            &public_path,
            json!({"operation_id":"public-barrier","text":"still connected"}),
        )
        .await
        .error_for_status()
        .unwrap();
    let mut withdrawn = false;
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let frame = ws.next().await.unwrap().unwrap();
            if let Ok(text) = frame.to_text() {
                let batch: SyncBatch = serde_json::from_str(text).unwrap();
                let mut complete = false;
                for change in batch.changes {
                    match change {
                        Change::RoomRemoved { room_id } if room_id == rooms[0].id => {
                            withdrawn = true
                        }
                        Change::MessageUpsert(message) => {
                            assert!(
                                !(withdrawn && message.room_id == rooms[0].id),
                                "no payload may follow its withdrawal on this connection"
                            );
                            assert_ne!(message.id, "strictly-after-withdrawal");
                            complete |= message.id == "public-barrier";
                        }
                        Change::RoomUpsert(room) => assert!(!(withdrawn && room.id == rooms[0].id)),
                        _ => (),
                    }
                }
                if complete {
                    assert!(withdrawn);
                    break;
                }
            }
        }
    })
    .await
    .unwrap();
    ws.close(None).await.unwrap();
}

#[sqlx::test]
async fn concurrent_dm_and_pagination(pool: PgPool) {
    let app = App::from_pool(pool.clone()).await.unwrap();
    let alice = user(&app, "alice").await;
    let bob = user(&app, "bob").await;
    let server = Server::start(pool).await;
    let a = server.login("alice").await;
    let b = server.login("bob").await;
    let (ab, ba) = tokio::join!(
        server.post(
            &a.token,
            "/api/v1/direct-messages",
            json!({"user_id":bob.id})
        ),
        server.post(
            &b.token,
            "/api/v1/direct-messages",
            json!({"user_id":alice.id})
        )
    );
    let ab: Room = ab.error_for_status().unwrap().json().await.unwrap();
    let ba: Room = ba.error_for_status().unwrap().json().await.unwrap();
    assert_eq!(ab, ba);
    let path = format!("/api/v1/rooms/{}/messages", ab.id);
    for n in 0..3 {
        server
            .post(
                &a.token,
                &path,
                json!({"operation_id":format!("message-{n}"),"text":format!("text {n}")}),
            )
            .await
            .error_for_status()
            .unwrap();
    }
    let first: MessagePage = server
        .get(&b.token, &format!("{path}?limit=2"))
        .await
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(first.has_more);
    assert_eq!(first.messages.len(), 2);
    let second: MessagePage = server
        .get(
            &b.token,
            &format!("{path}?limit=2&before={}", first.messages[1].position),
        )
        .await
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(!second.has_more);
    assert_eq!(second.messages[0].text, "text 0");
    assert_ne!(second.messages[0].id, first.messages[1].id);
}

#[sqlx::test]
async fn late_commit_cannot_be_skipped_by_a_cursor(pool: PgPool) {
    let app = App::from_pool(pool.clone()).await.unwrap();
    user(&app, "alice").await;
    let server = Server::start(pool.clone()).await;
    let alice = server.login("alice").await;
    let snapshot = server.snapshot(&alice.token).await;
    let mut stalled = pool.begin().await.unwrap();
    sqlx::query("UPDATE instance SET position=position+1 WHERE singleton")
        .execute(&mut *stalled)
        .await
        .unwrap();
    let request = server
        .client
        .post(format!("{}/api/v1/rooms", server.base))
        .bearer_auth(&alice.token)
        .json(&json!({"name":"after stalled commit","private":true}));
    let pending = tokio::spawn(async move { request.send().await.unwrap() });
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(
        !pending.is_finished(),
        "later publisher must wait for the counter lock"
    );
    let batch = server.changes(&alice.token, &snapshot.cursor).await;
    assert!(batch.changes.is_empty());
    assert!(!batch.has_more);
    stalled.rollback().await.unwrap();
    pending.await.unwrap().error_for_status().unwrap();
    assert_eq!(
        server
            .changes(&alice.token, &batch.cursor)
            .await
            .changes
            .len(),
        1
    );
}

#[sqlx::test]
async fn a_stalled_publisher_releases_its_session_before_logout_times_out(pool: PgPool) {
    let app = App::from_pool(pool.clone()).await.unwrap();
    user(&app, "alice").await;
    let server = Server::start(pool.clone()).await;
    let alice = server.login("alice").await;
    let mut stalled = pool.begin().await.unwrap();
    sqlx::query("UPDATE instance SET position=position+1 WHERE singleton")
        .execute(&mut *stalled)
        .await
        .unwrap();
    let request = server
        .client
        .post(format!("{}/api/v1/rooms", server.base))
        .bearer_auth(&alice.token)
        .json(&json!({"name":"Must roll back","private":true}));
    let publish = tokio::spawn(async move { request.send().await.unwrap() });
    tokio::time::timeout(Duration::from_secs(2),async {
        loop {
            let waiting: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'UPDATE instance SET position%')").fetch_one(&pool).await.unwrap();
            if waiting { break; }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }).await.unwrap();
    let logout = server
        .client
        .post(format!("{}/api/v1/auth/logout", server.base))
        .bearer_auth(&alice.token)
        .send();
    let (publish, logout) = tokio::time::timeout(Duration::from_secs(10), async {
        tokio::join!(publish, logout)
    })
    .await
    .unwrap();
    assert_eq!(publish.unwrap().status(), StatusCode::INTERNAL_SERVER_ERROR);
    assert_eq!(logout.unwrap().status(), StatusCode::NO_CONTENT);
    let rooms: i64 = sqlx::query_scalar("SELECT count(*) FROM rooms")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        rooms, 0,
        "the blocked mutation must roll back before releasing its session"
    );
    stalled.rollback().await.unwrap();
}

#[sqlx::test]
async fn auth_validation_and_generation_reset(pool: PgPool) {
    let app = App::from_pool(pool.clone()).await.unwrap();
    user(&app, "alice").await;
    let server = Server::start(pool.clone()).await;
    let discovery: Discovery = server
        .client
        .get(format!("{}/.well-known/rocketvibe", server.base))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(discovery.product, "rocketvibe");
    assert!(!discovery.capabilities.e2ee);
    assert!(!discovery.capabilities.uploads);
    let unknown = server
        .client
        .post(format!("{}/api/v1/auth/login", server.base))
        .json(&json!({"username":"unknown","password":"wrong"}))
        .send()
        .await
        .unwrap();
    assert_eq!(unknown.status(), StatusCode::UNAUTHORIZED);
    let error: rv_protocol::ApiError = unknown.json().await.unwrap();
    assert_eq!(error.code, "session_rejected");
    let a = server.login("alice").await;
    let snapshot = server.snapshot(&a.token).await;
    let malformed = server
        .post(
            &a.token,
            "/api/v1/rooms",
            json!({"name":"test","private":true,"admin":true}),
        )
        .await;
    assert_eq!(malformed.status(), StatusCode::BAD_REQUEST);
    assert_eq!(
        malformed
            .json::<rv_protocol::ApiError>()
            .await
            .unwrap()
            .code,
        "invalid_request"
    );
    sqlx::query("UPDATE instance SET data_epoch=$1 WHERE singleton")
        .bind(auth::random_token())
        .execute(&pool)
        .await
        .unwrap();
    let reset = server
        .get(
            &a.token,
            &format!("/api/v1/sync/changes?cursor={}", snapshot.cursor),
        )
        .await;
    assert_eq!(reset.status(), StatusCode::CONFLICT);
    assert_eq!(
        reset.json::<rv_protocol::ApiError>().await.unwrap().code,
        "sync_reset_required"
    );
}

#[sqlx::test]
async fn login_budgets_survive_restart_and_ignore_forwarded_ip(pool: PgPool) {
    let app = App::from_pool(pool.clone()).await.unwrap();
    user(&app, "alice").await;
    user(&app, "bob").await;
    let server = Server::start(pool.clone()).await;
    for username in ["alice", "unknown"] {
        for _ in 0..10 {
            let response = server
                .client
                .post(format!("{}/api/v1/auth/login", server.base))
                .json(&json!({"username":username,"password":"wrong"}))
                .send()
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        }
        let response = server
            .client
            .post(format!("{}/api/v1/auth/login", server.base))
            .json(&json!({"username":username,"password":"test-password-2026"}))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::TOO_MANY_REQUESTS);
        let delay: u64 = response.headers()["retry-after"]
            .to_str()
            .unwrap()
            .parse()
            .unwrap();
        assert!((1..=60).contains(&delay));
        assert_eq!(
            response.json::<rv_protocol::ApiError>().await.unwrap().code,
            "auth_rate_limited"
        );
    }
    drop(server);
    let server = Server::start(pool.clone()).await;
    let limited = server
        .client
        .post(format!("{}/api/v1/auth/login", server.base))
        .json(&json!({"username":"alice","password":"test-password-2026"}))
        .send()
        .await
        .unwrap();
    assert_eq!(limited.status(), StatusCode::TOO_MANY_REQUESTS);
    let bob = server.login("bob").await;
    // Prime the actual TCP peer's last IP allowance, not a forwarded header.
    sqlx::query("UPDATE login_windows SET attempts=30 WHERE key=$1")
        .bind(format!("ip:{}", auth::hash_token("127.0.0.1")))
        .execute(&pool)
        .await
        .unwrap();
    let spoofed = server
        .client
        .post(format!("{}/api/v1/auth/login", server.base))
        .header("x-forwarded-for", "203.0.113.123")
        .header("forwarded", "for=203.0.113.123")
        .json(&json!({"username":"another-unknown","password":"wrong"}))
        .send()
        .await
        .unwrap();
    assert_eq!(spoofed.status(), StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(
        server.get(&bob.token, "/api/v1/me").await.status(),
        StatusCode::OK
    );
    // Expired windows release the budget; rejected attempts never extend it.
    sqlx::query(
        "UPDATE login_windows SET expires_at=now()-interval '1 second' WHERE key<> 'global'",
    )
    .execute(&pool)
    .await
    .unwrap();
    let alice = server.login("alice").await;
    assert_eq!(alice.user.username, "alice");
    sqlx::query("UPDATE login_windows SET attempts=120 WHERE key='global'")
        .execute(&pool)
        .await
        .unwrap();
    let global = server
        .client
        .post(format!("{}/api/v1/auth/login", server.base))
        .json(&json!({"username":"new-key","password":"wrong"}))
        .send()
        .await
        .unwrap();
    assert_eq!(global.status(), StatusCode::TOO_MANY_REQUESTS);
    let inserted: bool =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM login_windows WHERE key=$1)")
            .bind(format!("user:{}", auth::hash_token("new-key")))
            .fetch_one(&pool)
            .await
            .unwrap();
    assert!(
        !inserted,
        "rejected requests must not grow the limiter table"
    );
}

#[sqlx::test]
async fn simultaneous_logins_cannot_overrun_a_username_budget(pool: PgPool) {
    let app = App::from_pool(pool.clone()).await.unwrap();
    user(&app, "alice").await;
    let server = Server::start(pool.clone()).await;
    sqlx::query("INSERT INTO login_windows(key,attempts,expires_at) VALUES($1,9,now()+interval '60 seconds')")
        .bind(format!("user:{}",auth::hash_token("alice"))).execute(&pool).await.unwrap();
    let requests = (0..8).map(|_| {
        server
            .client
            .post(format!("{}/api/v1/auth/login", server.base))
            .json(&json!({"username":"alice","password":"test-password-2026"}))
            .send()
    });
    let responses = futures_util::future::join_all(requests).await;
    assert_eq!(
        responses
            .iter()
            .filter(|r| r.as_ref().unwrap().status() == StatusCode::OK)
            .count(),
        1
    );
    for response in responses {
        let response = response.unwrap();
        assert!(matches!(
            response.status(),
            StatusCode::OK | StatusCode::TOO_MANY_REQUESTS
        ));
    }
    let attempts: i32 = sqlx::query_scalar("SELECT attempts FROM login_windows WHERE key=$1")
        .bind(format!("user:{}", auth::hash_token("alice")))
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(attempts, 10);
}

#[sqlx::test]
async fn ticket_and_socket_slots_are_bounded_and_released(pool: PgPool) {
    let app = App::from_pool(pool.clone()).await.unwrap();
    user(&app, "alice").await;
    let server = Server::start(pool.clone()).await;
    let alice = server.login("alice").await;
    let snapshot = server.snapshot(&alice.token).await;
    let replies = futures_util::future::join_all(
        (0..8).map(|_| server.post(&alice.token, "/api/v1/sync/ticket", json!({}))),
    )
    .await;
    let mut tickets = Vec::new();
    for reply in replies {
        if reply.status() == StatusCode::OK {
            tickets.push(reply.json::<SocketTicket>().await.unwrap());
        } else {
            assert_eq!(reply.status(), StatusCode::TOO_MANY_REQUESTS);
            assert_eq!(reply.headers()["retry-after"], "30");
        }
    }
    assert_eq!(tickets.len(), 4);
    let url = |ticket: &str| {
        format!(
            "{}/api/v1/sync/socket?ticket={ticket}&cursor={}",
            server.base.replace("http://", "ws://"),
            snapshot.cursor
        )
    };
    let (first, _) = tokio_tungstenite::connect_async(url(&tickets[0].ticket))
        .await
        .unwrap();
    let replay = tokio_tungstenite::connect_async(url(&tickets[0].ticket))
        .await
        .unwrap_err();
    assert!(
        matches!(replay,tokio_tungstenite::tungstenite::Error::Http(r) if r.status()==StatusCode::UNAUTHORIZED)
    );
    sqlx::query(
        "UPDATE socket_tickets SET expires_at=now()-interval '1 second' WHERE token_hash=$1",
    )
    .bind(auth::hash_token(&tickets[1].ticket))
    .execute(&pool)
    .await
    .unwrap();
    let expired = tokio_tungstenite::connect_async(url(&tickets[1].ticket))
        .await
        .unwrap_err();
    assert!(
        matches!(expired,tokio_tungstenite::tungstenite::Error::Http(r) if r.status()==StatusCode::UNAUTHORIZED)
    );
    let fresh: SocketTicket = server
        .post(&alice.token, "/api/v1/sync/ticket", json!({}))
        .await
        .json()
        .await
        .unwrap();
    let mut sockets = vec![first];
    for ticket in [&tickets[2].ticket, &tickets[3].ticket] {
        sockets.push(
            tokio_tungstenite::connect_async(url(ticket))
                .await
                .unwrap()
                .0,
        );
    }
    let excess: SocketTicket = server
        .post(&alice.token, "/api/v1/sync/ticket", json!({}))
        .await
        .json()
        .await
        .unwrap();
    // Reserve this ticket while a socket slot is still available, then fill it:
    // the upgrade must also enforce the limit when admissions race.
    sockets.push(
        tokio_tungstenite::connect_async(url(&fresh.ticket))
            .await
            .unwrap()
            .0,
    );
    let ticket_refused = server
        .post(&alice.token, "/api/v1/sync/ticket", json!({}))
        .await;
    assert_eq!(ticket_refused.status(), StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(ticket_refused.headers()["retry-after"], "5");
    assert_eq!(
        ticket_refused
            .json::<rv_protocol::ApiError>()
            .await
            .unwrap()
            .code,
        "socket_limit"
    );
    let limited = tokio_tungstenite::connect_async(url(&excess.ticket))
        .await
        .unwrap_err();
    assert!(
        matches!(limited,tokio_tungstenite::tungstenite::Error::Http(r) if r.status()==StatusCode::TOO_MANY_REQUESTS && r.headers()["retry-after"]=="5")
    );
    sockets.pop().unwrap().close(None).await.unwrap();
    let replacement = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let response = server
                .post(&alice.token, "/api/v1/sync/ticket", json!({}))
                .await;
            if response.status() == StatusCode::TOO_MANY_REQUESTS {
                tokio::time::sleep(Duration::from_millis(20)).await;
                continue;
            }
            let ticket: SocketTicket = response.error_for_status().unwrap().json().await.unwrap();
            if let Ok((ws, _)) = tokio_tungstenite::connect_async(url(&ticket.ticket)).await {
                break ws;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("closed socket must release its reservation");
    sockets.push(replacement);
    server
        .post(&alice.token, "/api/v1/auth/logout", json!({}))
        .await
        .error_for_status()
        .unwrap();
    for mut socket in sockets {
        let closed = tokio::time::timeout(Duration::from_secs(5), async {
            while let Some(Ok(message)) = socket.next().await {
                if message.is_close() {
                    return;
                }
            }
        })
        .await;
        assert!(closed.is_ok(), "logout must close active sockets");
    }
}

#[sqlx::test]
async fn expired_cursors_reset_without_resurrecting_and_records_are_pruned(pool: PgPool) {
    let app = App::from_pool(pool.clone()).await.unwrap();
    user(&app, "alice").await;
    let server = Server::start(pool.clone()).await;
    let alice = server.login("alice").await;
    let old = server.snapshot(&alice.token).await;
    sqlx::query("UPDATE sync_cursors SET expires_at=now()-interval '1 second' WHERE token=$1")
        .bind(&old.cursor)
        .execute(&pool)
        .await
        .unwrap();
    let reset = server
        .get(
            &alice.token,
            &format!("/api/v1/sync/changes?cursor={}", old.cursor),
        )
        .await;
    assert_eq!(reset.status(), StatusCode::CONFLICT);
    assert_eq!(
        reset.json::<rv_protocol::ApiError>().await.unwrap().code,
        "sync_reset_required"
    );
    let fresh = server.snapshot(&alice.token).await;
    assert_ne!(
        fresh.cursor, old.cursor,
        "an expired token must stay expired at the same watermark"
    );
    assert_eq!(
        server
            .get(
                &alice.token,
                &format!("/api/v1/sync/changes?cursor={}", old.cursor)
            )
            .await
            .status(),
        StatusCode::CONFLICT
    );
    // Simulate retained cursors from many devices / historical watermarks.
    sqlx::query("INSERT INTO sync_cursors(token,user_id,data_epoch,position,expires_at) SELECT lpad(n::text,64,'0'),$1,data_epoch,n,now()+interval '1 day' FROM instance CROSS JOIN generate_series(1,600) n")
        .bind(&alice.user.id).execute(&pool).await.unwrap();
    let current = server.snapshot(&alice.token).await;
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM sync_cursors WHERE user_id=$1")
        .bind(&alice.user.id)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(count, 512);
    assert_eq!(current.cursor, fresh.cursor);
    let pruned = format!("{:0>64}", 1);
    assert_eq!(
        server
            .get(
                &alice.token,
                &format!("/api/v1/sync/changes?cursor={pruned}")
            )
            .await
            .status(),
        StatusCode::CONFLICT
    );
    let active_ticket: SocketTicket = server
        .post(&alice.token, "/api/v1/sync/ticket", json!({}))
        .await
        .json()
        .await
        .unwrap();
    let expired_session = auth::random_token();
    sqlx::query("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()-interval '1 second')")
        .bind(&expired_session).bind(&alice.user.id).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO socket_tickets(token_hash,session_hash,expires_at) VALUES($1,$2,now()+interval '20 seconds')")
        .bind(auth::random_token()).bind(&expired_session).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO socket_tickets(token_hash,session_hash,expires_at) VALUES($1,$2,now()-interval '1 second')")
        .bind(auth::random_token()).bind(auth::hash_token(&alice.token)).execute(&pool).await.unwrap();
    sqlx::query("UPDATE sync_cursors SET expires_at=now()-interval '1 second' WHERE token<>$1")
        .bind(&current.cursor)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("UPDATE login_windows SET expires_at=now()-interval '1 second'")
        .execute(&pool)
        .await
        .unwrap();
    // Startup cleanup skips work held by another transaction instead of blocking
    // login / cursor creation behind a cycle of row locks.
    let mut held = pool.begin().await.unwrap();
    sqlx::query("SELECT token FROM sync_cursors WHERE token<>$1 LIMIT 1 FOR UPDATE")
        .bind(&current.cursor)
        .fetch_one(&mut *held)
        .await
        .unwrap();
    let restarted = tokio::time::timeout(Duration::from_secs(5), App::from_pool(pool.clone()))
        .await
        .expect("cleanup must skip a locked cursor")
        .unwrap();
    let retained: i64 = sqlx::query_scalar("SELECT count(*) FROM sync_cursors")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(retained, 2, "live and locked cursor must remain");
    held.rollback().await.unwrap();
    restarted.cleanup().await.unwrap();
    for (table, expected) in [
        ("sessions", 1_i64),
        ("socket_tickets", 1),
        ("sync_cursors", 1),
        ("login_windows", 0),
    ] {
        let query = format!("SELECT count(*) FROM {table}");
        let count: i64 = sqlx::query_scalar(&query).fetch_one(&pool).await.unwrap();
        assert_eq!(count, expected, "cleanup of {table}");
    }
    assert!(
        server
            .changes(&alice.token, &current.cursor)
            .await
            .changes
            .is_empty()
    );
    let ticket_exists: bool =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM socket_tickets WHERE token_hash=$1)")
            .bind(auth::hash_token(&active_ticket.ticket))
            .fetch_one(&pool)
            .await
            .unwrap();
    assert!(ticket_exists, "cleanup must keep valid tickets");
}

#[sqlx::test]
async fn large_json_is_bounded_without_skipping_replay_events(pool: PgPool) {
    let app = App::from_pool(pool.clone()).await.unwrap();
    user(&app, "alice").await;
    let server = Server::start(pool.clone()).await;
    let alice = server.login("alice").await;
    let initial = server.snapshot(&alice.token).await;
    // Quotes double their wire size: limits must measure JSON, not raw text.
    let text = "\"".repeat(30_000);
    let mut ids = Vec::new();
    let mut last_room = String::new();
    for n in 0..3 {
        let room: Room = server
            .post(
                &alice.token,
                "/api/v1/rooms",
                json!({"name":format!("Large {n}"),"private":true}),
            )
            .await
            .error_for_status()
            .unwrap()
            .json()
            .await
            .unwrap();
        last_room = room.id.clone();
        for m in 0..50 {
            let id = format!("large-{n}-{m}");
            server
                .post(
                    &alice.token,
                    &format!("/api/v1/rooms/{}/messages", room.id),
                    json!({"operation_id":id,"text":text}),
                )
                .await
                .error_for_status()
                .unwrap();
            ids.push(id);
        }
        if n == 1 {
            let response = server.get(&alice.token, "/api/v1/sync/snapshot").await;
            assert_eq!(response.status(), StatusCode::OK);
            let bytes = response.bytes().await.unwrap();
            assert!(bytes.len() <= 8 * 1024 * 1024);
            assert_eq!(
                serde_json::from_slice::<Snapshot>(&bytes)
                    .unwrap()
                    .messages
                    .len(),
                100
            );
        }
    }
    let cursors_before: i64 = sqlx::query_scalar("SELECT count(*) FROM sync_cursors")
        .fetch_one(&pool)
        .await
        .unwrap();
    let oversized = server.get(&alice.token, "/api/v1/sync/snapshot").await;
    assert_eq!(oversized.status(), StatusCode::CONFLICT);
    assert_eq!(
        oversized
            .json::<rv_protocol::ApiError>()
            .await
            .unwrap()
            .code,
        "snapshot_limit"
    );
    let cursors_after: i64 = sqlx::query_scalar("SELECT count(*) FROM sync_cursors")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        cursors_before, cursors_after,
        "a partial snapshot must not publish a cursor"
    );
    let first_bytes = server
        .post(&alice.token, "/api/v1/sync/snapshots", json!({}))
        .await
        .error_for_status()
        .unwrap()
        .bytes()
        .await
        .unwrap();
    assert!(first_bytes.len() <= 1024 * 1024);
    let first: SnapshotPage = serde_json::from_slice(&first_bytes).unwrap();
    assert!(first.next.is_some());
    assert!(
        first.cursor.is_none(),
        "partial pages cannot publish a replay cursor"
    );
    let frozen_ids = ids.clone();
    let future = "after-materialization";
    server
        .post(
            &alice.token,
            &format!("/api/v1/rooms/{last_room}/messages"),
            json!({"operation_id":future,"text":"arrived between snapshot pages"}),
        )
        .await
        .error_for_status()
        .unwrap();
    ids.push(future.into());
    let mut page = first;
    let mut snapshot_ids = Vec::new();
    let snapshot_id = page.snapshot_id.clone();
    let mut index = 0;
    let frozen_cursor = loop {
        assert_eq!(page.snapshot_id, snapshot_id);
        assert_eq!(page.page_index, index);
        snapshot_ids.extend(page.messages.iter().map(|m| m.id.clone()));
        if let Some(next) = page.next {
            assert!(page.cursor.is_none());
            let bytes = server
                .get(&alice.token, &format!("/api/v1/sync/snapshots/{next}"))
                .await
                .error_for_status()
                .unwrap()
                .bytes()
                .await
                .unwrap();
            assert!(bytes.len() <= 1024 * 1024);
            page = serde_json::from_slice(&bytes).unwrap();
            index += 1;
        } else {
            break page.cursor.unwrap();
        }
    };
    assert!(index > 1);
    snapshot_ids.sort();
    let mut sorted_frozen = frozen_ids;
    sorted_frozen.sort();
    assert_eq!(
        snapshot_ids, sorted_frozen,
        "every page must come from the same immutable view"
    );
    let after_snapshot = server.changes(&alice.token, &frozen_cursor).await;
    assert!(
        matches!(after_snapshot.changes.as_slice(), [Change::MessageUpsert(m)] if m.id==future)
    );
    let mut native = rv_client::NativeClient::new(&server.base).unwrap();
    native.restore(alice.token.clone());
    let assembled = native.snapshot().await.unwrap();
    assert_eq!(assembled.messages.len(), 150);
    assert!(assembled.messages.iter().any(|m| m.id == future));
    let mobile = tokio::time::timeout(
        Duration::from_secs(60),
        tokio::process::Command::new("node")
            .arg("../../scripts/native-snapshot-smoke.ts")
            .env("RV_SMOKE_URL", &server.base)
            .env("RV_SMOKE_PASSWORD", "test-password-2026")
            .kill_on_drop(true)
            .output(),
    )
    .await
    .expect("large mobile snapshot timed out")
    .expect("Node 24 is required");
    assert!(
        mobile.status.success(),
        "mobile snapshot: {} {}",
        String::from_utf8_lossy(&mobile.stdout),
        String::from_utf8_lossy(&mobile.stderr)
    );
    let mut cursor = initial.cursor;
    let mut delivered = Vec::new();
    let mut batches = 0;
    loop {
        let response = server
            .get(
                &alice.token,
                &format!("/api/v1/sync/changes?cursor={cursor}"),
            )
            .await
            .error_for_status()
            .unwrap();
        let bytes = response.bytes().await.unwrap();
        assert!(bytes.len() <= 1024 * 1024);
        let batch: SyncBatch = serde_json::from_slice(&bytes).unwrap();
        for change in batch.changes {
            if let Change::MessageUpsert(message) = change {
                delivered.push(message.id);
            }
        }
        assert_ne!(batch.cursor, cursor);
        cursor = batch.cursor;
        batches += 1;
        if !batch.has_more {
            break;
        }
        assert!(batches < 30, "byte-bounded batches must keep advancing");
    }
    assert!(batches > 2, "large messages must produce smaller batches");
    assert_eq!(
        delivered, ids,
        "replay must preserve every event exactly once in journal order"
    );
    let page: MessagePage = server
        .get(
            &alice.token,
            &format!("/api/v1/rooms/{last_room}/messages?limit=1"),
        )
        .await
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(page.messages[0].id, *ids.last().unwrap());
    assert!(
        server
            .changes(&alice.token, &cursor)
            .await
            .changes
            .is_empty()
    );
}

#[sqlx::test]
async fn materialized_pages_expire_and_cannot_survive_withdrawal_or_restore(pool: PgPool) {
    let app = App::from_pool(pool.clone()).await.unwrap();
    user(&app, "alice").await;
    user(&app, "bob").await;
    let server = Server::start(pool.clone()).await;
    let alice = server.login("alice").await;
    let bob = server.login("bob").await;
    let room: Room = server
        .post(
            &alice.token,
            "/api/v1/rooms",
            json!({"name":"Paged private", "private":true}),
        )
        .await
        .json()
        .await
        .unwrap();
    server
        .post(
            &alice.token,
            &format!("/api/v1/rooms/{}/members/{}", room.id, bob.user.id),
            json!({}),
        )
        .await
        .error_for_status()
        .unwrap();
    for n in 0..24 {
        server
            .post(
                &alice.token,
                &format!("/api/v1/rooms/{}/messages", room.id),
                json!({"operation_id":format!("paged-{n}"),"text":"\"".repeat(30_000)}),
            )
            .await
            .error_for_status()
            .unwrap();
    }
    let first: SnapshotPage = server
        .post(&bob.token, "/api/v1/sync/snapshots", json!({}))
        .await
        .json()
        .await
        .unwrap();
    let next = first.next.unwrap();
    let path = format!("/api/v1/sync/snapshots/{next}");
    assert_eq!(
        server.get(&alice.token, &path).await.status(),
        StatusCode::CONFLICT,
        "a page belongs to one account"
    );
    let again = server.get(&bob.token, &path).await.bytes().await.unwrap();
    assert_eq!(
        again,
        server.get(&bob.token, &path).await.bytes().await.unwrap(),
        "lost page responses can be retried"
    );
    server
        .client
        .delete(format!(
            "{}/api/v1/rooms/{}/members/{}",
            server.base, room.id, bob.user.id
        ))
        .bearer_auth(&alice.token)
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap();
    assert_eq!(
        server.get(&bob.token, &path).await.status(),
        StatusCode::CONFLICT
    );
    server
        .post(
            &alice.token,
            &format!("/api/v1/rooms/{}/members/{}", room.id, bob.user.id),
            json!({}),
        )
        .await
        .error_for_status()
        .unwrap();
    assert_eq!(
        server.get(&bob.token, &path).await.status(),
        StatusCode::CONFLICT,
        "rejoining must not revive a withdrawn snapshot"
    );
    let fresh: SnapshotPage = server
        .post(&bob.token, "/api/v1/sync/snapshots", json!({}))
        .await
        .json()
        .await
        .unwrap();
    let fresh_path = format!("/api/v1/sync/snapshots/{}", fresh.next.unwrap());
    sqlx::query("UPDATE snapshot_heads SET expires_at=now()-interval '1 second'")
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(
        server.get(&bob.token, &fresh_path).await.status(),
        StatusCode::CONFLICT
    );
    app.cleanup().await.unwrap();
    let remaining: i64 = sqlx::query_scalar("SELECT count(*) FROM snapshot_pages")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        remaining, 0,
        "cleanup must cascade to the immutable payload pages"
    );
    let before_restore: SnapshotPage = server
        .post(&bob.token, "/api/v1/sync/snapshots", json!({}))
        .await
        .json()
        .await
        .unwrap();
    sqlx::query("UPDATE instance SET data_epoch=$1")
        .bind(auth::random_token())
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(
        server
            .get(
                &bob.token,
                &format!("/api/v1/sync/snapshots/{}", before_restore.next.unwrap())
            )
            .await
            .status(),
        StatusCode::CONFLICT
    );
}

#[sqlx::test]
async fn concurrent_snapshot_admission_keeps_account_and_global_storage_bounded(pool: PgPool) {
    let app = App::from_pool(pool.clone()).await.unwrap();
    user(&app, "alice").await;
    user(&app, "bob").await;
    let server = Server::start(pool.clone()).await;
    let alice = server.login("alice").await;
    let bob = server.login("bob").await;
    for _ in 0..3 {
        server
            .post(&alice.token, "/api/v1/sync/snapshots", json!({}))
            .await
            .error_for_status()
            .unwrap();
    }
    let results = futures_util::future::join_all(
        (0..8).map(|_| server.post(&alice.token, "/api/v1/sync/snapshots", json!({}))),
    )
    .await;
    assert_eq!(
        results
            .iter()
            .filter(|r| r.status() == StatusCode::OK)
            .count(),
        1
    );
    for result in results.into_iter().filter(|r| r.status() != StatusCode::OK) {
        assert_eq!(result.status(), StatusCode::TOO_MANY_REQUESTS);
        assert_eq!(result.headers()["retry-after"], "30");
        assert_eq!(
            result.json::<rv_protocol::ApiError>().await.unwrap().code,
            "snapshot_busy"
        );
    }
    let own: i64 = sqlx::query_scalar("SELECT count(*) FROM snapshot_heads WHERE user_id=$1")
        .bind(&alice.user.id)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(own, 4);
    sqlx::query("INSERT INTO snapshot_heads(id,user_id,data_epoch) SELECT $1||n,$2,data_epoch FROM instance CROSS JOIN generate_series(1,12) n")
        .bind(auth::random_token()).bind(&alice.user.id).execute(&pool).await.unwrap();
    assert_eq!(
        server
            .post(&bob.token, "/api/v1/sync/snapshots", json!({}))
            .await
            .status(),
        StatusCode::TOO_MANY_REQUESTS
    );
    sqlx::query("UPDATE snapshot_heads SET expires_at=now()-interval '1 second'")
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(
        server
            .post(&bob.token, "/api/v1/sync/snapshots", json!({}))
            .await
            .status(),
        StatusCode::OK
    );
}

#[sqlx::test]
async fn snapshot_room_and_total_byte_limits_refund_failed_reservations(pool: PgPool) {
    let app = App::from_pool(pool.clone()).await.unwrap();
    user(&app, "alice").await;
    let server = Server::start(pool.clone()).await;
    let alice = server.login("alice").await;
    sqlx::query("INSERT INTO rooms(id,name,kind) SELECT 'small-room-'||n,'Small '||n,'private' FROM generate_series(1,110) n")
        .execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO members(room_id,user_id,role) SELECT id,$1,'owner' FROM rooms")
        .bind(&alice.user.id)
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(
        server
            .get(&alice.token, "/api/v1/sync/snapshot")
            .await
            .status(),
        StatusCode::CONFLICT
    );
    let mut native = rv_client::NativeClient::new(&server.base).unwrap();
    native.restore(alice.token.clone());
    assert_eq!(native.snapshot().await.unwrap().rooms.len(), 110);
    sqlx::query("UPDATE snapshot_heads SET expires_at=now()-interval '1 second'")
        .execute(&pool)
        .await
        .unwrap();
    app.cleanup().await.unwrap();
    sqlx::query("INSERT INTO rooms(id,name,kind) SELECT 'quota-room-'||n,'Quota '||n,'private' FROM generate_series(1,22) n")
        .execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO members(room_id,user_id,role) SELECT id,$1,'owner' FROM rooms WHERE id LIKE 'quota-room-%'")
        .bind(&alice.user.id).execute(&pool).await.unwrap();
    // Escaping 32,000 quotes doubles the wire size. 22 x 50 messages exceeds
    // the 64 MiB budget after several pages were inserted in the transaction.
    sqlx::query("INSERT INTO messages(id,room_id,author_id,operation_id,text,position,revision) SELECT 'quota-message-'||n,'quota-room-'||((n-1)/50+1),$1,'quota-send-'||n,$2,n,1 FROM generate_series(1,1100) n")
        .bind(&alice.user.id).bind("\"".repeat(32_000)).execute(&pool).await.unwrap();
    sqlx::query("UPDATE instance SET position=1100 WHERE singleton")
        .execute(&pool)
        .await
        .unwrap();
    let response = server
        .client
        .post(format!("{}/api/v1/sync/snapshots", server.base))
        .bearer_auth(&alice.token)
        .json(&json!({}))
        // This test deliberately materializes over 64 MiB on a shared CI runner.
        // It measures storage rejection/refund, independently of client deadlines.
        .timeout(Duration::from_secs(60))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::CONFLICT);
    assert_eq!(
        response.json::<rv_protocol::ApiError>().await.unwrap().code,
        "snapshot_limit"
    );
    let counts: (i64, i64) = sqlx::query_as(
        "SELECT (SELECT count(*) FROM snapshot_heads),(SELECT count(*) FROM snapshot_pages)",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        counts,
        (0, 0),
        "a failed build refunds its reservation and every partial page"
    );
    sqlx::query("INSERT INTO rooms(id,name,kind) SELECT 'overflow-room-'||n,'Overflow '||n,'private' FROM generate_series(1,950) n")
        .execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO members(room_id,user_id,role) SELECT id,$1,'owner' FROM rooms WHERE id LIKE 'overflow-room-%'")
        .bind(&alice.user.id).execute(&pool).await.unwrap();
    assert_eq!(
        server
            .post(&alice.token, "/api/v1/sync/snapshots", json!({}))
            .await
            .status(),
        StatusCode::CONFLICT
    );
    let remaining: i64 = sqlx::query_scalar("SELECT count(*) FROM snapshot_heads")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(remaining, 0);
}
