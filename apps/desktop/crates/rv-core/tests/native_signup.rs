mod common;
use common::{FakeHttp, respond};
use rv_core::native;
use serde_json::json;
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};

#[tokio::test]
async fn signup_is_anonymous_and_fences_generation_capability_and_authenticated_uid() {
    let fixture: serde_json::Value =
        serde_json::from_str(include_str!("../../../../../docs/protocol/v1.fixture.json")).unwrap();
    for scenario in ["ok", "capability", "before", "after", "uid", "after-login"] {
        let reads = Arc::new(AtomicUsize::new(0));
        let accepts = Arc::new(AtomicUsize::new(0));
        let logins = Arc::new(AtomicUsize::new(0));
        let (f, r, a, l) = (fixture.clone(), reads.clone(), accepts.clone(), logins.clone());
        let server = FakeHttp::start(move |request| {
            assert!(!request.headers.contains_key("authorization"));
            match request.path() {
                "/.well-known/rocketvibe" => {
                    let n = r.fetch_add(1, Ordering::SeqCst) + 1;
                    let mut discovery = f["discovery"].clone();
                    discovery["capabilities"]["account_invitations"] = json!(scenario != "capability");
                    if scenario == "before" || scenario == "after" && n >= 2 || scenario == "after-login" && n >= 4 {
                        discovery["data_epoch"] = json!("changed");
                    }
                    respond(200, &discovery.to_string())
                }
                "/api/v1/auth/invitations/accept" => {
                    a.fetch_add(1, Ordering::SeqCst);
                    let body: serde_json::Value = serde_json::from_str(&request.body).unwrap();
                    assert_eq!(body["token"], "a".repeat(64));
                    assert_eq!(body["password"], "new-password-2026");
                    let mut user = f["session"]["user"].clone();
                    if scenario == "uid" {
                        user["id"] = json!("different");
                    }
                    respond(200, &user.to_string())
                }
                "/api/v1/auth/login" => {
                    l.fetch_add(1, Ordering::SeqCst);
                    respond(200, &f["session"].to_string())
                }
                _ => respond(404, r#"{"code":"not_found","request_id":"fixture"}"#),
            }
        })
        .await;
        let discovery = serde_json::from_value(fixture["discovery"].clone()).unwrap();
        let result = native::register(&server.url, &discovery, &"a".repeat(64), "alice", "new-password-2026").await;
        if scenario == "ok" {
            assert_eq!(result.unwrap().user_id, fixture["session"]["user"]["id"].as_str().unwrap());
        } else {
            assert_eq!(
                result.unwrap_err().code(),
                if scenario == "capability" { "invitation_unavailable" } else { "server_identity_changed" }
            );
        }
        assert_eq!(accepts.load(Ordering::SeqCst), usize::from(scenario != "before" && scenario != "capability"));
        assert_eq!(logins.load(Ordering::SeqCst), usize::from(matches!(scenario, "ok" | "uid" | "after-login")));
    }
}
