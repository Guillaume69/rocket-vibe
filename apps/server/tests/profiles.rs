use reqwest::{Client, Method, StatusCode};
use rv_client::NativeClient;
use rv_protocol::{
    live::PresenceStatus,
    profiles::{AvatarCommand, DesktopNotifications, UpdatePreferences, UpdateProfile},
};
use rv_server::{App, auth, objects::LocalObjects};
use serde_json::{Value, json};
use sqlx::PgPool;

struct Bench {
    app: App,
    base: String,
    task: tokio::task::JoinHandle<()>,
    root: std::path::PathBuf,
}
impl Drop for Bench {
    fn drop(&mut self) {
        self.task.abort();
        let _ = std::fs::remove_dir_all(&self.root);
    }
}
impl Bench {
    async fn start(pool: PgPool) -> Self {
        let root = std::env::temp_dir().join(format!("rv-profiles-{}", auth::random_token()));
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
            task,
            root,
        }
    }
    async fn user(&self, name: &str) -> (NativeClient, String, String) {
        let u = auth::create_user(&self.app, name, "profiles-test-password".into(), false)
            .await
            .unwrap();
        let mut client = NativeClient::new(&self.base).unwrap();
        let token = client
            .login(name, "profiles-test-password")
            .await
            .unwrap()
            .token;
        (client, u.id, token)
    }
    async fn request(
        &self,
        method: Method,
        token: &str,
        path: &str,
        value: Value,
    ) -> reqwest::Response {
        Client::new()
            .request(method, format!("{}{path}", self.base))
            .bearer_auth(token)
            .json(&value)
            .send()
            .await
            .unwrap()
    }
}
fn command(profile: &rv_protocol::parity::UserProfile, operation: &str) -> UpdateProfile {
    UpdateProfile {
        operation_id: operation.into(),
        expected_revision: profile.revision.clone(),
        username: profile.user.username.clone(),
        display_name: profile.user.display_name.clone(),
        bio: profile.bio.clone(),
        status: profile.status,
        status_text: profile.status_text.clone(),
    }
}
fn code(error: rv_client::Error) -> String {
    match error {
        rv_client::Error::Server { code, .. } => code,
        _ => panic!("expected server error: {error}"),
    }
}
fn png(color: u8) -> Vec<u8> {
    let image = image::DynamicImage::ImageRgba8(image::ImageBuffer::from_pixel(
        10,
        10,
        image::Rgba([color, 10, 20, 255]),
    ));
    let mut bytes = std::io::Cursor::new(Vec::new());
    image.write_to(&mut bytes, image::ImageFormat::Png).unwrap();
    bytes.into_inner()
}

#[sqlx::test(migrations = "./migrations")]
async fn mobile_profiles_and_protected_avatars_use_the_existing_provider(pool: PgPool) {
    let b = Bench::start(pool).await;
    b.user("profile_owner").await;
    b.user("profile_reader").await;
    let fixture = b.root.join("profile-fixture.png");
    std::fs::write(&fixture, png(120)).unwrap();
    let output = tokio::time::timeout(
        std::time::Duration::from_secs(45),
        tokio::process::Command::new("node")
            .arg("../../scripts/native-profiles-smoke.ts")
            .env("RV_SMOKE_URL", &b.base)
            .env("RV_PROFILE_PNG", fixture)
            .kill_on_drop(true)
            .output(),
    )
    .await
    .expect("mobile profiles must finish within 45 seconds")
    .expect("Node is required for the mobile SQLite bench");
    assert!(
        output.status.success(),
        "{} {}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

#[sqlx::test(migrations = "./migrations")]
async fn profile_identity_privacy_conflicts_and_replays(pool: PgPool) {
    let b = Bench::start(pool).await;
    let (alice, uid, token) = b.user("alice").await;
    let (bob, _, _) = b.user("bob").await;
    sqlx::query("INSERT INTO account_emails(user_id,address,verified_at) VALUES($1,'alice@example.test',now())").bind(&uid).execute(&b.app.pool).await.unwrap();
    assert_eq!(
        alice.own_profile().await.unwrap().email.as_deref(),
        Some("alice@example.test")
    );
    let response = b
        .request(
            Method::GET,
            &token,
            &format!("/api/v1/users/{uid}"),
            json!({}),
        )
        .await;
    assert_eq!(response.headers().get("cache-control").unwrap(), "no-store");
    let public: Value = response.json().await.unwrap();
    assert!(!public.to_string().contains("alice@example.test"));
    assert!(public.get("email").is_none() && public.get("preferences").is_none());
    let mut input = command(&alice.own_profile().await.unwrap().profile, "profile-one");
    input.display_name = "Alice 🚀".into();
    input.bio = "Bonjour\nà tous".into();
    input.status = PresenceStatus::Busy;
    input.status_text = "En réunion".into();
    let receipt = alice.update_profile(&input).await.unwrap();
    let current = bob.user_profile(&uid).await.unwrap();
    assert_eq!(current.user.display_name, "Alice 🚀");
    assert_eq!(current.status, PresenceStatus::Busy);
    assert_eq!(current.revision, receipt.applied_revision);
    assert_eq!(alice.me().await.unwrap().display_name, "Alice 🚀");
    assert_eq!(
        alice.update_profile(&input).await.unwrap().applied_revision,
        receipt.applied_revision
    );
    let mut diverging = input.clone();
    diverging.bio = "changed under same key".into();
    assert_eq!(
        code(alice.update_profile(&diverging).await.unwrap_err()),
        "operation_conflict"
    );
    let mut stale = input.clone();
    stale.operation_id = "stale-other-device".into();
    assert_eq!(
        code(alice.update_profile(&stale).await.unwrap_err()),
        "revision_conflict"
    );
    let mut rename = command(&current, "rename");
    rename.username = "alice-new".into();
    alice.update_profile(&rename).await.unwrap();
    assert_eq!(
        alice.lookup_profile("alice-new").await.unwrap().user.id,
        uid
    );
    assert!(alice.lookup_profile("alice").await.is_err());
    assert_eq!(alice.me().await.unwrap().username, "alice-new");
    // A lost earlier response remains the original receipt, never renaming back.
    alice.update_profile(&input).await.unwrap();
    assert_eq!(alice.me().await.unwrap().username, "alice-new");
    let mut taken = command(&alice.own_profile().await.unwrap().profile, "taken");
    taken.username = "bob".into();
    assert_eq!(
        code(alice.update_profile(&taken).await.unwrap_err()),
        "username_taken"
    );
    sqlx::query("UPDATE session_devices SET created_at=now()-interval '1 day' WHERE user_id=$1")
        .bind(&uid)
        .execute(&b.app.pool)
        .await
        .unwrap();
    let mut sensitive = command(&alice.own_profile().await.unwrap().profile, "sensitive");
    sensitive.username = "another".into();
    assert_eq!(
        code(alice.update_profile(&sensitive).await.unwrap_err()),
        "reauthentication_required"
    );
    sensitive.operation_id = "bio-old-session".into();
    sensitive.username = "alice-new".into();
    sensitive.bio = "still permitted".into();
    alice.update_profile(&sensitive).await.unwrap();
    let mut forged = serde_json::to_value(sensitive).unwrap();
    forged["user_id"] = "bob-id".into();
    assert_eq!(
        b.request(Method::PATCH, &token, "/api/v1/me", forged)
            .await
            .status(),
        StatusCode::BAD_REQUEST
    );
    sqlx::query("UPDATE users SET disabled=true WHERE id=$1")
        .bind(&uid)
        .execute(&b.app.pool)
        .await
        .unwrap();
    assert!(bob.user_profile(&uid).await.is_err());
}

#[sqlx::test(migrations = "./migrations")]
async fn preferences_are_private_independent_and_live_status_is_sticky(pool: PgPool) {
    let b = Bench::start(pool).await;
    let (alice, uid, token) = b.user("alice").await;
    let own = alice.own_profile().await.unwrap();
    let prefs = UpdatePreferences {
        operation_id: "prefs-one".into(),
        expected_revision: own.preferences.revision.clone(),
        language: "fr".into(),
        clock_24h: false,
        push_enabled: false,
        push_mentions_only: true,
        desktop_notifications: DesktopNotifications::Mention,
    };
    let receipt = alice.update_preferences(&prefs).await.unwrap();
    let after = alice.own_profile().await.unwrap();
    assert_eq!(after.profile.revision, own.profile.revision);
    assert_ne!(after.preferences.revision, own.preferences.revision);
    assert_eq!(
        after.preferences.desktop_notifications,
        DesktopNotifications::Mention
    );
    assert_eq!(
        alice
            .update_preferences(&prefs)
            .await
            .unwrap()
            .applied_revision,
        receipt.applied_revision
    );
    let mut invalid = prefs.clone();
    invalid.operation_id = "invalid-language".into();
    invalid.language = "arbitrary".into();
    assert_eq!(
        code(alice.update_preferences(&invalid).await.unwrap_err()),
        "invalid_request"
    );
    let mut input = command(&own.profile, "chosen-away");
    input.status = PresenceStatus::Away;
    alice.update_profile(&input).await.unwrap();
    alice.set_presence(PresenceStatus::Online).await.unwrap();
    let status: String = sqlx::query_scalar("SELECT status FROM presence_leases WHERE user_id=$1")
        .bind(&uid)
        .fetch_one(&b.app.pool)
        .await
        .unwrap();
    assert_eq!(status, "away");
    let rv_protocol::live::LiveFrame::Live(frame) = alice.live_state().await.unwrap();
    assert_eq!(frame.profiles.len(), 1);
    assert_eq!(frame.profiles[0].user.id, uid);
    let mut offline = command(
        &alice.own_profile().await.unwrap().profile,
        "chosen-offline",
    );
    offline.status = PresenceStatus::Offline;
    alice.update_profile(&offline).await.unwrap();
    alice.set_presence(PresenceStatus::Online).await.unwrap();
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM presence_leases WHERE user_id=$1")
        .bind(&uid)
        .fetch_one(&b.app.pool)
        .await
        .unwrap();
    assert_eq!(count, 0);
    let response = b
        .request(Method::GET, &token, "/api/v1/me/profile", json!({}))
        .await;
    assert_eq!(response.status(), StatusCode::OK);
}

#[sqlx::test(migrations = "./migrations")]
async fn avatars_are_finalized_on_disk_authorized_and_old_versions_are_retired(pool: PgPool) {
    let b = Bench::start(pool).await;
    let (alice, uid, _) = b.user("alice").await;
    let (bob, _, _) = b.user("bob").await;
    let profile = alice.own_profile().await.unwrap().profile;
    let command = AvatarCommand {
        operation_id: "photo-one".into(),
        expected_revision: profile.revision.clone(),
    };
    let first = png(120);
    let receipt = alice
        .set_avatar(&command, Some(("image/png", first.clone())))
        .await
        .unwrap();
    let photo = alice.own_profile().await.unwrap().profile;
    let id = photo.avatar_file_id.clone().unwrap();
    assert_eq!(receipt.applied_revision, photo.revision);
    assert!(b.root.join(&id).is_file());
    let bytes = bob.avatar_bytes(&id).await.unwrap();
    let decoded = image::load_from_memory(&bytes).unwrap();
    assert_eq!(decoded.width(), 10);
    assert_eq!(
        Client::new()
            .get(format!("{}/api/v1/avatars/{id}", b.base))
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::UNAUTHORIZED
    );
    alice
        .set_avatar(&command, Some(("image/png", first.clone())))
        .await
        .unwrap();
    assert_eq!(std::fs::read_dir(&b.root).unwrap().count(), 1);
    let second = AvatarCommand {
        operation_id: "photo-two".into(),
        expected_revision: photo.revision,
    };
    alice
        .set_avatar(&second, Some(("image/png", png(20))))
        .await
        .unwrap();
    assert!(bob.avatar_bytes(&id).await.is_err());
    assert!(!b.root.join(&id).exists());
    alice
        .set_avatar(&command, Some(("image/png", first)))
        .await
        .unwrap();
    let current = alice.user_profile(&uid).await.unwrap();
    assert_ne!(current.avatar_file_id.as_ref().unwrap(), &id);
    // A fresh App and object adapter reopen the same durable image, independently
    // of any process cache. Garbage from a cancelled SQL write can be reclaimed.
    let reopened = App::from_pool(b.app.pool.clone())
        .await
        .unwrap()
        .with_objects(LocalObjects::open(&b.root).unwrap());
    let garbage = auth::random_token();
    std::fs::write(b.root.join(&garbage), b"orphan").unwrap();
    let active = current.avatar_file_id.as_ref().unwrap();
    let old = std::time::SystemTime::now() - std::time::Duration::from_secs(7200);
    for name in [&garbage, active] {
        std::fs::File::open(b.root.join(name))
            .unwrap()
            .set_times(std::fs::FileTimes::new().set_modified(old))
            .unwrap();
    }
    reopened.cleanup().await.unwrap();
    assert!(!b.root.join(garbage).exists());
    assert!(b.root.join(active).exists());
    let invalid = AvatarCommand {
        operation_id: "invalid".into(),
        expected_revision: current.revision.clone(),
    };
    assert_eq!(
        code(
            alice
                .set_avatar(&invalid, Some(("image/png", b"not a PNG".to_vec())))
                .await
                .unwrap_err()
        ),
        "invalid_avatar"
    );
    assert_eq!(
        code(
            alice
                .set_avatar(&invalid, Some(("image/svg+xml", b"<svg/>".to_vec())))
                .await
                .unwrap_err()
        ),
        "invalid_avatar"
    );
    let oversized = Client::new()
        .put(format!(
            "{}/api/v1/me/avatar?operation_id=oversized&expected_revision={}",
            b.base, current.revision
        ))
        .bearer_auth(alice.saved_token().unwrap())
        .header("content-type", "image/png")
        .body(vec![1u8; 2 * 1024 * 1024 + 1])
        .send()
        .await
        .unwrap();
    assert_eq!(oversized.status(), StatusCode::PAYLOAD_TOO_LARGE);
    // Storage failure cannot produce a successful SQL reference.
    std::fs::remove_dir_all(&b.root).unwrap();
    assert!(
        alice
            .set_avatar(&invalid, Some(("image/png", png(40))))
            .await
            .is_err()
    );
    assert_eq!(
        alice.user_profile(&uid).await.unwrap().avatar_file_id,
        current.avatar_file_id
    );
    std::fs::create_dir_all(&b.root).unwrap();
    alice
        .set_avatar(
            &AvatarCommand {
                operation_id: "remove".into(),
                expected_revision: current.revision,
            },
            None,
        )
        .await
        .unwrap();
    assert!(
        alice
            .user_profile(&uid)
            .await
            .unwrap()
            .avatar_file_id
            .is_none()
    );
}

#[sqlx::test(migrations = "./migrations")]
async fn invalid_images_consume_decode_budget_and_dimensions_are_bounded(pool: PgPool) {
    let b = Bench::start(pool).await;
    let (alice, _, token) = b.user("alice").await;
    let profile = alice.own_profile().await.unwrap().profile;
    let image = image::DynamicImage::ImageRgb8(image::ImageBuffer::from_pixel(
        2049,
        1,
        image::Rgb([1, 2, 3]),
    ));
    let mut bytes = std::io::Cursor::new(Vec::new());
    image.write_to(&mut bytes, image::ImageFormat::Png).unwrap();
    let first = AvatarCommand {
        operation_id: "too-wide".into(),
        expected_revision: profile.revision.clone(),
    };
    assert_eq!(
        code(
            alice
                .set_avatar(&first, Some(("image/png", bytes.into_inner())))
                .await
                .unwrap_err()
        ),
        "invalid_avatar"
    );
    for n in 1..20 {
        let input = AvatarCommand {
            operation_id: format!("bad-{n}"),
            expected_revision: profile.revision.clone(),
        };
        assert_eq!(
            code(
                alice
                    .set_avatar(&input, Some(("image/png", b"bad".to_vec())))
                    .await
                    .unwrap_err()
            ),
            "invalid_avatar"
        );
    }
    let response = Client::new()
        .put(format!(
            "{}/api/v1/me/avatar?operation_id=over-budget&expected_revision={}",
            b.base, profile.revision
        ))
        .bearer_auth(&token)
        .header("content-type", "image/png")
        .body(png(10))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(
        alice.own_profile().await.unwrap().profile.revision,
        profile.revision
    );
    assert_eq!(std::fs::read_dir(&b.root).unwrap().count(), 0);
}

#[sqlx::test(migrations = "./migrations")]
async fn profile_budget_does_not_block_messages_and_replays_do_not_consume_it(pool: PgPool) {
    let b = Bench::start(pool).await;
    let (alice, uid, token) = b.user("alice").await;
    let first = command(&alice.own_profile().await.unwrap().profile, "first");
    alice.update_profile(&first).await.unwrap();
    for _ in 0..30 {
        alice.update_profile(&first).await.unwrap();
    }
    for n in 1..20 {
        let p = alice.own_profile().await.unwrap().profile;
        alice
            .update_profile(&command(&p, &format!("save-{n}")))
            .await
            .unwrap();
    }
    let p = alice.own_profile().await.unwrap().profile;
    let response = b
        .request(
            Method::PATCH,
            &token,
            "/api/v1/me",
            serde_json::to_value(command(&p, "over-budget")).unwrap(),
        )
        .await;
    assert_eq!(response.status(), StatusCode::TOO_MANY_REQUESTS);
    assert!(response.headers().get("retry-after").is_some());
    let room = alice
        .create_room(&rv_protocol::CreateRoom {
            name: "Room".into(),
            private: true,
            operation_id: Some("room".into()),
        })
        .await
        .unwrap();
    alice
        .send(
            &room.id,
            &rv_protocol::SendMessage {
                cards: Vec::new(),
                operation_id: "send".into(),
                text: "still works".into(),
                reply_to: None,
                quotes: vec![],
            },
        )
        .await
        .unwrap();
    sqlx::query("UPDATE profile_windows SET expires_at=now()-interval '1 second' WHERE user_id=$1")
        .bind(&uid)
        .execute(&b.app.pool)
        .await
        .unwrap();
    b.app.cleanup().await.unwrap();
    // Cooldown is enforced in this client; a fresh transport checks server expiry.
    let mut fresh = NativeClient::new(&b.base).unwrap();
    fresh.restore(token);
    fresh
        .update_profile(&command(&p, "after-expiry"))
        .await
        .unwrap();
}
