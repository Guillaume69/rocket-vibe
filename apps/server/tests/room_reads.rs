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

#[sqlx::test(migrations = "./migrations")]
async fn search_plaintext_is_room_scoped_paginated_and_tracks_edits_and_deletion(pool: PgPool) {
    let b = Bench::start(pool).await;
    let (owner, _, token) = b.user("search-owner", false).await;
    let (reader, uid, reader_token) = b.user("search-reader", false).await;
    let (outsider, _, _) = b.user("search-outsider", true).await;
    let room = b.room(&owner, &token, &uid).await;
    let first = thread_send(&owner, &room, None, "search-first", "Bonjour ALPHA café").await;
    let second = thread_send(&owner, &room, Some(&first.id), "search-reply", "alpha beta").await;
    let page = reader.search_messages(&room, "alpha", None).await.unwrap();
    assert_eq!(
        page.membership_version,
        reader
            .room_read_state(&room)
            .await
            .unwrap()
            .membership_version
            .unwrap()
    );
    assert_eq!(
        page.messages
            .iter()
            .map(|m| m.id.as_str())
            .collect::<Vec<_>>(),
        vec![second.id.as_str(), first.id.as_str()]
    );
    assert_eq!(
        reader
            .search_messages(&room, "café", None)
            .await
            .unwrap()
            .messages
            .len(),
        1
    );
    assert!(
        reader
            .search_messages(&room, "alpha OR absent", None)
            .await
            .unwrap()
            .messages
            .is_empty()
    );
    let response = b
        .request(
            Method::GET,
            &reader_token,
            &format!("/api/v1/rooms/{room}/messages/search?q=alpha&limit=1"),
            json!({}),
        )
        .await;
    let limited: rv_protocol::search::SearchPage = response.json().await.unwrap();
    assert!(limited.has_more);
    assert_eq!(limited.messages[0].id, second.id);
    let next = reader
        .search_messages(&room, "alpha", Some(&second.position))
        .await
        .unwrap();
    assert!(!next.has_more);
    assert_eq!(next.messages[0].id, first.id);
    let denied = outsider
        .search_messages(&room, "alpha", None)
        .await
        .unwrap_err();
    assert!(
        matches!(denied, rv_client::Error::Server { status: 404, .. }),
        "admin has no private-room access"
    );
    let origin = owner
        .create_room(&CreateRoom {
            name: "Search source".into(),
            private: true,
            operation_id: Some("search-source".into()),
            voice: false,
        })
        .await
        .unwrap();
    let secret = thread_send(
        &owner,
        &origin.id,
        None,
        "search-secret",
        "classifiedneedle",
    )
    .await;
    let quoted = owner
        .send(
            &room,
            &SendMessage {
                cards: Vec::new(),
                operation_id: "search-quote".into(),
                text: "reference only".into(),
                quotes: vec![rv_protocol::parity::QuoteReference {
                    room_id: origin.id.clone(),
                    message_id: secret.id.clone(),
                    revision: secret.revision.clone(),
                }],
                reply_to: None,
                files: vec![],
            },
        )
        .await
        .unwrap();
    assert!(
        reader
            .search_messages(&room, "classifiedneedle", None)
            .await
            .unwrap()
            .messages
            .is_empty()
    );
    let quoted = reader
        .search_messages(&room, "reference", None)
        .await
        .unwrap()
        .messages
        .into_iter()
        .find(|m| m.id == quoted.id)
        .unwrap();
    assert!(quoted.quotes.iter().all(|q| q.excerpt.is_none()));
    owner
        .edit_message(
            &first.id,
            &rv_protocol::parity::EditMessage {
                operation_id: "search-edit".into(),
                expected_revision: page
                    .messages
                    .iter()
                    .find(|m| m.id == first.id)
                    .unwrap()
                    .revision
                    .clone(),
                content: rv_protocol::parity::MessageContent::Plain {
                    markdown: "changed gamma".into(),
                    mentions: vec![],
                    quotes: vec![],
                    files: vec![],
                },
            },
        )
        .await
        .unwrap();
    assert_eq!(
        reader
            .search_messages(&room, "alpha", None)
            .await
            .unwrap()
            .messages
            .len(),
        1
    );
    let changed = reader.search_messages(&room, "gamma", None).await.unwrap();
    assert_eq!(changed.messages[0].id, first.id);
    owner
        .delete_message(
            &first.id,
            &DeleteMessage {
                operation_id: "search-delete".into(),
                expected_revision: changed.messages[0].revision.clone(),
            },
        )
        .await
        .unwrap();
    assert!(
        reader
            .search_messages(&room, "gamma", None)
            .await
            .unwrap()
            .messages
            .is_empty()
    );
    assert_eq!(
        b.request(
            Method::DELETE,
            &token,
            &format!("/api/v1/rooms/{room}/members/{uid}"),
            json!({})
        )
        .await
        .status(),
        StatusCode::NO_CONTENT
    );
    assert!(matches!(
        reader
            .search_messages(&room, "alpha", None)
            .await
            .unwrap_err(),
        rv_client::Error::Server { status: 404, .. }
    ));
}

#[sqlx::test(migrations = "./migrations")]
async fn search_is_bounded_has_an_independent_budget_and_never_writes_journal(pool: PgPool) {
    let b = Bench::start(pool).await;
    let (owner, _, token) = b.user("search-budget", false).await;
    let (_, uid, _) = b.user("search-budget-reader", false).await;
    let room = b.room(&owner, &token, &uid).await;
    for query in ["", "!!!"] {
        assert!(matches!(
            owner.search_messages(&room, query, None).await.unwrap_err(),
            rv_client::Error::Server { status: 400, .. }
        ));
    }
    for suffix in [
        "q=alpha&limit=51",
        "q=alpha&before=01",
        "q=alpha&before=-1",
        "q=alpha&before=0",
        "q=alpha&extra=1",
    ] {
        assert_eq!(
            b.request(
                Method::GET,
                &token,
                &format!("/api/v1/rooms/{room}/messages/search?{suffix}"),
                json!({})
            )
            .await
            .status(),
            StatusCode::BAD_REQUEST
        );
    }
    assert!(
        owner
            .search_messages(&room, &"a".repeat(257), None)
            .await
            .is_err()
    );
    assert!(
        owner
            .search_messages(&room, &"a ".repeat(17), None)
            .await
            .is_err()
    );
    let before: i64 = sqlx::query_scalar("SELECT position FROM instance")
        .fetch_one(&b.app.pool)
        .await
        .unwrap();
    for _ in 0..20 {
        assert!(
            owner
                .search_messages(&room, "alpha", None)
                .await
                .unwrap()
                .messages
                .is_empty()
        );
    }
    let denied = b
        .request(
            Method::GET,
            &token,
            &format!("/api/v1/rooms/{room}/messages/search?q=alpha"),
            json!({}),
        )
        .await;
    assert_eq!(denied.status(), StatusCode::TOO_MANY_REQUESTS);
    assert!(denied.headers().contains_key("retry-after"));
    assert_eq!(
        denied.json::<Value>().await.unwrap()["code"],
        "search_rate_limited"
    );
    let after: i64 = sqlx::query_scalar("SELECT position FROM instance")
        .fetch_one(&b.app.pool)
        .await
        .unwrap();
    assert_eq!(before, after);
    thread_send(
        &owner,
        &room,
        None,
        "after-search-limit",
        "alpha still sends",
    )
    .await;
    sqlx::query("UPDATE search_windows SET expires_at=clock_timestamp()-interval '1 second'")
        .execute(&b.app.pool)
        .await
        .unwrap();
    assert_eq!(
        owner
            .search_messages(&room, "alpha", None)
            .await
            .unwrap()
            .messages
            .len(),
        1
    );
}

#[sqlx::test(migrations = "./migrations")]
async fn live_leases_expire_follow_membership_and_freeze_here_recipients(pool: PgPool) {
    use futures_util::StreamExt;
    use rv_protocol::live::{LiveFrame, PresenceStatus, SetTyping};
    let b = Bench::start(pool).await;
    let (owner, _, token) = b.user("live-owner", false).await;
    let (reader, uid, reader_token) = b.user("live-reader", false).await;
    let (outsider, _, _) = b.user("live-outsider", true).await;
    let room = b.room(&owner, &token, &uid).await;
    let grant = reader
        .room_read_state(&room)
        .await
        .unwrap()
        .membership_version
        .unwrap();
    let high: i64 = sqlx::query_scalar("SELECT position FROM instance")
        .fetch_one(&b.app.pool)
        .await
        .unwrap();
    reader.set_presence(PresenceStatus::Online).await.unwrap();
    reader
        .set_typing(
            &room,
            &SetTyping {
                active: true,
                membership_version: grant.clone(),
                root_id: None,
            },
        )
        .await
        .unwrap();
    let LiveFrame::Live(state) = owner.live_state().await.unwrap();
    assert!(
        state
            .presence
            .iter()
            .any(|p| p.user.id == uid && p.status == PresenceStatus::Online)
    );
    assert!(
        state
            .rooms
            .iter()
            .any(|r| r.room_id == room && r.typing.iter().any(|t| t.user.id == uid))
    );
    let LiveFrame::Live(state) = outsider.live_state().await.unwrap();
    assert!(state.presence.is_empty() && state.rooms.is_empty());
    let after: i64 = sqlx::query_scalar("SELECT position FROM instance")
        .fetch_one(&b.app.pool)
        .await
        .unwrap();
    assert_eq!(high, after, "leases never append to the journal");
    let snapshot = owner.snapshot().await.unwrap();
    let (mut socket, _) = tokio_tungstenite::connect_async(
        owner
            .live_socket_url(&snapshot.cursor)
            .await
            .unwrap()
            .as_str(),
    )
    .await
    .unwrap();
    let frame = tokio::time::timeout(std::time::Duration::from_secs(4), socket.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    let LiveFrame::Live(state) = serde_json::from_str(frame.to_text().unwrap()).unwrap();
    assert!(
        state
            .rooms
            .iter()
            .any(|r| r.typing.iter().any(|t| t.user.id == uid))
    );
    let here = thread_send(&owner, &room, None, "here-first", "@here hello").await;
    assert_eq!(
        reader.room_read_state(&room).await.unwrap().group_mentions,
        "1"
    );
    sqlx::query("UPDATE presence_leases SET expires_at=clock_timestamp()-interval '1 second'")
        .execute(&b.app.pool)
        .await
        .unwrap();
    sqlx::query("UPDATE typing_leases SET expires_at=clock_timestamp()-interval '1 second'")
        .execute(&b.app.pool)
        .await
        .unwrap();
    let LiveFrame::Live(state) = owner.live_state().await.unwrap();
    assert!(state.presence.is_empty() && state.rooms.iter().all(|r| r.typing.is_empty()));
    thread_send(&owner, &room, None, "here-expired", "@here offline").await;
    assert_eq!(
        reader.room_read_state(&room).await.unwrap().group_mentions,
        "1"
    );
    reader.set_presence(PresenceStatus::Away).await.unwrap();
    thread_send(&owner, &room, None, "here-away", "@here away").await;
    assert_eq!(
        reader.room_read_state(&room).await.unwrap().group_mentions,
        "1"
    );
    reader.set_presence(PresenceStatus::Busy).await.unwrap();
    thread_send(&owner, &room, None, "here-busy", "@here busy").await;
    assert_eq!(
        reader.room_read_state(&room).await.unwrap().group_mentions,
        "2"
    );
    assert_eq!(
        reader
            .set_typing(
                &room,
                &SetTyping {
                    active: true,
                    membership_version: "old-grant".into(),
                    root_id: None
                }
            )
            .await
            .unwrap_err()
            .to_string(),
        "server refused request (409): membership_changed"
    );
    reader
        .set_typing(
            &room,
            &SetTyping {
                active: true,
                membership_version: grant.clone(),
                root_id: Some(here.id.clone()),
            },
        )
        .await
        .unwrap();
    let LiveFrame::Live(state) = owner.live_state().await.unwrap();
    assert!(state.rooms.iter().any(|r| {
        r.typing
            .iter()
            .any(|t| t.root_id.as_deref() == Some(&here.id))
    }));
    assert_eq!(
        b.request(
            Method::DELETE,
            &token,
            &format!("/api/v1/rooms/{room}/members/{uid}"),
            json!({})
        )
        .await
        .status(),
        StatusCode::NO_CONTENT
    );
    let LiveFrame::Live(state) = owner.live_state().await.unwrap();
    assert!(state.presence.is_empty() && state.rooms.iter().all(|r| r.typing.is_empty()));
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
    let fresh = reader
        .room_read_state(&room)
        .await
        .unwrap()
        .membership_version
        .unwrap();
    assert_ne!(fresh, grant);
    let LiveFrame::Live(state) = owner.live_state().await.unwrap();
    assert!(
        state.rooms.iter().all(|r| r.typing.is_empty()),
        "old composer cannot return after rejoin"
    );
    assert!(
        reader
            .set_typing(
                &room,
                &SetTyping {
                    active: true,
                    membership_version: grant,
                    root_id: None
                }
            )
            .await
            .is_err()
    );
    reader
        .set_typing(
            &room,
            &SetTyping {
                active: true,
                membership_version: fresh,
                root_id: None,
            },
        )
        .await
        .unwrap();
    reader.set_presence(PresenceStatus::Offline).await.unwrap();
    let LiveFrame::Live(state) = owner.live_state().await.unwrap();
    assert!(state.presence.is_empty() && state.rooms.iter().all(|r| r.typing.is_empty()));
    assert_eq!(
        b.request(
            Method::PUT,
            &reader_token,
            "/api/v1/me/presence",
            json!({"status":"invalid"})
        )
        .await
        .status(),
        StatusCode::BAD_REQUEST
    );
    b.task.abort();
}

#[sqlx::test(migrations = "./migrations")]
async fn live_aggregation_rechecks_session_epoch_and_applies_a_separate_budget(pool: PgPool) {
    use rv_protocol::live::{LiveFrame, PresenceStatus};
    let b = Bench::start(pool).await;
    let (owner, _, token) = b.user("device-owner", false).await;
    let (reader, uid, reader_token) = b.user("device-reader", false).await;
    let room = b.room(&owner, &token, &uid).await;
    let mut second = NativeClient::new(&b.base).unwrap();
    second
        .login("device-reader", "read-test-password-2026")
        .await
        .unwrap();
    reader.set_presence(PresenceStatus::Busy).await.unwrap();
    second.set_presence(PresenceStatus::Online).await.unwrap();
    let LiveFrame::Live(state) = owner.live_state().await.unwrap();
    assert_eq!(
        state
            .presence
            .iter()
            .find(|p| p.user.id == uid)
            .unwrap()
            .status,
        PresenceStatus::Busy
    );
    reader.set_presence(PresenceStatus::Offline).await.unwrap();
    let LiveFrame::Live(state) = owner.live_state().await.unwrap();
    assert_eq!(
        state
            .presence
            .iter()
            .find(|p| p.user.id == uid)
            .unwrap()
            .status,
        PresenceStatus::Online
    );
    reader.set_presence(PresenceStatus::Busy).await.unwrap();
    sqlx::query("DELETE FROM sessions WHERE token_hash=$1")
        .bind(auth::hash_token(&reader_token))
        .execute(&b.app.pool)
        .await
        .unwrap();
    let LiveFrame::Live(state) = owner.live_state().await.unwrap();
    assert_eq!(
        state
            .presence
            .iter()
            .find(|p| p.user.id == uid)
            .unwrap()
            .status,
        PresenceStatus::Online,
        "revoked device is ignored immediately"
    );
    sqlx::query("UPDATE presence_leases SET data_epoch='old-epoch'")
        .execute(&b.app.pool)
        .await
        .unwrap();
    let LiveFrame::Live(state) = owner.live_state().await.unwrap();
    assert!(state.presence.is_empty());
    for _ in 0..59 {
        second.set_presence(PresenceStatus::Online).await.unwrap();
    }
    let err = second
        .set_presence(PresenceStatus::Online)
        .await
        .unwrap_err();
    assert!(
        matches!(err,rv_client::Error::Server{status:429,ref code,..} if code=="live_rate_limited")
    );
    // The volatile budget never starves durable sends/reads.
    thread_send(
        &second,
        &room,
        None,
        "budget-independent",
        "still able to chat",
    )
    .await;
    assert_eq!(
        owner
            .history(&room, None)
            .await
            .unwrap()
            .messages
            .iter()
            .filter(|m| m.system.is_none())
            .count(),
        1
    );
    b.task.abort();
}

async fn thread_send(
    client: &NativeClient,
    room: &str,
    root: Option<&str>,
    id: &str,
    text: &str,
) -> rv_protocol::Message {
    client
        .send(
            room,
            &SendMessage {
                cards: Vec::new(),
                operation_id: id.into(),
                text: text.into(),
                quotes: vec![],
                reply_to: root.map(str::to_owned),
                files: vec![],
            },
        )
        .await
        .unwrap()
}

#[sqlx::test(migrations = "./migrations")]
async fn threads_keep_roots_separate_and_reads_only_clear_the_observed_thread(pool: PgPool) {
    let b = Bench::start(pool).await;
    let (owner, _, token) = b.user("alice", false).await;
    let (reader, uid, reader_token) = b.user("bob", false).await;
    let room = b.room(&owner, &token, &uid).await;
    let first = thread_send(&owner, &room, None, "root-one", "First root").await;
    let second = thread_send(&owner, &room, None, "root-two", "Second root").await;
    reader
        .mark_room_read(
            &room,
            &MarkRead {
                root_position: second.position.clone(),
                reply_position: "0".into(),
            },
        )
        .await
        .unwrap();
    let a = thread_send(
        &owner,
        &room,
        Some(&first.id),
        "reply-a",
        "@bob First response",
    )
    .await;
    let c = thread_send(&owner, &room, Some(&first.id), "reply-c", "Second response").await;
    let d = thread_send(&owner, &room, Some(&first.id), "reply-d", "Third response").await;
    let other = thread_send(
        &owner,
        &room,
        Some(&second.id),
        "reply-other",
        "Other thread",
    )
    .await;
    let state = reader.room_read_state(&room).await.unwrap();
    assert_eq!(
        (
            state.unread_roots.as_str(),
            state.unread_replies.as_str(),
            state.mentions.as_str()
        ),
        ("0", "4", "1")
    );
    let roots = reader.history(&room, None).await.unwrap();
    assert!(roots.messages.iter().all(|m| m.reply_to.is_none()));
    assert_eq!(
        roots
            .messages
            .iter()
            .find(|m| m.id == first.id)
            .unwrap()
            .thread
            .as_ref()
            .unwrap()
            .replies,
        "3"
    );
    let path = format!("/api/v1/messages/{}/replies?limit=2", first.id);
    let page: rv_protocol::ThreadPage = b
        .request(Method::GET, &reader_token, &path, json!({}))
        .await
        .json()
        .await
        .unwrap();
    assert_eq!(page.root.id, first.id);
    assert!(page.has_more);
    assert_eq!(
        page.messages
            .iter()
            .map(|m| m.id.as_str())
            .collect::<Vec<_>>(),
        vec![d.id.as_str(), c.id.as_str()]
    );
    let page: rv_protocol::ThreadPage = b
        .request(
            Method::GET,
            &reader_token,
            &format!("{path}&before={}", c.position),
            json!({}),
        )
        .await
        .json()
        .await
        .unwrap();
    assert!(!page.has_more);
    assert_eq!(page.messages[0].id, a.id);
    assert!(
        page.messages
            .iter()
            .all(|m| m.reply_to.as_deref() == Some(first.id.as_str()) && m.room_id == room)
    );
    let read = reader
        .mark_thread_read(
            &first.id,
            &rv_protocol::MarkThreadRead {
                position: d.position.clone(),
            },
        )
        .await
        .unwrap();
    assert_eq!(read.unread, "0");
    let state = reader.room_read_state(&room).await.unwrap();
    assert_eq!(
        (
            state.unread_roots.as_str(),
            state.unread_replies.as_str(),
            state.mentions.as_str()
        ),
        ("0", "1", "0")
    );
    assert_eq!(
        reader
            .thread(&second.id, None)
            .await
            .unwrap()
            .read_state
            .unread,
        "1"
    );
    let again = reader
        .mark_thread_read(
            &first.id,
            &rv_protocol::MarkThreadRead {
                position: a.position,
            },
        )
        .await
        .unwrap();
    assert_eq!(again.position, read.position);
    assert_eq!(again.revision, read.revision);
    let restarted = Bench::start(b.app.pool.clone()).await;
    let read: rv_protocol::ThreadPage = restarted
        .request(
            Method::GET,
            &reader_token,
            &format!("/api/v1/messages/{}/thread", first.id),
            json!({}),
        )
        .await
        .json()
        .await
        .unwrap();
    assert_eq!(read.read_state.unread, "0");
    reader
        .mark_room_read(
            &room,
            &MarkRead {
                root_position: "0".into(),
                reply_position: other.position,
            },
        )
        .await
        .unwrap();
    assert_eq!(
        reader.room_read_state(&room).await.unwrap().unread_replies,
        "0"
    );
}

#[sqlx::test(migrations = "./migrations")]
async fn threads_enforce_same_room_roots_replays_deletions_and_withdrawal(pool: PgPool) {
    let b = Bench::start(pool).await;
    let (owner, _, token) = b.user("alice", false).await;
    let (reader, uid, reader_token) = b.user("bob", false).await;
    let (_, _, outsider_token) = b.user("carol", true).await;
    let room = b.room(&owner, &token, &uid).await;
    let root = thread_send(&owner, &room, None, "thread-root", "Root").await;
    let reply_response = b
        .request(
            Method::POST,
            &token,
            &format!("/api/v1/messages/{}/replies", root.id),
            json!({"operation_id":"thread-reply","text":"Response"}),
        )
        .await;
    assert!(reply_response.status().is_success());
    let reply: rv_protocol::Message = reply_response.json().await.unwrap();
    assert_eq!(reply.reply_to.as_deref(), Some(root.id.as_str()));
    assert_eq!(
        b.request(
            Method::POST,
            &token,
            &format!("/api/v1/messages/{}/replies", root.id),
            json!({"operation_id":"wrong-parent","text":"Response","reply_to":"different-root"})
        )
        .await
        .status(),
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        b.request(
            Method::POST,
            &outsider_token,
            &format!("/api/v1/messages/{}/replies", root.id),
            json!({"operation_id":"private-bypass","text":"Response"})
        )
        .await
        .status(),
        StatusCode::NOT_FOUND
    );
    let replay = thread_send(&owner, &room, Some(&root.id), "thread-reply", "Response").await;
    assert_eq!(reply.id, replay.id);
    assert_eq!(
        reader
            .thread(&root.id, None)
            .await
            .unwrap()
            .root
            .thread
            .as_ref()
            .unwrap()
            .replies,
        "1"
    );
    for (op, parent, status) in [
        (
            "reply-as-root",
            Some(reply.id.clone()),
            StatusCode::UNPROCESSABLE_ENTITY,
        ),
        ("changed-thread-replay", None, StatusCode::CONFLICT),
    ] {
        let op = if op == "changed-thread-replay" {
            "thread-reply"
        } else {
            op
        };
        assert_eq!(
            b.request(
                Method::POST,
                &token,
                &format!("/api/v1/rooms/{room}/messages"),
                json!({"operation_id":op,"text":"Response","reply_to":parent})
            )
            .await
            .status(),
            status
        );
    }
    assert_eq!(
        b.request(
            Method::GET,
            &outsider_token,
            &format!("/api/v1/messages/{}/thread", root.id),
            json!({})
        )
        .await
        .status(),
        StatusCode::NOT_FOUND
    );
    let elsewhere = owner
        .create_room(&CreateRoom {
            name: "Elsewhere".into(),
            private: true,
            operation_id: Some("elsewhere".into()),
            voice: false,
        })
        .await
        .unwrap();
    assert_eq!(
        b.request(
            Method::POST,
            &token,
            &format!("/api/v1/rooms/{}/messages", elsewhere.id),
            json!({"operation_id":"wrong-room","text":"Response","reply_to":root.id})
        )
        .await
        .status(),
        StatusCode::NOT_FOUND
    );
    reader
        .mark_thread_read(
            &root.id,
            &rv_protocol::MarkThreadRead {
                position: reply.position.clone(),
            },
        )
        .await
        .unwrap();
    let retained: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM thread_read_states WHERE room_id=$1 AND user_id=$2",
    )
    .bind(&room)
    .bind(&uid)
    .fetch_one(&b.app.pool)
    .await
    .unwrap();
    assert_eq!(retained, 1);
    owner
        .delete_message(
            &reply.id,
            &DeleteMessage {
                operation_id: "delete-thread-reply".into(),
                expected_revision: reply.revision,
            },
        )
        .await
        .unwrap();
    let page = reader.thread(&root.id, None).await.unwrap();
    assert!(page.root.thread.is_none());
    assert!(page.messages[0].deleted);
    assert_eq!(page.read_state.unread, "0");
    owner
        .delete_message(
            &root.id,
            &DeleteMessage {
                operation_id: "delete-thread-root".into(),
                expected_revision: page.root.revision,
            },
        )
        .await
        .unwrap();
    assert!(reader.thread(&root.id, None).await.unwrap().root.deleted);
    assert_eq!(
        b.request(
            Method::POST,
            &token,
            &format!("/api/v1/rooms/{room}/messages"),
            json!({"operation_id":"deleted-root-reply","text":"Response","reply_to":root.id})
        )
        .await
        .status(),
        StatusCode::GONE
    );
    // A committed original remains a replay even after its root was deleted.
    assert!(
        thread_send(&owner, &room, Some(&root.id), "thread-reply", "Response")
            .await
            .deleted
    );
    b.request(
        Method::DELETE,
        &token,
        &format!("/api/v1/rooms/{room}/members/{uid}"),
        json!({}),
    )
    .await
    .error_for_status()
    .unwrap();
    assert_eq!(
        b.request(
            Method::GET,
            &reader_token,
            &format!("/api/v1/messages/{}/thread", root.id),
            json!({})
        )
        .await
        .status(),
        StatusCode::NOT_FOUND
    );
    let retained: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM thread_read_states WHERE room_id=$1 AND user_id=$2",
    )
    .bind(&room)
    .bind(&uid)
    .fetch_one(&b.app.pool)
    .await
    .unwrap();
    assert_eq!(retained, 0);
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
                voice: false,
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

struct QuoteBench {
    b: Bench,
    owner: NativeClient,
    reader: NativeClient,
    outsider: NativeClient,
    outsider_token: String,
    token: String,
    reader_id: String,
    source: rv_protocol::Message,
    destination: String,
}
impl QuoteBench {
    async fn start(pool: PgPool) -> Self {
        let b = Bench::start(pool).await;
        let (owner, _, token) = b.user("quote-owner", false).await;
        let (reader, reader_id, _) = b.user("quote-reader", false).await;
        let (outsider, outsider_id, outsider_token) = b.user("quote-outsider", true).await;
        let destination = b.room(&owner, &token, &reader_id).await;
        let origin = owner
            .create_room(&CreateRoom {
                name: "Private source".into(),
                private: true,
                operation_id: Some("quote-origin".into()),
                voice: false,
            })
            .await
            .unwrap();
        for (room, member) in [(&destination, &outsider_id), (&origin.id, &reader_id)] {
            assert_eq!(
                b.request(
                    Method::POST,
                    &token,
                    &format!("/api/v1/rooms/{room}/members/{member}"),
                    json!({})
                )
                .await
                .status(),
                StatusCode::NO_CONTENT
            );
        }
        let source = owner
            .send(
                &origin.id,
                &SendMessage {
                    cards: Vec::new(),
                    reply_to: None,
                    operation_id: "quote-source".into(),
                    text: "Privé @quote-outsider 🚀".into(),
                    quotes: vec![],
                    files: vec![],
                },
            )
            .await
            .unwrap();
        Self {
            b,
            owner,
            reader,
            outsider,
            outsider_token,
            token,
            reader_id,
            source,
            destination,
        }
    }
    fn reference(&self) -> rv_protocol::parity::QuoteReference {
        rv_protocol::parity::QuoteReference {
            room_id: self.source.room_id.clone(),
            message_id: self.source.id.clone(),
            revision: self.source.revision.clone(),
        }
    }
    fn input(&self, operation: &str, text: &str) -> SendMessage {
        SendMessage {
            cards: Vec::new(),
            reply_to: None,
            operation_id: operation.into(),
            text: text.into(),
            quotes: vec![self.reference()],
            files: vec![],
        }
    }
}

fn assert_quote_view(message: &rv_protocol::Message, allowed: bool) {
    let quote = &message.quotes[0];
    let view = quote.view_position.parse::<i64>().unwrap();
    assert!(view >= message.revision.parse::<i64>().unwrap());
    assert_eq!(quote.source_membership_version.is_some(), allowed);
    assert_eq!(quote.excerpt.is_some(), allowed);
    if let Some(excerpt) = &quote.excerpt {
        assert_eq!(
            Some(&excerpt.membership_version),
            quote.source_membership_version.as_ref()
        );
        assert!(view >= excerpt.revision.parse::<i64>().unwrap());
    }
}

#[sqlx::test(migrations = "./migrations")]
async fn nested_quotes_resolve_each_grant_bound_depth_and_keep_shared_journal_reference_only(
    pool: PgPool,
) {
    let q = QuoteBench::start(pool).await;
    let initial = q.reader.snapshot().await.unwrap();
    let middle = q
        .reader
        .send(&q.destination, &q.input("nested-middle", "Visible middle"))
        .await
        .unwrap();
    let reference = |message: &rv_protocol::Message| rv_protocol::parity::QuoteReference {
        room_id: message.room_id.clone(),
        message_id: message.id.clone(),
        revision: message.revision.clone(),
    };
    let outer = q
        .reader
        .send(
            &q.destination,
            &SendMessage {
                cards: Vec::new(),
                reply_to: None,
                operation_id: "nested-outer".into(),
                text: "Outer".into(),
                quotes: vec![reference(&middle)],
                files: vec![],
            },
        )
        .await
        .unwrap();
    let parent = outer.quotes[0].excerpt.as_ref().unwrap();
    assert_eq!(parent.text, "Visible middle");
    assert_eq!(parent.references, vec![q.reference()]);
    assert_eq!(
        parent.quotes[0].excerpt.as_ref().unwrap().text,
        q.source.text
    );
    assert_eq!(
        parent.quotes[0].view_position,
        outer.quotes[0].view_position
    );
    let outsider = q.outsider.message(&outer.id).await.unwrap();
    let parent = outsider.quotes[0].excerpt.as_ref().unwrap();
    assert_eq!(parent.text, "Visible middle");
    assert!(
        parent.quotes[0].excerpt.is_none() && parent.quotes[0].source_membership_version.is_none()
    );
    assert!(
        !serde_json::to_string(&outsider)
            .unwrap()
            .contains(&q.source.text)
    );
    for read in [
        q.reader.message(&outer.id).await.unwrap(),
        q.reader
            .history(&q.destination, None)
            .await
            .unwrap()
            .messages
            .into_iter()
            .find(|m| m.id == outer.id)
            .unwrap(),
        q.reader
            .snapshot()
            .await
            .unwrap()
            .messages
            .into_iter()
            .find(|m| m.id == outer.id)
            .unwrap(),
    ] {
        assert_eq!(
            read.quotes[0].excerpt.as_ref().unwrap().quotes[0]
                .excerpt
                .as_ref()
                .unwrap()
                .text,
            q.source.text
        );
    }
    let batch = q.reader.changes(&initial.cursor).await.unwrap();
    let synced = batch
        .changes
        .into_iter()
        .find_map(|c| match c {
            rv_protocol::Change::MessageUpsert(m) if m.id == outer.id => Some(m),
            _ => None,
        })
        .unwrap();
    assert!(
        synced.quotes[0].excerpt.as_ref().unwrap().quotes[0]
            .excerpt
            .is_some()
    );
    let third = q
        .reader
        .send(
            &q.destination,
            &SendMessage {
                cards: Vec::new(),
                reply_to: None,
                operation_id: "nested-third".into(),
                text: "Third".into(),
                quotes: vec![reference(&outer)],
                files: vec![],
            },
        )
        .await
        .unwrap();
    let terminal = third.quotes[0].excerpt.as_ref().unwrap().quotes[0]
        .excerpt
        .as_ref()
        .unwrap();
    assert_eq!(terminal.text, "Visible middle");
    assert!(terminal.quotes.is_empty());
    assert_eq!(terminal.references, vec![q.reference()]);
    let journal: Vec<serde_json::Value> =
        sqlx::query_scalar("SELECT change FROM journal WHERE room_id=$1")
            .bind(&q.destination)
            .fetch_all(&q.b.app.pool)
            .await
            .unwrap();
    assert!(
        !serde_json::to_string(&journal)
            .unwrap()
            .contains(&q.source.text)
    );
    assert_eq!(
        q.b.request(
            Method::DELETE,
            &q.token,
            &format!("/api/v1/rooms/{}/members/{}", q.source.room_id, q.reader_id),
            json!({})
        )
        .await
        .status(),
        StatusCode::NO_CONTENT
    );
    let withdrawn = q.reader.message(&outer.id).await.unwrap();
    let parent = withdrawn.quotes[0].excerpt.as_ref().unwrap();
    assert_eq!(parent.text, "Visible middle");
    assert!(parent.quotes[0].excerpt.is_none());
    assert!(
        !serde_json::to_string(&withdrawn)
            .unwrap()
            .contains(&q.source.text)
    );
}

#[sqlx::test(migrations = "./migrations")]
async fn quotes_resolve_per_reader_in_every_read_without_private_journal_excerpts(pool: PgPool) {
    let q = QuoteBench::start(pool).await;
    let initial_reader = q.reader.snapshot().await.unwrap();
    let initial_outsider = q.outsider.snapshot().await.unwrap();
    let reply = q
        .reader
        .send(&q.destination, &q.input("quoted-reply", "Ma réponse"))
        .await
        .unwrap();
    assert_eq!(
        reply.quotes[0].excerpt.as_ref().unwrap().text,
        q.source.text
    );
    assert_eq!(reply.quotes[0].reference, q.reference());
    assert_quote_view(&reply, true);
    let private = q.outsider.message(&reply.id).await.unwrap();
    assert_quote_view(&private, false);
    assert_eq!(private.text, "Ma réponse");
    assert!(
        private.quotes[0].excerpt.is_none(),
        "instance admin has no private-source bypass"
    );
    for client in [&q.reader, &q.outsider] {
        let allowed = std::ptr::eq(client, &q.reader);
        let history = client.history(&q.destination, None).await.unwrap();
        let snapshot = client.snapshot().await.unwrap();
        for message in [
            history.messages.iter().find(|m| m.id == reply.id).unwrap(),
            snapshot.messages.iter().find(|m| m.id == reply.id).unwrap(),
        ] {
            assert_quote_view(message, allowed);
        }
        let cursor = if allowed {
            &initial_reader.cursor
        } else {
            &initial_outsider.cursor
        };
        let changes = client.changes(cursor).await.unwrap();
        let message = changes
            .changes
            .iter()
            .find_map(|change| match change {
                Change::MessageUpsert(m) if m.id == reply.id => Some(m),
                _ => None,
            })
            .unwrap();
        assert_quote_view(message, allowed);
    }
    q.owner
        .set_mark(
            &reply.id,
            &rv_protocol::parity::SetMark {
                operation_id: "quote-pin".into(),
                present: true,
            },
            false,
        )
        .await
        .unwrap();
    q.reader
        .set_mark(
            &reply.id,
            &rv_protocol::parity::SetMark {
                operation_id: "quote-star".into(),
                present: true,
            },
            true,
        )
        .await
        .unwrap();
    assert!(
        q.outsider
            .marked(&q.destination, false, None)
            .await
            .unwrap()
            .messages[0]
            .quotes[0]
            .excerpt
            .is_none()
    );
    assert!(
        q.reader
            .marked(&q.destination, true, None)
            .await
            .unwrap()
            .messages[0]
            .quotes[0]
            .excerpt
            .is_some()
    );
    let journal: Vec<Value> = sqlx::query_scalar("SELECT change FROM journal WHERE room_id=$1")
        .bind(&q.destination)
        .fetch_all(&q.b.app.pool)
        .await
        .unwrap();
    assert!(
        !serde_json::to_string(&journal)
            .unwrap()
            .contains(&q.source.text)
    );
    for change in journal {
        if change["type"] == "message_upsert" {
            for quote in change["data"]["quotes"].as_array().into_iter().flatten() {
                assert!(quote["excerpt"].is_null());
                assert_eq!(quote["view_position"], "0");
                assert!(quote["source_membership_version"].is_null());
            }
        }
    }
    let room = q
        .outsider
        .rooms()
        .await
        .unwrap()
        .into_iter()
        .find(|r| r.id == q.destination)
        .unwrap();
    let reads = room.read_state.unwrap();
    assert_eq!(
        reads.mentions, "0",
        "quoted source cannot ping a destination member"
    );
    assert_eq!(reads.group_mentions, "0");
}

#[sqlx::test(migrations = "./migrations")]
async fn quotes_follow_current_source_acl_edits_deletion_and_original_send_receipts(pool: PgPool) {
    let q = QuoteBench::start(pool).await;
    let input = q.input("quote-lifecycle", "");
    let reply = q.reader.send(&q.destination, &input).await.unwrap();
    let first_membership = reply.quotes[0]
        .excerpt
        .as_ref()
        .unwrap()
        .membership_version
        .clone();
    let source = edit(&q.owner, &q.source, "quote-source-edit", "Extrait actuel").await;
    let current = q.reader.message(&reply.id).await.unwrap();
    assert_eq!(
        current.revision, reply.revision,
        "source resolution is independent of the reply revision"
    );
    assert!(
        current.quotes[0].view_position.parse::<i64>().unwrap()
            > reply.quotes[0].view_position.parse::<i64>().unwrap()
    );
    assert_quote_view(&current, true);
    assert_eq!(
        current.quotes[0].excerpt.as_ref().unwrap().text,
        "Extrait actuel"
    );
    assert_eq!(
        current.quotes[0].excerpt.as_ref().unwrap().revision,
        source.revision
    );
    let replay = q.reader.send(&q.destination, &input).await.unwrap();
    assert_eq!(replay.id, reply.id);
    let mut divergent = input.clone();
    divergent.quotes[0].revision = source.revision.clone();
    assert_eq!(
        native_error_code(q.reader.send(&q.destination, &divergent).await.unwrap_err()),
        "operation_conflict"
    );
    assert_eq!(
        native_error_code(
            q.reader
                .send(&q.destination, &q.input("quote-stale-source", "autre"))
                .await
                .unwrap_err()
        ),
        "quote_revision_conflict"
    );
    let page =
        q.b.request(Method::POST, &q.token, "/api/v1/sync/snapshots", json!({}))
            .await
            .json::<rv_protocol::SnapshotPage>()
            .await
            .unwrap();
    let page_token: String =
        sqlx::query_scalar("SELECT token FROM snapshot_pages WHERE snapshot_id=$1 LIMIT 1")
            .bind(&page.snapshot_id)
            .fetch_one(&q.b.app.pool)
            .await
            .unwrap();
    let path = format!("/api/v1/rooms/{}/members/{}", source.room_id, q.reader_id);
    assert_eq!(
        q.b.request(Method::DELETE, &q.token, &path, json!({}))
            .await
            .status(),
        StatusCode::NO_CONTENT
    );
    let withdrawn = q.reader.message(&reply.id).await.unwrap();
    assert_quote_view(&withdrawn, false);
    assert!(
        withdrawn.quotes[0].view_position.parse::<i64>().unwrap()
            > current.quotes[0].view_position.parse::<i64>().unwrap()
    );
    // A reply can keep the reference when its author loses source access.
    let retained = q
        .reader
        .edit_message(
            &reply.id,
            &rv_protocol::parity::EditMessage {
                operation_id: "quote-edit-retained".into(),
                expected_revision: reply.revision.clone(),
                content: rv_protocol::parity::MessageContent::Plain {
                    markdown: "Réponse ajustée".into(),
                    mentions: vec![],
                    quotes: input.quotes.clone(),
                    files: vec![],
                },
            },
        )
        .await
        .unwrap();
    assert!(retained.quotes[0].excerpt.is_none());
    assert_eq!(
        q.b.request(
            Method::GET,
            &q.token,
            &format!("/api/v1/sync/snapshots/{page_token}"),
            json!({})
        )
        .await
        .status(),
        StatusCode::CONFLICT
    );
    assert_eq!(
        q.b.request(Method::POST, &q.token, &path, json!({}))
            .await
            .status(),
        StatusCode::NO_CONTENT
    );
    let rejoined = q.reader.message(&reply.id).await.unwrap();
    assert_quote_view(&rejoined, true);
    assert!(
        rejoined.quotes[0].view_position.parse::<i64>().unwrap()
            > withdrawn.quotes[0].view_position.parse::<i64>().unwrap()
    );
    assert_ne!(
        rejoined.quotes[0]
            .excerpt
            .as_ref()
            .unwrap()
            .membership_version,
        first_membership
    );
    q.owner
        .delete_message(
            &source.id,
            &DeleteMessage {
                operation_id: "quote-source-delete".into(),
                expected_revision: source.revision,
            },
        )
        .await
        .unwrap();
    let unavailable = q.reader.message(&reply.id).await.unwrap();
    assert!(unavailable.quotes[0].excerpt.is_none());
    assert_eq!(
        unavailable.quotes[0].source_membership_version,
        rejoined.quotes[0].source_membership_version
    );
    assert!(
        unavailable.quotes[0].view_position.parse::<i64>().unwrap()
            > rejoined.quotes[0].view_position.parse::<i64>().unwrap()
    );
    assert_eq!(
        q.reader.send(&q.destination, &input).await.unwrap().id,
        reply.id
    );
    let history = q.reader.history(&q.destination, None).await.unwrap();
    assert!(history.messages[0].quotes[0].excerpt.is_none());
    // Destination deletion erases its references from every prior upsert too.
    q.reader
        .delete_message(
            &retained.id,
            &DeleteMessage {
                operation_id: "quote-reply-delete".into(),
                expected_revision: retained.revision,
            },
        )
        .await
        .unwrap();
    let tombstone = q.reader.message(&reply.id).await.unwrap();
    assert!(tombstone.quotes.is_empty() && tombstone.text.is_empty());
    let journal: Vec<Change> = sqlx::query_scalar::<_, sqlx::types::Json<Change>>(
        "SELECT change FROM journal WHERE change #>> '{data,id}'=$1",
    )
    .bind(&reply.id)
    .fetch_all(&q.b.app.pool)
    .await
    .unwrap()
    .into_iter()
    .map(|v| v.0)
    .collect();
    for change in journal {
        if let Change::MessageUpsert(message) = change {
            assert!(message.deleted && message.quotes.is_empty());
        }
    }
}

#[sqlx::test(migrations = "./migrations")]
async fn quotes_watermarks_and_unicode_excerpts_preserve_exact_current_read_state(pool: PgPool) {
    let q = QuoteBench::start(pool).await;
    let reply = q
        .reader
        .send(&q.destination, &q.input("quote-watermark", "Réponse"))
        .await
        .unwrap();
    sqlx::query("UPDATE instance SET position=9007199254740993 WHERE singleton")
        .execute(&q.b.app.pool)
        .await
        .unwrap();
    let source = edit(
        &q.owner,
        &q.source,
        "quote-unicode-edit",
        &"🚀".repeat(1025),
    )
    .await;
    let resolved = q.reader.message(&reply.id).await.unwrap();
    assert_quote_view(&resolved, true);
    assert_eq!(resolved.revision, reply.revision);
    assert_eq!(resolved.quotes[0].view_position, source.revision);
    assert!(resolved.quotes[0].view_position.parse::<i64>().unwrap() > 9007199254740993);
    assert_eq!(
        resolved.quotes[0].excerpt.as_ref().unwrap().text,
        "🚀".repeat(1024)
    );
    let hidden = q.outsider.message(&reply.id).await.unwrap();
    assert_quote_view(&hidden, false);
    assert_eq!(
        hidden.quotes[0].view_position,
        resolved.quotes[0].view_position
    );
}

#[sqlx::test(migrations = "./migrations")]
async fn quotes_reject_forged_excerpts_and_missing_source_authorization_atomically(pool: PgPool) {
    let q = QuoteBench::start(pool).await;
    let before: i64 = sqlx::query_scalar("SELECT count(*) FROM messages WHERE room_id=$1")
        .bind(&q.destination)
        .fetch_one(&q.b.app.pool)
        .await
        .unwrap();
    let quote = q.reference();
    let missing =
        q.b.request(
            Method::POST,
            &q.outsider_token,
            &format!("/api/v1/rooms/{}/messages", q.destination),
            json!({"operation_id":"quote-forbidden","text":"Réponse","quotes":[quote]}),
        )
        .await;
    assert_eq!(missing.status(), StatusCode::NOT_FOUND);
    let forged = q.b.request(Method::POST, &q.token, &format!("/api/v1/rooms/{}/messages", q.destination), json!({"operation_id":"quote-forged","text":"Réponse","quotes":[{"room_id":q.source.room_id,"message_id":q.source.id,"revision":q.source.revision,"excerpt":"copie privée"}]})).await;
    assert_eq!(forged.status(), StatusCode::BAD_REQUEST);
    let duplicate = q.input("quote-duplicate", "Réponse");
    let mut duplicate = duplicate;
    duplicate.quotes.push(duplicate.quotes[0].clone());
    assert_eq!(
        native_error_code(q.reader.send(&q.destination, &duplicate).await.unwrap_err()),
        "invalid_request"
    );
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM messages WHERE room_id=$1")
        .bind(&q.destination)
        .fetch_one(&q.b.app.pool)
        .await
        .unwrap();
    assert_eq!(count, before);
}

fn native_error_code(error: rv_client::Error) -> String {
    match error {
        rv_client::Error::Server { code, .. } => code,
        other => panic!("unexpected native error: {other}"),
    }
}

#[sqlx::test(migrations = "./migrations")]
async fn opposing_cross_room_quotes_use_one_domain_lock_order(pool: PgPool) {
    let q = QuoteBench::start(pool).await;
    let other = q
        .reader
        .send(
            &q.destination,
            &SendMessage {
                cards: Vec::new(),
                reply_to: None,
                operation_id: "quote-other-source".into(),
                text: "Autre source".into(),
                quotes: vec![],
                files: vec![],
            },
        )
        .await
        .unwrap();
    let forward = q.input("quote-forward", "Réponse dans la destination");
    let reverse = SendMessage {
        cards: Vec::new(),
        reply_to: None,
        operation_id: "quote-reverse".into(),
        text: "Réponse dans la source".into(),
        quotes: vec![rv_protocol::parity::QuoteReference {
            room_id: q.destination.clone(),
            message_id: other.id,
            revision: other.revision,
        }],
        files: vec![],
    };
    let (a, b) = tokio::time::timeout(std::time::Duration::from_secs(10), async {
        tokio::join!(
            q.owner.send(&q.destination, &forward),
            q.reader.send(&q.source.room_id, &reverse)
        )
    })
    .await
    .expect("cross-room quote lock order stalled");
    assert!(a.unwrap().quotes[0].excerpt.is_some());
    assert!(b.unwrap().quotes[0].excerpt.is_some());
}

#[sqlx::test(migrations = "./migrations")]
async fn native_rendering_crosses_mobile_http_cache_and_preserves_acl_tombstones(pool: PgPool) {
    let b = Bench::start(pool).await;
    let (owner, _, token) = b.user("read-owner", false).await;
    let (reader, uid, _) = b.user("read-member", false).await;
    let (_, _, outsider) = b.user("render-outsider", false).await;
    let room = b.room(&owner, &token, &uid).await;
    let mut command = tokio::process::Command::new("node");
    command
        .arg(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../../scripts/native-rendering-peer.ts"),
        )
        .env("RV_ROOM_PEER_URL", &b.base)
        .env("RV_ROOM_PEER_ROOM", &room)
        .kill_on_drop(true);
    let output = tokio::time::timeout(std::time::Duration::from_secs(30), command.output())
        .await
        .unwrap()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let result: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(
        result,
        json!({"canonicalNativeBody":true,"existingMobileRenderer":true,"revisionAndDeletion":true,"cases":15})
    );
    let id = "native-rich-styles";
    let deleted = owner.message(id).await.unwrap();
    assert!(deleted.body.is_none());
    assert!(deleted.text.is_empty());
    assert!(
        reader
            .history(&room, None)
            .await
            .unwrap()
            .messages
            .iter()
            .all(|m| m.id != id || m.deleted && m.body.is_none() && m.text.is_empty())
    );
    assert!(
        reader
            .snapshot()
            .await
            .unwrap()
            .messages
            .iter()
            .all(|m| m.id != id || m.deleted && m.body.is_none() && m.text.is_empty())
    );
    let journal: Vec<sqlx::types::Json<Change>> =
        sqlx::query_scalar("SELECT change FROM journal WHERE change #>> '{data,id}'=$1")
            .bind(id)
            .fetch_all(&b.app.pool)
            .await
            .unwrap();
    assert!(!journal.is_empty());
    assert!(journal.iter().all(|change|matches!(&change.0,Change::MessageUpsert(message) if message.body.is_none() && message.text.is_empty())));
    assert_eq!(
        b.request(
            Method::GET,
            &outsider,
            "/api/v1/messages/native-rich-unicode",
            json!({})
        )
        .await
        .status(),
        StatusCode::NOT_FOUND
    );
    assert_eq!(b.request(Method::POST,&token,&format!("/api/v1/rooms/{room}/messages"),json!({"operation_id":"forged-render-body","text":"source","body":{"format":"native1","nodes":[]}})).await.status(),StatusCode::BAD_REQUEST);
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
        json!({"unreads":true,"monotone":true,"privateFavorite":true,"lostAckRecovered":true,"noSecondFavorite":true,"oldReplayHarmless":true,"mentions":true,"sqliteCache":true,"missedRejoin":true,"durableRunner":true,"openComposerFenced":true,"providerFavorite":true,"scopedObservedRead":true,"visibleReadController":true})
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
                cards: Vec::new(),
                reply_to: None,
                quotes: vec![],
                operation_id: "first-root".into(),
                text: "First".into(),
                files: vec![],
            },
        )
        .await
        .unwrap();
    let second = a
        .send(
            &room,
            &SendMessage {
                cards: Vec::new(),
                reply_to: None,
                quotes: vec![],
                operation_id: "second-root".into(),
                text: "Second".into(),
                files: vec![],
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
                cards: Vec::new(),
                reply_to: None,
                quotes: vec![],
                operation_id: "own-root".into(),
                text: "Own message".into(),
                files: vec![],
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
                cards: Vec::new(),
                reply_to: None,
                quotes: vec![],
                operation_id: "while-absent".into(),
                text: "Historical".into(),
                files: vec![],
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
async fn edit(
    client: &NativeClient,
    message: &rv_protocol::Message,
    operation: &str,
    text: &str,
) -> rv_protocol::Message {
    client
        .edit_message(
            &message.id,
            &rv_protocol::parity::EditMessage {
                operation_id: operation.into(),
                expected_revision: message.revision.clone(),
                content: rv_protocol::parity::MessageContent::Plain {
                    markdown: text.into(),
                    mentions: vec![],
                    quotes: vec![],
                    files: vec![],
                },
            },
        )
        .await
        .unwrap()
}

#[sqlx::test(migrations = "./migrations")]
async fn mentions_resolve_current_members_once_and_direct_mentions_take_priority(pool: PgPool) {
    let b = Bench::start(pool).await;
    let (owner, owner_id, token) = b.user("alice", false).await;
    let (reader, uid, _) = b.user("bob", false).await;
    let (peer, peer_id, _) = b.user("carol", false).await;
    let (outsider, outsider_id, _) = b.user("eve", false).await;
    let room = b.room(&owner, &token, &uid).await;
    assert_eq!(
        b.request(
            Method::POST,
            &token,
            &format!("/api/v1/rooms/{room}/members/{peer_id}"),
            json!({})
        )
        .await
        .status(),
        StatusCode::NO_CONTENT
    );
    let input = SendMessage {
        cards: Vec::new(),
        reply_to: None,
        quotes: vec![],
        operation_id: "mention-once".into(),
        text: "@bob @bob @all @all @alice @eve `@carol`".into(),
        files: vec![],
    };
    let message = owner.send(&room, &input).await.unwrap();
    assert_eq!(owner.send(&room, &input).await.unwrap().id, message.id);
    let own = owner.room_read_state(&room).await.unwrap();
    let direct = reader.room_read_state(&room).await.unwrap();
    let group = peer.room_read_state(&room).await.unwrap();
    assert_eq!(
        (
            own.unread_roots.as_str(),
            own.mentions.as_str(),
            own.group_mentions.as_str()
        ),
        ("0", "0", "0")
    );
    assert_eq!(
        (
            direct.unread_roots.as_str(),
            direct.mentions.as_str(),
            direct.group_mentions.as_str()
        ),
        ("1", "1", "0")
    );
    assert_eq!(
        (
            group.unread_roots.as_str(),
            group.mentions.as_str(),
            group.group_mentions.as_str()
        ),
        ("1", "0", "1")
    );
    assert_eq!(
        self_code(outsider.room_read_state(&room).await.unwrap_err()),
        "not_found"
    );
    let excluded: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM message_mentions WHERE message_id=$1 AND user_id=ANY($2)",
    )
    .bind(&message.id)
    .bind(vec![owner_id, outsider_id])
    .fetch_one(&b.app.pool)
    .await
    .unwrap();
    assert_eq!(excluded, 0);
    let payload = json!({"operation_id":"forged-mentions","text":"Ordinary text","mentions":[uid]});
    assert_eq!(
        b.request(
            Method::POST,
            &token,
            &format!("/api/v1/rooms/{room}/messages"),
            payload
        )
        .await
        .status(),
        StatusCode::BAD_REQUEST
    );
    let snapshot = peer.snapshot().await.unwrap();
    assert_eq!(
        snapshot
            .rooms
            .iter()
            .find(|r| r.id == room)
            .unwrap()
            .read_state
            .as_ref()
            .unwrap()
            .group_mentions,
        "1"
    );
    let read = reader
        .mark_room_read(&room, &mark(&message.position))
        .await
        .unwrap();
    assert_eq!(
        (
            read.unread_roots.as_str(),
            read.mentions.as_str(),
            read.group_mentions.as_str()
        ),
        ("0", "0", "0")
    );
}

#[sqlx::test(migrations = "./migrations")]
async fn edits_can_withdraw_mentions_but_cannot_ping_a_new_or_previous_recipient(pool: PgPool) {
    let b = Bench::start(pool).await;
    let (owner, _, token) = b.user("alice", false).await;
    let (reader, uid, _) = b.user("bob", false).await;
    let (peer, peer_id, _) = b.user("carol", false).await;
    let room = b.room(&owner, &token, &uid).await;
    assert_eq!(
        b.request(
            Method::POST,
            &token,
            &format!("/api/v1/rooms/{room}/members/{peer_id}"),
            json!({})
        )
        .await
        .status(),
        StatusCode::NO_CONTENT
    );
    let sent = owner
        .send(
            &room,
            &SendMessage {
                cards: Vec::new(),
                reply_to: None,
                quotes: vec![],
                operation_id: "mention-edit-source".into(),
                text: "Hello @bob".into(),
                files: vec![],
            },
        )
        .await
        .unwrap();
    assert_eq!(reader.room_read_state(&room).await.unwrap().mentions, "1");
    let changed = edit(&owner, &sent, "mention-edit-one", "Hello @carol").await;
    let state = reader.room_read_state(&room).await.unwrap();
    assert_eq!(
        (state.unread_roots.as_str(), state.mentions.as_str()),
        ("1", "0")
    );
    assert_eq!(peer.room_read_state(&room).await.unwrap().mentions, "0");
    let changed = edit(&owner, &changed, "mention-edit-two", "Again @bob @all").await;
    assert_eq!(reader.room_read_state(&room).await.unwrap().mentions, "0");
    assert_eq!(
        peer.room_read_state(&room).await.unwrap().group_mentions,
        "0"
    );
    owner
        .delete_message(
            &changed.id,
            &DeleteMessage {
                operation_id: "mention-edit-delete".into(),
                expected_revision: changed.revision,
            },
        )
        .await
        .unwrap();
    assert_eq!(
        reader.room_read_state(&room).await.unwrap().unread_roots,
        "0"
    );
    let count: i64 =
        sqlx::query_scalar("SELECT count(*) FROM message_mentions WHERE message_id=$1")
            .bind(&sent.id)
            .fetch_one(&b.app.pool)
            .await
            .unwrap();
    assert_eq!(count, 0);
}

#[sqlx::test(migrations = "./migrations")]
async fn joining_after_a_group_mention_and_rejoining_do_not_receive_historical_pings(pool: PgPool) {
    let b = Bench::start(pool).await;
    let (owner, _, token) = b.user("alice", false).await;
    let (reader, uid, _) = b.user("bob", false).await;
    let (peer, peer_id, _) = b.user("carol", false).await;
    let room = b.room(&owner, &token, &uid).await;
    owner
        .send(
            &room,
            &SendMessage {
                cards: Vec::new(),
                reply_to: None,
                quotes: vec![],
                operation_id: "mention-before-join".into(),
                text: "@all @carol".into(),
                files: vec![],
            },
        )
        .await
        .unwrap();
    assert_eq!(
        reader.room_read_state(&room).await.unwrap().group_mentions,
        "1"
    );
    assert_eq!(
        b.request(
            Method::POST,
            &token,
            &format!("/api/v1/rooms/{room}/members/{peer_id}"),
            json!({})
        )
        .await
        .status(),
        StatusCode::NO_CONTENT
    );
    let joined = peer.room_read_state(&room).await.unwrap();
    assert_eq!(
        (
            joined.unread_roots.as_str(),
            joined.mentions.as_str(),
            joined.group_mentions.as_str()
        ),
        ("0", "0", "0")
    );
    let details = reader.room_details(&room).await.unwrap();
    reader
        .leave_room(
            &room,
            &LeaveRoom {
                operation_id: "mention-leave".into(),
                expected_revision: details.revision,
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
    assert_eq!(
        reader.room_read_state(&room).await.unwrap().group_mentions,
        "0"
    );
    owner
        .send(
            &room,
            &SendMessage {
                cards: Vec::new(),
                reply_to: None,
                quotes: vec![],
                operation_id: "mention-after-join".into(),
                text: "@bob @all @here".into(),
                files: vec![],
            },
        )
        .await
        .unwrap();
    let fresh = reader.room_read_state(&room).await.unwrap();
    assert_eq!(
        (
            fresh.unread_roots.as_str(),
            fresh.mentions.as_str(),
            fresh.group_mentions.as_str()
        ),
        ("1", "1", "0")
    );
    assert_eq!(
        peer.room_read_state(&room).await.unwrap().group_mentions,
        "1"
    );
}

#[sqlx::test(migrations = "./migrations")]
async fn read_quota_keeps_retries_state_reads_and_favorite_commands_available(pool: PgPool) {
    let b = Bench::start(pool).await;
    let (owner, _, token) = b.user("alice", false).await;
    let (reader, uid, reader_token) = b.user("bob", false).await;
    let room = b.room(&owner, &token, &uid).await;
    let mut positions = Vec::new();
    for n in 0..61 {
        positions.push(
            owner
                .send(
                    &room,
                    &SendMessage {
                        cards: Vec::new(),
                        reply_to: None,
                        quotes: vec![],
                        operation_id: format!("quota-root-{n}"),
                        text: "Quota message".into(),
                        files: vec![],
                    },
                )
                .await
                .unwrap()
                .position,
        );
    }
    for p in &positions[..60] {
        reader.mark_room_read(&room, &mark(p)).await.unwrap();
    }
    assert_eq!(
        self_code(
            reader
                .mark_room_read(&room, &mark(&positions[60]))
                .await
                .unwrap_err()
        ),
        "room_read_limit"
    );
    // The SDK respects Retry-After for POST; the server accepts an old marker
    // without charging another advancement.
    let repeated: rv_protocol::parity::ReadState = b
        .request(
            Method::POST,
            &reader_token,
            &format!("/api/v1/rooms/{room}/read"),
            serde_json::to_value(mark(&positions[0])).unwrap(),
        )
        .await
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(repeated.root_position, positions[59]);
    let state = reader.room_read_state(&room).await.unwrap();
    assert_eq!(state.unread_roots, "1");
    let input = favorite(
        state.favorite_revision.as_deref().unwrap(),
        "favorite-during-read-limit",
        true,
    );
    let receipt = reader.set_room_favorite(&room, &input).await.unwrap();
    assert_eq!(
        reader
            .room_command_receipt(&room, &input.operation_id)
            .await
            .unwrap(),
        receipt
    );
    sqlx::query("UPDATE room_read_windows SET expires_at=clock_timestamp()-interval '1 second' WHERE user_id=$1")
        .bind(&uid).execute(&b.app.pool).await.unwrap();
    let after: rv_protocol::parity::ReadState = b
        .request(
            Method::POST,
            &reader_token,
            &format!("/api/v1/rooms/{room}/read"),
            serde_json::to_value(mark(&positions[60])).unwrap(),
        )
        .await
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(after.unread_roots, "0");
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
                cards: Vec::new(),
                reply_to: None,
                quotes: vec![],
                operation_id: "read-version-root".into(),
                text: "A message during the favorite form".into(),
                files: vec![],
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
        json!({"root_position":"9223372036854775807","reply_position":"0"}),
        json!({"root_position":"0","reply_position":"9223372036854775807"}),
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
                    cards: Vec::new(),
                    reply_to: None,
                    quotes: vec![],
                    operation_id: input.operation_id,
                    text: "Collision".into(),
                    files: vec![],
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
