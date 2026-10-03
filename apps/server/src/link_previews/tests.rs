use super::*;
use rv_protocol::{
    CreateRoom, SendMessage,
    parity::{EditMessage, MessageContent},
};
use sqlx::PgPool;
use std::io::Cursor;

struct Fixture {
    app: App,
    owner: auth::Account,
    room: String,
    session: rv_protocol::Session,
    directory: std::path::PathBuf,
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.directory);
    }
}
async fn fixture(pool: PgPool) -> Fixture {
    let directory = std::env::temp_dir().join(format!("rv-preview-test-{}", auth::random_token()));
    let app = App::from_pool(pool)
        .await
        .unwrap()
        .with_objects(crate::objects::LocalObjects::open(&directory).unwrap());
    auth::create_user(&app, "owner", "test-password-2026".into(), false)
        .await
        .unwrap();
    let session = auth::login(&app, "owner".into(), "test-password-2026".into())
        .await
        .unwrap();
    let owner = auth::authenticate(&app, &auth::hash_token(&session.token))
        .await
        .unwrap();
    let room = store::create_room(
        &app,
        &owner,
        CreateRoom {
            name: "Previews".into(),
            private: true,
            operation_id: Some("preview-room".into()),
        },
    )
    .await
    .unwrap()
    .id;
    Fixture {
        app,
        owner,
        room,
        session,
        directory,
    }
}
async fn send(f: &Fixture, id: &str, text: &str) -> rv_protocol::Message {
    store::send(
        &f.app,
        &f.owner,
        &f.room,
        SendMessage {
            cards: Vec::new(),
            operation_id: id.into(),
            text: text.into(),
            reply_to: None,
            quotes: vec![],
        },
    )
    .await
    .unwrap()
}
fn collected(image: bool) -> network::Collected {
    let image = image.then(|| {
        let mut bytes = Cursor::new(Vec::new());
        image::DynamicImage::new_rgb8(2, 2)
            .write_to(&mut bytes, image::ImageFormat::Png)
            .unwrap();
        network::NormalizedImage {
            bytes: bytes.into_inner(),
            width: 2,
            height: 2,
        }
    });
    network::Collected {
        kind: rv_protocol::link_previews::PreviewKind::Page,
        title: Some("Public page".into()),
        description: Some("Description".into()),
        site: Some("Example".into()),
        image,
    }
}
async fn edit(f: &Fixture, message: &rv_protocol::Message, text: &str) {
    crate::message_actions::apply(
        &f.app,
        &f.owner,
        &message.id,
        crate::message_actions::Command::Edit(EditMessage {
            operation_id: auth::random_token(),
            expected_revision: message.revision.clone(),
            content: MessageContent::Plain {
                markdown: text.into(),
                mentions: vec![],
                quotes: vec![],
                files: vec![],
            },
        }),
    )
    .await
    .unwrap();
}

#[sqlx::test]
async fn durable_leases_recover_and_publish_in_source_order(pool: PgPool) {
    let f = fixture(pool).await;
    let message=send(&f,"preview-message","https://one.example/a https://two.example/b https://three.example/c https://four.example/d").await;
    assert!(message.previews.is_empty());
    let mut first = claim(&f.app).await.unwrap();
    assert_eq!(first.len(), 3);
    assert!(claim(&f.app).await.unwrap().is_empty());
    let old = first.remove(0);
    // Process restart: the SQL lease, not an in-memory queue, decides ownership.
    sqlx::query(
        "UPDATE link_preview_jobs SET lease_expires_at=clock_timestamp()-interval '1 second'",
    )
    .execute(&f.app.pool)
    .await
    .unwrap();
    let mut fresh = claim(&f.app).await.unwrap();
    assert_eq!(fresh.len(), 3);
    assert!(!publish(&f.app, &old, collected(false)).await.unwrap());
    fresh.sort_by_key(|j| j.slot);
    let last = fresh.remove(2);
    assert!(publish(&f.app, &last, collected(false)).await.unwrap());
    assert!(
        publish(&f.app, &fresh.remove(0), collected(false))
            .await
            .unwrap()
    );
    assert!(
        publish(&f.app, &fresh.remove(0), collected(false))
            .await
            .unwrap()
    );
    let current = crate::message_actions::read(&f.app, &f.owner, &message.id)
        .await
        .unwrap();
    assert_eq!(
        current
            .previews
            .iter()
            .map(|p| p.url.as_str())
            .collect::<Vec<_>>(),
        [
            "https://one.example/a",
            "https://two.example/b",
            "https://three.example/c"
        ]
    );
    assert_eq!(current.text, message.text);
    assert_eq!(current.edited_at, None);
    assert!(current.revision.parse::<i64>().unwrap() > message.revision.parse::<i64>().unwrap());
    assert!(!publish(&f.app, &last, collected(false)).await.unwrap());
    let count:i64=sqlx::query_scalar("SELECT count(*) FROM journal WHERE change->>'type'='message_upsert' AND change #>> '{data,id}'=$1").bind(&message.id).fetch_one(&f.app.pool).await.unwrap();
    assert_eq!(count, 4); // send plus exactly one publication per slot.
}

#[sqlx::test]
async fn editing_and_deletion_fence_late_results_and_old_private_images(pool: PgPool) {
    let f = fixture(pool).await;
    let message = send(&f, "preview-message", "https://one.example/a").await;
    let old = claim(&f.app).await.unwrap().remove(0);
    edit(&f, &message, "https://two.example/b").await;
    assert!(!publish(&f.app, &old, collected(true)).await.unwrap());
    let new = claim(&f.app).await.unwrap().remove(0);
    assert!(publish(&f.app, &new, collected(true)).await.unwrap());
    let current = crate::message_actions::read(&f.app, &f.owner, &message.id)
        .await
        .unwrap();
    assert_eq!(current.previews[0].url, "https://two.example/b");
    let file = current.previews[0].image.as_ref().unwrap().file_id.clone();
    let hash = auth::hash_token(&f.session.token);
    let response = image_response(&f.app, &f.owner, &hash, &message.id, &file)
        .await
        .unwrap();
    let bytes = axum::body::to_bytes(response.into_body(), 1024)
        .await
        .unwrap();
    assert!(bytes.starts_with(b"\x89PNG"));
    crate::message_actions::apply(
        &f.app,
        &f.owner,
        &message.id,
        crate::message_actions::Command::Delete(rv_protocol::parity::DeleteMessage {
            operation_id: auth::random_token(),
            expected_revision: current.revision,
        }),
    )
    .await
    .unwrap();
    let deleted = crate::message_actions::read(&f.app, &f.owner, &message.id)
        .await
        .unwrap();
    assert!(deleted.previews.is_empty());
    assert_eq!(
        image_response(&f.app, &f.owner, &hash, &message.id, &file)
            .await
            .unwrap_err()
            .status,
        axum::http::StatusCode::NOT_FOUND
    );
    assert!(!publish(&f.app, &new, collected(false)).await.unwrap());
    let retained:i64=sqlx::query_scalar("SELECT count(*) FROM journal WHERE change #>> '{data,id}'=$1 AND change #> '{data,previews}' IS NOT NULL").bind(&message.id).fetch_one(&f.app.pool).await.unwrap();
    assert_eq!(retained, 0);
}

#[sqlx::test]
async fn bounds_retry_deadlines_and_rejects_old_epoch(pool: PgPool) {
    let f = fixture(pool).await;
    send(&f, "preview-message", "https://one.example/a").await;
    for attempt in 1..=3 {
        let job = claim(&f.app).await.unwrap().remove(0);
        assert!(current(&f.app, &job).await.unwrap());
        failed(&f.app, &job, true).await.unwrap();
        let (count, state): (i16, String) =
            sqlx::query_as("SELECT attempts,state FROM link_preview_jobs")
                .fetch_one(&f.app.pool)
                .await
                .unwrap();
        assert_eq!(count, attempt);
        assert_eq!(state, if attempt < 3 { "pending" } else { "retired" });
        sqlx::query(
            "UPDATE link_preview_jobs SET next_attempt_at=clock_timestamp()-interval '1 second'",
        )
        .execute(&f.app.pool)
        .await
        .unwrap();
    }
    assert!(claim(&f.app).await.unwrap().is_empty());
    let message = send(&f, "epoch-message", "https://one.example/a").await;
    let job = claim(&f.app).await.unwrap().remove(0);
    sqlx::query("UPDATE instance SET data_epoch=$1")
        .bind(auth::random_token())
        .execute(&f.app.pool)
        .await
        .unwrap();
    assert!(!current(&f.app, &job).await.unwrap());
    assert!(!publish(&f.app, &job, collected(false)).await.unwrap());
    assert!(
        crate::message_actions::read(&f.app, &f.owner, &message.id)
            .await
            .unwrap()
            .previews
            .is_empty()
    );
    f.app.cleanup().await.unwrap();
    assert!(claim(&f.app).await.unwrap().is_empty());
}

#[sqlx::test]
async fn images_require_current_membership_and_live_session(pool: PgPool) {
    use axum::body::Body;
    use tower::ServiceExt;
    let f = fixture(pool).await;
    auth::create_user(&f.app, "reader", "test-password-2026".into(), false)
        .await
        .unwrap();
    let session = auth::login(&f.app, "reader".into(), "test-password-2026".into())
        .await
        .unwrap();
    let reader = auth::authenticate(&f.app, &auth::hash_token(&session.token))
        .await
        .unwrap();
    store::membership(&f.app, &f.owner, &f.room, &reader.id, false)
        .await
        .unwrap();
    let message = send(&f, "preview-message", "https://one.example/a").await;
    let job = claim(&f.app).await.unwrap().remove(0);
    assert!(publish(&f.app, &job, collected(true)).await.unwrap());
    let message = crate::message_actions::read(&f.app, &f.owner, &message.id)
        .await
        .unwrap();
    let file = &message.previews[0].image.as_ref().unwrap().file_id;
    let path = format!("/api/v1/messages/{}/previews/{file}", message.id);
    let request = || {
        axum::http::Request::builder()
            .uri(&path)
            .header("authorization", format!("Bearer {}", session.token))
            .body(Body::empty())
            .unwrap()
    };
    let response = f.app.clone().router().oneshot(request()).await.unwrap();
    assert_eq!(response.status(), axum::http::StatusCode::OK);
    assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
    assert_eq!(
        response.headers()[header::X_CONTENT_TYPE_OPTIONS],
        "nosniff"
    );
    axum::body::to_bytes(response.into_body(), 1024)
        .await
        .unwrap();
    store::membership(&f.app, &f.owner, &f.room, &reader.id, true)
        .await
        .unwrap();
    let response = f.app.clone().router().oneshot(request()).await.unwrap();
    assert_eq!(response.status(), axum::http::StatusCode::NOT_FOUND);
    store::membership(&f.app, &f.owner, &f.room, &reader.id, false)
        .await
        .unwrap();
    sqlx::query("DELETE FROM sessions WHERE token_hash=$1")
        .bind(auth::hash_token(&session.token))
        .execute(&f.app.pool)
        .await
        .unwrap();
    let response = f.app.clone().router().oneshot(request()).await.unwrap();
    assert_eq!(response.status(), axum::http::StatusCode::UNAUTHORIZED);
}

#[sqlx::test]
async fn lease_expiry_prevents_publication_even_without_another_worker(pool: PgPool) {
    let f = fixture(pool).await;
    let message = send(&f, "preview-message", "https://one.example/a").await;
    let job = claim(&f.app).await.unwrap().remove(0);
    sqlx::query(
        "UPDATE link_preview_jobs SET lease_expires_at=clock_timestamp()-interval '1 second'",
    )
    .execute(&f.app.pool)
    .await
    .unwrap();
    assert!(!publish(&f.app, &job, collected(true)).await.unwrap());
    assert!(
        crate::message_actions::read(&f.app, &f.owner, &message.id)
            .await
            .unwrap()
            .previews
            .is_empty()
    );
}

#[sqlx::test]
async fn rust_transport_fetches_authenticated_png_and_checks_hash_and_dimensions(pool: PgPool) {
    let f = fixture(pool).await;
    let message = send(&f, "preview-message", "https://one.example/a").await;
    let job = claim(&f.app).await.unwrap().remove(0);
    assert!(publish(&f.app, &job, collected(true)).await.unwrap());
    let message = crate::message_actions::read(&f.app, &f.owner, &message.id)
        .await
        .unwrap();
    let image = message.previews[0].image.as_ref().unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let client = rv_client::NativeClient::new(&base).unwrap();
    let router = f.app.clone().router();
    let server = tokio::spawn(async move {
        axum::serve(
            listener,
            router.into_make_service_with_connect_info::<std::net::SocketAddr>(),
        )
        .await
        .unwrap()
    });
    client.update_token(f.session.token.clone());
    let bytes = client.preview_image(&message.id, image).await.unwrap();
    assert!(bytes.starts_with(b"\x89PNG"));
    let mut wrong = image.clone();
    wrong.sha256 = "0".repeat(64);
    assert!(matches!(
        client.preview_image(&message.id, &wrong).await,
        Err(rv_client::Error::InvalidPreview)
    ));
    wrong = image.clone();
    wrong.width += 1;
    assert!(matches!(
        client.preview_image(&message.id, &wrong).await,
        Err(rv_client::Error::InvalidPreview)
    ));
    let anonymous = rv_client::NativeClient::new(&base).unwrap();
    assert!(matches!(
        anonymous.preview_image(&message.id, image).await,
        Err(rv_client::Error::SessionMissing)
    ));
    let script = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../scripts/native-link-previews-smoke.ts");
    let output = tokio::process::Command::new("node")
        .arg(script)
        .env("RV_PREVIEW_TEST_SERVER", &base)
        .env("RV_PREVIEW_TEST_MESSAGE", &message.id)
        .output()
        .await
        .unwrap();
    assert!(
        output.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    server.abort();
}

#[sqlx::test]
async fn expiry_while_waiting_for_journal_rolls_back_all_publication(pool: PgPool) {
    let f = fixture(pool).await;
    let message = send(&f, "preview-message", "https://one.example/a").await;
    let job = claim(&f.app).await.unwrap().remove(0);
    sqlx::query(
        "UPDATE link_preview_jobs SET lease_expires_at=clock_timestamp()+interval '1.2 seconds'",
    )
    .execute(&f.app.pool)
    .await
    .unwrap();
    let mut barrier = f.app.pool.begin().await.unwrap();
    sqlx::query("SELECT singleton FROM instance FOR NO KEY UPDATE")
        .fetch_one(&mut *barrier)
        .await
        .unwrap();
    let worker = f.app.clone();
    let publishing = tokio::spawn(async move { publish(&worker, &job, collected(false)).await });
    let mut waiting = false;
    for _ in 0..40 {
        waiting=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'UPDATE instance SET position%')")
            .fetch_one(&f.app.pool).await.unwrap();
        if waiting {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    assert!(waiting, "publication did not reach the real sequencer lock");
    let remaining:f64=sqlx::query_scalar("SELECT GREATEST(0,EXTRACT(EPOCH FROM lease_expires_at-clock_timestamp()))::float8 FROM link_preview_jobs").fetch_one(&f.app.pool).await.unwrap();
    tokio::time::sleep(std::time::Duration::from_secs_f64(remaining + 0.05)).await;
    barrier.commit().await.unwrap();
    assert!(!publishing.await.unwrap().unwrap());
    let current = crate::message_actions::read(&f.app, &f.owner, &message.id)
        .await
        .unwrap();
    assert_eq!(current.revision, message.revision);
    assert!(current.previews.is_empty());
    let count: i64 =
        sqlx::query_scalar("SELECT count(*) FROM journal WHERE change #>> '{data,id}'=$1")
            .bind(&message.id)
            .fetch_one(&f.app.pool)
            .await
            .unwrap();
    assert_eq!(count, 1);
}
