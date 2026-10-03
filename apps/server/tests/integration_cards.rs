use rv_client::{Error, NativeClient};
use rv_protocol::{
    CreateRoom, SendMessage,
    parity::{DeleteMessage, EditMessage, MessageContent},
};
use rv_server::{App, auth};
use sqlx::PgPool;

#[sqlx::test]
async fn cards_use_normal_permissions_receipts_sync_search_edit_and_erasure(pool: PgPool) {
    let app = App::from_pool(pool.clone()).await.unwrap();
    auth::create_user(
        &app,
        "cards-owner",
        "disposable-cards-password".into(),
        false,
    )
    .await
    .unwrap();
    auth::create_user(
        &app,
        "cards-outsider",
        "disposable-cards-password".into(),
        false,
    )
    .await
    .unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let router = app.router();
    let task = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    let mut client = NativeClient::new(&base).unwrap();
    client
        .login("cards-owner", "disposable-cards-password")
        .await
        .unwrap();
    let mut outsider = NativeClient::new(&base).unwrap();
    outsider
        .login("cards-outsider", "disposable-cards-password")
        .await
        .unwrap();
    assert!(
        client
            .discover()
            .await
            .unwrap()
            .capabilities
            .structured_cards
    );
    let room = client
        .create_room(&CreateRoom {
            name: "Integration cards".into(),
            private: true,
            operation_id: Some(auth::random_token()),
        })
        .await
        .unwrap();
    let card=serde_json::from_value(serde_json::json!({"author":"CI","title":"Release ready","url":"https://example.org/build","text":"Build completed","color":"#1177aa","fields":[{"title":"Artifact","value":"abcdef","short":true}]})).unwrap();
    let input = SendMessage {
        operation_id: auth::random_token(),
        text: String::new(),
        reply_to: None,
        quotes: vec![],
        cards: vec![card],
    };
    let sent = client.send(&room.id, &input).await.unwrap();
    assert_eq!(sent.cards, input.cards);
    let output = tokio::process::Command::new("node")
        .arg(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../../scripts/native-integration-cards-smoke.ts"),
        )
        .env("RV_CARDS_TEST_SERVER", &base)
        .env("RV_CARDS_TEST_ROOM", &room.id)
        .env("RV_CARDS_TEST_MESSAGE", &sent.id)
        .output()
        .await
        .unwrap();
    assert!(
        output.status.success(),
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(client.send(&room.id, &input).await.unwrap(), sent);
    let mut changed = input.clone();
    changed.cards[0].title = Some("Other".into());
    assert!(matches!(
        client.send(&room.id, &changed).await,
        Err(Error::Server { status: 409, .. })
    ));
    assert!(matches!(
        outsider.send(&room.id, &input).await,
        Err(Error::Server { status: 404, .. })
    ));
    assert_eq!(
        client.history(&room.id, None).await.unwrap().messages[0].cards,
        input.cards
    );
    assert_eq!(
        client
            .snapshot()
            .await
            .unwrap()
            .messages
            .iter()
            .find(|m| m.id == sent.id)
            .unwrap()
            .cards,
        input.cards
    );
    assert_eq!(
        client
            .search_messages(&room.id, "abcdef", None)
            .await
            .unwrap()
            .messages[0]
            .cards,
        input.cards
    );
    let edited = client
        .edit_message(
            &sent.id,
            &EditMessage {
                operation_id: auth::random_token(),
                expected_revision: sent.revision,
                content: MessageContent::Plain {
                    markdown: "New text".into(),
                    mentions: vec![],
                    quotes: vec![],
                    files: vec![],
                },
            },
        )
        .await
        .unwrap();
    assert_eq!(edited.cards, input.cards);
    assert_eq!(client.send(&room.id, &input).await.unwrap(), edited);
    let deleted = client
        .delete_message(
            &sent.id,
            &DeleteMessage {
                operation_id: auth::random_token(),
                expected_revision: edited.revision,
            },
        )
        .await
        .unwrap();
    assert!(deleted.deleted && deleted.cards.is_empty());
    assert!(
        client
            .search_messages(&room.id, "abcdef", None)
            .await
            .unwrap()
            .messages
            .is_empty()
    );
    let raw: serde_json::Value = sqlx::query_scalar("SELECT cards FROM messages WHERE id=$1")
        .bind(&sent.id)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(raw, serde_json::json!([]));
    let retained:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM journal WHERE change #>> '{data,id}'=$1 AND change #> '{data,cards}' IS NOT NULL)").bind(&sent.id).fetch_one(&pool).await.unwrap();
    assert!(!retained);
    task.abort();
}
