//! Workflows (RFC 0004): definitions, triggers, the engine's steps and forms,
//! driven by calling the engine's tick directly.
use rv_client::NativeClient;
use rv_protocol::{
    CreateRoom, SendMessage,
    bots::{BotScope, CreateBot, CreateBotKey, UpdateInstanceSettings},
    commands::RunCommand,
    parity::SetReaction,
    workflows::{
        AnswerForm, CreateWorkflow, Every, FormAnswer, FormField, FormFieldKind, FormRecipient,
        HttpMethod, RunState, Step, Trigger, UpdateWorkflow,
    },
};
use rv_server::{App, auth};
use sqlx::PgPool;

const PASSWORD: &str = "workflow-test-password-2026";

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
    async fn start(pool: PgPool, private_http: bool) -> Self {
        let app = App::from_pool(pool)
            .await
            .unwrap()
            .with_private_http(private_http);
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
    async fn user(&self, name: &str, admin: bool) -> (NativeClient, String) {
        let user = auth::create_user(&self.app, name, PASSWORD.into(), admin)
            .await
            .unwrap();
        let mut client = NativeClient::new(&self.base).unwrap();
        client.login(name, PASSWORD).await.unwrap();
        (client, user.id)
    }
    /// A bot of `owner` with these scopes, member of `room`.
    async fn bot(
        &self,
        owner: &NativeClient,
        name: &str,
        scopes: &[BotScope],
        room: &str,
    ) -> String {
        let bot = owner
            .create_bot(&CreateBot {
                operation_id: format!("bot-{name}"),
                username: name.into(),
                display_name: name.into(),
                description: String::new(),
                scopes: scopes.to_vec(),
            })
            .await
            .unwrap();
        owner.add_member(room, &bot.user.id).await.unwrap();
        bot.user.id
    }
    /// Ticks the engine until nothing is due.
    async fn drain(&self) {
        for _ in 0..5 {
            rv_server::workflows::engine::drain(&self.app)
                .await
                .unwrap();
        }
    }
}

async fn room(owner: &NativeClient, name: &str, private: bool) -> String {
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

fn message(room: &str, text: &str) -> Step {
    Step::Message {
        room: room.into(),
        text: text.into(),
        cards: Vec::new(),
        in_thread: false,
        save_as: None,
    }
}

fn workflow(name: &str, bot: &str, trigger: Trigger, steps: Vec<Step>) -> CreateWorkflow {
    CreateWorkflow {
        operation_id: format!("wf-{name}"),
        name: name.into(),
        description: String::new(),
        bot_id: bot.into(),
        trigger,
        steps,
        enabled: true,
    }
}

fn code<T: std::fmt::Debug>(result: Result<T, rv_client::Error>, expected: &str) {
    assert!(
        matches!(&result, Err(rv_client::Error::Server { code, .. }) if code == expected),
        "{result:?} is not {expected}"
    );
}

async fn texts(client: &NativeClient, room: &str) -> Vec<String> {
    let mut page = client.history(room, None).await.unwrap().messages;
    page.reverse();
    page.into_iter()
        .filter(|m| m.system.is_none())
        .map(|m| m.text)
        .collect()
}

async fn run_command(
    client: &NativeClient,
    room: &str,
    command: &str,
    params: &str,
) -> Result<(), rv_client::Error> {
    client
        .run_command(&RunCommand {
            room_id: room.into(),
            command: command.into(),
            params: params.into(),
        })
        .await
}

#[sqlx::test]
async fn definitions_are_checked_when_saved(pool: PgPool) {
    let bench = Bench::start(pool, false).await;
    let (admin, _) = bench.user("def-admin", true).await;
    let (alice, _) = bench.user("def-alice", false).await;
    let general = room(&admin, "def-general", false).await;
    let bot = bench
        .bot(&admin, "def-bot", &[BotScope::MessagesWrite], &general)
        .await;
    let reader = bench.bot(&admin, "def-reader", &[], &general).await;
    let away = room(&admin, "def-away", false).await;

    assert!(admin.discover().await.unwrap().capabilities.workflows);
    // Who may create one is who may create a bot.
    code(
        alice
            .create_workflow(&workflow(
                "a",
                &bot,
                Trigger::Command { name: "a".into() },
                vec![message(&general, "x")],
            ))
            .await,
        "bots_disabled",
    );
    admin
        .update_instance_settings(&UpdateInstanceSettings {
            operation_id: "allow".into(),
            user_bots: Some(true),
        })
        .await
        .unwrap();
    // Never someone else's bot.
    code(
        alice
            .create_workflow(&workflow(
                "b",
                &bot,
                Trigger::Command { name: "b".into() },
                vec![message(&general, "x")],
            ))
            .await,
        "workflow_bot",
    );
    code(
        admin
            .create_workflow(&workflow(
                "c",
                &reader,
                Trigger::Command { name: "c".into() },
                vec![message(&general, "x")],
            ))
            .await,
        "bot_scope_missing",
    );
    code(
        admin
            .create_workflow(&workflow(
                "d",
                &bot,
                Trigger::Command { name: "d".into() },
                vec![message(&away, "x")],
            ))
            .await,
        "workflow_bot_not_member",
    );
    code(
        admin
            .create_workflow(&workflow(
                "e",
                &bot,
                Trigger::Command {
                    name: "topic".into(),
                },
                vec![message(&general, "x")],
            ))
            .await,
        "workflow_command",
    );
    code(
        admin
            .create_workflow(&workflow(
                "f",
                &bot,
                Trigger::Webhook {},
                vec![message("trigger", "x")],
            ))
            .await,
        "workflow_room",
    );
    admin
        .create_workflow(&workflow(
            "g",
            &bot,
            Trigger::Command {
                name: "hello".into(),
            },
            vec![message(&general, "x")],
        ))
        .await
        .unwrap();
    code(
        admin
            .create_workflow(&workflow(
                "h",
                &bot,
                Trigger::Command {
                    name: "hello".into(),
                },
                vec![message(&general, "x")],
            ))
            .await,
        "workflow_command_taken",
    );
    // The engine's key of the bot is never one of its keys.
    assert!(admin.bot_keys(&bot).await.unwrap().keys.is_empty());
    admin
        .create_bot_key(
            &bot,
            &CreateBotKey {
                operation_id: "k".into(),
                label: "k".into(),
                expires_in_days: None,
            },
        )
        .await
        .unwrap();
    assert_eq!(admin.bot_keys(&bot).await.unwrap().keys.len(), 1);
}

#[sqlx::test]
async fn a_command_runs_its_steps_as_the_bot(pool: PgPool) {
    let bench = Bench::start(pool, false).await;
    let (admin, _) = bench.user("cmd-admin", true).await;
    let (bob, bob_id) = bench.user("cmd-bob", false).await;
    let general = room(&admin, "cmd-general", false).await;
    admin.add_member(&general, &bob_id).await.unwrap();
    let bot = bench
        .bot(&admin, "cmd-bot", &[BotScope::MessagesWrite], &general)
        .await;
    admin
        .create_workflow(&workflow(
            "greet",
            &bot,
            Trigger::Command {
                name: "greet".into(),
            },
            vec![message(
                "trigger",
                "Hi {{trigger.user.username}}: {{trigger.text}}",
            )],
        ))
        .await
        .unwrap();

    let offered = bob.room_commands(&general).await.unwrap().commands;
    assert!(
        offered
            .iter()
            .any(|c| c.command == "greet" && c.description == "greet")
    );
    assert!(
        !bob.commands()
            .await
            .unwrap()
            .commands
            .iter()
            .any(|c| c.command == "greet")
    );
    run_command(&bob, &general, "greet", "how are you")
        .await
        .unwrap();
    bench.drain().await;
    let history = bob.history(&general, None).await.unwrap().messages;
    let posted = history
        .iter()
        .find(|m| m.text == "Hi cmd-bob: how are you")
        .unwrap();
    assert!(posted.author.bot);

    // Nowhere the bot is not.
    let elsewhere = room(&admin, "cmd-elsewhere", false).await;
    code(
        run_command(&admin, &elsewhere, "greet", "").await,
        "workflow_unavailable",
    );
    code(
        run_command(&admin, &general, "nothing", "").await,
        "unknown_command",
    );
}

#[sqlx::test]
async fn a_wait_resumes_later_and_a_replayed_step_never_posts_twice(pool: PgPool) {
    let bench = Bench::start(pool.clone(), false).await;
    let (admin, _) = bench.user("wait-admin", true).await;
    let general = room(&admin, "wait-general", false).await;
    let bot = bench
        .bot(&admin, "wait-bot", &[BotScope::MessagesWrite], &general)
        .await;
    let flow = admin
        .create_workflow(&workflow(
            "later",
            &bot,
            Trigger::Command {
                name: "later".into(),
            },
            vec![
                message("trigger", "first {{now}}"),
                Step::Wait { seconds: 3600 },
                message("trigger", "second"),
            ],
        ))
        .await
        .unwrap();
    // Each attempt sees a new {{now}}: only the first word is stable.
    let words = |all: Vec<String>| -> Vec<String> {
        all.into_iter()
            .map(|t| t.split(' ').next().unwrap_or_default().to_owned())
            .collect()
    };
    run_command(&admin, &general, "later", "").await.unwrap();
    bench.drain().await;
    assert_eq!(words(texts(&admin, &general).await), vec!["first"]);
    let runs = admin.workflow_runs(&flow.id).await.unwrap().runs;
    assert_eq!(runs[0].state, RunState::Waiting);

    // A crash after the first post: the step comes again, with the same operation.
    sqlx::query("UPDATE workflow_runs SET step=0,state='pending',wake_at=now()")
        .execute(&pool)
        .await
        .unwrap();
    bench.drain().await;
    assert_eq!(words(texts(&admin, &general).await), vec!["first"]);
    assert_eq!(
        admin.workflow_runs(&flow.id).await.unwrap().runs[0].state,
        RunState::Waiting
    );
    // The hour has passed.
    sqlx::query("UPDATE workflow_runs SET wake_at=now()")
        .execute(&pool)
        .await
        .unwrap();
    bench.drain().await;
    assert_eq!(
        words(texts(&admin, &general).await),
        vec!["first", "second"]
    );
    assert_eq!(
        admin.workflow_runs(&flow.id).await.unwrap().runs[0].state,
        RunState::Done
    );
}

#[sqlx::test]
async fn a_webhook_starts_a_run_with_its_body(pool: PgPool) {
    let bench = Bench::start(pool, false).await;
    let (admin, _) = bench.user("hook-admin", true).await;
    let general = room(&admin, "hook-general", false).await;
    let bot = bench
        .bot(&admin, "hook-bot", &[BotScope::MessagesWrite], &general)
        .await;
    let flow = admin
        .create_workflow(&workflow(
            "orders",
            &bot,
            Trigger::Webhook {},
            vec![message(
                &general,
                "Order {{webhook.order.id}} by {{webhook.order.who}}",
            )],
        ))
        .await
        .unwrap();
    let secret = admin.workflow_webhook(&flow.id).await.unwrap();
    let http = reqwest::Client::new();
    let sent = http
        .post(format!("{}{}", bench.base, secret.path))
        .body(r#"{"order":{"id":42,"who":"Ada"}}"#)
        .send()
        .await
        .unwrap();
    assert_eq!(sent.status(), 202);
    let wrong = http
        .post(format!(
            "{}/api/v1/hooks/{}/{}",
            bench.base,
            flow.id,
            "0".repeat(64)
        ))
        .body("{}")
        .send()
        .await
        .unwrap();
    assert_eq!(wrong.status(), 404);
    bench.drain().await;
    assert_eq!(texts(&admin, &general).await, vec!["Order 42 by Ada"]);
    // A rotated secret replaces the old one.
    let current = admin.workflow_webhook(&flow.id).await.unwrap();
    let old = http
        .post(format!("{}{}", bench.base, secret.path))
        .body("{}")
        .send()
        .await
        .unwrap();
    assert_eq!(old.status(), 404);

    // Moved to a command and back, the workflow needs a new secret.
    let edit = |trigger: Trigger, revision: String, op: &str| UpdateWorkflow {
        operation_id: op.into(),
        revision,
        name: flow.name.clone(),
        description: String::new(),
        bot_id: bot.clone(),
        trigger,
        steps: flow.steps.clone(),
        enabled: true,
    };
    let moved = admin
        .update_workflow(
            &flow.id,
            &edit(
                Trigger::Command {
                    name: "orders".into(),
                },
                admin.workflow(&flow.id).await.unwrap().revision,
                "to-command",
            ),
        )
        .await;
    // A webhook-only step room ("trigger" is not used here): the move is valid.
    let moved = moved.unwrap();
    let back = admin
        .update_workflow(
            &flow.id,
            &edit(Trigger::Webhook {}, moved.revision, "to-hook"),
        )
        .await
        .unwrap();
    assert!(!back.has_webhook);
    let revived = http
        .post(format!("{}{}", bench.base, current.path))
        .body("{}")
        .send()
        .await
        .unwrap();
    assert_eq!(revived.status(), 404);
}

#[sqlx::test]
async fn an_http_step_saves_the_answer_and_private_addresses_are_refused(pool: PgPool) {
    // A tiny service on loopback, reachable only when private HTTP is allowed.
    let service = axum::Router::new().route(
        "/item",
        axum::routing::post(|body: String| async move {
            axum::Json(serde_json::json!({"name": "tea", "echo": body}))
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base_url = format!("http://{}", listener.local_addr().unwrap());
    let service_url = format!("{base_url}/item");
    let server = tokio::spawn(async move { axum::serve(listener, service).await.unwrap() });

    for private in [true, false] {
        let bench = Bench::start(pool.clone(), private).await;
        let name = if private { "http-on" } else { "http-off" };
        let (admin, _) = bench.user(&format!("{name}-admin"), true).await;
        let general = room(&admin, &format!("{name}-general"), false).await;
        let bot = bench
            .bot(
                &admin,
                &format!("{name}-bot"),
                &[BotScope::MessagesWrite],
                &general,
            )
            .await;
        let flow = admin
            .create_workflow(&workflow(
                name,
                &bot,
                Trigger::Command { name: name.into() },
                vec![
                    Step::Http {
                        method: HttpMethod::Post,
                        url: service_url.clone(),
                        headers: Vec::new(),
                        body: Some("{{trigger.text}}".into()),
                        save_as: Some("item".into()),
                        continue_on_error: false,
                    },
                    message(
                        "trigger",
                        "{{item.status}} {{item.body.name}} {{item.body.echo}}",
                    ),
                ],
            ))
            .await
            .unwrap();
        run_command(&admin, &general, name, "milk").await.unwrap();
        bench.drain().await;
        let runs = admin.workflow_runs(&flow.id).await.unwrap().runs;
        if private {
            assert_eq!(texts(&admin, &general).await, vec!["200 tea milk"]);
            assert_eq!(runs[0].state, RunState::Done);
        } else {
            assert!(texts(&admin, &general).await.is_empty());
            assert_eq!(runs[0].state, RunState::Failed);
            assert_eq!(runs[0].error.as_deref(), Some("http_address"));
        }
        if !private {
            // On the web's ports a private address is refused for what it is, and
            // any other port is refused whatever the address.
            for (n, url) in ["http://127.0.0.1/item", "https://example.com:8443/item"]
                .into_iter()
                .enumerate()
            {
                let command = format!("closed-{n}");
                let flow = admin
                    .create_workflow(&workflow(
                        &command,
                        &bot,
                        Trigger::Command {
                            name: command.clone(),
                        },
                        vec![Step::Http {
                            method: HttpMethod::Get,
                            url: url.into(),
                            headers: Vec::new(),
                            body: None,
                            save_as: None,
                            continue_on_error: false,
                        }],
                    ))
                    .await
                    .unwrap();
                run_command(&admin, &general, &command, "").await.unwrap();
                bench.drain().await;
                let run = &admin.workflow_runs(&flow.id).await.unwrap().runs[0];
                assert_eq!(run.error.as_deref(), Some("http_address"), "{url}");
            }
            continue;
        }
        // A 404 fails the run, unless the step carries on with what it got.
        for carry_on in [true, false] {
            let command = format!("missing-{carry_on}");
            let flow = admin
                .create_workflow(&workflow(
                    &command,
                    &bot,
                    Trigger::Command {
                        name: command.clone(),
                    },
                    vec![
                        Step::Http {
                            method: HttpMethod::Get,
                            url: format!("{base_url}/missing"),
                            headers: Vec::new(),
                            body: None,
                            save_as: Some("miss".into()),
                            continue_on_error: carry_on,
                        },
                        message("trigger", "after {{miss.status}}"),
                    ],
                ))
                .await
                .unwrap();
            run_command(&admin, &general, &command, "").await.unwrap();
            bench.drain().await;
            let run = &admin.workflow_runs(&flow.id).await.unwrap().runs[0];
            if carry_on {
                assert_eq!(run.state, RunState::Done);
                assert!(
                    texts(&admin, &general)
                        .await
                        .contains(&"after 404".to_owned())
                );
            } else {
                assert_eq!(run.state, RunState::Failed);
                assert_eq!(run.error.as_deref(), Some("http_failed"));
            }
        }
    }
    server.abort();
}

#[sqlx::test]
async fn a_form_waits_for_its_answer(pool: PgPool) {
    let bench = Bench::start(pool, false).await;
    let (admin, _) = bench.user("form-admin", true).await;
    let (bob, bob_id) = bench.user("form-bob", false).await;
    let (carol, carol_id) = bench.user("form-carol", false).await;
    let general = room(&admin, "form-general", false).await;
    admin.add_member(&general, &bob_id).await.unwrap();
    admin.add_member(&general, &carol_id).await.unwrap();
    let bot = bench
        .bot(&admin, "form-bot", &[BotScope::MessagesWrite], &general)
        .await;
    admin
        .create_workflow(&workflow(
            "leave",
            &bot,
            Trigger::Command {
                name: "leave-request".into(),
            },
            vec![
                Step::Form {
                    room: "trigger".into(),
                    recipient: FormRecipient::TriggerUser,
                    title: "Leave request".into(),
                    fields: vec![
                        FormField {
                            id: "days".into(),
                            label: "Days".into(),
                            kind: FormFieldKind::Number,
                            options: Vec::new(),
                            people: Vec::new(),
                            multiple: false,
                            required: true,
                        },
                        FormField {
                            id: "kind".into(),
                            label: "Kind".into(),
                            kind: FormFieldKind::Choice,
                            options: vec!["paid".into(), "unpaid".into()],
                            people: Vec::new(),
                            multiple: false,
                            required: true,
                        },
                    ],
                    save_as: "leave".into(),
                },
                message(
                    "trigger",
                    "{{leave.by.username}}: {{leave.answers.days}} {{leave.answers.kind}} days",
                ),
            ],
        ))
        .await
        .unwrap();
    run_command(&bob, &general, "leave-request", "")
        .await
        .unwrap();
    bench.drain().await;
    let history = bob.history(&general, None).await.unwrap().messages;
    let posted = history.iter().find(|m| m.form.is_some()).unwrap();
    let form = posted.form.as_ref().unwrap();
    assert_eq!(form.title, "Leave request");
    assert_eq!(form.recipient.as_ref().unwrap().id, bob_id);
    assert!(form.answered_by.is_none());

    let answer = |days: &str, kind: &str, op: &str| AnswerForm {
        operation_id: op.into(),
        answers: [
            ("days".to_owned(), days.into()),
            ("kind".to_owned(), kind.into()),
        ]
        .into_iter()
        .collect(),
    };
    code(
        carol
            .answer_form(&posted.id, &answer("2", "paid", "c1"))
            .await,
        "permission_denied",
    );
    code(
        bob.answer_form(&posted.id, &answer("two", "paid", "b0"))
            .await,
        "form_value",
    );
    code(
        bob.answer_form(&posted.id, &answer("2", "sabbatical", "b0"))
            .await,
        "form_value",
    );
    bob.answer_form(&posted.id, &answer("2", "paid", "b1"))
        .await
        .unwrap();
    bob.answer_form(&posted.id, &answer("2", "paid", "b1"))
        .await
        .unwrap();
    code(
        bob.answer_form(&posted.id, &answer("3", "paid", "b2"))
            .await,
        "form_answered",
    );
    bench.drain().await;
    let history = bob.history(&general, None).await.unwrap().messages;
    let answered = history.iter().find(|m| m.id == posted.id).unwrap();
    assert_eq!(
        answered
            .form
            .as_ref()
            .unwrap()
            .answered_by
            .as_ref()
            .unwrap()
            .id,
        bob_id
    );
    assert!(history.iter().any(|m| m.text == "form-bob: 2 paid days"));
}

#[sqlx::test]
async fn joins_and_schedules_start_runs(pool: PgPool) {
    let bench = Bench::start(pool.clone(), false).await;
    let (admin, _) = bench.user("join-admin", true).await;
    let (bob, _) = bench.user("join-bob", false).await;
    let general = room(&admin, "join-general", false).await;
    let bot = bench
        .bot(&admin, "join-bot", &[BotScope::MessagesWrite], &general)
        .await;
    admin
        .create_workflow(&workflow(
            "welcome",
            &bot,
            Trigger::MemberJoined {
                room: general.clone(),
            },
            vec![message("trigger", "Welcome {{trigger.user.username}}")],
        ))
        .await
        .unwrap();
    // A bot added later is nobody's arrival.
    bench
        .bot(&admin, "join-late", &[BotScope::MessagesWrite], &general)
        .await;
    bob.join_public(&general).await.unwrap();
    bench.drain().await;
    assert_eq!(texts(&admin, &general).await, vec!["Welcome join-bob"]);
    let welcome = admin
        .workflows(false)
        .await
        .unwrap()
        .workflows
        .into_iter()
        .find(|w| w.name == "welcome")
        .unwrap();
    // Turned off, it can still be tried: the run names its room and me.
    admin.disable_workflow(&welcome.id).await.unwrap();
    admin.test_workflow(&welcome.id).await.unwrap();
    bench.drain().await;
    assert!(
        texts(&admin, &general)
            .await
            .contains(&"Welcome join-admin".to_owned())
    );

    let flow = admin
        .create_workflow(&workflow(
            "daily",
            &bot,
            Trigger::Schedule {
                every: Every::Day,
                time: "09:00".into(),
                days: Vec::new(),
                timezone: "Europe/Paris".into(),
                room: general.clone(),
            },
            vec![message("trigger", "Standup in {{trigger.room.name}}")],
        ))
        .await
        .unwrap();
    assert!(flow.next_fire_at.is_some());
    sqlx::query("UPDATE workflows SET next_fire_at=now()-interval '1 second' WHERE id=$1")
        .bind(&flow.id)
        .execute(&pool)
        .await
        .unwrap();
    bench.drain().await;
    assert!(
        texts(&admin, &general)
            .await
            .contains(&"Standup in join-general".to_owned())
    );
    let moved = admin.workflow(&flow.id).await.unwrap();
    assert!(
        chrono::DateTime::parse_from_rfc3339(moved.next_fire_at.as_deref().unwrap()).unwrap()
            > chrono::Utc::now()
    );
}

#[sqlx::test]
async fn owners_edit_administrators_oversee_and_disabling_cancels_runs(pool: PgPool) {
    let bench = Bench::start(pool, false).await;
    let (admin, _) = bench.user("own-admin", true).await;
    let (alice, _) = bench.user("own-alice", false).await;
    admin
        .update_instance_settings(&UpdateInstanceSettings {
            operation_id: "allow".into(),
            user_bots: Some(true),
        })
        .await
        .unwrap();
    let general = room(&alice, "own-general", false).await;
    let bot = bench
        .bot(&alice, "own-bot", &[BotScope::MessagesWrite], &general)
        .await;
    let flow = alice
        .create_workflow(&workflow(
            "slow",
            &bot,
            Trigger::Command {
                name: "slow".into(),
            },
            vec![Step::Wait { seconds: 3600 }, message("trigger", "late")],
        ))
        .await
        .unwrap();
    run_command(&alice, &general, "slow", "").await.unwrap();
    bench.drain().await;
    assert_eq!(
        alice.workflow_runs(&flow.id).await.unwrap().runs[0].state,
        RunState::Waiting
    );

    // An administrator sees and stops it, never edits it.
    assert!(
        admin
            .workflows(true)
            .await
            .unwrap()
            .workflows
            .iter()
            .any(|w| w.id == flow.id)
    );
    code(
        admin
            .update_workflow(
                &flow.id,
                &UpdateWorkflow {
                    operation_id: "edit".into(),
                    revision: flow.revision.clone(),
                    name: "mine".into(),
                    description: String::new(),
                    bot_id: bot.clone(),
                    trigger: flow.trigger.clone(),
                    steps: flow.steps.clone(),
                    enabled: true,
                },
            )
            .await,
        "not_found",
    );
    let stopped = admin.disable_workflow(&flow.id).await.unwrap();
    assert!(!stopped.enabled);
    code(alice.test_workflow(&flow.id).await, "workflow_test_command");
    assert_eq!(
        alice.workflow_runs(&flow.id).await.unwrap().runs[0].state,
        RunState::Cancelled
    );
    code(
        run_command(&alice, &general, "slow", "").await,
        "unknown_command",
    );

    // The owner edits at the expected revision only.
    code(
        alice
            .update_workflow(
                &flow.id,
                &UpdateWorkflow {
                    operation_id: "stale".into(),
                    revision: flow.revision.clone(),
                    name: "slow".into(),
                    description: String::new(),
                    bot_id: bot.clone(),
                    trigger: flow.trigger.clone(),
                    steps: flow.steps.clone(),
                    enabled: true,
                },
            )
            .await,
        "revision_conflict",
    );
    alice.delete_workflow(&flow.id).await.unwrap();
    assert!(alice.workflows(false).await.unwrap().workflows.is_empty());
}

fn said(text: &str, operation: &str) -> SendMessage {
    SendMessage {
        operation_id: operation.into(),
        text: text.into(),
        reply_to: None,
        quotes: Vec::new(),
        cards: Vec::new(),
        files: Vec::new(),
    }
}

fn react(emoji: &str, operation: &str, present: bool) -> SetReaction {
    SetReaction {
        operation_id: operation.into(),
        emoji: emoji.into(),
        present,
    }
}

async fn run_count(pool: &PgPool) -> i64 {
    sqlx::query_scalar("SELECT count(*) FROM workflow_runs")
        .fetch_one(pool)
        .await
        .unwrap()
}

#[sqlx::test]
async fn reactions_and_matching_messages_start_runs_for_people_only(pool: PgPool) {
    let bench = Bench::start(pool.clone(), false).await;
    let (admin, _) = bench.user("watch-admin", true).await;
    let (bob, _) = bench.user("watch-bob", false).await;
    let general = room(&admin, "watch-general", false).await;
    bob.join_public(&general).await.unwrap();
    let writer = bench
        .bot(&admin, "watch-writer", &[BotScope::MessagesWrite], &general)
        .await;
    let reader = bench
        .bot(
            &admin,
            "watch-reader",
            &[BotScope::RoomsRead, BotScope::MessagesWrite],
            &general,
        )
        .await;
    let posted = |contains: &str| Trigger::MessagePosted {
        room: general.clone(),
        contains: contains.into(),
    };
    // Watching what is said in a room is reading it.
    code(
        admin
            .create_workflow(&workflow(
                "blind",
                &writer,
                posted("deploy"),
                vec![message("trigger", "x")],
            ))
            .await,
        "bot_scope_missing",
    );
    code(
        admin
            .create_workflow(&workflow(
                "empty",
                &reader,
                posted("  "),
                vec![message("trigger", "x")],
            ))
            .await,
        "workflow_match",
    );
    code(
        admin
            .create_workflow(&workflow(
                "odd",
                &reader,
                Trigger::ReactionAdded {
                    room: general.clone(),
                    emoji: Some("not-an-emoji-at-all".into()),
                },
                vec![message("trigger", "x")],
            ))
            .await,
        "workflow_emoji",
    );

    // The bot's own answer says "deploy" too: it never starts another run.
    let mut noted = message(
        "trigger",
        "{{trigger.user.username}} said {{trigger.message.text}}, deploy noted",
    );
    if let Step::Message { in_thread, .. } = &mut noted {
        *in_thread = true;
    }
    admin
        .create_workflow(&workflow("deploys", &reader, posted("Deploy"), vec![noted]))
        .await
        .unwrap();
    let said_it = bob
        .send(&general, &said("We DEPLOY today", "watch-1"))
        .await
        .unwrap();
    bob.send(&general, &said("nothing to see", "watch-2"))
        .await
        .unwrap();
    bench.drain().await;
    assert_eq!(run_count(&pool).await, 1);
    let replies: Vec<String> = sqlx::query_scalar("SELECT text FROM messages WHERE reply_to=$1")
        .bind(&said_it.id)
        .fetch_all(&pool)
        .await
        .unwrap();
    assert_eq!(
        replies,
        vec!["watch-bob said We DEPLOY today, deploy noted"]
    );
    assert_eq!(run_count(&pool).await, 1);

    admin
        .create_workflow(&workflow(
            "party",
            &reader,
            Trigger::ReactionAdded {
                room: general.clone(),
                emoji: Some(":tada:".into()),
            },
            vec![message(
                "trigger",
                "{{trigger.user.username}} :{{trigger.emoji}}: on {{trigger.message.author.username}}",
            )],
        ))
        .await
        .unwrap();
    admin
        .create_workflow(&workflow(
            "any",
            &reader,
            Trigger::ReactionAdded {
                room: general.clone(),
                emoji: None,
            },
            vec![message("trigger", "any reaction")],
        ))
        .await
        .unwrap();
    let nothing = bob.send(&general, &said("plain", "watch-3")).await.unwrap();
    admin
        .set_reaction(&nothing.id, &react("tada", "watch-r1", true))
        .await
        .unwrap();
    admin
        .set_reaction(&nothing.id, &react("+1", "watch-r2", true))
        .await
        .unwrap();
    // Taking a reaction back starts nothing.
    admin
        .set_reaction(&nothing.id, &react("tada", "watch-r3", false))
        .await
        .unwrap();
    bench.drain().await;
    let mut all = texts(&admin, &general).await;
    all.retain(|t| t.contains("reaction") || t.contains("on watch-bob"));
    all.sort();
    assert_eq!(
        all,
        vec![
            "any reaction",
            "any reaction",
            "watch-admin :tada: on watch-bob"
        ]
    );
    assert_eq!(run_count(&pool).await, 4);

    // What a person wrote never pings the whole room through the bot.
    bob.send(&general, &said("@all deploy now", "watch-4"))
        .await
        .unwrap();
    bench.drain().await;
    assert_eq!(run_count(&pool).await, 5);
    let echoes: Vec<String> =
        sqlx::query_scalar("SELECT text FROM messages WHERE text LIKE '%deploy noted'")
            .fetch_all(&pool)
            .await
            .unwrap();
    assert!(echoes.iter().any(|t| t.contains("@\u{2060}all deploy now")));
    let pinged: i64 = sqlx::query_scalar("SELECT count(*) FROM message_mentions n JOIN messages m ON m.id=n.message_id WHERE n.kind='all' AND m.author_id=$1")
        .bind(&reader)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(pinged, 0);

    // Taken out of the room, the bot no longer watches it.
    sqlx::query("DELETE FROM members WHERE room_id=$1 AND user_id=$2")
        .bind(&general)
        .bind(&reader)
        .execute(&pool)
        .await
        .unwrap();
    bob.send(&general, &said("deploy again", "watch-5"))
        .await
        .unwrap();
    admin
        .set_reaction(&nothing.id, &react("tada", "watch-r4", true))
        .await
        .unwrap();
    bench.drain().await;
    assert_eq!(run_count(&pool).await, 5);
}

#[sqlx::test]
async fn a_person_field_offers_its_list_or_the_room(pool: PgPool) {
    let bench = Bench::start(pool, false).await;
    let (admin, _) = bench.user("who-admin", true).await;
    let (bob, bob_id) = bench.user("who-bob", false).await;
    let (_, carol_id) = bench.user("who-carol", false).await;
    let (_, dave_id) = bench.user("who-dave", false).await;
    let general = room(&admin, "who-general", false).await;
    admin.add_member(&general, &bob_id).await.unwrap();
    admin.add_member(&general, &carol_id).await.unwrap();
    let bot = bench
        .bot(&admin, "who-bot", &[BotScope::MessagesWrite], &general)
        .await;
    let person = |id: &str, people: Vec<String>, multiple: bool| FormField {
        id: id.into(),
        label: id.into(),
        kind: FormFieldKind::Person,
        options: Vec::new(),
        people,
        multiple,
        required: !multiple,
    };
    let assign = |reviewers: Vec<String>| {
        workflow(
            "assign",
            &bot,
            Trigger::Command {
                name: "assign".into(),
            },
            vec![
                Step::Form {
                    room: "trigger".into(),
                    recipient: FormRecipient::TriggerUser,
                    title: "Assign".into(),
                    fields: vec![
                        person("owner", Vec::new(), false),
                        person("reviewer", reviewers, true),
                    ],
                    save_as: "task".into(),
                },
                message(
                    "trigger",
                    "@{{task.answers.owner}} owns it, {{task.mentions.reviewer}} review ({{task.answers.reviewer}}, {{task.people.reviewer.0.display_name}} first)",
                ),
            ],
        )
    };
    // A bot is never someone a form offers.
    code(
        admin.create_workflow(&assign(vec![bot.clone()])).await,
        "workflow_form",
    );
    admin
        .create_workflow(&assign(vec![carol_id.clone(), dave_id.clone()]))
        .await
        .unwrap();
    run_command(&bob, &general, "assign", "").await.unwrap();
    bench.drain().await;
    let history = bob.history(&general, None).await.unwrap().messages;
    let posted = history.iter().find(|m| m.form.is_some()).unwrap();
    let named: Vec<&str> = posted
        .form
        .as_ref()
        .unwrap()
        .people
        .iter()
        .map(|p| p.username.as_str())
        .collect();
    assert_eq!(named, vec!["who-carol", "who-dave"]);

    let answer = |owner: FormAnswer, reviewer: FormAnswer, op: &str| AnswerForm {
        operation_id: op.into(),
        answers: [
            ("owner".to_owned(), owner),
            ("reviewer".to_owned(), reviewer),
        ]
        .into_iter()
        .collect(),
    };
    // Any member of the room: not someone outside it, not a bot.
    code(
        bob.answer_form(
            &posted.id,
            &answer(dave_id.as_str().into(), carol_id.as_str().into(), "w1"),
        )
        .await,
        "form_value",
    );
    code(
        bob.answer_form(
            &posted.id,
            &answer(bot.as_str().into(), carol_id.as_str().into(), "w2"),
        )
        .await,
        "form_value",
    );
    // The list: not someone else, member or not.
    code(
        bob.answer_form(
            &posted.id,
            &answer(
                carol_id.as_str().into(),
                FormAnswer::Many(vec![carol_id.clone(), bob_id.clone()]),
                "w3",
            ),
        )
        .await,
        "form_value",
    );
    // One answer only where the field takes one.
    code(
        bob.answer_form(
            &posted.id,
            &answer(
                FormAnswer::Many(vec![carol_id.clone(), bob_id.clone()]),
                dave_id.as_str().into(),
                "w5",
            ),
        )
        .await,
        "form_value",
    );
    // Several, in the list's order whatever the order sent.
    bob.answer_form(
        &posted.id,
        &answer(
            carol_id.as_str().into(),
            FormAnswer::Many(vec![dave_id.clone(), carol_id.clone()]),
            "w4",
        ),
    )
    .await
    .unwrap();
    bench.drain().await;
    assert!(
        texts(&bob, &general)
            .await
            .contains(&"@who-carol owns it, @who-carol, @who-dave review (who-carol, who-dave, who-carol first)".to_owned())
    );
}

#[sqlx::test]
async fn administrators_never_read_credentials_and_a_deleted_bot_stops_its_workflows(pool: PgPool) {
    let bench = Bench::start(pool.clone(), false).await;
    let (admin, _) = bench.user("cred-admin", true).await;
    let (alice, _) = bench.user("cred-alice", false).await;
    admin
        .update_instance_settings(&UpdateInstanceSettings {
            operation_id: "allow".into(),
            user_bots: Some(true),
        })
        .await
        .unwrap();
    let general = room(&alice, "cred-general", false).await;
    let bot = bench
        .bot(&alice, "cred-bot", &[BotScope::MessagesWrite], &general)
        .await;
    let flow = alice
        .create_workflow(&workflow(
            "crm",
            &bot,
            Trigger::Webhook {},
            vec![Step::Http {
                method: HttpMethod::Post,
                url: "https://crm.example.com/notes".into(),
                headers: vec![rv_protocol::workflows::HttpHeader {
                    name: "Authorization".into(),
                    value: "Bearer s3cret".into(),
                }],
                body: None,
                save_as: None,
                continue_on_error: false,
            }],
        ))
        .await
        .unwrap();
    let header = |w: &rv_protocol::workflows::Workflow| match &w.steps[0] {
        Step::Http { headers, .. } => headers[0].value.clone(),
        _ => unreachable!(),
    };
    assert_eq!(
        header(&alice.workflow(&flow.id).await.unwrap()),
        "Bearer s3cret"
    );
    let overseen = admin.workflow(&flow.id).await.unwrap();
    assert_ne!(header(&overseen), "Bearer s3cret");
    let listed = admin.workflows(true).await.unwrap().workflows;
    assert!(
        listed
            .iter()
            .filter(|w| w.id == flow.id)
            .all(|w| header(w) != "Bearer s3cret")
    );

    // The engine's session of the bot is not one of its five keys.
    for n in 0..5 {
        alice
            .create_bot_key(
                &bot,
                &rv_protocol::bots::CreateBotKey {
                    operation_id: format!("key-{n}"),
                    label: format!("key {n}"),
                    expires_in_days: None,
                },
            )
            .await
            .unwrap();
    }
    assert_eq!(alice.bot_keys(&bot).await.unwrap().keys.len(), 5);
    let internal: String =
        sqlx::query_scalar("SELECT id FROM bot_keys WHERE bot_id=$1 AND internal")
            .bind(&bot)
            .fetch_one(&pool)
            .await
            .unwrap();
    // Revoking it by its id does nothing: the engine keeps its session.
    let _ = alice.revoke_bot_key(&bot, &internal).await;
    let kept: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM bot_keys WHERE id=$1)")
        .bind(&internal)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert!(kept);

    // Deleting the bot turns its workflows off.
    alice.delete_bot(&bot).await.unwrap();
    assert!(!alice.workflow(&flow.id).await.unwrap().enabled);
}

#[sqlx::test]
async fn form_answers_are_checked_and_a_deleted_or_expired_form_takes_none(pool: PgPool) {
    let bench = Bench::start(pool.clone(), false).await;
    let (admin, _) = bench.user("check-admin", true).await;
    let (bob, bob_id) = bench.user("check-bob", false).await;
    let general = room(&admin, "check-general", false).await;
    admin.add_member(&general, &bob_id).await.unwrap();
    let bot = bench
        .bot(&admin, "check-bot", &[BotScope::MessagesWrite], &general)
        .await;
    admin
        .create_workflow(&workflow(
            "tags",
            &bot,
            Trigger::Command {
                name: "tags".into(),
            },
            vec![
                Step::Form {
                    room: "trigger".into(),
                    recipient: FormRecipient::Anyone,
                    title: "Tags".into(),
                    fields: vec![
                        FormField {
                            id: "tags".into(),
                            label: "Tags".into(),
                            kind: FormFieldKind::Choice,
                            options: vec!["a".into(), "b".into(), "c".into()],
                            people: Vec::new(),
                            multiple: true,
                            required: true,
                        },
                        FormField {
                            id: "note".into(),
                            label: "Note".into(),
                            kind: FormFieldKind::Text,
                            options: Vec::new(),
                            people: Vec::new(),
                            multiple: false,
                            required: false,
                        },
                    ],
                    save_as: "x".into(),
                },
                message("trigger", "tags: {{x.answers.tags}}"),
            ],
        ))
        .await
        .unwrap();
    let forms = |history: &[rv_protocol::Message]| -> Vec<String> {
        history
            .iter()
            .filter(|m| m.form.is_some())
            .map(|m| m.id.clone())
            .collect()
    };
    run_command(&bob, &general, "tags", "").await.unwrap();
    bench.drain().await;
    let posted = forms(&bob.history(&general, None).await.unwrap().messages)[0].clone();
    let answer = |answers: Vec<(&str, FormAnswer)>, op: &str| AnswerForm {
        operation_id: op.into(),
        answers: answers
            .into_iter()
            .map(|(k, v)| (k.to_owned(), v))
            .collect(),
    };
    let many = |values: &[&str]| FormAnswer::Many(values.iter().map(|v| (*v).to_owned()).collect());
    for (answers, expected) in [
        (vec![], "form_required"),
        (vec![("tags", many(&[]))], "form_required"),
        (vec![("tags", many(&["z"]))], "form_value"),
        (
            vec![("tags", "a".into()), ("extra", "x".into())],
            "form_value",
        ),
        (
            vec![("tags", "a".into()), ("note", "two\nlines".into())],
            "form_value",
        ),
    ] {
        code(
            bob.answer_form(&posted, &answer(answers, "bad")).await,
            expected,
        );
    }
    bob.answer_form(
        &posted,
        &answer(vec![("tags", many(&["c", "a", "c"]))], "good"),
    )
    .await
    .unwrap();
    bench.drain().await;
    assert!(
        texts(&bob, &general)
            .await
            .contains(&"tags: a, c".to_owned())
    );

    // A deleted form shows no form and takes no answer; an expired one neither.
    run_command(&bob, &general, "tags", "").await.unwrap();
    run_command(&bob, &general, "tags", "").await.unwrap();
    bench.drain().await;
    let history = bob.history(&general, None).await.unwrap().messages;
    let open: Vec<String> = history
        .iter()
        .filter(|m| m.form.as_ref().is_some_and(|f| f.answered_by.is_none()))
        .map(|m| m.id.clone())
        .collect();
    assert_eq!(open.len(), 2);
    let deleted = history.iter().find(|m| m.id == open[0]).unwrap();
    admin
        .delete_message(
            &deleted.id,
            &rv_protocol::parity::DeleteMessage {
                operation_id: "remove-form".into(),
                expected_revision: deleted.revision.clone(),
            },
        )
        .await
        .unwrap();
    let after = bob.history(&general, None).await.unwrap().messages;
    assert!(
        after
            .iter()
            .find(|m| m.id == open[0])
            .unwrap()
            .form
            .is_none()
    );
    code(
        bob.answer_form(&open[0], &answer(vec![("tags", "a".into())], "late-1"))
            .await,
        "not_found",
    );
    sqlx::query(
        "UPDATE workflow_forms SET expires_at=now()-interval '1 second' WHERE message_id=$1",
    )
    .bind(&open[1])
    .execute(&pool)
    .await
    .unwrap();
    code(
        bob.answer_form(&open[1], &answer(vec![("tags", "a".into())], "late-2"))
            .await,
        "form_expired",
    );
}
