use axum::{
    body::Body,
    http::{Request, StatusCode},
};
use rv_client::NativeClient;
use rv_protocol::{CreateRoom, SendMessage, parity::SetReaction};
use rv_server::{App, auth, custom_emojis, objects::LocalObjects};
use sqlx::PgPool;
use std::{io::Cursor, path::PathBuf};
use tower::ServiceExt;
struct Bench {
    app: App,
    root: PathBuf,
    base: String,
    task: tokio::task::JoinHandle<()>,
}
impl Drop for Bench {
    fn drop(&mut self) {
        self.task.abort();
        let _ = std::fs::remove_dir_all(&self.root);
    }
}
impl Bench {
    async fn new(pool: PgPool) -> Self {
        let root = std::env::temp_dir().join(format!("rv-emoji-{}", auth::random_token()));
        let app = App::from_pool(pool)
            .await
            .unwrap()
            .with_objects(LocalObjects::open(&root).unwrap());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let router = app.clone().router();
        let task = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        Self {
            app,
            root,
            base,
            task,
        }
    }
    async fn user(&self) -> NativeClient {
        auth::create_user(
            &self.app,
            "emoji-user",
            "disposable-emoji-password".into(),
            false,
        )
        .await
        .unwrap();
        let mut client = NativeClient::new(&self.base).unwrap();
        client
            .login("emoji-user", "disposable-emoji-password")
            .await
            .unwrap();
        client
    }
}
fn png() -> Vec<u8> {
    let mut out = Cursor::new(Vec::new());
    image::DynamicImage::new_rgba8(2, 2)
        .write_to(&mut out, image::ImageFormat::Png)
        .unwrap();
    out.into_inner()
}
fn gif() -> Vec<u8> {
    let mut out = Vec::new();
    {
        let mut encoder = image::codecs::gif::GifEncoder::new(&mut out);
        encoder
            .set_repeat(image::codecs::gif::Repeat::Infinite)
            .unwrap();
        for _ in 0..2 {
            encoder
                .encode_frame(image::Frame::from_parts(
                    image::RgbaImage::new(2, 2),
                    0,
                    0,
                    image::Delay::from_numer_denom_ms(100, 1),
                ))
                .unwrap();
        }
    }
    out
}
#[sqlx::test]
async fn catalogue_receipts_aliases_and_protected_images_survive_retirement(pool: PgPool) {
    let bench = Bench::new(pool).await;
    let client = bench.user().await;
    assert!(client.discover().await.unwrap().capabilities.custom_emojis);
    let operation = auth::random_token();
    let image = gif();
    let (a, b) = tokio::join!(
        custom_emojis::put(
            &bench.app,
            &operation,
            "party_parrot",
            vec!["vibe_parrot".into()],
            None,
            image.clone()
        ),
        custom_emojis::put(
            &bench.app,
            &operation,
            "party_parrot",
            vec!["vibe_parrot".into()],
            None,
            image.clone()
        )
    );
    let receipt = a.unwrap();
    assert_eq!(receipt, b.unwrap());
    let catalog = client.emoji_catalog().await.unwrap();
    assert_eq!(catalog.items.len(), 1);
    let first = catalog.items[0].clone();
    assert_eq!(first.media_type, "image/gif");
    assert_eq!(client.emoji_bytes(&first).await.unwrap(), image);
    let live = client.live_state().await.unwrap();
    let rv_protocol::live::LiveFrame::Live(live) = live;
    assert_eq!(
        live.emoji_catalog_revision.as_deref(),
        Some(catalog.revision.as_str())
    );
    let anonymous = bench
        .app
        .clone()
        .router()
        .oneshot(
            Request::builder()
                .uri(format!("/api/v1/emoji/files/{}", first.file_id))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(anonymous.status(), StatusCode::UNAUTHORIZED);
    let room = client
        .create_room(&CreateRoom {
            operation_id: Some(auth::random_token()),
            name: "custom reactions".into(),
            private: true,
            voice: false,
        })
        .await
        .unwrap();
    let message = client
        .send(
            &room.id,
            &SendMessage {
                cards: Vec::new(),
                operation_id: auth::random_token(),
                text: ":vibe_parrot:".into(),
                quotes: vec![],
                reply_to: None,
                files: vec![],
            },
        )
        .await
        .unwrap();
    let react = SetReaction {
        operation_id: auth::random_token(),
        emoji: "vibe_parrot".into(),
        present: true,
    };
    client.set_reaction(&message.id, &react).await.unwrap();
    assert_eq!(
        client
            .history(&room.id, None)
            .await
            .unwrap()
            .messages
            .iter()
            .find(|m| m.id == message.id)
            .unwrap()
            .reactions[0]
            .emoji,
        "party_parrot"
    );
    let changed = custom_emojis::put(
        &bench.app,
        &auth::random_token(),
        "party_parrot",
        vec!["vibe_bird".into()],
        Some(&first.revision),
        png(),
    )
    .await
    .unwrap();
    assert!(client.emoji_bytes(&first).await.is_err());
    client.set_reaction(&message.id, &react).await.unwrap();
    let delete = auth::random_token();
    let removed = custom_emojis::remove(
        &bench.app,
        &delete,
        "party_parrot",
        &changed.applied_revision,
    )
    .await
    .unwrap();
    assert_eq!(
        removed,
        custom_emojis::remove(
            &bench.app,
            &delete,
            "party_parrot",
            &changed.applied_revision
        )
        .await
        .unwrap()
    );
    assert!(client.emoji_catalog().await.unwrap().items.is_empty());
    assert_eq!(
        receipt,
        custom_emojis::put(
            &bench.app,
            &operation,
            "party_parrot",
            vec!["vibe_parrot".into()],
            None,
            image
        )
        .await
        .unwrap()
    );
    assert!(
        client.emoji_catalog().await.unwrap().items.is_empty(),
        "replaying a receipt cannot recreate a retired emoji"
    );
    client.set_reaction(&message.id, &react).await.unwrap();
    client
        .set_reaction(
            &message.id,
            &SetReaction {
                operation_id: auth::random_token(),
                emoji: "party_parrot".into(),
                present: false,
            },
        )
        .await
        .unwrap();
    assert!(
        client
            .history(&room.id, None)
            .await
            .unwrap()
            .messages
            .iter()
            .find(|m| m.id == message.id)
            .unwrap()
            .reactions
            .is_empty()
    );
}
#[sqlx::test]
async fn catalog_rejects_ambiguous_names_stale_updates_and_hostile_images_atomically(pool: PgPool) {
    let bench = Bench::new(pool).await;
    for name in ["smile", "thumbsup", "../file", "BadCase"] {
        assert!(
            custom_emojis::put(&bench.app, &auth::random_token(), name, vec![], None, png())
                .await
                .is_err()
        );
    }
    for image in [
        b"<svg/>".to_vec(),
        b"GIF89a".to_vec(),
        vec![0; 1024 * 1024 + 1],
    ] {
        assert!(
            custom_emojis::put(
                &bench.app,
                &auth::random_token(),
                "bad",
                vec![],
                None,
                image
            )
            .await
            .is_err()
        );
    }
    assert!(
        custom_emojis::catalog(&bench.app)
            .await
            .unwrap()
            .items
            .is_empty()
    );
    let first = custom_emojis::put(
        &bench.app,
        &auth::random_token(),
        "first",
        vec!["alias".into()],
        None,
        png(),
    )
    .await
    .unwrap();
    assert!(
        custom_emojis::put(
            &bench.app,
            &auth::random_token(),
            "second",
            vec!["alias".into()],
            None,
            png()
        )
        .await
        .is_err()
    );
    assert!(
        custom_emojis::put(
            &bench.app,
            &auth::random_token(),
            "first",
            vec![],
            None,
            png()
        )
        .await
        .is_err()
    );
    assert!(
        custom_emojis::remove(&bench.app, &auth::random_token(), "first", "999")
            .await
            .is_err()
    );
    assert_eq!(
        custom_emojis::catalog(&bench.app)
            .await
            .unwrap()
            .items
            .len(),
        1
    );
    let count: i64 =
        sqlx::query_scalar("SELECT count(*) FROM operator_audit WHERE action LIKE 'emoji.%'")
            .fetch_one(&bench.app.pool)
            .await
            .unwrap();
    assert_eq!(count, 1);
    assert_eq!(first.applied_revision, "1");
}
