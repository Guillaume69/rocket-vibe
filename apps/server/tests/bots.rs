//! Bot accounts (RFC 0003): creation policy, keys, the scope gate, encrypted
//! rooms, the owner's authority and the bot budget.
use rv_client::NativeClient;
use rv_protocol::{
    CreateRoom, SendMessage,
    bots::{BotScope, CreateBot, CreateBotKey, UpdateBot, UpdateInstanceSettings},
};
use rv_server::{App, auth, objects::LocalObjects};
use sqlx::PgPool;

const PASSWORD: &str = "bot-test-password-2026";

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
        let root = std::env::temp_dir().join(format!("rv-bots-{}", auth::random_token()));
        let app = App::from_pool(pool)
            .await
            .unwrap()
            .with_objects(LocalObjects::open(&root).unwrap());
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
            task,
            root,
        }
    }
    async fn user(&self, name: &str, admin: bool) -> (NativeClient, String) {
        let user = auth::create_user(&self.app, name, PASSWORD.into(), admin)
            .await
            .unwrap();
        let mut client = NativeClient::new(&self.base).unwrap();
        client.login(name, PASSWORD).await.unwrap();
        (client, user.id)
    }
    async fn allow_everyone(&self, admin: &NativeClient) {
        let settings = admin
            .update_instance_settings(&UpdateInstanceSettings {
                operation_id: "allow-bots".into(),
                user_bots: Some(true),
            })
            .await
            .unwrap();
        assert!(settings.user_bots);
    }
    /// A bot of `owner` with these scopes, and a client holding a fresh key.
    async fn bot(
        &self,
        owner: &NativeClient,
        name: &str,
        scopes: &[BotScope],
    ) -> (NativeClient, String) {
        let bot = owner.create_bot(&create(name, scopes)).await.unwrap();
        let created = owner
            .create_bot_key(
                &bot.user.id,
                &CreateBotKey {
                    operation_id: format!("key-{name}"),
                    ..key("first")
                },
            )
            .await
            .unwrap();
        let mut client = NativeClient::new(&self.base).unwrap();
        client.with_bot_key(created.key).unwrap();
        (client, bot.user.id)
    }
}
fn create(name: &str, scopes: &[BotScope]) -> CreateBot {
    CreateBot {
        operation_id: format!("create-{name}"),
        username: name.into(),
        display_name: format!("Bot {name}"),
        description: "Says hello".into(),
        scopes: scopes.to_vec(),
    }
}
fn key(label: &str) -> CreateBotKey {
    CreateBotKey {
        operation_id: format!("key-{label}"),
        label: label.into(),
        expires_in_days: None,
    }
}
fn message(text: &str, operation: &str) -> SendMessage {
    SendMessage {
        operation_id: operation.into(),
        text: text.into(),
        reply_to: None,
        quotes: Vec::new(),
        cards: Vec::new(),
        files: Vec::new(),
    }
}
fn code<T: std::fmt::Debug>(result: Result<T, rv_client::Error>, expected: &str) {
    assert!(
        matches!(&result, Err(rv_client::Error::Server { code, .. }) if code == expected),
        "{result:?} is not {expected}"
    );
}
async fn public_room(owner: &NativeClient, name: &str, private: bool) -> String {
    owner
        .create_room(&CreateRoom {
            name: name.into(),
            private,
            operation_id: Some(format!("room-{name}")),
            voice: false,
        })
        .await
        .unwrap()
        .id
}

#[sqlx::test]
async fn people_create_bots_only_when_the_instance_allows_it(pool: PgPool) {
    let bench = Bench::start(pool).await;
    let (admin, _) = bench.user("bot-admin", true).await;
    let (alice, _) = bench.user("bot-alice", false).await;

    assert!(admin.discover().await.unwrap().capabilities.bots);
    assert!(!alice.account_permissions().await.unwrap().create_bot);
    assert!(admin.account_permissions().await.unwrap().create_bot);
    code(
        alice.create_bot(&create("alice-helper", &[])).await,
        "bots_disabled",
    );
    // Administrators always may.
    let own = admin
        .create_bot(&create("admin-helper", &[]))
        .await
        .unwrap();
    assert!(own.user.bot);
    assert_eq!(own.owner.username, "bot-admin");
    // A replay of the same intent is the same bot.
    let again = admin
        .create_bot(&create("admin-helper", &[]))
        .await
        .unwrap();
    assert_eq!(again.user.id, own.user.id);

    code(alice.instance_settings().await, "permission_denied");
    bench.allow_everyone(&admin).await;
    assert!(alice.account_permissions().await.unwrap().create_bot);
    let bot = alice
        .create_bot(&create(
            "alice-helper",
            &[
                BotScope::UsersRead,
                BotScope::RoomsRead,
                BotScope::RoomsRead,
            ],
        ))
        .await
        .unwrap();
    assert_eq!(bot.scopes, vec![BotScope::RoomsRead, BotScope::UsersRead]);
    code(
        alice
            .create_bot(&create("bot-admin", &[]))
            .await
            .map(|_| ()),
        "username_taken",
    );

    // Each sees their own; an administrator sees every bot with `all`.
    assert_eq!(alice.bots(false).await.unwrap().bots.len(), 1);
    assert_eq!(admin.bots(false).await.unwrap().bots.len(), 1);
    assert_eq!(admin.bots(true).await.unwrap().bots.len(), 2);
    // The administrators' user list marks bots.
    let users = admin.admin_users(None, None, Some("helper")).await.unwrap();
    assert!(users.items.iter().all(|u| u.bot) && users.items.len() == 2);
    code(alice.bots(true).await, "permission_denied");
    // Someone else's bot does not exist for alice.
    code(alice.bot_keys(&own.user.id).await, "not_found");
}

#[sqlx::test]
async fn a_key_reaches_only_the_routes_of_its_scopes(pool: PgPool) {
    let bench = Bench::start(pool).await;
    let (admin, _) = bench.user("gate-admin", true).await;
    let (alice, alice_id) = bench.user("gate-alice", false).await;
    bench.allow_everyone(&admin).await;
    let (bot, bot_id) = bench
        .bot(
            &alice,
            "gate-bot",
            &[BotScope::RoomsRead, BotScope::MessagesWrite],
        )
        .await;

    let me = bot.me().await.unwrap();
    assert!(me.bot);
    // The reference the apps show is the table the gate enforces.
    let reference = alice.bot_reference().await.unwrap();
    assert_eq!(reference, bot.bot_reference().await.unwrap());
    let writes = reference
        .groups
        .iter()
        .find(|g| g.scope == Some(BotScope::MessagesWrite))
        .unwrap();
    assert!(
        writes
            .routes
            .iter()
            .any(|r| r.method == "POST" && r.path == "/api/v1/rooms/{room}/messages")
    );
    assert_eq!(me.id, bot_id);
    let room = public_room(&alice, "gate-room", false).await;
    alice.add_member(&room, &bot_id).await.unwrap();
    let sent = bot
        .send(&room, &message("hello", "bot-hello"))
        .await
        .unwrap();
    assert!(sent.author.bot);
    let history = alice.history(&room, None).await.unwrap();
    assert!(
        history
            .messages
            .iter()
            .any(|m| m.id == sent.id && m.author.bot)
    );
    let profile = alice.user_profile(&bot_id).await.unwrap();
    assert!(profile.user.bot);
    let rv_protocol::live::LiveFrame::Live(live) = alice.live_state().await.unwrap();
    let bot_stamp = live
        .profiles
        .iter()
        .find(|stamp| stamp.user.id == bot_id)
        .expect("A room member's profile must be observed");
    assert!(
        bot_stamp.user.bot,
        "Live profile updates must retain bot identity"
    );
    assert!(
        live.profiles
            .iter()
            .any(|stamp| stamp.user.id == alice_id && !stamp.user.bot)
    );
    assert_eq!(profile.bot_owner.unwrap().id, alice_id);
    assert!(
        alice
            .user_profile(&alice_id)
            .await
            .unwrap()
            .bot_owner
            .is_none()
    );

    // A listed route without its scope; routes never open to a key.
    code(bot.direct(&alice_id).await, "bot_scope_missing");
    code(
        bot.create_room(&CreateRoom {
            name: "bot-room".into(),
            private: false,
            operation_id: Some("bot-room".into()),
            voice: false,
        })
        .await,
        "bot_forbidden",
    );
    code(bot.bots(false).await, "bot_forbidden");
    code(bot.device_sessions().await, "bot_forbidden");
    code(
        bot.create_bot(&create("bot-child", &[])).await,
        "bot_forbidden",
    );

    // A scope withdrawn applies to the next request.
    alice
        .update_bot(
            &bot_id,
            &UpdateBot {
                operation_id: "read-only".into(),
                display_name: None,
                description: None,
                scopes: Some(vec![BotScope::RoomsRead]),
            },
        )
        .await
        .unwrap();
    code(
        bot.send(&room, &message("again", "bot-again")).await,
        "bot_scope_missing",
    );
    assert!(bot.rooms().await.unwrap().iter().any(|r| r.id == room));
}

#[sqlx::test]
async fn keys_are_revocable_and_a_bot_never_signs_in(pool: PgPool) {
    let bench = Bench::start(pool).await;
    let (admin, _) = bench.user("key-admin", true).await;
    let (bot, bot_id) = bench.bot(&admin, "key-bot", &[]).await;

    let mut stranger = NativeClient::new(&bench.base).unwrap();
    code(
        stranger.login("key-bot", PASSWORD).await.map(|_| ()),
        "session_rejected",
    );

    // A replayed creation never shows a key twice.
    code(
        admin
            .create_bot_key(
                &bot_id,
                &CreateBotKey {
                    operation_id: "key-key-bot".into(),
                    ..key("first")
                },
            )
            .await,
        "bot_key_replayed",
    );
    let second = admin.create_bot_key(&bot_id, &key("second")).await.unwrap();
    assert_eq!(second.info.hint, second.key[second.key.len() - 4..]);
    let keys = admin.bot_keys(&bot_id).await.unwrap().keys;
    assert_eq!(keys.len(), 2);
    let first = keys.iter().find(|k| k.label == "first").unwrap();
    // The key itself, or one stripped of its prefix, is no person's token.
    let stripped = second.key.trim_start_matches("rvb_").to_owned();
    stranger.restore(stripped);
    code(stranger.me().await, "session_rejected");

    admin.revoke_bot_key(&bot_id, &first.id).await.unwrap();
    admin.revoke_bot_key(&bot_id, &first.id).await.unwrap();
    code(bot.me().await, "session_rejected");
    let mut other = NativeClient::new(&bench.base).unwrap();
    other.with_bot_key(second.key).unwrap();
    assert!(other.me().await.unwrap().bot);

    for label in ["third", "fourth", "fifth", "sixth"] {
        admin.create_bot_key(&bot_id, &key(label)).await.unwrap();
    }
    code(
        admin.create_bot_key(&bot_id, &key("seventh")).await,
        "bot_key_limit",
    );
}

#[sqlx::test]
async fn bots_stay_out_of_encrypted_rooms(pool: PgPool) {
    let bench = Bench::start(pool.clone()).await;
    let (admin, _) = bench.user("crypto-admin", true).await;
    let (_, bot_id) = bench.bot(&admin, "crypto-bot", &[]).await;
    let room = public_room(&admin, "crypto-room", true).await;
    // An MLS group exists for the room: its content is no longer plaintext.
    sqlx::query("INSERT INTO e2ee_groups(room_id,data_epoch,incarnation,revision,epoch,fingerprint,transition,tree,receipt) SELECT $1,data_epoch,'test',1,0,'test','\\x00','\\x00','{}' FROM instance")
        .bind(&room)
        .execute(&pool)
        .await
        .unwrap();
    code(admin.add_member(&room, &bot_id).await, "bot_encrypted_room");
}

#[sqlx::test]
async fn owners_take_their_bots_down(pool: PgPool) {
    let bench = Bench::start(pool.clone()).await;
    let (admin, _) = bench.user("owner-admin", true).await;
    let (alice, alice_id) = bench.user("owner-alice", false).await;
    bench.allow_everyone(&admin).await;
    let (bot, bot_id) = bench.bot(&alice, "owner-bot", &[]).await;
    let (other, other_id) = bench.bot(&alice, "owner-other", &[]).await;

    // Deleting a bot revokes its keys and frees nothing: the name is retired.
    alice.delete_bot(&bot_id).await.unwrap();
    alice.delete_bot(&bot_id).await.unwrap();
    code(bot.me().await, "session_rejected");
    assert_eq!(alice.bots(false).await.unwrap().bots.len(), 1);
    code(
        alice
            .create_bot(&CreateBot {
                operation_id: "recreate".into(),
                ..create("owner-bot", &[])
            })
            .await
            .map(|_| ()),
        "username_taken",
    );

    // An owner deactivated takes the rest down with it.
    assert!(other.me().await.unwrap().bot);
    sqlx::query("UPDATE users SET disabled=true WHERE id=$1")
        .bind(&alice_id)
        .execute(&pool)
        .await
        .unwrap();
    code(other.me().await, "session_rejected");
    let all = admin.bots(true).await.unwrap().bots;
    assert!(all.iter().any(|b| b.user.id == other_id && b.disabled));
}

#[sqlx::test]
async fn a_bot_has_a_send_budget(pool: PgPool) {
    let bench = Bench::start(pool).await;
    let (admin, _) = bench.user("budget-admin", true).await;
    let (bot, bot_id) = bench
        .bot(&admin, "budget-bot", &[BotScope::MessagesWrite])
        .await;
    let room = public_room(&admin, "budget-room", false).await;
    admin.add_member(&room, &bot_id).await.unwrap();
    for n in 0..60 {
        bot.send(&room, &message("tick", &format!("tick-{n}")))
            .await
            .unwrap();
    }
    code(
        bot.send(&room, &message("tick", "tick-60")).await,
        "bot_rate_limited",
    );
    // People keep sending without a budget.
    for n in 0..61 {
        admin
            .send(&room, &message("tock", &format!("tock-{n}")))
            .await
            .unwrap();
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

#[sqlx::test]
async fn owners_name_and_picture_their_bots_and_see_key_use(pool: PgPool) {
    let bench = Bench::start(pool).await;
    let (admin, _) = bench.user("look-admin", true).await;
    let (alice, _) = bench.user("look-alice", false).await;
    let (bot, bot_id) = bench.bot(&admin, "look-bot", &[BotScope::RoomsRead]).await;

    let renamed = admin
        .update_bot(
            &bot_id,
            &UpdateBot {
                operation_id: "rename".into(),
                display_name: Some("  Build robot ".into()),
                description: None,
                scopes: None,
            },
        )
        .await
        .unwrap();
    assert_eq!(renamed.user.display_name, "Build robot");
    assert_eq!(renamed.scopes, vec![BotScope::RoomsRead]);
    assert_eq!(bot.me().await.unwrap().display_name, "Build robot");

    let pictured = admin
        .set_bot_avatar(&bot_id, Some(("image/png", png(40))))
        .await
        .unwrap();
    let file = pictured.avatar_file_id.clone().unwrap();
    assert_eq!(
        admin.user_profile(&bot_id).await.unwrap().avatar_file_id,
        Some(file.clone())
    );
    assert!(!admin.avatar_bytes(&file).await.unwrap().is_empty());
    code(
        admin
            .set_bot_avatar(&bot_id, Some(("image/gif", b"GIF89a".to_vec())))
            .await,
        "invalid_avatar",
    );
    // Someone else's bot does not exist for alice; a key never reaches the route.
    code(
        alice
            .set_bot_avatar(&bot_id, Some(("image/png", png(1))))
            .await,
        "not_found",
    );
    code(bot.set_bot_avatar(&bot_id, None).await, "bot_forbidden");
    let cleared = admin.set_bot_avatar(&bot_id, None).await.unwrap();
    assert_eq!(cleared.avatar_file_id, None);

    // A key's use shows at once, not five minutes later.
    let keys = admin.bot_keys(&bot_id).await.unwrap().keys;
    assert!(keys[0].last_used_at.is_some());
}

async fn admin_revision(admin: &NativeClient, username: &str) -> rv_protocol::admin::AdminUser {
    admin
        .admin_users(None, None, Some(username))
        .await
        .unwrap()
        .items
        .into_iter()
        .find(|u| u.username == username)
        .unwrap()
}

async fn encrypt(pool: &PgPool, room: &str) {
    sqlx::query("INSERT INTO e2ee_groups(room_id,data_epoch,incarnation,revision,epoch,fingerprint,transition,tree,receipt) SELECT $1,data_epoch,'test',1,0,'test','\\x00','\\x00','{}' FROM instance")
        .bind(room)
        .execute(pool)
        .await
        .unwrap();
}

#[sqlx::test]
async fn administrators_oversee_other_bots_but_never_act_as_them(pool: PgPool) {
    let bench = Bench::start(pool).await;
    let (admin, _) = bench.user("watch-admin", true).await;
    let (alice, _) = bench.user("watch-alice", false).await;
    bench.allow_everyone(&admin).await;
    let (bot, bot_id) = bench.bot(&alice, "watch-bot", &[BotScope::RoomsRead]).await;

    // A key, wider scopes or a new face would let an administrator in as the bot.
    code(
        admin.create_bot_key(&bot_id, &key("admin-key")).await,
        "not_found",
    );
    code(
        admin
            .update_bot(
                &bot_id,
                &UpdateBot {
                    operation_id: "widen".into(),
                    display_name: None,
                    description: None,
                    scopes: Some(vec![BotScope::RoomsRead, BotScope::DmWrite]),
                },
            )
            .await,
        "not_found",
    );
    code(
        admin
            .set_bot_avatar(&bot_id, Some(("image/png", png(9))))
            .await,
        "not_found",
    );
    // Looking, revoking and deleting stay theirs.
    let keys = admin.bot_keys(&bot_id).await.unwrap().keys;
    assert_eq!(keys.len(), 1);
    admin.revoke_bot_key(&bot_id, &keys[0].id).await.unwrap();
    code(bot.me().await, "session_rejected");
    admin.delete_bot(&bot_id).await.unwrap();
    assert!(alice.bots(false).await.unwrap().bots.is_empty());
}

#[sqlx::test]
async fn a_bot_is_refused_administration_and_encrypted_rooms_in_every_way(pool: PgPool) {
    let bench = Bench::start(pool.clone()).await;
    let (admin, _) = bench.user("policy-admin", true).await;
    let (_, bot_id) = bench
        .bot(&admin, "policy-bot", &[BotScope::RoomsJoin])
        .await;
    let user = admin_revision(&admin, "policy-bot").await;
    assert!(user.bot);
    code(
        admin
            .update_admin_user(
                &bot_id,
                &rv_protocol::admin::UpdateAdminUser {
                    operation_id: "promote".into(),
                    revision: user.revision.clone(),
                    admin: Some(true),
                    disabled: None,
                },
            )
            .await,
        "bot_privilege",
    );

    // Encrypted while the bot was disabled: it is not re-enabled into it.
    let room = public_room(&admin, "policy-room", true).await;
    admin.add_member(&room, &bot_id).await.unwrap();
    let disabled = admin
        .update_admin_user(
            &bot_id,
            &rv_protocol::admin::UpdateAdminUser {
                operation_id: "disable".into(),
                revision: user.revision,
                admin: None,
                disabled: Some(true),
            },
        )
        .await
        .unwrap();
    encrypt(&pool, &room).await;
    code(
        admin
            .update_admin_user(
                &bot_id,
                &rv_protocol::admin::UpdateAdminUser {
                    operation_id: "enable".into(),
                    revision: disabled.revision,
                    admin: None,
                    disabled: Some(false),
                },
            )
            .await,
        "bot_encrypted_room",
    );

    // Nor does a bot join an encrypted public room by itself.
    let (joiner, _) = bench
        .bot(&admin, "policy-joiner", &[BotScope::RoomsJoin])
        .await;
    let public = public_room(&admin, "policy-public", false).await;
    encrypt(&pool, &public).await;
    code(joiner.join_public(&public).await, "bot_encrypted_room");
}

#[sqlx::test]
async fn a_bot_never_holds_a_person_session_even_with_a_password(pool: PgPool) {
    let bench = Bench::start(pool.clone()).await;
    let (admin, _) = bench.user("pw-admin", true).await;
    let (_, bot_id) = bench.bot(&admin, "pw-bot", &[]).await;
    // Give the bot the very hash of a known password.
    let hash: String =
        sqlx::query_scalar("SELECT password_hash FROM users WHERE username='pw-admin'")
            .fetch_one(&pool)
            .await
            .unwrap();
    sqlx::query("UPDATE users SET password_hash=$2 WHERE id=$1")
        .bind(&bot_id)
        .bind(hash)
        .execute(&pool)
        .await
        .unwrap();
    let mut stranger = NativeClient::new(&bench.base).unwrap();
    code(
        stranger.login("pw-bot", PASSWORD).await.map(|_| ()),
        "session_rejected",
    );
    assert!(
        rv_server::recovery::issue(&bench.app, "pw-bot", 1)
            .await
            .is_err()
    );
    // The database refuses a session that is not one of its keys.
    sqlx::query("INSERT INTO session_devices(id,user_id) VALUES('forged-device',$1)")
        .bind(&bot_id)
        .execute(&pool)
        .await
        .unwrap();
    let forged = sqlx::query("INSERT INTO sessions(token_hash,user_id,expires_at,device_id) VALUES('forged',$1,now()+interval '1 day','forged-device')")
        .bind(&bot_id)
        .execute(&pool)
        .await;
    assert!(forged.is_err());
}

#[sqlx::test]
async fn creation_keys_and_budgets_have_their_limits(pool: PgPool) {
    let bench = Bench::start(pool.clone()).await;
    let (admin, _) = bench.user("limit-admin", true).await;
    for n in 0..10 {
        admin
            .create_bot(&create(&format!("limit-{n}"), &[]))
            .await
            .unwrap();
    }
    code(
        admin.create_bot(&create("limit-10", &[])).await,
        "bot_limit",
    );
    // Deleting frees a live slot, not the day's budget: names are not retired at will.
    let first = admin.bots(false).await.unwrap().bots[0].user.id.clone();
    admin.delete_bot(&first).await.unwrap();
    code(
        admin.create_bot(&create("limit-11", &[])).await,
        "bot_create_limit",
    );
    sqlx::query("UPDATE bots SET created_at=created_at-interval '2 days'")
        .execute(&pool)
        .await
        .unwrap();
    for bot in admin.bots(false).await.unwrap().bots {
        admin.delete_bot(&bot.user.id).await.unwrap();
    }
    sqlx::query("UPDATE bots SET created_at=created_at-interval '2 days'")
        .execute(&pool)
        .await
        .unwrap();

    // A disabled bot gets no key.
    let (_, quiet_id) = bench.bot(&admin, "limit-quiet", &[]).await;
    sqlx::query("UPDATE users SET disabled=true WHERE id=$1")
        .bind(&quiet_id)
        .execute(&pool)
        .await
        .unwrap();
    code(
        admin
            .create_bot_key(
                &quiet_id,
                &CreateBotKey {
                    operation_id: "late".into(),
                    ..key("late")
                },
            )
            .await,
        "bot_disabled",
    );

    // Only new conversations spend the direct budget; replays never spend sends.
    let (_, alice_id) = bench.user("limit-alice", false).await;
    let (dm, _) = bench
        .bot(
            &admin,
            "limit-dm",
            &[BotScope::DmWrite, BotScope::MessagesWrite],
        )
        .await;
    for _ in 0..12 {
        dm.direct(&alice_id).await.unwrap();
    }
    let room = dm.direct(&alice_id).await.unwrap().id;
    for _ in 0..61 {
        dm.send(&room, &message("same", "same-op")).await.unwrap();
    }
    for n in 0..10 {
        let (_, id) = bench.user(&format!("limit-p{n}"), false).await;
        if n < 9 {
            dm.direct(&id).await.unwrap();
        } else {
            code(dm.direct(&id).await, "bot_rate_limited");
        }
    }
}

#[sqlx::test]
async fn each_scope_opens_its_routes_and_profiles_stay_the_owners(pool: PgPool) {
    let bench = Bench::start(pool).await;
    let (admin, admin_id) = bench.user("scope-admin", true).await;
    let (bot, _) = bench
        .bot(
            &admin,
            "scope-bot",
            &[
                BotScope::RoomsJoin,
                BotScope::UsersRead,
                BotScope::ReactionsWrite,
                BotScope::MessagesWrite,
            ],
        )
        .await;
    let room = public_room(&admin, "scope-room", false).await;
    bot.join_public(&room).await.unwrap();
    assert!(bot.users().await.unwrap().iter().any(|u| u.id == admin_id));
    let sent = bot
        .send(&room, &message("react", "react-to"))
        .await
        .unwrap();
    bot.set_reaction(
        &sent.id,
        &rv_protocol::parity::SetReaction {
            operation_id: "react-1".into(),
            emoji: ":+1:".into(),
            present: true,
        },
    )
    .await
    .unwrap();
    // Its profile is read-only to its keys.
    let own = bot.own_profile().await.unwrap();
    code(
        bot.update_profile(&rv_protocol::profiles::UpdateProfile {
            operation_id: "rename".into(),
            expected_revision: own.profile.revision,
            username: "scope-impostor".into(),
            display_name: "Impostor".into(),
            bio: String::new(),
            status: own.profile.status,
            status_text: String::new(),
        })
        .await,
        "bot_forbidden",
    );
    // The operator switch is the same setting.
    rv_server::bots::set_user_bots(&bench.app, false)
        .await
        .unwrap();
    assert!(!admin.instance_settings().await.unwrap().user_bots);
}

#[sqlx::test]
async fn an_open_socket_closes_when_the_bot_loses_rooms_read(pool: PgPool) {
    use futures_util::StreamExt;
    let bench = Bench::start(pool).await;
    let (admin, _) = bench.user("socket-admin", true).await;
    let (bot, bot_id) = bench
        .bot(&admin, "socket-bot", &[BotScope::RoomsRead])
        .await;
    let cursor = bot.snapshot().await.unwrap().cursor;
    let url = bot.socket_url(&cursor).await.unwrap();
    let (mut socket, _) = tokio_tungstenite::connect_async(url.as_str())
        .await
        .unwrap();
    admin
        .update_bot(
            &bot_id,
            &UpdateBot {
                operation_id: "mute".into(),
                display_name: None,
                description: None,
                scopes: Some(Vec::new()),
            },
        )
        .await
        .unwrap();
    let closed = tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            match socket.next().await {
                None
                | Some(Err(_))
                | Some(Ok(tokio_tungstenite::tungstenite::Message::Close(_))) => break,
                Some(Ok(_)) => continue,
            }
        }
    })
    .await;
    assert!(closed.is_ok(), "the socket outlived the scope");
}
