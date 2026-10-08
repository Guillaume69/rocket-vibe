use super::*;
use rv_core::{
    native::{Identity, store::NativeStore},
    session::{Connection, SessionInfo},
};
use std::{
    sync::Mutex,
    time::{Duration, Instant},
};
// The fake server, also loaded by the link previews test.
#[allow(clippy::duplicate_mod)]
#[path = "../../../rv-core/tests/common/mod.rs"]
mod http;

fn until(check: impl Fn() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(8);
    while !check() {
        assert!(Instant::now() < deadline, "GTK workflows timed out");
        while glib::MainContext::default().iteration(false) {}
        std::thread::sleep(Duration::from_millis(10));
    }
}

/// Every descendant of `widget` carrying `class`, in order.
fn find(widget: &gtk::Widget, class: &str) -> Vec<gtk::Widget> {
    let mut found = Vec::new();
    if widget.has_css_class(class) {
        found.push(widget.clone());
    }
    for child in std::iter::successors(widget.first_child(), |w| w.next_sibling()) {
        found.extend(find(&child, class));
    }
    found
}

#[test]
#[ignore = "requires a GTK display; run under Xvfb"]
fn the_editor_and_the_form_card_follow_the_contract() {
    gtk::init().unwrap();
    adw::init().unwrap();
    let runtime = tokio::runtime::Runtime::new().unwrap();
    let _entered = runtime.enter();
    let fixture: serde_json::Value =
        serde_json::from_str(include_str!("../../../../../../docs/protocol/v1.fixture.json")).unwrap();
    let mut discovery = fixture["discovery"].clone();
    for capability in ["bots", "workflows", "slash_commands"] {
        discovery["capabilities"][capability] = serde_json::json!(true);
    }
    let mut raw = fixture["snapshot"].clone();
    raw["rooms"] = serde_json::json!([fixture["room"].clone()]);
    let mut asked = fixture["message"].clone();
    asked["form"] = fixture["workflows"]["workflow_form"].clone();
    asked["form"]["expires_at"] = serde_json::json!((chrono::Utc::now() + chrono::Duration::days(3)).to_rfc3339());
    // Two fields taking several answers: a choice, and the fixture's person
    // field (whatever the fixture holds, it is set here).
    let fields = asked["form"]["fields"].as_array_mut().unwrap();
    fields.retain(|f| f["id"] == "today");
    fields.extend([
        serde_json::json!({"id":"mood","label":"Mood <b>","kind":"choice","options":["good","meh"],"multiple":true}),
        serde_json::json!({"id":"reviewers","label":"Reviewers","kind":"person","people":["bob-id"],"multiple":true}),
    ]);
    asked["form"]["people"] = serde_json::json!([{"id":"bob-id","username":"bob","display_name":"Bob"}]);
    raw["messages"] = serde_json::json!([asked]);
    let sent = Arc::new(Mutex::new(Vec::<(String, String, serde_json::Value)>::new()));
    let log = sent.clone();
    let server = runtime.block_on(http::FakeHttp::start(move |r| {
        if r.method != "GET" {
            let body = serde_json::from_str(&r.body).unwrap_or(serde_json::Value::Null);
            log.lock().unwrap().push((r.method.clone(), r.path().to_owned(), body));
        }
        let flows = &fixture["workflows"];
        match (r.method.as_str(), r.path()) {
            (_, "/.well-known/rocketvibe") => http::respond(200, &discovery.to_string()),
            (_, "/api/v1/me") => http::respond(200, &fixture["session"]["user"].to_string()),
            (_, "/api/v1/me/permissions") => {
                let mut permissions = fixture["parity"]["account_permissions"].clone();
                permissions["create_bot"] = serde_json::json!(true);
                http::respond(200, &permissions.to_string())
            }
            (_, "/api/v1/sync/changes") => http::respond(
                200,
                &serde_json::json!({"protocol_version":1,"changes":[],"cursor":"opaque-fixture","has_more":false})
                    .to_string(),
            ),
            (_, "/api/v1/sync/ticket") => http::respond(200, &fixture["socket_ticket"].to_string()),
            (_, "/api/v1/sync/socket") => http::Response { websocket: true, ..Default::default() },
            ("GET", "/api/v1/bots") => http::respond(200, &fixture["bots"]["bot_list"].to_string()),
            ("GET", "/api/v1/workflows") => http::respond(200, &flows["workflow_list"].to_string()),
            ("GET", "/api/v1/workflows/wf-id/runs") => http::respond(200, &flows["workflow_run_list"].to_string()),
            ("PUT", "/api/v1/workflows/wf-id") => http::respond(200, &flows["workflow"].to_string()),
            ("POST", "/api/v1/forms/message-id/answer") => http::respond(204, ""),
            _ => http::respond(404, r#"{"code":"not_found","request_id":"fixture"}"#),
        }
    }));
    let path = std::env::temp_dir().join(format!("gtk-workflows-{}.sqlite", std::process::id()));
    let identity = Identity { instance_id: "fixture-instance".into(), data_epoch: "fixture-epoch".into() };
    let store = NativeStore::open(&path, identity.clone()).unwrap();
    store.snapshot(&serde_json::from_value(raw).unwrap()).unwrap();
    drop(store);
    let session = NativeSession::start(
        SessionInfo {
            base_url: server.url.to_string(),
            user_id: "alice-id".into(),
            username: "alice".into(),
            auth_token: "fixture-token".into(),
            native: Some(identity),
        },
        &path,
    )
    .unwrap();
    until(|| session.status().connection == Connection::Online);
    assert!(session.workflows_supported());

    let dialog = crate::sidebar_dialog::SidebarDialog::new("Settings", "settings-dialog");
    let host = dialog.host();
    let list = page(&host, session.clone(), None);
    until(|| !find(list.upcast_ref(), "workflow-row").is_empty());
    assert_eq!(find(list.upcast_ref(), "workflow-create").len(), 1, "I may create one, and I have a bot");

    let workflow: Workflow = serde_json::from_value(fixture_workflow()).unwrap();
    let ctx = Ctx {
        host: host.clone(),
        session: session.clone(),
        list: Rows::new(&adw::PreferencesGroup::new()),
        bots: Rc::new(RefCell::new(serde_json::from_value(fixture_bots()).unwrap())),
        security: None,
    };
    let ed = open_editor(&ctx, Some(workflow.clone()));
    let page = ed.page.upgrade().unwrap().upcast::<gtk::Widget>();
    assert_eq!(find(&page, "workflow-step").len(), 4, "form, wait, HTTP, message");
    assert_eq!(find(&page, "workflow-field").len(), 2);
    assert_eq!(find(&page, "workflow-headers").len(), 1);
    assert_eq!(find(&page, "workflow-variables").len(), 2, "message and HTTP use templates");
    until(|| !find(&page, "workflow-run").is_empty());
    // A step added, then moved up: the draft follows, the page is rebuilt.
    find(&page, "workflow-add-wait")[0].downcast_ref::<gtk::Button>().unwrap().emit_clicked();
    assert_eq!(find(&page, "workflow-step").len(), 5);
    let ups = find(&page, "workflow-step-up");
    ups[4].downcast_ref::<gtk::Button>().unwrap().emit_clicked();
    assert!(matches!(ed.draft.borrow().steps[3], Step::Wait { seconds: 60 }));
    assert!(matches!(ed.draft.borrow().steps[4], Step::Message { .. }));
    // A variable goes where the last chosen template field has its cursor.
    let url = find(&page, "workflow-url")[0].clone().downcast::<adw::EntryRow>().unwrap();
    url.set_text("https://example.org/");
    url.set_position(-1);
    Field::line(&url).insert(&workflows::placeholder("standup.answers.today"));
    let step = ed.draft.borrow().steps[2].clone();
    let Step::Http { url: saved, .. } = step else { panic!() };
    assert_eq!(saved, "https://example.org/{{standup.answers.today}}");
    // A new field takes its id from its label.
    find(&page, "workflow-field-add")[0].downcast_ref::<adw::ButtonRow>().unwrap().emit_by_name::<()>("activated", &[]);
    let labels = find(&page, "workflow-field-label");
    labels[2].downcast_ref::<adw::EntryRow>().unwrap().set_text("Blockers?");
    let step = ed.draft.borrow().steps[0].clone();
    let Step::Form { fields, .. } = step else { panic!() };
    assert_eq!(fields[2].id, "blockers");
    // A person field gets its people rows; "any member" sends no list.
    let kinds = find(&page, "workflow-field-kind");
    kinds[2].downcast_ref::<adw::ComboRow>().unwrap().set_selected(4);
    assert_eq!(find(&page, "workflow-people-mode").len(), 1);
    let step = ed.draft.borrow().steps[0].clone();
    let Step::Form { fields, .. } = step else { panic!() };
    assert_eq!((fields[2].kind, fields[2].people.len()), (FormFieldKind::Person, 0));
    drop(kinds);
    // "Several answers" shows for a choice or a person only.
    let several = find(&page, "workflow-field-multiple");
    let shown: Vec<bool> = several.iter().map(|w| w.is_visible()).collect();
    assert_eq!(shown, [false, true, true], "long text, choice, person");
    several[2].downcast_ref::<adw::SwitchRow>().unwrap().set_active(true);
    let step = ed.draft.borrow().steps[0].clone();
    let Step::Form { fields, .. } = step else { panic!() };
    assert!(fields[2].multiple && !fields[1].multiple);
    drop(several);
    // Save sends the whole definition at the revision it was read at.
    find(&page, "workflow-save")[0].downcast_ref::<adw::ButtonRow>().unwrap().emit_by_name::<()>("activated", &[]);
    until(|| sent.lock().unwrap().iter().any(|(m, p, _)| m == "PUT" && p == "/api/v1/workflows/wf-id"));
    let put = sent.lock().unwrap().iter().find(|(m, _, _)| m == "PUT").unwrap().2.clone();
    assert_eq!(put["revision"], "rev-1");
    assert_eq!(put["steps"].as_array().unwrap().len(), 5);
    assert_eq!(put["steps"][0]["fields"][2]["id"], "blockers");

    // The form card offers Answer to its recipient; the dialog sends the answers.
    let row = session.store.messages("room-id", 10).unwrap().remove(0).presentation("room-id", "alice-id");
    let form = workflows::row_form(&row).unwrap();
    let card = crate::workflow_forms::card(&session, "room-id", "message-id", form.clone(), "alice-id");
    assert_eq!(find(&card, "workflow-form-answer").len(), 1);
    let other = crate::workflow_forms::card(&session, "room-id", "message-id", form.clone(), "bob-id");
    assert!(find(&other, "workflow-form-answer").is_empty(), "someone else's form");
    let window = gtk::Window::new();
    window.set_child(Some(&card));
    window.present();
    let answer = crate::workflow_forms::open(&card, &session, "room-id", "message-id", &form);
    let fields = find(answer.upcast_ref(), "workflow-form-field");
    let view = fields[0].downcast_ref::<gtk::TextView>().unwrap();
    view.buffer().set_text(" Reviews ");
    // Checkboxes, not radios: mood "good" and the person Bob ticked.
    let picks = find(answer.upcast_ref(), "workflow-form-pick");
    assert_eq!(picks.len(), 3, "good, meh, Bob");
    let check = |i: usize| picks[i].downcast_ref::<gtk::CheckButton>().unwrap().clone();
    check(0).set_active(true);
    check(1).set_active(true);
    assert!(check(0).is_active() && check(1).is_active(), "no radio group: both stay ticked");
    check(1).set_active(false);
    check(2).set_active(true);
    find(answer.upcast_ref(), "workflow-form-submit")[0].downcast_ref::<gtk::Button>().unwrap().emit_clicked();
    until(|| sent.lock().unwrap().iter().any(|(_, p, _)| p == "/api/v1/forms/message-id/answer"));
    let answered = sent.lock().unwrap().iter().find(|(_, p, _)| p.ends_with("/answer")).unwrap().2.clone();
    assert_eq!(
        answered["answers"],
        serde_json::json!({"today":"Reviews","mood":["good"],"reviewers":["bob-id"]}),
        "a multiple field sends a list (FormAnswer::Many), a single one its value"
    );
    session.shutdown();
    // The widgets hold the session in their handlers: let them all go first.
    answer.force_close();
    window.destroy();
    // Widgets found above hold editor handlers, and so the session.
    drop((ups, labels, url, fields, picks));
    drop((answer, card, other, window, ed, ctx, list, host, dialog, page));
    until(|| Arc::strong_count(&session) == 1);
    runtime.block_on(http::close_native(session));
    let _ = std::fs::remove_file(path);
}

fn fixture_workflow() -> serde_json::Value {
    let fixture: serde_json::Value =
        serde_json::from_str(include_str!("../../../../../../docs/protocol/v1.fixture.json")).unwrap();
    fixture["workflows"]["workflow"].clone()
}

fn fixture_bots() -> serde_json::Value {
    let fixture: serde_json::Value =
        serde_json::from_str(include_str!("../../../../../../docs/protocol/v1.fixture.json")).unwrap();
    fixture["bots"]["bot_list"]["bots"].clone()
}
