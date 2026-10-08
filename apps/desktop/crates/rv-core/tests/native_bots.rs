mod common;
use common::{FakeHttp, respond};
use rv_core::{
    admin::Admin,
    native::{self, Identity, bots::BotScope},
    session::{Connection, SessionInfo},
};
use serde_json::json;
use std::{
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

#[tokio::test]
async fn bots_keys_and_the_instance_setting_follow_the_contract() {
    let fixture: serde_json::Value =
        serde_json::from_str(include_str!("../../../../../docs/protocol/v1.fixture.json")).unwrap();
    let recent = Arc::new(AtomicBool::new(false));
    let bodies = Arc::new(Mutex::new(Vec::<(String, String, serde_json::Value)>::new()));
    let (responses, fresh, log) = (fixture.clone(), recent.clone(), bodies.clone());
    let server = FakeHttp::start(move |request| {
        if request.method != "GET" {
            let body = serde_json::from_str(&request.body).unwrap_or(serde_json::Value::Null);
            log.lock().unwrap().push((request.method.clone(), request.target.clone(), body));
        }
        let bots = &responses["bots"];
        match (request.method.as_str(), request.path()) {
            (_, "/.well-known/rocketvibe") => {
                let mut discovery = responses["discovery"].clone();
                discovery["capabilities"]["administration"] = json!(true);
                discovery["capabilities"]["bots"] = json!(true);
                respond(200, &discovery.to_string())
            }
            (_, "/api/v1/me") => respond(200, &responses["session"]["user"].to_string()),
            (_, "/api/v1/me/permissions") => {
                let mut permissions = responses["parity"]["account_permissions"].clone();
                permissions["manage_accounts"] = json!(true);
                permissions["create_bot"] = json!(true);
                respond(200, &permissions.to_string())
            }
            (_, "/api/v1/sync/changes") => respond(
                200,
                &json!({"protocol_version":1,"changes":[],"cursor":"initial","has_more":false}).to_string(),
            ),
            (_, "/api/v1/sync/ticket") => respond(200, &responses["socket_ticket"].to_string()),
            (_, "/api/v1/sync/socket") => common::Response { websocket: true, ..Default::default() },
            ("GET", "/api/v1/bots/reference") => respond(200, &bots["bot_reference"].to_string()),
            ("GET", "/api/v1/bots") => respond(200, &bots["bot_list"].to_string()),
            ("POST", "/api/v1/bots") => respond(201, &bots["bot"].to_string()),
            ("PATCH", "/api/v1/bots/helper-id") => respond(200, &bots["bot"].to_string()),
            ("DELETE", "/api/v1/bots/helper-id") => respond(204, ""),
            ("GET", "/api/v1/bots/helper-id/keys") => respond(200, &bots["bot_key_list"].to_string()),
            ("POST", "/api/v1/bots/helper-id/keys") if fresh.load(Ordering::SeqCst) => {
                respond(201, &bots["bot_key_created"].to_string())
            }
            ("POST", "/api/v1/bots/helper-id/keys") => {
                respond(403, r#"{"code":"reauthentication_required","request_id":"reauth-key"}"#)
            }
            ("DELETE", "/api/v1/bots/helper-id/keys/key-id") => respond(204, ""),
            ("GET", "/api/v1/admin/settings") => respond(200, &bots["instance_settings"].to_string()),
            ("PATCH", "/api/v1/admin/settings") => respond(200, r#"{"user_bots":true}"#),
            _ => respond(404, r#"{"code":"not_found","request_id":"fixture"}"#),
        }
    })
    .await;
    let identity = Identity {
        instance_id: fixture["discovery"]["instance_id"].as_str().unwrap().into(),
        data_epoch: fixture["discovery"]["data_epoch"].as_str().unwrap().into(),
    };
    let path = std::env::temp_dir().join(format!("rv-bots-{:032x}.sqlite", fastrand::u128(..)));
    let store = native::store::NativeStore::open(&path, identity.clone()).unwrap();
    store
        .snapshot(&rv_protocol::Snapshot {
            protocol_version: 1,
            rooms: vec![],
            messages: vec![],
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
    assert!(session.bots_supported() && session.supported_features().iter().any(|f| f == "bots"));
    assert!(session.can_create_bot().await.unwrap());
    let reference = session.bot_reference().await.unwrap();
    assert_eq!(
        native::bots::routes(&reference, Some(BotScope::MessagesWrite))[0].path,
        "/api/v1/rooms/{room}/messages"
    );
    let mine = session.bots().await.unwrap();
    assert!(mine[0].user.bot && mine[0].owner.username == "alice" && mine[0].live_keys == 1);

    let made = session
        .create_bot(" helper ", "", "Posts the build results", &[BotScope::MessagesWrite, BotScope::RoomsRead])
        .await
        .unwrap();
    assert_eq!(made.user.id, "helper-id");
    assert_eq!(session.create_bot("  ", "Name", "", &[]).await.unwrap_err().code(), "invalid_request");
    session.update_bot("helper-id", Some(" Builds "), Some(&[BotScope::RoomsRead])).await.unwrap();
    assert_eq!(session.bot_keys("helper-id").await.unwrap()[0].hint, "9f3a");

    let refused = session.create_bot_key("helper-id", "CI", Some(365)).await.unwrap_err();
    assert_eq!(native::bots::error_key(refused.code()), "bots.error_reauth");
    recent.store(true, Ordering::SeqCst);
    let created = session.create_bot_key("helper-id", " CI ", Some(365)).await.unwrap();
    assert!(created.key.starts_with("rvb_") && created.info.id == "key-id");
    assert_eq!(session.create_bot_key("helper-id", "CI", Some(0)).await.unwrap_err().code(), "invalid_request");
    assert_eq!(session.create_bot_key("helper-id", "", None).await.unwrap_err().code(), "invalid_request");
    session.revoke_bot_key("helper-id", "key-id").await.unwrap();
    session.delete_bot("helper-id").await.unwrap();

    let admin = Admin::Native(session.clone());
    assert_eq!(admin.user_bots().await.unwrap(), Some(false));
    assert!(admin.set_user_bots(true).await.unwrap());

    let sent = bodies.lock().unwrap().clone();
    let body = |method: &str, target: &str| {
        sent.iter().find(|(m, t, _)| m == method && t == target).map(|(_, _, b)| b.clone()).unwrap()
    };
    let create = body("POST", "/api/v1/bots");
    assert_eq!(create["username"], "helper");
    assert_eq!(create["display_name"], "helper", "an empty name falls back to the username");
    assert_eq!(create["scopes"], json!(["rooms:read", "messages:write"]), "canonical order");
    assert!(create["operation_id"].as_str().is_some_and(|id| !id.is_empty()));
    let update = body("PATCH", "/api/v1/bots/helper-id");
    assert_eq!((update["description"].clone(), update["scopes"].clone()), (json!("Builds"), json!(["rooms:read"])));
    let key = sent.iter().rfind(|(m, t, _)| m == "POST" && t == "/api/v1/bots/helper-id/keys").unwrap();
    assert_eq!((key.2["label"].clone(), key.2["expires_in_days"].clone()), (json!("CI"), json!(365)));
    assert_eq!(body("PATCH", "/api/v1/admin/settings")["user_bots"], true);
    session.shutdown();
}
