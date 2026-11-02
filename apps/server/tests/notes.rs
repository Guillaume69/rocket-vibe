use reqwest::{Client, Method, StatusCode};
use rv_client::NativeClient;
use rv_protocol::{CreateRoom, parity::UpdateRoomNotes};
use serde_json::{Value, json};
use sqlx::PgPool;
use std::time::Duration;
use vibez::{App, auth};

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
        let http = Client::builder()
            .timeout(Duration::from_secs(10))
            .build()
            .unwrap();
        Self {
            app,
            base,
            http,
            task,
        }
    }
    async fn user(&self, name: &str) -> (NativeClient, String, String) {
        let user = auth::create_user(&self.app, name, "notes-test-password-2026".into(), false)
            .await
            .unwrap();
        let mut client = NativeClient::new(&self.base).unwrap();
        let session = client
            .login(name, "notes-test-password-2026")
            .await
            .unwrap();
        (client, user.id, session.token)
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
}

fn code<T>(result: Result<T, rv_client::Error>, expected: &str) {
    assert!(
        matches!(&result, Err(rv_client::Error::Server { code, .. }) if code == expected),
        "expected {expected}"
    );
}

fn save(body: &str, expected_revision: &str) -> UpdateRoomNotes {
    UpdateRoomNotes {
        body: body.into(),
        expected_revision: expected_revision.into(),
    }
}

#[sqlx::test(migrations = "./migrations")]
async fn members_share_one_document_saved_against_the_revision_they_read(pool: PgPool) {
    let bench = Bench::start(pool).await;
    let (alice, _, alice_token) = bench.user("notes-alice").await;
    let (bob, bob_id, _) = bench.user("notes-bob").await;
    let (carol, _, _) = bench.user("notes-carol").await;
    assert!(alice.discover().await.unwrap().capabilities.room_notes);
    let room = alice
        .create_room(&CreateRoom {
            name: "Notes".into(),
            private: true,
            operation_id: Some("notes-room".into()),
            voice: false,
        })
        .await
        .unwrap()
        .id;
    assert_eq!(
        bench
            .request(
                Method::POST,
                &alice_token,
                &format!("/api/v1/rooms/{room}/members/{bob_id}"),
                Some(json!({})),
            )
            .await
            .status(),
        StatusCode::NO_CONTENT
    );

    let empty = bob.room_notes(&room).await.unwrap();
    assert_eq!((empty.body.as_str(), empty.revision.as_str()), ("", "0"));
    assert!(empty.editable);

    let first = alice
        .update_room_notes(&room, &save("# Plan\n\n- ship", "0"))
        .await
        .unwrap();
    assert_eq!(first.revision, "1");
    assert_eq!(first.updated_by.as_deref(), Some("notes-alice"));
    let read = bob.room_notes(&room).await.unwrap();
    assert_eq!(read.body, "# Plan\n\n- ship");

    code(
        bob.update_room_notes(&room, &save("stale", "0")).await,
        "revision_conflict",
    );
    let second = bob
        .update_room_notes(&room, &save("# Plan\n\n- ship\n- test", &read.revision))
        .await
        .unwrap();
    assert_eq!(second.revision, "2");
    assert_eq!(second.updated_by.as_deref(), Some("notes-bob"));

    assert!(carol.room_notes(&room).await.is_err());
    assert!(
        carol
            .update_room_notes(&room, &save("no", "2"))
            .await
            .is_err()
    );
    code(
        alice
            .update_room_notes(&room, &save(&"x".repeat(64 * 1024 + 1), "2"))
            .await,
        "invalid_request",
    );
}
