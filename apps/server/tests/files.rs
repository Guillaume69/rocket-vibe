use axum::{
    body::Body,
    http::{Request, StatusCode},
};
use futures_util::StreamExt;
use rv_client::NativeClient;
use rv_protocol::{
    CreateRoom, SendMessage,
    parity::{CompleteUpload, MessageContent, PrepareUpload, Upload, UploadState},
};
use rv_server::{App, auth, objects::LocalObjects};
use sha2::{Digest, Sha256};
use sqlx::PgPool;
use std::time::Duration;
use tower::ServiceExt;

#[sqlx::test]
async fn portable_mobile_transport_recovers_lost_byte_and_message_acknowledgements(pool: PgPool) {
    let bench = Bench::new(pool).await;
    bench.user("mobile", false).await;
    let script = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../scripts/native-files-smoke.ts");
    let output = tokio::process::Command::new("node")
        .arg(script)
        .env("RV_FILE_TEST_SERVER", &bench.base)
        .output()
        .await
        .unwrap();
    assert!(
        output.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM messages WHERE system IS NULL")
        .fetch_one(&bench.app.pool)
        .await
        .unwrap();
    assert_eq!(count, 1);
}

struct Bench {
    app: App,
    base: String,
    root: std::path::PathBuf,
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
        let root = std::env::temp_dir().join(format!("rv-files-{}", auth::random_token()));
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
            base,
            root,
            task,
        }
    }
    async fn user(&self, name: &str, admin: bool) -> (NativeClient, String, String) {
        let user = auth::create_user(&self.app, name, "files-test-password".into(), admin)
            .await
            .unwrap();
        let mut client = NativeClient::new(&self.base).unwrap();
        let token = client
            .login(name, "files-test-password")
            .await
            .unwrap()
            .token;
        (client, user.id, token)
    }
    async fn room(&self, client: &NativeClient) -> String {
        client
            .create_room(&CreateRoom {
                operation_id: Some(auth::random_token()),
                name: "Files pilot".into(),
                private: true,
            })
            .await
            .unwrap()
            .id
    }
    async fn prepared(
        &self,
        client: &NativeClient,
        room: &str,
        bytes: &[u8],
        mime: &str,
    ) -> Upload {
        client
            .prepare_upload(&input(room, bytes, mime))
            .await
            .unwrap()
    }
    async fn complete(
        &self,
        client: &NativeClient,
        room: &str,
        bytes: &[u8],
    ) -> (Upload, rv_protocol::Message) {
        let upload = self
            .prepared(client, room, bytes, "application/octet-stream")
            .await;
        client
            .upload_bytes(&upload.id, bytes.to_vec().into())
            .await
            .unwrap();
        let message = client
            .complete_upload(&upload.id, &confirmation(&upload.id))
            .await
            .unwrap();
        (upload, message)
    }
    async fn raw(&self, token: &str, path: &str) -> reqwest::Response {
        reqwest::Client::new()
            .get(format!("{}{path}", self.base))
            .bearer_auth(token)
            .send()
            .await
            .unwrap()
    }
}
fn input(room: &str, bytes: &[u8], mime: &str) -> PrepareUpload {
    PrepareUpload {
        operation_id: auth::random_token(),
        room_id: room.into(),
        bytes: bytes.len().to_string(),
        sha256: format!("{:x}", Sha256::digest(bytes)),
        media_type: mime.into(),
        filename: Some("Document été.bin".into()),
        encrypted: false,
    }
}
fn confirmation(id: &str) -> CompleteUpload {
    CompleteUpload {
        operation_id: auth::random_token(),
        content: MessageContent::Plain {
            markdown: "File caption".into(),
            mentions: vec![],
            quotes: vec![],
            files: vec![id.into()],
        },
        reply_to: None,
    }
}
fn code(error: rv_client::Error) -> String {
    match error {
        rv_client::Error::Server { code, .. } => code,
        _ => panic!("unexpected transport error: {error}"),
    }
}

#[sqlx::test]
async fn file_retry_is_one_atomic_message_with_protected_manifests_and_range_reads(pool: PgPool) {
    let bench = Bench::new(pool).await;
    let (client, _, token) = bench.user("author", false).await;
    let room = bench.room(&client).await;
    let bytes: Vec<_> = (0..800_000).map(|i| (i % 251) as u8).collect();
    let prepare = input(&room, &bytes, "application/octet-stream");
    let (first, second) = tokio::join!(
        client.prepare_upload(&prepare),
        client.prepare_upload(&prepare)
    );
    let upload = first.unwrap();
    assert_eq!(upload.id, second.unwrap().id);
    assert_eq!(
        bench
            .raw(&token, &format!("/api/v1/files/{}", upload.id))
            .await
            .status(),
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        client
            .upload_bytes(
                &upload.id,
                rv_client::UploadBody::wrap_stream(futures_util::stream::iter(
                    bytes
                        .chunks(80_000)
                        .map(|chunk| Ok::<_, std::io::Error>(chunk.to_vec()))
                        .collect::<Vec<_>>()
                ))
            )
            .await
            .unwrap()
            .state,
        UploadState::Ready
    );
    assert_eq!(
        client
            .upload_bytes(&upload.id, bytes.clone().into())
            .await
            .unwrap()
            .state,
        UploadState::Ready
    );
    let confirm = confirmation(&upload.id);
    let (a, b) = tokio::join!(
        client.complete_upload(&upload.id, &confirm),
        client.complete_upload(&upload.id, &confirm)
    );
    let message = a.unwrap();
    assert_eq!(message, b.unwrap());
    assert_eq!(message.files.len(), 1);
    assert_eq!(message.files[0], upload.file);
    assert_eq!(
        client.upload_status(&upload.id).await.unwrap().state,
        UploadState::Completed
    );
    assert_eq!(
        client.history(&room, None).await.unwrap().messages[0].files,
        message.files
    );
    assert!(
        client
            .snapshot()
            .await
            .unwrap()
            .messages
            .iter()
            .any(|m| m.id == message.id && m.files == message.files)
    );
    let response = client.file_response(&upload.id, None).await.unwrap();
    assert_eq!(response.headers()["cache-control"], "no-store");
    assert_eq!(response.headers()["x-content-type-options"], "nosniff");
    assert!(
        response.headers()["content-disposition"]
            .to_str()
            .unwrap()
            .contains("%C3%A9")
    );
    assert_eq!(response.bytes().await.unwrap(), bytes.as_slice());
    let response = client
        .file_response(&upload.id, Some("bytes=13-200"))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
    assert_eq!(response.headers()["content-range"], "bytes 13-200/800000");
    assert_eq!(response.bytes().await.unwrap(), &bytes[13..201]);
    assert_eq!(
        client
            .file_response(&upload.id, Some("bytes=-12"))
            .await
            .unwrap()
            .bytes()
            .await
            .unwrap(),
        &bytes[bytes.len() - 12..]
    );
    assert_eq!(
        code(
            client
                .file_response(&upload.id, Some("bytes=800000-"))
                .await
                .unwrap_err()
        ),
        "invalid_range"
    );
    let (admin, _, _) = bench.user("administrator", true).await;
    assert_eq!(
        code(admin.file_response(&upload.id, None).await.unwrap_err()),
        "not_found"
    );
    assert_eq!(
        code(admin.upload_status(&upload.id).await.unwrap_err()),
        "not_found"
    );
    assert_eq!(
        reqwest::get(format!("{}/api/v1/files/{}", bench.base, upload.id))
            .await
            .unwrap()
            .status(),
        StatusCode::UNAUTHORIZED
    );
    let mut different = confirmation(&upload.id);
    different.operation_id = confirm.operation_id.clone();
    different.content = MessageContent::Plain {
        markdown: "Different caption".into(),
        mentions: vec![],
        quotes: vec![],
        files: vec![upload.id.clone()],
    };
    assert_eq!(
        code(
            client
                .complete_upload(&upload.id, &different)
                .await
                .unwrap_err()
        ),
        "operation_conflict"
    );
    assert_eq!(
        code(
            client
                .send(
                    &room,
                    &SendMessage {
                        operation_id: prepare.operation_id,
                        text: "reuse reservation identity".into(),
                        reply_to: None,
                        quotes: vec![]
                    }
                )
                .await
                .unwrap_err()
        ),
        "operation_conflict"
    );
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM messages WHERE system IS NULL")
        .fetch_one(&bench.app.pool)
        .await
        .unwrap();
    assert_eq!(count, 1);
    let empty_caption = client
        .edit_message(
            &message.id,
            &rv_protocol::parity::EditMessage {
                operation_id: auth::random_token(),
                expected_revision: message.revision.clone(),
                content: MessageContent::Plain {
                    markdown: String::new(),
                    mentions: vec![],
                    quotes: vec![],
                    files: vec![],
                },
            },
        )
        .await
        .unwrap();
    assert!(empty_caption.text.is_empty());
    assert_eq!(empty_caption.files, message.files);
    assert_eq!(
        client
            .complete_upload(&upload.id, &confirm)
            .await
            .unwrap()
            .text,
        ""
    );
}

#[sqlx::test]
async fn corrupt_interrupted_and_cancelled_uploads_never_publish_a_message(pool: PgPool) {
    let bench = Bench::new(pool).await;
    let (client, _, _) = bench.user("author", false).await;
    let room = bench.room(&client).await;
    let data = b"some original file data";
    let upload = bench
        .prepared(&client, &room, data, "application/octet-stream")
        .await;
    assert_eq!(
        code(
            client
                .upload_bytes(&upload.id, b"short".to_vec().into())
                .await
                .unwrap_err()
        ),
        "invalid_file"
    );
    assert_eq!(
        code(
            client
                .upload_bytes(&upload.id, vec![0; data.len() + 1].into())
                .await
                .unwrap_err()
        ),
        "file_too_large"
    );
    assert_eq!(
        code(
            client
                .upload_bytes(&upload.id, vec![0; data.len()].into())
                .await
                .unwrap_err()
        ),
        "invalid_file"
    );
    assert_eq!(
        client.upload_status(&upload.id).await.unwrap().state,
        UploadState::Prepared
    );
    assert_eq!(
        code(
            client
                .complete_upload(&upload.id, &confirmation(&upload.id))
                .await
                .unwrap_err()
        ),
        "upload_not_ready"
    );
    client
        .upload_bytes(&upload.id, data.to_vec().into())
        .await
        .unwrap();
    assert_eq!(
        client.cancel_upload(&upload.id).await.unwrap().state,
        UploadState::Cancelled
    );
    assert_eq!(
        client.cancel_upload(&upload.id).await.unwrap().state,
        UploadState::Cancelled
    );
    assert_eq!(
        code(
            client
                .upload_bytes(&upload.id, data.to_vec().into())
                .await
                .unwrap_err()
        ),
        "upload_cancelled"
    );
    assert_eq!(
        code(
            client
                .complete_upload(&upload.id, &confirmation(&upload.id))
                .await
                .unwrap_err()
        ),
        "upload_cancelled"
    );
    let fake = bench
        .prepared(&client, &room, b"not a PNG", "image/png")
        .await;
    assert_eq!(
        code(
            client
                .upload_bytes(&fake.id, b"not a PNG".to_vec().into())
                .await
                .unwrap_err()
        ),
        "invalid_file"
    );
    let mut unsupported = input(&room, data, "text/html");
    assert_eq!(
        code(client.prepare_upload(&unsupported).await.unwrap_err()),
        "invalid_request"
    );
    unsupported.media_type = "application/octet-stream".into();
    unsupported.filename = Some("../../hidden".into());
    assert_eq!(
        code(client.prepare_upload(&unsupported).await.unwrap_err()),
        "invalid_request"
    );
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM messages WHERE system IS NULL")
        .fetch_one(&bench.app.pool)
        .await
        .unwrap();
    assert_eq!(count, 0);
    assert!(std::fs::read_dir(&bench.root).unwrap().all(|p| {
        !p.unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with(".tmp-")
    }));
}

#[sqlx::test]
async fn expiration_membership_generation_and_deleted_messages_end_file_access(pool: PgPool) {
    let bench = Bench::new(pool).await;
    let (owner, _, _) = bench.user("owner", false).await;
    let (member, uid, token) = bench.user("member", false).await;
    let room = bench.room(&owner).await;
    owner.add_member(&room, &uid).await.unwrap();
    let bytes = b"private content";
    let pending = bench
        .prepared(&member, &room, bytes, "application/octet-stream")
        .await;
    sqlx::query("UPDATE uploads SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1")
        .bind(&pending.id)
        .execute(&bench.app.pool)
        .await
        .unwrap();
    assert_eq!(
        member.upload_status(&pending.id).await.unwrap().state,
        UploadState::Expired
    );
    assert_eq!(
        code(
            member
                .upload_bytes(&pending.id, bytes.to_vec().into())
                .await
                .unwrap_err()
        ),
        "upload_expired"
    );
    let (upload, message) = bench.complete(&member, &room, bytes).await;
    let pending = bench
        .prepared(&member, &room, bytes, "application/octet-stream")
        .await;
    reqwest::Client::new()
        .delete(format!("{}/api/v1/rooms/{room}/members/{uid}", bench.base))
        .bearer_auth(owner.saved_token().unwrap())
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap();
    assert_eq!(
        bench
            .raw(&token, &format!("/api/v1/files/{}", upload.id))
            .await
            .status(),
        StatusCode::NOT_FOUND
    );
    owner.add_member(&room, &uid).await.unwrap();
    assert_eq!(
        code(member.upload_status(&pending.id).await.unwrap_err()),
        "upload_authority_changed"
    );
    assert_eq!(
        member
            .file_response(&upload.id, None)
            .await
            .unwrap()
            .bytes()
            .await
            .unwrap(),
        bytes.as_slice()
    );
    sqlx::query("UPDATE messages SET deleted=true WHERE id=$1")
        .bind(&message.id)
        .execute(&bench.app.pool)
        .await
        .unwrap();
    assert_eq!(
        code(member.file_response(&upload.id, None).await.unwrap_err()),
        "not_found"
    );
    assert!(
        member
            .history(&room, None)
            .await
            .unwrap()
            .messages
            .iter()
            .find(|m| m.id == message.id)
            .unwrap()
            .files
            .is_empty()
    );
    sqlx::query("UPDATE instance SET data_epoch='changed-generation' WHERE singleton")
        .execute(&bench.app.pool)
        .await
        .unwrap();
    assert_eq!(
        code(member.upload_status(&pending.id).await.unwrap_err()),
        "upload_authority_changed"
    );
}

#[sqlx::test]
async fn file_stream_revalidates_membership_before_each_next_chunk(pool: PgPool) {
    let bench = Bench::new(pool).await;
    let (owner, _, _) = bench.user("owner", false).await;
    let (member, uid, token) = bench.user("reader", false).await;
    let room = bench.room(&owner).await;
    owner.add_member(&room, &uid).await.unwrap();
    let bytes = vec![42u8; 800_000];
    let (upload, _) = bench.complete(&owner, &room, &bytes).await;
    let response = bench
        .app
        .clone()
        .router()
        .oneshot(
            Request::builder()
                .uri(format!("/api/v1/files/{}", upload.id))
                .header("authorization", format!("Bearer {token}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let mut stream = response.into_body().into_data_stream();
    assert_eq!(stream.next().await.unwrap().unwrap().len(), 256 * 1024);
    let request = reqwest::Client::new()
        .delete(format!("{}/api/v1/rooms/{room}/members/{uid}", bench.base))
        .bearer_auth(owner.saved_token().unwrap());
    let remove =
        tokio::spawn(async move { request.send().await.unwrap().error_for_status().unwrap() });
    tokio::time::timeout(Duration::from_secs(2),async{loop{let waiting:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock')").fetch_one(&bench.app.pool).await.unwrap();if waiting{break;}tokio::task::yield_now().await;}}).await.unwrap();
    let (next, removed) = tokio::join!(stream.next(), remove);
    removed.unwrap();
    assert!(next.is_none() || next.unwrap().is_err());
    assert_eq!(
        code(member.file_response(&upload.id, None).await.unwrap_err()),
        "not_found"
    );
}

#[sqlx::test]
async fn reservations_bound_account_and_global_storage_and_preserve_replay(pool: PgPool) {
    let bench = Bench::new(pool).await;
    let (client, uid, _) = bench.user("owner", false).await;
    let room = bench.room(&client).await;
    let mut reserved = vec![];
    for _ in 0..10 {
        reserved.push(
            bench
                .prepared(&client, &room, b"a", "application/octet-stream")
                .await,
        );
    }
    assert_eq!(
        code(
            client
                .prepare_upload(&input(&room, b"a", "application/octet-stream"))
                .await
                .unwrap_err()
        ),
        "upload_limit"
    );
    for reservation in &reserved {
        client.cancel_upload(&reservation.id).await.unwrap();
    }
    let original = input(&room, b"a", "application/octet-stream");
    let ready = client.prepare_upload(&original).await.unwrap();
    let (_, bulk, _) = bench.user("bulk", false).await;
    sqlx::query("INSERT INTO uploads(id,user_id,operation_id,fingerprint,room_id,membership_version,data_epoch,bytes,sha256,media_type,filename,state) SELECT 'quota-'||n,$1,'quota-'||n,'quota',$2,(SELECT access_version FROM members WHERE user_id=$3 AND room_id=$2),(SELECT data_epoch FROM instance),104857600,repeat('0',64),'application/octet-stream','reserved.bin','prepared' FROM generate_series(1,512) n")
 .bind(bulk).bind(&room).bind(uid).execute(&bench.app.pool).await.unwrap();
    assert_eq!(
        code(
            client
                .prepare_upload(&input(&room, b"b", "application/octet-stream"))
                .await
                .unwrap_err()
        ),
        "file_quota"
    );
    assert_eq!(client.upload_status(&ready.id).await.unwrap().id, ready.id);
    assert_eq!(client.prepare_upload(&original).await.unwrap().id, ready.id);
    sqlx::query("UPDATE uploads SET expires_at=clock_timestamp()-interval '1 second' WHERE id LIKE 'quota-%'")
        .execute(&bench.app.pool).await.unwrap();
    assert_eq!(
        code(
            client
                .prepare_upload(&input(&room, b"b", "application/octet-stream"))
                .await
                .unwrap_err()
        ),
        "file_quota"
    );
    bench.app.cleanup().await.unwrap();
    assert_eq!(
        client
            .prepare_upload(&input(&room, b"b", "application/octet-stream"))
            .await
            .unwrap()
            .state,
        UploadState::Prepared
    );
}

#[sqlx::test]
async fn cancelling_during_a_live_transfer_never_resurrects_its_reservation(pool: PgPool) {
    let bench = Bench::new(pool).await;
    let (client, _, token) = bench.user("owner", false).await;
    let room = bench.room(&client).await;
    let data = b"bytes held until cancellation".to_vec();
    let upload = bench
        .prepared(&client, &room, &data, "application/octet-stream")
        .await;
    let (release, wait) = tokio::sync::oneshot::channel();
    let stream = futures_util::stream::once(async move {
        wait.await.unwrap();
        Ok::<_, std::io::Error>(axum::body::Bytes::from(data))
    });
    let request = Request::builder()
        .method("PUT")
        .uri(format!("/api/v1/uploads/{}/bytes", upload.id))
        .header("authorization", format!("Bearer {token}"))
        .body(Body::from_stream(stream))
        .unwrap();
    let router = bench.app.clone().router();
    let transfer = tokio::spawn(async move { router.oneshot(request).await.unwrap() });
    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            let claimed: bool =
                sqlx::query_scalar("SELECT lease_id IS NOT NULL FROM uploads WHERE id=$1")
                    .bind(&upload.id)
                    .fetch_one(&bench.app.pool)
                    .await
                    .unwrap();
            if claimed {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert_eq!(
        client.cancel_upload(&upload.id).await.unwrap().state,
        UploadState::Cancelled
    );
    release.send(()).unwrap();
    assert_eq!(transfer.await.unwrap().status(), StatusCode::CONFLICT);
    assert_eq!(
        client.upload_status(&upload.id).await.unwrap().state,
        UploadState::Cancelled
    );
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM uploads WHERE object_id IS NOT NULL")
        .fetch_one(&bench.app.pool)
        .await
        .unwrap();
    assert_eq!(count, 0);
}
