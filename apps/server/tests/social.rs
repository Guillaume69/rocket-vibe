use rv_client::NativeClient;
use rv_protocol::{CreateRoom, social::*};
use sqlx::PgPool;
use vibez::{App, auth};
struct Bench {
    app: App,
    base: String,
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
        Self::from_app(app).await
    }
    async fn from_app(app: App) -> Self {
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
        Self { app, base, task }
    }
    async fn user(&self, name: &str) -> (NativeClient, String) {
        let user = auth::create_user(&self.app, name, "social-test-password-2026".into(), false)
            .await
            .unwrap();
        let mut client = NativeClient::new(&self.base).unwrap();
        client
            .login(name, "social-test-password-2026")
            .await
            .unwrap();
        (client, user.id)
    }
    async fn room(&self, client: &NativeClient) -> String {
        client
            .create_room(&CreateRoom {
                name: "Social room".into(),
                private: true,
                operation_id: Some("social-room".into()),
                voice: false,
            })
            .await
            .unwrap()
            .id
    }
}
fn code(result: Result<(), rv_client::Error>, expected: &str) {
    assert!(
        matches!(&result, Err(rv_client::Error::Server { code, .. }) if code == expected),
        "{result:?} is not {expected}"
    );
}
#[sqlx::test]
async fn polls_votes_retries_and_close_are_authoritative(pool: PgPool) {
    let b = Bench::start(pool).await;
    let (owner, uid) = b.user("social-owner").await;
    let (alice, aid) = b.user("social-alice").await;
    let (outsider, _) = b.user("social-outsider").await;
    let room = b.room(&owner).await;
    owner
        .run_command(&rv_protocol::commands::RunCommand {
            room_id: room.clone(),
            command: "invite".into(),
            params: "social-alice".into(),
        })
        .await
        .unwrap();
    let p = CreateSocial::Poll {
        operation_id: "social-poll".into(),
        question: "What game?".into(),
        options: vec!["Co-op".into(), "Racing".into()],
        multiple: false,
        closes_at: None,
        reply_to: None,
    };
    owner.create_social(&room, &p).await.unwrap();
    owner.create_social(&room, &p).await.unwrap();
    assert_eq!(
        owner
            .history(&room, None)
            .await
            .unwrap()
            .messages
            .iter()
            .filter(|m| m.id == "social-poll")
            .count(),
        1
    );
    owner
        .answer_social(
            "social-poll",
            &AnswerSocial {
                operation_id: "vote-owner".into(),
                choices: vec![0],
            },
        )
        .await
        .unwrap();
    alice
        .answer_social(
            "social-poll",
            &AnswerSocial {
                operation_id: "vote-alice".into(),
                choices: vec![1],
            },
        )
        .await
        .unwrap();
    code(
        alice
            .answer_social(
                "social-poll",
                &AnswerSocial {
                    operation_id: "invalid-multi".into(),
                    choices: vec![0, 1],
                },
            )
            .await,
        "invalid_request",
    );
    assert!(
        outsider
            .answer_social(
                "social-poll",
                &AnswerSocial {
                    operation_id: "outsider-vote".into(),
                    choices: vec![0]
                }
            )
            .await
            .is_err()
    );
    let message = owner.message("social-poll").await.unwrap();
    match *message.social.unwrap() {
        SocialCard::Poll { options, .. } => {
            assert_eq!(options[0].voters, vec![uid]);
            assert_eq!(options[1].voters, vec![aid]);
        }
        _ => panic!("not a poll"),
    }
    alice
        .answer_social(
            "social-poll",
            &AnswerSocial {
                operation_id: "clear-alice".into(),
                choices: vec![],
            },
        )
        .await
        .unwrap();
    // A late retry of the earlier vote must not overwrite the newer clear.
    alice
        .answer_social(
            "social-poll",
            &AnswerSocial {
                operation_id: "vote-alice".into(),
                choices: vec![1],
            },
        )
        .await
        .unwrap();
    match *owner.message("social-poll").await.unwrap().social.unwrap() {
        SocialCard::Poll { options, .. } => assert!(options[1].voters.is_empty()),
        _ => panic!(),
    }
    code(
        alice
            .close_poll(
                "social-poll",
                &ClosePoll {
                    operation_id: "not-owner-close".into(),
                },
            )
            .await,
        "permission_denied",
    );
    owner
        .close_poll(
            "social-poll",
            &ClosePoll {
                operation_id: "owner-close".into(),
            },
        )
        .await
        .unwrap();
    code(
        alice
            .answer_social(
                "social-poll",
                &AnswerSocial {
                    operation_id: "vote-after-close".into(),
                    choices: vec![1],
                },
            )
            .await,
        "poll_closed",
    );
    let changed = CreateSocial::Poll {
        operation_id: "social-poll".into(),
        question: "Different?".into(),
        options: vec!["One".into(), "Two".into()],
        multiple: false,
        closes_at: None,
        reply_to: None,
    };
    code(
        owner.create_social(&room, &changed).await,
        "operation_conflict",
    );
}
#[sqlx::test]
async fn game_nights_and_private_shelves_round_trip(pool: PgPool) {
    let b = Bench::start(pool).await;
    let (owner, uid) = b.user("shelf-owner").await;
    let (alice, _) = b.user("shelf-alice").await;
    let room = b.room(&owner).await;
    let game = CreateSocial::GameNight {
        operation_id: "night-1".into(),
        title: "Friday co-op".into(),
        starts_at: (chrono::Utc::now() + chrono::Duration::days(1)).to_rfc3339(),
        description: "Bring a controller".into(),
        reply_to: None,
    };
    owner.create_social(&room, &game).await.unwrap();
    owner
        .answer_social(
            "night-1",
            &AnswerSocial {
                operation_id: "rsvp-1".into(),
                choices: vec![0],
            },
        )
        .await
        .unwrap();
    match *owner.message("night-1").await.unwrap().social.unwrap() {
        SocialCard::GameNight { going, maybe, .. } => {
            assert_eq!(going, vec![uid]);
            assert!(maybe.is_empty())
        }
        _ => panic!(),
    }
    let sticker = SaveSticker {
        operation_id: "sticker-1".into(),
        name: "Wave".into(),
        url: "https://media.giphy.com/wave.gif".into(),
    };
    owner.save_sticker(&sticker).await.unwrap();
    owner.save_sticker(&sticker).await.unwrap();
    assert_eq!(owner.stickers().await.unwrap().stickers.len(), 1);
    assert!(alice.stickers().await.unwrap().stickers.is_empty());
    alice.remove_sticker("sticker-1").await.unwrap();
    assert_eq!(owner.stickers().await.unwrap().stickers.len(), 1);
    let unsafe_sticker = SaveSticker {
        operation_id: "unsafe-sticker".into(),
        name: "Private".into(),
        url: "https://chat.example/file?rc_token=secret".into(),
    };
    code(owner.save_sticker(&unsafe_sticker).await, "invalid_request");
    let image = SendImage {
        operation_id: "sticker-message".into(),
        title: "Wave".into(),
        url: sticker.url,
        reply_to: Some("night-1".into()),
    };
    owner.send_image(&room, &image).await.unwrap();
    owner.send_image(&room, &image).await.unwrap();
    let m = owner.message("sticker-message").await.unwrap();
    assert_eq!(m.reply_to, Some("night-1".into()));
    assert!(matches!(*m.social.unwrap(), SocialCard::Image { .. }));
    let caps = owner.discover().await.unwrap().capabilities;
    assert!(caps.social_cards && caps.sticker_shelf);
    assert!(!caps.giphy);
    assert!(owner.gifs("cats", false).await.is_err());
    owner.remove_sticker("sticker-1").await.unwrap();
    assert!(owner.stickers().await.unwrap().stickers.is_empty());
}

#[sqlx::test]
async fn voice_reactions_require_live_participation_and_expire(pool: PgPool) {
    let _ = tracing_subscriber::fmt()
        .with_max_level(tracing::Level::ERROR)
        .try_init();
    use vibez::livekit::LiveKit;
    let livekit=LiveKit::parse(br#"{"url":"ws://127.0.0.1:7880","api_url":"http://127.0.0.1:7880","api_key":"test-key","api_secret":"test-livekit-secret-with-32-characters"}"#).unwrap();
    let app = App::from_pool(pool)
        .await
        .unwrap()
        .with_livekit(Some(livekit));
    let b = Bench::from_app(app).await;
    let (owner, uid) = b.user("voice-social-owner").await;
    let (reader, reader_id) = b.user("voice-social-reader").await;
    let room = b.room(&owner).await;
    owner
        .run_command(&rv_protocol::commands::RunCommand {
            room_id: room.clone(),
            command: "invite".into(),
            params: "voice-social-reader".into(),
        })
        .await
        .unwrap();
    let reaction = ReactVoice {
        operation_id: "voice-burst-1".into(),
        emoji: "👏".into(),
    };
    code(
        owner.react_voice(&room, &reaction).await,
        "permission_denied",
    );
    sqlx::query("INSERT INTO voice_sessions(user_id,room_id,data_epoch,state,expires_at) SELECT $1,$2,data_epoch,'joining',clock_timestamp()+interval '1 minute' FROM instance WHERE singleton").bind(&uid).bind(&room).execute(&b.app.pool).await.unwrap();
    code(
        owner.react_voice(&room, &reaction).await,
        "permission_denied",
    );
    sqlx::query("UPDATE voice_sessions SET state='connected' WHERE user_id=$1")
        .bind(&uid)
        .execute(&b.app.pool)
        .await
        .unwrap();
    owner.react_voice(&room, &reaction).await.unwrap();
    owner.react_voice(&room, &reaction).await.unwrap();
    let rv_protocol::live::LiveFrame::Live(state) = reader.live_state().await.unwrap();
    assert!(
        state.voice_reactions.is_empty(),
        "Room members outside voice must not receive bursts"
    );
    sqlx::query("INSERT INTO voice_sessions(user_id,room_id,data_epoch,state,expires_at) SELECT $1,$2,data_epoch,'connected',clock_timestamp()+interval '1 minute' FROM instance WHERE singleton").bind(&reader_id).bind(&room).execute(&b.app.pool).await.unwrap();
    let rv_protocol::live::LiveFrame::Live(state) = reader.live_state().await.unwrap();
    assert_eq!(state.voice_reactions.len(), 1);
    assert_eq!(state.voice_reactions[0].emoji, "👏");
    code(
        owner
            .react_voice(
                &room,
                &ReactVoice {
                    operation_id: "voice-burst-2".into(),
                    emoji: "😂".into(),
                },
            )
            .await,
        "voice_reaction_rate",
    );
    sqlx::query("UPDATE voice_reactions SET expires_at=clock_timestamp()-interval '1 second'")
        .execute(&b.app.pool)
        .await
        .unwrap();
    let rv_protocol::live::LiveFrame::Live(state) = reader.live_state().await.unwrap();
    assert!(state.voice_reactions.is_empty());
    sqlx::query("UPDATE voice_sessions SET data_epoch='old-epoch' WHERE user_id=$1")
        .bind(uid)
        .execute(&b.app.pool)
        .await
        .unwrap();
    code(
        owner
            .react_voice(
                &room,
                &ReactVoice {
                    operation_id: "old-epoch-burst".into(),
                    emoji: "🎉".into(),
                },
            )
            .await,
        "permission_denied",
    );
}
#[sqlx::test]
async fn configured_giphy_is_advertised_without_exposing_the_key(pool: PgPool) {
    let g =
        vibez::giphy::Giphy::parse(br#"{"api_key":"disposable-test-key","rating":"pg"}"#).unwrap();
    let b = Bench::from_app(App::from_pool(pool).await.unwrap().with_giphy(Some(g))).await;
    let (owner, _) = b.user("configured-giphy").await;
    let discovery = owner.discover().await.unwrap();
    assert!(discovery.capabilities.giphy);
    assert!(
        !serde_json::to_string(&discovery)
            .unwrap()
            .contains("disposable-test-key")
    );
    assert!(
        owner
            .commands()
            .await
            .unwrap()
            .commands
            .iter()
            .any(|c| c.command == "giphy")
    );
}
