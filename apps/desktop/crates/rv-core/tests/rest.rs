mod common;

use common::{FakeHttp, dropped, respond};
use rv_core::rest::{CallOptions, Credentials, RestClient, TwoFactorCode, is_token_rejected};
use serde_json::json;

fn client(server: &FakeHttp, token: Option<&str>) -> RestClient {
    let c = RestClient::new(server.url.clone());
    c.set_credentials(token.map(|t| Credentials { auth_token: t.into(), user_id: "uid".into() }));
    c
}

fn anonymous() -> CallOptions {
    CallOptions { anonymous: true, ..Default::default() }
}

#[tokio::test]
async fn revoked_token_is_reported_with_the_token_sent() {
    let server = FakeHttp::queue(vec![respond(
        401,
        r#"{"success":false,"error":"You must be logged in to do this.","status":"error"}"#,
    )])
    .await;
    let c = client(&server, Some("tok-1"));
    let mut rejected = c.token_rejected();
    let e = c.get("me", CallOptions::default()).await.unwrap_err();
    assert_eq!(e.status, 401);
    assert!(e.understood);
    assert_eq!(rejected.try_recv().unwrap(), "tok-1");
    assert_eq!(server.requests()[0].headers["x-auth-token"], "tok-1");
}

#[tokio::test]
async fn proxy_unauthorized_is_not_a_revocation() {
    let server = FakeHttp::queue(vec![respond(401, r#"{"message":"Unauthorized"}"#)]).await;
    let c = client(&server, Some("tok"));
    let mut rejected = c.token_rejected();
    let e = c.get("me", CallOptions::default()).await.unwrap_err();
    assert!(!e.understood);
    assert!(rejected.try_recv().is_err());
}

#[tokio::test]
async fn anonymous_calls_never_revoke() {
    let server =
        FakeHttp::queue(vec![respond(401, r#"{"status":"error","error":"Unauthorized","message":"Unauthorized"}"#)])
            .await;
    let c = client(&server, Some("tok"));
    let mut rejected = c.token_rejected();
    assert!(c.post("login", anonymous()).await.is_err());
    assert!(rejected.try_recv().is_err());
    assert!(!server.requests()[0].headers.contains_key("x-auth-token"));
}

#[tokio::test]
async fn login_two_factor_challenge_is_detected() {
    let server = FakeHttp::queue(vec![respond(
        401,
        r#"{"status":"error","error":"totp-required","details":{"method":"totp","codeGenerated":false,"availableMethods":["totp"]}}"#,
    )])
    .await;
    let c = client(&server, None);
    let e = c.post("login", anonymous()).await.unwrap_err();
    let challenge = e.two_factor.clone().unwrap();
    assert_eq!(challenge.method, "totp");
    assert_eq!(challenge.methods, ["totp"]);
    assert!(!is_token_rejected(&e));
}

#[tokio::test]
async fn two_factor_headers_are_sent() {
    let server = FakeHttp::queue(vec![respond(200, r#"{"status":"success","data":{}}"#)]).await;
    let c = client(&server, None);
    let options =
        CallOptions { two_factor: Some(TwoFactorCode { code: "123456".into(), method: "totp".into() }), ..anonymous() };
    c.post("login", options).await.unwrap();
    let headers = &server.requests()[0].headers;
    assert_eq!(headers["x-2fa-code"], "123456");
    assert_eq!(headers["x-2fa-method"], "totp");
}

#[tokio::test]
async fn rate_limit_is_retried_after_reset() {
    let reset = (chrono::Utc::now().timestamp_millis() + 100).to_string();
    let mut limited = respond(429, r#"{"success":false,"error":"Too many requests"}"#);
    limited.headers.push(("x-ratelimit-reset".into(), reset));
    let server = FakeHttp::queue(vec![limited, respond(200, r#"{"success":true,"value":42}"#)]).await;
    let v = client(&server, None).get("me", CallOptions::default()).await.unwrap();
    assert_eq!(v["value"], 42);
    assert_eq!(server.requests().len(), 2);
}

#[tokio::test]
async fn empty_success_body_is_ok() {
    let server = FakeHttp::queue(vec![respond(200, "")]).await;
    assert_eq!(client(&server, None).post("logout", CallOptions::default()).await.unwrap(), json!({}));
}

#[tokio::test]
async fn non_json_is_not_understood() {
    let server = FakeHttp::queue(vec![respond(401, "<html>Portal</html>")]).await;
    let c = client(&server, Some("tok"));
    let mut rejected = c.token_rejected();
    let e = c.get("me", CallOptions::default()).await.unwrap_err();
    assert_eq!(e.status, 401);
    assert!(rejected.try_recv().is_err());
}

#[tokio::test]
async fn dropped_connection_is_status_zero() {
    let server = FakeHttp::start(|_| dropped()).await;
    let e = client(&server, None).get("me", CallOptions::default()).await.unwrap_err();
    assert_eq!(e.status, 0);
}

#[tokio::test]
async fn network_retry_only_when_asked() {
    let server = FakeHttp::queue(vec![dropped(), respond(200, r#"{"success":true}"#)]).await;
    let options = CallOptions { retry_on_network_error: true, ..Default::default() };
    client(&server, None).post("users.setStatus", options).await.unwrap();
    assert_eq!(server.requests().len(), 2);

    let server = FakeHttp::queue(vec![dropped(), respond(200, r#"{"success":true}"#)]).await;
    assert!(client(&server, None).post("chat.sendMessage", CallOptions::default()).await.is_err());
    assert_eq!(server.requests().len(), 1);
}

#[tokio::test]
async fn query_is_encoded() {
    let server = FakeHttp::queue(vec![respond(200, r#"{"success":true}"#)]).await;
    let options = CallOptions::params([("updatedSince", "2026-09-22T10:00:00.000Z"), ("q", "a+b&c")]);
    client(&server, None).get("rooms.get", options).await.unwrap();
    assert_eq!(server.requests()[0].target, "/api/v1/rooms.get?updatedSince=2026-09-22T10%3A00%3A00.000Z&q=a%2Bb%26c");
}
