//! The Rocket.Chat import against a source built here, in the shapes Rocket.Chat
//! 8.5 stores (docs/protocol/IMPORT.md). Needs a MongoDB: RV_IMPORT_TEST_MONGO
//! (CI's `verify` job); without it the test says so and passes.
use futures_util::AsyncWriteExt;
use mongodb::{
    Client, Database,
    bson::{Bson, DateTime as BsonTime, Document, doc},
    options::GridFsBucketOptions,
};
use rv_client::NativeClient;
use rv_server::{App, auth::random_token, import, objects::LocalObjects};
use serde_json::Value;
use sha2::{Digest, Sha256};
use sqlx::PgPool;

const ALICE: &str = "aliceRocketChat01";
const BOB: &str = "bobRocketChat0001";
const JEAN: &str = "jeanRocketChat001";
const PUBLIC: &str = "roomPublicRC00001";
const PRIVATE: &str = "roomPrivateRC0001";
const DIRECT: &str = "aliceRocketChat01bobRocketChat0001";
const BOT_DIRECT: &str = "aliceRocketChat01rocket.cat";
const ENCRYPTED: &str = "roomCryptRC000001";

fn at(minute: i64) -> BsonTime {
    BsonTime::from_millis(1_780_000_000_000 + minute * 60_000)
}
fn meteor(password: &str) -> String {
    let digest: String = Sha256::digest(password.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    bcrypt::hash(digest, 4).unwrap()
}
fn png() -> Vec<u8> {
    let mut bytes = std::io::Cursor::new(Vec::new());
    image::RgbaImage::from_pixel(16, 16, image::Rgba([255, 95, 162, 255]))
        .write_to(&mut bytes, image::ImageFormat::Png)
        .unwrap();
    bytes.into_inner()
}
async fn put(db: &Database, bucket: &str, id: Option<&str>, name: &str, bytes: &[u8]) {
    let bucket = db.gridfs_bucket(
        GridFsBucketOptions::builder()
            .bucket_name(bucket.to_owned())
            .build(),
    );
    let mut stream = match id {
        Some(id) => bucket
            .open_upload_stream(name)
            .id(Bson::String(id.into()))
            .await
            .unwrap(),
        None => bucket.open_upload_stream(name).await.unwrap(),
    };
    stream.write_all(bytes).await.unwrap();
    stream.close().await.unwrap();
}
async fn insert(db: &Database, collection: &str, docs: Vec<Document>) {
    db.collection::<Document>(collection)
        .insert_many(docs)
        .await
        .unwrap();
}
fn user(id: &str, name: &str) -> Document {
    doc! { "_id": id, "username": name, "u": { "_id": id, "username": name } }
}
fn author(id: &str, name: &str) -> Document {
    user(id, name).get_document("u").unwrap().clone()
}

/// A small Rocket.Chat instance holding one case of every mapping rule.
async fn source(db: &Database) {
    insert(db, "users", vec![
        doc! { "_id": ALICE, "username": "alice", "name": "Alice", "active": true, "type": "user", "roles": ["user"], "createdAt": at(0),
               "services": { "password": { "bcrypt": meteor("alice-pass-2026") }, "email2fa": { "enabled": true } } },
        doc! { "_id": BOB, "username": "bob", "name": "Bob", "active": true, "type": "user", "roles": ["admin"], "createdAt": at(1),
               "services": { "password": { "bcrypt": meteor("bob-pass-2026") }, "totp": { "enabled": true } } },
        doc! { "_id": JEAN, "username": "jean.dupont", "name": "Jean", "active": true, "type": "user", "roles": ["user"], "createdAt": at(2),
               "services": { "password": { "bcrypt": meteor("jean-pass-2026") } } },
        doc! { "_id": "rocket.cat", "username": "rocket.cat", "name": "Rocket.Cat", "active": true, "type": "bot", "createdAt": at(0) },
    ]).await;
    insert(db, "rocketchat_room", vec![
        doc! { "_id": PUBLIC, "t": "c", "name": "general", "topic": "Hello", "u": author(BOB, "bob") },
        doc! { "_id": PRIVATE, "t": "p", "name": "secret", "u": author(ALICE, "alice") },
        doc! { "_id": DIRECT, "t": "d", "uids": [ALICE, BOB], "usernames": ["alice", "bob"] },
        doc! { "_id": BOT_DIRECT, "t": "d", "uids": [ALICE, "rocket.cat"] },
        doc! { "_id": ENCRYPTED, "t": "p", "name": "crypt", "encrypted": true, "u": author(ALICE, "alice") },
    ]).await;
    let sub = |rid: &str, uid: &str, name: &str, roles: Vec<&str>, extra: Document| {
        let mut sub = doc! { "_id": random_token()[..17].to_owned(), "rid": rid, "u": author(uid, name), "roles": roles, "unread": 0 };
        sub.extend(extra);
        sub
    };
    insert(
        db,
        "rocketchat_subscription",
        vec![
            sub(
                PUBLIC,
                ALICE,
                "alice",
                vec![],
                doc! { "f": true, "unread": 3, "ls": at(12) },
            ),
            sub(PUBLIC, BOB, "bob", vec!["owner"], doc! {}),
            sub(
                PUBLIC,
                JEAN,
                "jean.dupont",
                vec!["moderator", "leader"],
                doc! {},
            ),
            sub(PRIVATE, ALICE, "alice", vec![], doc! {}),
            sub(PRIVATE, JEAN, "jean.dupont", vec![], doc! {}),
            sub(DIRECT, ALICE, "alice", vec![], doc! {}),
            sub(DIRECT, BOB, "bob", vec![], doc! {}),
            sub(ENCRYPTED, ALICE, "alice", vec!["owner"], doc! {}),
        ],
    )
    .await;
    let message = |id: &str,
                   rid: &str,
                   minute: i64,
                   by: (&str, &str),
                   msg: &str,
                   extra: Document| {
        let mut m =
            doc! { "_id": id, "rid": rid, "ts": at(minute), "u": author(by.0, by.1), "msg": msg };
        m.extend(extra);
        m
    };
    let (alice, bob, jean) = ((ALICE, "alice"), (BOB, "bob"), (JEAN, "jean.dupont"));
    insert(db, "rocketchat_message", vec![
        message("msgRocketChat0001", PUBLIC, 10, bob, "hello **world**", doc! {
            "reactions": { ":+1:": { "usernames": ["alice", "bob"] }, ":nope_nope:": { "usernames": ["alice"] } },
            "starred": [{ "_id": ALICE }], "pinned": true }),
        message("msgRocketChat0002", PUBLIC, 11, alice, "thread root", doc! {}),
        message("msgRocketChat0003", PUBLIC, 12, jean, "in the thread", doc! { "tmid": "msgRocketChat0002" }),
        message("msgRocketChat0004", PUBLIC, 13, alice, "[ ](https://chat.example/channel/general?msg=msgRocketChat0001) cites", doc! {}),
        message("msgRocketChat0005", PUBLIC, 14, jean, "@alice see the file", doc! {
            "file": { "_id": "fileRocketChat001", "name": "notes.txt", "type": "text/plain" },
            "files": [{ "_id": "fileRocketChat001", "name": "notes.txt", "type": "text/plain" }],
            "attachments": [{ "type": "file", "title": "notes.txt" }, { "text": "a bot card" }] }),
        message("msgRocketChat0006", PUBLIC, 15, jean, "", doc! { "t": "uj" }),
        message("msgRocketChat0007", PUBLIC, 16, bob, "", doc! { "t": "message_pinned" }),
        message("msgRocketChat0008", ENCRYPTED, 17, alice, "ciphertext", doc! { "t": "e2e" }),
        message("msgRocketChat0009", DIRECT, 18, alice, "hi bob (edited)", doc! { "editedAt": at(19) }),
        message("msgRocketChat0010", BOT_DIRECT, 20, ("rocket.cat", "rocket.cat"), "Update available", doc! {}),
    ]).await;
    insert(db, "rocketchat_uploads", vec![doc! {
        "_id": "fileRocketChat001", "name": "notes.txt", "type": "text/plain", "size": 6, "store": "GridFS:Uploads",
        "rid": PUBLIC, "userId": JEAN,
    }]).await;
    put(
        db,
        "rocketchat_uploads",
        Some("fileRocketChat001"),
        "fileRocketChat001",
        b"notes\n",
    )
    .await;
    insert(db, "rocketchat_custom_emoji", vec![doc! { "_id": "emojiRocketChat01", "name": "party", "aliases": ["parrot", "partytime"], "extension": "png" }]).await;
    put(db, "custom_emoji", None, "party.png", &png()).await;
    insert(db, "rocketchat_avatars", vec![doc! { "_id": "avatarRocketChat1", "userId": ALICE, "type": "image/png", "store": "GridFS:Avatars" }]).await;
    put(
        db,
        "rocketchat_avatars",
        Some("avatarRocketChat1"),
        "avatarRocketChat1",
        &png(),
    )
    .await;
}

fn omitted(report: &Value, kind: &str, reason: &str) -> i64 {
    report["omissions"]
        .as_array()
        .unwrap()
        .iter()
        .find(|o| o["kind"] == kind && o["reason"] == reason)
        .map_or(0, |o| o["count"].as_i64().unwrap())
}

#[sqlx::test]
async fn a_rocket_chat_instance_imports_once_and_resumes_without_duplicates(pool: PgPool) {
    let Ok(mongo) = std::env::var("RV_IMPORT_TEST_MONGO") else {
        eprintln!("RV_IMPORT_TEST_MONGO unset: the Rocket.Chat import test needs a MongoDB");
        return;
    };
    let name = format!("rc_import_{}", &random_token()[..12]);
    let client = Client::with_uri_str(&mongo).await.unwrap();
    let db = client.database(&name);
    source(&db).await;
    let objects = std::env::temp_dir().join(format!("rv-import-{}", &random_token()[..12]));
    std::fs::create_dir_all(&objects).unwrap();
    let app = App::from_pool(pool.clone())
        .await
        .unwrap()
        .with_objects(LocalObjects::open(&objects).unwrap());
    let options = || import::Options {
        mongo_url: format!("{}/{name}", mongo.trim_end_matches('/')),
        files_dir: None,
    };

    let report = import::rocketchat(&app, options()).await.unwrap();
    assert_eq!(report["phase"], "done");
    let imported = &report["imported"];
    assert_eq!(
        (imported["user"].as_i64(), imported["room"].as_i64()),
        (Some(4), Some(3))
    );
    assert_eq!(
        (
            imported["message"].as_i64(),
            imported["file"].as_i64(),
            imported["emoji"].as_i64()
        ),
        (Some(7), Some(1), Some(1))
    );
    for (kind, reason, count) in [
        ("room", "encrypted_room", 1),
        ("room", "bot_direct_room", 1),
        ("room", "owner_assigned", 1),
        ("message", "room_skipped", 2),
        ("message", "system_message_pinned", 1),
        ("message", "attachment_dropped", 1),
        ("reaction", "unknown_emoji", 1),
        ("user", "renamed", 2),
        ("user", "second_factor_dropped", 1),
        ("emoji", "alias_dropped", 1),
    ] {
        assert_eq!(omitted(&report, kind, reason), count, "{kind} {reason}");
    }

    // Accounts: names made native, the admin kept, the bot disabled, a photo.
    let users: Vec<(String, bool, bool, bool)> = sqlx::query_as(
        "SELECT username,admin,disabled,avatar_file_id IS NOT NULL FROM users ORDER BY username",
    )
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(
        users,
        [
            ("alice".into(), false, false, true),
            ("bob".into(), true, false, false),
            ("jean_dupont".into(), false, false, false),
            ("rocket_cat".into(), false, true, false),
        ]
    );
    // Rooms and roles: the creator owns the room nobody owned; leader is no role.
    let roles: Vec<(String, String, String)> = sqlx::query_as(
        "SELECT r.name,u.username,m.role FROM members m JOIN rooms r ON r.id=m.room_id JOIN users u ON u.id=m.user_id ORDER BY 1,2",
    )
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(
        roles,
        [
            ("alice / bob".into(), "alice".into(), "member".into()),
            ("alice / bob".into(), "bob".into(), "member".into()),
            ("general".into(), "alice".into(), "member".into()),
            ("general".into(), "bob".into(), "owner".into()),
            ("general".into(), "jean_dupont".into(), "moderator".into()),
            ("secret".into(), "alice".into(), "owner".into()),
            ("secret".into(), "jean_dupont".into(), "member".into()),
        ]
    );
    // History: time order, thread, quote, edit, pin, stars, reactions, file, mention.
    let position = |id: &str| {
        let pool = pool.clone();
        let id = id.to_owned();
        async move {
            sqlx::query_scalar::<_, i64>("SELECT position FROM messages WHERE id=$1")
                .bind(id)
                .fetch_one(&pool)
                .await
                .unwrap()
        }
    };
    assert!(position("msgRocketChat0001").await < position("msgRocketChat0003").await);
    let (reply_to, quotes, text): (Option<String>, Value, String) = sqlx::query_as(
        "SELECT (SELECT reply_to FROM messages WHERE id='msgRocketChat0003'),quote_references,text FROM messages WHERE id='msgRocketChat0004'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(reply_to.as_deref(), Some("msgRocketChat0002"));
    assert_eq!(
        (quotes[0]["message_id"].as_str(), text.as_str()),
        (Some("msgRocketChat0001"), "cites")
    );
    let marks: (bool, i64, i64, bool) = sqlx::query_as(
        "SELECT pinned,(SELECT COUNT(*) FROM message_stars WHERE message_id=m.id AND present),(SELECT COUNT(*) FROM message_reactions WHERE message_id=m.id AND emoji='thumbsup'),(SELECT edited_at IS NOT NULL FROM messages WHERE id='msgRocketChat0009') FROM messages m WHERE id='msgRocketChat0001'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(marks, (true, 1, 2, true));
    let file: (String, i64, String) = sqlx::query_as(
        "SELECT state,bytes,media_type FROM uploads WHERE message_id='msgRocketChat0005'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(file, ("completed".into(), 6, "text/plain".into()));
    let mention: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM message_mentions WHERE message_id='msgRocketChat0005' AND user_id=$1)",
    )
    .bind(ALICE)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(mention);
    // Alice read up to her last seen message and kept her favorite; Bob read it all.
    let reads: Vec<(String, i64, bool)> = sqlx::query_as(
        "SELECT user_id,root_position,favorite FROM room_read_states WHERE room_id=$1 ORDER BY user_id",
    )
    .bind(PUBLIC)
    .fetch_all(&pool)
    .await
    .unwrap();
    let alice_read = reads.iter().find(|r| r.0 == ALICE).unwrap();
    assert_eq!(
        (alice_read.1, alice_read.2),
        (position("msgRocketChat0003").await, true)
    );
    let bob_read = reads.iter().find(|r| r.0 == BOB).unwrap();
    assert_eq!(bob_read.1, position("msgRocketChat0006").await);

    // A rerun resumes nothing and adds nothing.
    let again = import::rocketchat(&app, options()).await.unwrap();
    assert_eq!(again["imported"], report["imported"]);
    let messages: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM messages")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(messages, 7);

    // Alice signs in with her Rocket.Chat password; it becomes a native hash.
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let router = app.clone().router();
    let server = tokio::spawn(async move {
        axum::serve(
            listener,
            router.into_make_service_with_connect_info::<std::net::SocketAddr>(),
        )
        .await
        .unwrap();
    });
    let mut native = NativeClient::new(&base).unwrap();
    assert!(native.login("alice", "wrong-pass-2026").await.is_err());
    native.login("alice", "alice-pass-2026").await.unwrap();
    let legacy: Option<String> =
        sqlx::query_scalar("SELECT legacy_password FROM users WHERE id=$1")
            .bind(ALICE)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert!(legacy.is_none());
    NativeClient::new(&base)
        .unwrap()
        .login("alice", "alice-pass-2026")
        .await
        .unwrap();
    server.abort();
    db.drop().await.unwrap();
    let _ = std::fs::remove_dir_all(objects);
}
