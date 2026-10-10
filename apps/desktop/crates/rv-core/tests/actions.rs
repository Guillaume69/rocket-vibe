mod common;

use common::{FakeHttp, respond};
use rv_core::actions::{self, ServerSettings};
use rv_core::rest::{Credentials, RestClient};
use serde_json::{Value, json};

fn client(server: &FakeHttp) -> RestClient {
    let c = RestClient::new(server.url.clone());
    c.set_credentials(Some(Credentials { auth_token: "tok".into(), user_id: "me".into() }));
    c
}

fn body(server: &FakeHttp, i: usize) -> (String, Value) {
    let r = &server.requests()[i];
    (r.path().to_owned(), serde_json::from_str(&r.body).unwrap_or(Value::Null))
}

#[tokio::test]
async fn actions_send_what_the_server_expects() {
    let server = FakeHttp::start(|r| {
        if r.path().ends_with("chat.update") {
            respond(200, r#"{"success":true,"message":{"_id":"M1","msg":"new"}}"#)
        } else {
            respond(200, r#"{"success":true}"#)
        }
    })
    .await;
    let c = client(&server);
    actions::react(&c, "M1", ":+1:", true).await.unwrap();
    assert_eq!(actions::edit(&c, "R1", "M1", "new").await.unwrap()["msg"], "new");
    actions::delete(&c, "R1", "M1").await.unwrap();
    actions::pin(&c, "M1").await.unwrap();

    assert_eq!(
        body(&server, 0),
        ("/api/v1/chat.react".into(), json!({"messageId": "M1", "emoji": ":+1:", "shouldReact": true}))
    );
    assert_eq!(body(&server, 1), ("/api/v1/chat.update".into(), json!({"roomId": "R1", "msgId": "M1", "text": "new"})));
    assert_eq!(body(&server, 2), ("/api/v1/chat.delete".into(), json!({"roomId": "R1", "msgId": "M1"})));
    assert_eq!(body(&server, 3), ("/api/v1/chat.pinMessage".into(), json!({"messageId": "M1"})));
}

#[tokio::test]
async fn settings_are_read_whole_and_anonymously() {
    let server = FakeHttp::queue(vec![respond(
        200,
        r#"{"success":true,"settings":[{"_id":"Message_AllowEditing","value":false},{"_id":"Site_Url","value":"https://site"}]}"#,
    )])
    .await;
    let settings = ServerSettings::fetch(&client(&server)).await;
    assert!(!settings.editing_allowed);
    assert_eq!(settings.site_url.as_deref(), Some("https://site"));
    let request = &server.requests()[0];
    assert_eq!(request.target, "/api/v1/settings.public?count=0");
    assert!(!request.headers.contains_key("x-auth-token"));
}

#[tokio::test]
async fn threads_are_listed_by_page_and_followed() {
    let server = FakeHttp::start(|r| {
        if r.path().ends_with("chat.getThreadsList") {
            respond(
                200,
                r#"{"success":true,"threads":[{"_id":"T1","replies":["me"]}],"count":1,"offset":50,"total":51}"#,
            )
        } else {
            respond(200, r#"{"success":true}"#)
        }
    })
    .await;
    let c = client(&server);
    let (threads, total) = actions::threads(&c, "R1", true, 50, 50).await.unwrap();
    assert_eq!((threads.len(), threads[0]["_id"].as_str(), total), (1, Some("T1"), 51));
    actions::threads(&c, "R1", false, 0, 50).await.unwrap();
    actions::follow_thread(&c, "T1", true).await.unwrap();
    actions::follow_thread(&c, "T1", false).await.unwrap();

    let requests = server.requests();
    assert_eq!(requests[0].target, "/api/v1/chat.getThreadsList?rid=R1&offset=50&count=50&type=following");
    assert_eq!(requests[1].target, "/api/v1/chat.getThreadsList?rid=R1&offset=0&count=50");
    assert_eq!(body(&server, 2), ("/api/v1/chat.followMessage".into(), json!({"mid": "T1"})));
    assert_eq!(body(&server, 3), ("/api/v1/chat.unfollowMessage".into(), json!({"mid": "T1"})));
}

#[tokio::test]
async fn rooms_are_marked_unread_and_read_with_their_threads() {
    let server = FakeHttp::queue(vec![
        respond(200, r#"{"success":true}"#),
        respond(200, r#"{"success":true}"#),
        respond(
            400,
            r#"{"success":false,"error":"There are no messages to mark unread [error-no-message-for-unread]","errorType":"error-no-message-for-unread"}"#,
        ),
    ])
    .await;
    let c = client(&server);
    actions::mark_unread(&c, "R1").await.unwrap();
    actions::mark_read(&c, "R1").await.unwrap();
    let empty = actions::mark_unread(&c, "R2").await.unwrap_err();
    assert_eq!((empty.status, empty.error_type.as_deref()), (400, Some(actions::NOTHING_TO_UNREAD)));

    assert_eq!(body(&server, 0), ("/api/v1/subscriptions.unread".into(), json!({"roomId": "R1"})));
    assert_eq!(body(&server, 1), ("/api/v1/subscriptions.read".into(), json!({"rid": "R1", "readThreads": true})));
}
