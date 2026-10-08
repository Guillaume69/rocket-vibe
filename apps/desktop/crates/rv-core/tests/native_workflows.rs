mod common;
use common::{FakeHttp, respond};
use rv_core::{
    native::{
        self, Identity,
        workflows::{self, Draft, Step, Trigger},
    },
    session::{Connection, SessionInfo},
};
use serde_json::json;
use std::{
    collections::BTreeMap,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

#[tokio::test]
async fn workflows_forms_and_room_commands_follow_the_contract() {
    let fixture: serde_json::Value =
        serde_json::from_str(include_str!("../../../../../docs/protocol/v1.fixture.json")).unwrap();
    let recent = Arc::new(AtomicBool::new(false));
    let bodies = Arc::new(Mutex::new(Vec::<(String, String, serde_json::Value)>::new()));
    let (responses, fresh, log) = (fixture.clone(), recent.clone(), bodies.clone());
    let server = FakeHttp::start(move |request| {
        if request.method != "GET" {
            let body = serde_json::from_str(&request.body).unwrap_or(serde_json::Value::Null);
            log.lock().unwrap().push((request.method.clone(), request.target.clone(), body));
        } else if request.path() == "/api/v1/commands" {
            log.lock().unwrap().push((request.method.clone(), request.target.clone(), serde_json::Value::Null));
        }
        let flows = &responses["workflows"];
        let mut off = flows["workflow"].clone();
        off["enabled"] = json!(false);
        match (request.method.as_str(), request.path()) {
            (_, "/.well-known/rocketvibe") => {
                let mut discovery = responses["discovery"].clone();
                for capability in ["bots", "workflows", "slash_commands"] {
                    discovery["capabilities"][capability] = json!(true);
                }
                respond(200, &discovery.to_string())
            }
            (_, "/api/v1/me") => respond(200, &responses["session"]["user"].to_string()),
            (_, "/api/v1/me/permissions") => {
                let mut permissions = responses["parity"]["account_permissions"].clone();
                permissions["create_bot"] = json!(true);
                respond(200, &permissions.to_string())
            }
            (_, "/api/v1/sync/changes") => respond(
                200,
                &json!({"protocol_version":1,"changes":[],"cursor":"initial","has_more":false}).to_string(),
            ),
            (_, "/api/v1/sync/ticket") => respond(200, &responses["socket_ticket"].to_string()),
            (_, "/api/v1/sync/socket") => common::Response { websocket: true, ..Default::default() },
            ("GET", "/api/v1/commands") if request.target.contains("room=room-id") => {
                let mut list = responses["command_list"].clone();
                list["commands"]
                    .as_array_mut()
                    .unwrap()
                    .push(json!({"command":"standup","params":"","description":"Daily_Standup","client_side":false,"literal":true}));
                respond(200, &list.to_string())
            }
            ("GET", "/api/v1/commands") => respond(200, &responses["command_list"].to_string()),
            ("POST", "/api/v1/commands/run") => {
                respond(429, r#"{"code":"workflow_rate_limited","request_id":"run-limit"}"#)
            }
            ("GET", "/api/v1/workflows") => respond(200, &flows["workflow_list"].to_string()),
            ("POST", "/api/v1/workflows") => respond(201, &flows["workflow"].to_string()),
            ("GET", "/api/v1/workflows/wf-id") => respond(200, &flows["workflow"].to_string()),
            ("PUT", "/api/v1/workflows/wf-id") if request.body.contains(r#""revision":"rev-1""#) => {
                respond(200, &flows["workflow"].to_string())
            }
            ("PUT", "/api/v1/workflows/wf-id") => respond(409, r#"{"code":"revision_conflict","request_id":"moved"}"#),
            ("DELETE", "/api/v1/workflows/wf-id") => respond(204, ""),
            ("POST", "/api/v1/workflows/wf-id/disable") => respond(200, &off.to_string()),
            ("POST", "/api/v1/workflows/wf-id/webhook") if fresh.load(Ordering::SeqCst) => {
                respond(200, &flows["webhook_secret"].to_string())
            }
            ("POST", "/api/v1/workflows/wf-id/webhook") => {
                respond(403, r#"{"code":"reauthentication_required","request_id":"reauth-hook"}"#)
            }
            ("GET", "/api/v1/workflows/wf-id/runs") => respond(200, &flows["workflow_run_list"].to_string()),
            ("POST", "/api/v1/workflows/wf-id/test") => respond(202, &flows["run_started"].to_string()),
            ("POST", "/api/v1/forms/message-id/answer") => respond(204, ""),
            _ => respond(404, r#"{"code":"not_found","request_id":"fixture"}"#),
        }
    })
    .await;
    let identity = Identity {
        instance_id: fixture["discovery"]["instance_id"].as_str().unwrap().into(),
        data_epoch: fixture["discovery"]["data_epoch"].as_str().unwrap().into(),
    };
    let path = std::env::temp_dir().join(format!("rv-workflows-{:032x}.sqlite", fastrand::u128(..)));
    let store = native::store::NativeStore::open(&path, identity.clone()).unwrap();
    let mut form = fixture["workflows"]["workflow_form"].clone();
    form["expires_at"] = json!((chrono::Utc::now() + chrono::Duration::days(3)).to_rfc3339());
    let mut asked = fixture["message"].clone();
    asked["author"] = json!({"id":"helper-id","username":"helper","display_name":"Helper","bot":true});
    asked["text"] = json!("Standup");
    asked["form"] = form;
    store
        .snapshot(&rv_protocol::Snapshot {
            protocol_version: 1,
            rooms: vec![serde_json::from_value(fixture["room"].clone()).unwrap()],
            messages: vec![serde_json::from_value(asked).unwrap()],
            cursor: "initial".into(),
        })
        .unwrap();
    drop(store);
    let info = SessionInfo {
        base_url: server.url.as_str().into(),
        user_id: fixture["session"]["user"]["id"].as_str().unwrap().into(),
        username: "alice".into(),
        auth_token: "fixture-token".into(),
        native: Some(identity),
    };
    let session = native::NativeSession::start(info, &path).unwrap();
    tokio::time::timeout(Duration::from_secs(5), async {
        while session.status().connection != Connection::Online {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    assert!(session.workflows_supported() && session.supported_features().iter().any(|f| f == "workflows"));
    assert!(session.can_create_workflow().await.unwrap());

    // The stored message keeps its form, and the row carries it to the UIs.
    let row = session.store.messages("room-id", 10).unwrap().remove(0).presentation("room-id", "alice-id");
    let shown = workflows::row_form(&row).expect("the form reaches the row");
    assert_eq!(shown.title, "Standup");
    assert!(workflows::can_answer(&shown, "alice-id", chrono::Utc::now()));
    assert_eq!(session.store.message_form("message-id").unwrap(), Some(shown));

    let mine = session.workflows().await.unwrap();
    assert_eq!((mine[0].name.as_str(), mine[0].bot.username.as_str()), ("Standup", "helper"));
    let summary = workflows::trigger_summary(&mine[0].trigger, &|id| session.workflow_room_label(id));
    assert!(summary.contains("/standup"), "{summary}");
    assert_eq!(session.workflow_room_label("room-id"), "#A room");
    assert_eq!(session.workflow_room_label("trigger"), rv_core::i18n::t("workflows.room_trigger"));
    assert_eq!(session.workflow_rooms().len(), 1);

    let mut draft = Draft::new("helper-id");
    draft.name = "  Standup ".into();
    draft.trigger = Trigger::Command { name: " /Standup ".into() };
    draft.steps.push(workflows::new_step("message", &draft.trigger, &draft.steps).unwrap());
    if let Some(Step::Message { text, .. }) = draft.steps.last_mut() {
        *text = "Hello {{trigger.user.username}}".into();
    }
    session.create_workflow(&draft).await.unwrap();
    let mut nameless = draft.clone();
    nameless.name = "   ".into();
    assert_eq!(session.create_workflow(&nameless).await.unwrap_err().code(), "invalid_request");

    let current = session.workflow("wf-id").await.unwrap();
    let moved = session.update_workflow("wf-id", "old", &Draft::of(&current)).await.unwrap_err();
    assert_eq!(workflows::failure_key(&moved), "workflows.error_conflict");
    session.update_workflow("wf-id", &current.revision, &Draft::of(&current)).await.unwrap();

    let refused = session.workflow_webhook("wf-id").await.unwrap_err();
    assert_eq!(workflows::failure_key(&refused), "workflows.error_reauth");
    recent.store(true, Ordering::SeqCst);
    let url = session.workflow_webhook("wf-id").await.unwrap();
    assert_eq!(url, format!("{}/api/v1/hooks/wf-id/{}", server.url.as_str().trim_end_matches('/'), "ab".repeat(32)));

    let runs = session.workflow_runs("wf-id").await.unwrap();
    assert_eq!(runs.len(), 2);
    assert!(workflows::run_text(&runs[1]).contains(&workflows::run_error_text("http_address")));
    assert_eq!(session.test_workflow("wf-id").await.unwrap(), "run-id");
    assert!(!session.disable_workflow("wf-id").await.unwrap().enabled);

    let answers = |pairs: &[(&str, &str)]| {
        pairs.iter().map(|(k, v)| ((*k).to_owned(), workflows::FormAnswer::from(*v))).collect::<BTreeMap<_, _>>()
    };
    let empty = session.answer_form("message-id", &answers(&[("today", "  ")])).await.unwrap_err();
    assert_eq!(workflows::failure_key(&empty), "workflows.error_form_required");
    session.answer_form("message-id", &answers(&[("today", " Reviews ")])).await.unwrap();

    // The room's commands include its workflows, and a refusal has its words.
    let offered = session.room_commands("room-id").await.unwrap();
    let standup = offered.iter().find(|c| c.name == "standup").expect("the workflow command");
    assert_eq!(standup.description, "Daily_Standup", "a workflow's name, as written");
    assert!(session.loaded_room_commands("room-id").iter().any(|c| c.name == "standup"));
    assert!(!session.loaded_room_commands("elsewhere").iter().any(|c| c.name == "standup"));
    let run = session.run_command("room-id", "/standup now").await.expect("a command of the room").unwrap_err();
    assert_eq!(rv_core::commands::error_key(run.code()), Some("command.workflow_rate_limited"));
    assert!(session.run_command("room-id", "/unknown thing").await.is_none());
    session.delete_workflow("wf-id").await.unwrap();

    let sent = bodies.lock().unwrap().clone();
    let body = |method: &str, target: &str| {
        sent.iter().find(|(m, t, _)| m == method && t == target).map(|(_, _, b)| b.clone()).unwrap()
    };
    let create = body("POST", "/api/v1/workflows");
    assert_eq!(create["name"], "Standup", "trimmed");
    assert_eq!(create["trigger"], json!({"kind":"command","name":"standup"}), "no slash, lower case");
    assert_eq!(create["bot_id"], "helper-id");
    assert_eq!(create["steps"][0]["room"], "trigger");
    assert!(create["operation_id"].as_str().is_some_and(|id| !id.is_empty()));
    let creations = sent.iter().filter(|(m, t, _)| m == "POST" && t == "/api/v1/workflows").count();
    assert_eq!(creations, 1, "a nameless draft never leaves");
    let puts: Vec<_> =
        sent.iter().filter(|(m, t, _)| m == "PUT" && t == "/api/v1/workflows/wf-id").map(|(_, _, b)| b).collect();
    assert_eq!((puts[0]["revision"].clone(), puts[1]["revision"].clone()), (json!("old"), json!("rev-1")));
    let steps = |value: &serde_json::Value| serde_json::from_value::<Vec<Step>>(value.clone()).unwrap();
    let mut expected = steps(&fixture["workflows"]["workflow"]["steps"]);
    // A command has no thread to answer in: normalizing drops `in_thread`.
    for step in &mut expected {
        if let Step::Message { in_thread, .. } = step {
            *in_thread = false;
        }
    }
    assert_eq!(steps(&puts[1]["steps"]), expected, "the definition goes back whole, normalized");
    let answered: Vec<_> = sent
        .iter()
        .filter(|(m, t, _)| m == "POST" && t == "/api/v1/forms/message-id/answer")
        .map(|(_, _, b)| b)
        .collect();
    assert_eq!(answered.len(), 1, "a refused answer never leaves");
    assert_eq!(answered[0]["answers"], json!({"today":"Reviews"}));
    assert_eq!(body("POST", "/api/v1/commands/run")["command"], "standup");
    assert!(sent.iter().any(|(m, t, _)| m == "GET" && t == "/api/v1/commands?room=room-id"));
    session.shutdown();
}
