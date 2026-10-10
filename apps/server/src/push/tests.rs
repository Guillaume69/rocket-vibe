use super::*;
use crate::store;
use rv_protocol::{CreateRoom, SendMessage, parity::RenewSession};
use sqlx::PgPool;

const PASSWORD: &str = "disposable-push-test-password";
#[sqlx::test]
async fn push_reader_mentions_are_captured_privately_and_never_in_the_shared_message(pool: PgPool) {
    let (app, owner, recipient, _, room) = setup(pool).await;
    let recipient_cursor = crate::sync::snapshot(&app, &recipient)
        .await
        .unwrap()
        .cursor;
    let owner_cursor = crate::sync::snapshot(&app, &owner).await.unwrap().cursor;
    let here = store::send(
        &app,
        &owner,
        &room,
        input("@here offline readers do not gain a ping"),
    )
    .await
    .unwrap();
    assert_eq!(here.personal_mention, None);
    assert_eq!(
        crate::message_actions::read(&app, &recipient, &here.id)
            .await
            .unwrap()
            .personal_mention,
        Some(false)
    );
    let direct = store::send(&app, &owner, &room, input("@push-recipient exact ping"))
        .await
        .unwrap();
    assert_eq!(direct.personal_mention, None);
    for (reader, cursor, mentioned) in [
        (&recipient, &recipient_cursor, true),
        (&owner, &owner_cursor, false),
    ] {
        let batch = crate::sync::changes(&app, reader, cursor, 100)
            .await
            .unwrap();
        assert!(batch.changes.iter().any(|c|matches!(c,rv_protocol::Change::MessageUpsert(m) if m.id==direct.id&&m.personal_mention==Some(mentioned))));
        assert!(batch.changes.iter().any(|c|matches!(c,rv_protocol::Change::MessageUpsert(m) if m.id==here.id&&m.personal_mention==Some(false))));
    }
    assert_eq!(
        crate::message_actions::read(&app, &recipient, &direct.id)
            .await
            .unwrap()
            .personal_mention,
        Some(true)
    );
    assert_eq!(
        crate::message_actions::read(&app, &owner, &direct.id)
            .await
            .unwrap()
            .personal_mention,
        Some(false)
    );
    sqlx::query("DELETE FROM message_mentions WHERE message_id=$1")
        .bind(&direct.id)
        .execute(&app.pool)
        .await
        .unwrap();
    assert_eq!(
        crate::message_actions::read(&app, &recipient, &direct.id)
            .await
            .unwrap()
            .personal_mention,
        Some(false)
    );
}
async fn account(app: &App, name: &str) -> (Account, String) {
    auth::create_user(app, name, PASSWORD.into(), false)
        .await
        .unwrap();
    let s = auth::login(app, name.into(), PASSWORD.into())
        .await
        .unwrap();
    (
        auth::authenticate(app, &auth::hash_token(&s.token))
            .await
            .unwrap(),
        s.token,
    )
}
async fn setup(pool: PgPool) -> (App, Account, Account, String, String) {
    let app = App::from_pool(pool).await.unwrap();
    let (owner, _) = account(&app, "push-owner").await;
    let (recipient, token) = account(&app, "push-recipient").await;
    let room = store::create_room(
        &app,
        &owner,
        CreateRoom {
            name: "Push".into(),
            private: true,
            operation_id: None,
            voice: false,
        },
    )
    .await
    .unwrap();
    store::membership(&app, &owner, &room.id, &recipient.id, false)
        .await
        .unwrap();
    register(
        &app,
        &recipient,
        &recipient.session_hash,
        RegisterPush {
            token: "fixture-fcm-token".into(),
        },
    )
    .await
    .unwrap();
    (app, owner, recipient, token, room.id)
}
fn input(text: &str) -> SendMessage {
    SendMessage {
        operation_id: auth::random_token(),
        text: text.into(),
        reply_to: None,
        quotes: vec![],
        cards: vec![],
        files: vec![],
    }
}

#[sqlx::test]
async fn push_queue_is_atomic_idempotent_and_fenced_across_rotation_reclaim_and_logout(
    pool: PgPool,
) {
    let (app, owner, recipient, token, room) = setup(pool).await;
    let send = input("Private text never sent to FCM");
    // Rollback must also roll back its notification.
    let mut tx = app.pool.begin().await.unwrap();
    store::send_in_tx(&mut tx, &owner, &room, send.clone(), &[], None)
        .await
        .unwrap();
    tx.rollback().await.unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM push_notifications")
            .fetch_one(&app.pool)
            .await
            .unwrap(),
        0
    );
    let message = store::send(&app, &owner, &room, send.clone())
        .await
        .unwrap();
    store::send(&app, &owner, &room, send).await.unwrap();
    let jobs = claim(&app).await.unwrap();
    assert_eq!(jobs.len(), 1);
    let old = jobs.into_iter().next().unwrap();
    assert!(claim(&app).await.unwrap().is_empty());
    let data = payload(&old);
    assert!(data["message"].get("notification").is_none());
    assert_eq!(data["message"]["data"]["messageId"], message.id);
    assert!(!data.to_string().contains(&message.text));
    assert!(!data.to_string().contains(&token));
    sqlx::query("UPDATE push_notifications SET lease_expires_at=now()-interval '1 second'")
        .execute(&app.pool)
        .await
        .unwrap();
    let reclaimed = claim(&app).await.unwrap().pop().unwrap();
    assert_eq!(old.id, reclaimed.id);
    assert_ne!(old.lease_id, reclaimed.lease_id);
    acknowledge(&app, &old, Outcome::InvalidToken)
        .await
        .unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM push_devices")
            .fetch_one(&app.pool)
            .await
            .unwrap(),
        1
    );
    acknowledge(&app, &reclaimed, Outcome::Delivered)
        .await
        .unwrap();
    let fetched = content(&app, &recipient, &recipient.session_hash, &old.id)
        .await
        .unwrap();
    assert_eq!(fetched.message.id, message.id);
    assert_eq!(fetched.message.text, message.text);
    assert_eq!(fetched.message.revision, message.revision);
    // Opaque bearer renewal preserves registration and authenticates content.
    let renewed = crate::sessions::renew(
        &app,
        &recipient.session_hash,
        RenewSession {
            operation_id: auth::random_token(),
            next_token: auth::random_token(),
        },
    )
    .await
    .unwrap();
    let actor = auth::authenticate(&app, &auth::hash_token(&renewed.token))
        .await
        .unwrap();
    assert!(
        content(&app, &actor, &actor.session_hash, &old.id)
            .await
            .is_ok()
    );
    register(
        &app,
        &actor,
        &actor.session_hash,
        RegisterPush {
            token: "rotated-fcm-token".into(),
        },
    )
    .await
    .unwrap();
    assert_eq!(
        content(&app, &actor, &actor.session_hash, &old.id)
            .await
            .unwrap_err()
            .status,
        StatusCode::NOT_FOUND
    );
    acknowledge(&app, &reclaimed, Outcome::InvalidToken)
        .await
        .unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, String>("SELECT token FROM push_devices")
            .fetch_one(&app.pool)
            .await
            .unwrap(),
        "rotated-fcm-token"
    );
    crate::sessions::revoke(&app, &actor, None).await.unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM push_devices")
            .fetch_one(&app.pool)
            .await
            .unwrap(),
        0
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM push_notifications")
            .fetch_one(&app.pool)
            .await
            .unwrap(),
        0
    );
}

#[sqlx::test]
async fn push_respects_mentions_presence_preferences_reads_and_membership_lifetime(pool: PgPool) {
    let (app, owner, recipient, _, room) = setup(pool).await;
    sqlx::query("UPDATE users SET push_mentions_only=true WHERE id=$1")
        .bind(&recipient.id)
        .execute(&app.pool)
        .await
        .unwrap();
    store::send(&app, &owner, &room, input("ordinary message"))
        .await
        .unwrap();
    assert!(claim(&app).await.unwrap().is_empty());
    let mentioned = store::send(&app, &owner, &room, input("@push-recipient hello"))
        .await
        .unwrap();
    let job = claim(&app).await.unwrap().pop().unwrap();
    assert_eq!(job.message_id, mentioned.id);
    let (device, epoch): (String, String) =
        sqlx::query_as("SELECT device_id,data_epoch FROM push_devices")
            .fetch_one(&app.pool)
            .await
            .unwrap();
    sqlx::query("INSERT INTO presence_leases(device_id,user_id,data_epoch,status,expires_at) VALUES($1,$2,$3,'online',now()+interval '1 minute')")
        .bind(&device).bind(&recipient.id).bind(&epoch).execute(&app.pool).await.unwrap();
    assert!(
        content(&app, &recipient, &recipient.session_hash, &job.id)
            .await
            .is_err()
    );
    store::send(&app, &owner, &room, input("@push-recipient while online"))
        .await
        .unwrap();
    sqlx::query("DELETE FROM presence_leases")
        .execute(&app.pool)
        .await
        .unwrap();
    assert!(claim(&app).await.unwrap().is_empty()); // online message never queued
    let read = store::send(&app, &owner, &room, input("@push-recipient now read"))
        .await
        .unwrap();
    let readjob = claim(&app).await.unwrap().pop().unwrap();
    sqlx::query("UPDATE room_read_states SET root_position=$1 WHERE user_id=$2 AND room_id=$3")
        .bind(read.position.parse::<i64>().unwrap())
        .bind(&recipient.id)
        .bind(&room)
        .execute(&app.pool)
        .await
        .unwrap();
    assert!(
        content(&app, &recipient, &recipient.session_hash, &readjob.id)
            .await
            .is_err()
    );
    let later = store::send(&app, &owner, &room, input("@push-recipient after read"))
        .await
        .unwrap();
    let laterjob = claim(&app).await.unwrap().pop().unwrap();
    assert_eq!(laterjob.message_id, later.id);
    store::membership(&app, &owner, &room, &recipient.id, true)
        .await
        .unwrap();
    store::membership(&app, &owner, &room, &recipient.id, false)
        .await
        .unwrap();
    sqlx::query("UPDATE room_read_states SET root_position=0 WHERE user_id=$1")
        .bind(&recipient.id)
        .execute(&app.pool)
        .await
        .unwrap();
    assert!(
        content(&app, &recipient, &recipient.session_hash, &laterjob.id)
            .await
            .is_err()
    );
    sqlx::query("UPDATE users SET push_enabled=false WHERE id=$1")
        .bind(&recipient.id)
        .execute(&app.pool)
        .await
        .unwrap();
    store::send(&app, &owner, &room, input("@push-recipient disabled push"))
        .await
        .unwrap();
    assert!(claim(&app).await.unwrap().is_empty());
}

#[sqlx::test]
async fn push_private_http_guards_device_epoch_deletion_and_response_lease(pool: PgPool) {
    let (app, owner, recipient, token, room) = setup(pool).await;
    let message = store::send(&app, &owner, &room, input("secret"))
        .await
        .unwrap();
    let job = claim(&app).await.unwrap().pop().unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let router = app.clone().router();
    let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    let url = format!("{base}/api/v1/push/notifications/{}", job.id);
    let http = reqwest::Client::new();
    assert_eq!(
        http.get(&url).send().await.unwrap().status(),
        StatusCode::UNAUTHORIZED
    );
    let another = auth::login(&app, recipient.username.clone(), PASSWORD.into())
        .await
        .unwrap();
    assert_eq!(
        http.get(&url)
            .bearer_auth(another.token)
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::NOT_FOUND
    );
    let read = http.get(&url).bearer_auth(&token).send().await.unwrap();
    assert_eq!(read.status(), StatusCode::OK);
    let value: PushContent = read.json().await.unwrap();
    assert_eq!(value.message.id, message.id);
    let mut sdk = rv_client::NativeClient::new(&base).unwrap();
    sdk.restore(token.clone());
    let registration = sdk.register_push("fixture-fcm-token").await.unwrap();
    assert_eq!(registration.device_id, value.device_id);
    assert_eq!(
        sdk.push_content(&job.id).await.unwrap().message.id,
        message.id
    );
    let mut lease = app.pool.begin().await.unwrap();
    lock_content(&mut lease, &recipient.session_hash, &value)
        .await
        .unwrap();
    let delete_pool = app.pool.clone();
    let id = message.id.clone();
    let delete = tokio::spawn(async move {
        sqlx::query("UPDATE messages SET deleted=true,text='',revision=revision+1 WHERE id=$1")
            .bind(id)
            .execute(&delete_pool)
            .await
            .unwrap()
    });
    tokio::time::sleep(Duration::from_millis(30)).await;
    assert!(!delete.is_finished());
    lease.rollback().await.unwrap();
    delete.await.unwrap();
    assert_eq!(
        http.get(&url)
            .bearer_auth(&token)
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::NOT_FOUND
    );
    server.abort();
}

#[tokio::test]
async fn push_fcm_http_v1_only_purges_explicit_unregistered_tokens_and_honors_backoff() {
    let captured = std::sync::Arc::new(std::sync::Mutex::new(Vec::<Value>::new()));
    let sink = captured.clone();
    let router=axum::Router::new().route("/send",axum::routing::post(move |headers:axum::http::HeaderMap,axum::Json(body):axum::Json<Value>| {
        let sink=sink.clone();async move {
            assert_eq!(headers["authorization"],"Bearer fixture-oauth");
            let token=body["message"]["token"].as_str().unwrap().to_owned();sink.lock().unwrap().push(body);
            match token.as_str() {
                "gone" => (StatusCode::NOT_FOUND,axum::Json(json!({"error":{"details":[{"@type":"type.googleapis.com/google.firebase.fcm.v1.FcmError","errorCode":"UNREGISTERED"}]}}))).into_response(),
                "bad-payload" => (StatusCode::BAD_REQUEST,axum::Json(json!({"error":{"status":"INVALID_ARGUMENT"}}))).into_response(),
                "quota" => (StatusCode::TOO_MANY_REQUESTS,[("retry-after","300")],axum::Json(json!({"error":{}}))).into_response(),
                _ => axum::Json(json!({"name":"projects/fixture/messages/1"})).into_response(),
            }
        }
    }));
    use axum::response::IntoResponse;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}/send", listener.local_addr().unwrap());
    let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    let mut job = Lease {
        id: "notif".into(),
        device_id: "device".into(),
        user_id: "user".into(),
        message_id: "msg".into(),
        generation: "gen".into(),
        data_epoch: "epoch".into(),
        instance_id: "instance".into(),
        room_id: "room".into(),
        reply_to: Some("root".into()),
        token: "live".into(),
        lease_id: "lease".into(),
        attempts: 1,
    };
    let http = reqwest::Client::new();
    assert_eq!(
        send_http(&http, &endpoint, "fixture-oauth", &payload(&job)).await,
        Outcome::Delivered
    );
    job.token = "gone".into();
    assert_eq!(
        send_http(&http, &endpoint, "fixture-oauth", &payload(&job)).await,
        Outcome::InvalidToken
    );
    job.token = "bad-payload".into();
    assert_eq!(
        send_http(&http, &endpoint, "fixture-oauth", &payload(&job)).await,
        Outcome::Retired
    );
    job.token = "quota".into();
    assert_eq!(
        send_http(&http, &endpoint, "fixture-oauth", &payload(&job)).await,
        Outcome::Retry(300)
    );
    assert_eq!(
        captured.lock().unwrap()[0]["message"]["data"]["tmid"],
        "root"
    );
    server.abort();
}

#[sqlx::test]
async fn push_workers_share_claims_retry_with_backoff_and_retain_the_last_live_lease(pool: PgPool) {
    let (app, owner, recipient, _, room) = setup(pool).await;
    store::send(&app, &owner, &room, input("retry"))
        .await
        .unwrap();
    let (a, b) = tokio::join!(claim(&app), claim(&app));
    let mut jobs = a.unwrap();
    jobs.extend(b.unwrap());
    assert_eq!(jobs.len(), 1);
    let job = jobs.pop().unwrap();
    acknowledge(&app, &job, Outcome::Retry(300)).await.unwrap();
    let (attempts,delay):(i32,f64)=sqlx::query_as("SELECT attempts,EXTRACT(epoch FROM available_at-now())::float8 FROM push_notifications WHERE id=$1").bind(&job.id).fetch_one(&app.pool).await.unwrap();
    assert_eq!(attempts, 1);
    assert!((299.0..=331.0).contains(&delay));
    assert!(claim(&app).await.unwrap().is_empty());
    sqlx::query("UPDATE push_notifications SET attempts=5,available_at=now()-interval '1 second'")
        .execute(&app.pool)
        .await
        .unwrap();
    let last = claim(&app).await.unwrap().pop().unwrap();
    assert_eq!(last.attempts, 6);
    assert!(claim(&app).await.unwrap().is_empty());
    assert!(
        content(&app, &recipient, &recipient.session_hash, &last.id)
            .await
            .is_ok()
    );
    acknowledge(&app, &last, Outcome::Delivered).await.unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, String>("SELECT state FROM push_notifications WHERE id=$1")
            .bind(&last.id)
            .fetch_one(&app.pool)
            .await
            .unwrap(),
        "delivered"
    );
    store::send(&app, &owner, &room, input("invalid token"))
        .await
        .unwrap();
    let invalid = claim(&app).await.unwrap().pop().unwrap();
    acknowledge(&app, &invalid, Outcome::InvalidToken)
        .await
        .unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM push_devices")
            .fetch_one(&app.pool)
            .await
            .unwrap(),
        0
    );
}

#[sqlx::test]
async fn push_thread_reads_and_direct_mentions_preferences_use_original_message_positions(
    pool: PgPool,
) {
    let (app, owner, recipient, _, room) = setup(pool).await;
    let root = store::send(&app, &owner, &room, input("thread root"))
        .await
        .unwrap();
    let rootjob = claim(&app).await.unwrap().pop().unwrap();
    acknowledge(&app, &rootjob, Outcome::Delivered)
        .await
        .unwrap();
    sqlx::query("UPDATE room_read_states SET root_position=$1 WHERE user_id=$2")
        .bind(root.position.parse::<i64>().unwrap())
        .bind(&recipient.id)
        .execute(&app.pool)
        .await
        .unwrap();
    let reply = store::send(
        &app,
        &owner,
        &room,
        SendMessage {
            reply_to: Some(root.id.clone()),
            ..input("thread reply")
        },
    )
    .await
    .unwrap();
    let job = claim(&app).await.unwrap().pop().unwrap();
    assert_eq!(job.reply_to, Some(root.id.clone()));
    sqlx::query(
        "INSERT INTO thread_read_states(root_id,room_id,user_id,position) VALUES($1,$2,$3,$4)",
    )
    .bind(&root.id)
    .bind(&room)
    .bind(&recipient.id)
    .bind(reply.position.parse::<i64>().unwrap())
    .execute(&app.pool)
    .await
    .unwrap();
    assert!(
        content(&app, &recipient, &recipient.session_hash, &job.id)
            .await
            .is_err()
    );
    sqlx::query("UPDATE users SET push_mentions_only=true WHERE id=$1")
        .bind(&recipient.id)
        .execute(&app.pool)
        .await
        .unwrap();
    let dm = store::direct(&app, &owner, &recipient.id).await.unwrap();
    let sent = store::send(&app, &owner, &dm.id, input("DM without a textual mention"))
        .await
        .unwrap();
    let direct = claim(&app).await.unwrap().pop().unwrap();
    assert_eq!(direct.message_id, sent.id);
    // Restore epochs retire even valid current session / membership descriptors.
    sqlx::query("UPDATE instance SET data_epoch=$1")
        .bind(auth::random_token())
        .execute(&app.pool)
        .await
        .unwrap();
    assert!(
        content(&app, &recipient, &recipient.session_hash, &direct.id)
            .await
            .is_err()
    );
}

#[sqlx::test]
async fn push_skips_quiet_hours_and_a_mute_while_a_delivered_push_stays_readable(pool: PgPool) {
    let (app, owner, recipient, _, room) = setup(pool).await;
    let delivered = store::send(&app, &owner, &room, input("before quiet hours"))
        .await
        .unwrap();
    let job = claim(&app).await.unwrap().pop().unwrap();
    assert_eq!(job.message_id, delivered.id);
    // FCM took it, as the worker records; a push still pending is retired
    // instead once quiet hours begin.
    sqlx::query("UPDATE push_notifications SET state='delivered' WHERE id=$1")
        .bind(&job.id)
        .execute(&app.pool)
        .await
        .unwrap();
    // A window around the server's own UTC clock, wherever it is in the day.
    let minute: i32 = sqlx::query_scalar(
        "SELECT (EXTRACT(HOUR FROM now() AT TIME ZONE 'UTC')*60+EXTRACT(MINUTE FROM now() AT TIME ZONE 'UTC'))::int",
    )
    .fetch_one(&app.pool)
    .await
    .unwrap();
    let quiet = |start: i32, end: i32| {
        sqlx::query("UPDATE users SET quiet_start=$2,quiet_end=$3,quiet_zone='UTC' WHERE id=$1")
            .bind(&recipient.id)
            .bind(start.rem_euclid(1440) as i16)
            .bind(end.rem_euclid(1440) as i16)
    };
    quiet(minute - 30, minute + 30)
        .execute(&app.pool)
        .await
        .unwrap();
    store::send(&app, &owner, &room, input("inside quiet hours"))
        .await
        .unwrap();
    assert!(claim(&app).await.unwrap().is_empty());
    // A reply from a notification already shown reads the same content.
    assert!(
        content(&app, &recipient, &recipient.session_hash, &job.id)
            .await
            .is_ok()
    );
    quiet(minute + 60, minute + 120)
        .execute(&app.pool)
        .await
        .unwrap();
    let outside = store::send(&app, &owner, &room, input("outside quiet hours"))
        .await
        .unwrap();
    assert_eq!(
        claim(&app).await.unwrap().pop().unwrap().message_id,
        outside.id
    );
    sqlx::query("UPDATE users SET quiet_start=NULL,quiet_end=NULL,quiet_zone=NULL,muted_until=now()+interval '1 hour' WHERE id=$1")
        .bind(&recipient.id)
        .execute(&app.pool)
        .await
        .unwrap();
    store::send(&app, &owner, &room, input("while muted"))
        .await
        .unwrap();
    assert!(claim(&app).await.unwrap().is_empty());
    sqlx::query("UPDATE users SET muted_until=now()-interval '1 minute' WHERE id=$1")
        .bind(&recipient.id)
        .execute(&app.pool)
        .await
        .unwrap();
    let after = store::send(&app, &owner, &room, input("after the mute"))
        .await
        .unwrap();
    assert_eq!(
        claim(&app).await.unwrap().pop().unwrap().message_id,
        after.id
    );
}

#[sqlx::test]
async fn quiet_hours_are_validated_kept_when_absent_and_read_back(pool: PgPool) {
    use rv_protocol::profiles::{QuietHours, UpdatePreferences};
    let (app, _, recipient, _, _) = setup(pool).await;
    let command = |revision: String,
                   quiet_hours: Option<Option<QuietHours>>,
                   muted_until: Option<Option<String>>| UpdatePreferences {
        operation_id: auth::random_token(),
        expected_revision: revision,
        language: "auto".into(),
        clock_24h: true,
        push_enabled: true,
        push_mentions_only: false,
        desktop_notifications: Default::default(),
        quiet_hours,
        muted_until,
        share_read_receipts: None,
    };
    let window = |zone: &str, start: u16, end: u16| QuietHours {
        start_minute: start,
        end_minute: end,
        time_zone: zone.into(),
    };
    let revision = || async {
        crate::profiles::own(&app, &recipient)
            .await
            .unwrap()
            .preferences
    };
    for refused in [
        command(
            revision().await.revision,
            Some(Some(window("Mars/Olympus", 1320, 480))),
            None,
        ),
        command(
            revision().await.revision,
            Some(Some(window("Europe/Paris", 600, 600))),
            None,
        ),
        command(
            revision().await.revision,
            Some(Some(window("Europe/Paris", 1440, 0))),
            None,
        ),
        command(
            revision().await.revision,
            None,
            Some(Some("not a time".into())),
        ),
        command(
            revision().await.revision,
            None,
            Some(Some(
                (chrono::Utc::now() + chrono::Duration::days(8)).to_rfc3339(),
            )),
        ),
    ] {
        assert!(
            crate::profiles::preferences(&app, &recipient, refused)
                .await
                .is_err()
        );
    }
    let until = (chrono::Utc::now() + chrono::Duration::hours(1)).to_rfc3339();
    crate::profiles::preferences(
        &app,
        &recipient,
        command(
            revision().await.revision,
            Some(Some(window("Europe/Paris", 1320, 480))),
            Some(Some(until)),
        ),
    )
    .await
    .unwrap();
    let saved = revision().await;
    assert_eq!(saved.quiet_hours, Some(window("Europe/Paris", 1320, 480)));
    assert!(saved.muted_until.is_some());
    // A client that does not know the fields leaves them alone.
    crate::profiles::preferences(
        &app,
        &recipient,
        command(saved.revision.clone(), None, None),
    )
    .await
    .unwrap();
    let kept = revision().await;
    assert_eq!(kept.quiet_hours, saved.quiet_hours);
    assert_eq!(kept.muted_until, saved.muted_until);
    // `null` removes; a past instant is no mute.
    let past = (chrono::Utc::now() - chrono::Duration::minutes(5)).to_rfc3339();
    crate::profiles::preferences(
        &app,
        &recipient,
        command(kept.revision, Some(None), Some(Some(past))),
    )
    .await
    .unwrap();
    let cleared = revision().await;
    assert_eq!((cleared.quiet_hours, cleared.muted_until), (None, None));
}
