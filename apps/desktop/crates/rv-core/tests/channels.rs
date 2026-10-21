//! Creating a Rocket.Chat channel or private group against a fake server: the
//! route per kind, the name sent trimmed, the new room stored before the rid
//! comes back, and each refusal read as the reason the user sees.
mod common;

use std::sync::{Arc, Mutex};
use std::time::Duration;

use common::{FakeHttp, Request, Response, dropped, respond};
use rv_core::rocketchat::actions::creation_refusal;
use rv_core::session::{Session, SessionInfo};
use serde_json::{Value, json};

const ROOMS: &str = r#"{"success":true,"update":[
    {"_id":"c1","t":"c","name":"dev","_updatedAt":"2026-10-01T10:00:00.000Z"}
],"remove":[]}"#;

const SUBSCRIPTIONS: &str = r#"{"success":true,"update":[
    {"_id":"s1","rid":"c1","t":"c","name":"dev","open":true,"_updatedAt":"2026-10-01T10:00:00.000Z"}
],"remove":[]}"#;

/// The room `channels.create` / `groups.create` answers (probed shape on 8.5.1).
fn created(id: &str, kind: &str, name: &str) -> String {
    let key = if kind == "p" { "group" } else { "channel" };
    json!({"success": true, key: {
        "_id": id, "t": kind, "name": name, "fname": name, "ro": false, "usersCount": 1, "msgs": 0,
        "u": {"_id": "u-me", "username": "me"}, "ts": "2026-10-13T09:00:00.000Z",
        "_updatedAt": "2026-10-13T09:00:00.000Z"
    }})
    .to_string()
}

/// `ROOMS` or `SUBSCRIPTIONS` with the rooms created since, as a server lists
/// them: the session's reconciliation drops a stored room its server no
/// longer lists, so a fake that forgot them would race the test.
fn listed(base: &str, made: &[(String, String, String)], subscription: bool) -> String {
    let mut list: Value = serde_json::from_str(base).unwrap();
    let update = list["update"].as_array_mut().unwrap();
    for (id, kind, name) in made {
        let at = "2026-10-13T09:00:00.000Z";
        update.push(if subscription {
            json!({"_id": format!("s-{id}"), "rid": id, "t": kind, "name": name, "open": true, "_updatedAt": at})
        } else {
            json!({"_id": id, "t": kind, "name": name, "_updatedAt": at})
        });
    }
    list.to_string()
}

fn server(request: &Request, made: &Mutex<Vec<(String, String, String)>>) -> Response {
    let path = request.path();
    if path.ends_with("/websocket") {
        return dropped();
    }
    let name = serde_json::from_str::<Value>(&request.body)
        .ok()
        .and_then(|b| b.get("name").and_then(Value::as_str).map(str::to_owned))
        .unwrap_or_default();
    let create = |id: &str, kind: &str| {
        made.lock().unwrap().push((id.to_owned(), kind.to_owned(), name.clone()));
        respond(200, &created(id, kind, &name))
    };
    match (path.trim_start_matches("/api/v1/"), name.as_str()) {
        ("rooms.get", _) => respond(200, &listed(ROOMS, &made.lock().unwrap(), false)),
        ("subscriptions.get", _) => respond(200, &listed(SUBSCRIPTIONS, &made.lock().unwrap(), true)),
        ("channels.create" | "groups.create", "dev") => respond(
            400,
            r#"{"success":false,"error":"A channel with name 'dev' exists [error-duplicate-channel-name]","errorType":"error-duplicate-channel-name"}"#,
        ),
        ("channels.create", "Équipe dev") => respond(
            400,
            r#"{"success":false,"error":"Équipe dev is not a valid room name. [error-invalid-room-name]","errorType":"error-invalid-room-name"}"#,
        ),
        ("channels.create", "locked") => respond(403, r#"{"success":false,"error":"unauthorized"}"#),
        ("groups.create", "locked") => respond(
            400,
            r#"{"success":false,"error":"Not allowed [error-not-allowed]","errorType":"error-not-allowed"}"#,
        ),
        ("channels.create", "team") => create("c9", "c"),
        ("groups.create", "core") => create("p9", "p"),
        // A success without the room the kind names.
        ("channels.create", "hollow") => respond(200, &created("p8", "p", "hollow")),
        _ => respond(200, r#"{"success":true}"#),
    }
}

struct Bench {
    server: FakeHttp,
    session: Arc<Session>,
    _dir: tempfile::TempDir,
}

async fn bench() -> Bench {
    let made = Mutex::new(Vec::new());
    let server = FakeHttp::start(move |request: &Request| server(request, &made)).await;
    let dir = tempfile::tempdir().unwrap();
    let info = SessionInfo {
        base_url: server.url.to_string(),
        user_id: "u-me".into(),
        username: "me".into(),
        auth_token: "tok".into(),
        native: None,
        mattermost: None,
        slack: None,
        teams: None,
    };
    let session = Session::start(info, &dir.path().join("account.sqlite")).unwrap();
    for _ in 0..100 {
        if session.store.room_kind("c1").is_some() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert!(session.channels_creatable(), "a Rocket.Chat account creates channels");
    Bench { server, session, _dir: dir }
}

impl Bench {
    /// The body of each request on `route` since `from`.
    fn bodies(&self, from: usize, route: &str) -> Vec<Value> {
        self.server.requests()[from..]
            .iter()
            .filter(|r| r.path().ends_with(route))
            .map(|r| serde_json::from_str(&r.body).unwrap_or(Value::Null))
            .collect()
    }

    fn close(self) {
        self.session.shutdown();
        self.session.store.close();
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_channel_or_a_group_is_created_and_listed_before_it_opens() {
    let b = bench().await;
    let s = b.session.clone();
    let from = b.server.requests().len();
    assert_eq!(s.create_channel("  team ", false).await.unwrap(), "c9");
    assert_eq!(b.bodies(from, "/channels.create"), vec![json!({"name": "team"})]);
    assert!(b.bodies(from, "/groups.create").is_empty());
    assert_eq!(s.store.room_kind("c9").as_deref(), Some("c"), "stored before the rid comes back");

    let from = b.server.requests().len();
    assert_eq!(s.create_channel("core", true).await.unwrap(), "p9");
    assert_eq!(b.bodies(from, "/groups.create"), vec![json!({"name": "core"})]);
    assert!(b.bodies(from, "/channels.create").is_empty());
    assert_eq!(s.store.room_kind("p9").as_deref(), Some("p"));
    b.close();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn refusals_say_why() {
    let b = bench().await;
    let s = b.session.clone();
    let reason =
        async |name: &str, private: bool| creation_refusal(&s.create_channel(name, private).await.unwrap_err());
    assert_eq!(reason("dev", false).await, "new_channel.name_taken");
    assert_eq!(reason("dev", true).await, "new_channel.name_taken");
    assert_eq!(reason("Équipe dev", false).await, "new_channel.name_invalid");
    assert_eq!(reason("locked", false).await, "new_channel.forbidden");
    assert_eq!(reason("locked", true).await, "new_channel.forbidden");
    assert_eq!(reason("hollow", false).await, "new_channel.failed");

    // A blank name is refused here: the server would answer a bare 400.
    let from = b.server.requests().len();
    assert!(s.create_channel("   ", false).await.is_err());
    assert!(b.bodies(from, "/channels.create").is_empty());
    b.close();
}
