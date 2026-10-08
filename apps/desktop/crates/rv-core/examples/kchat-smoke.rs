//! A desktop session against a real kChat account, writing only to the DM with
//! oneself: `RV_KCHAT_TOKEN=<Infomaniak API token> cargo run --example kchat-smoke [server]`.
//! Without a server, the account's only kChat server is used.
use std::time::Duration;

use rv_core::mattermost::{self, Flavor};
use rv_core::native::ServerKind;
use rv_core::rest::{CallOptions, Credentials};
use rv_core::session::{self, Connection, Session, SessionEvent};
use serde_json::json;

async fn until(what: &str, mut check: impl FnMut() -> bool) {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
    while !check() {
        assert!(tokio::time::Instant::now() < deadline, "timed out: {what}");
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    println!("ok  {what}");
}

#[tokio::main]
async fn main() {
    let token = std::env::var("RV_KCHAT_TOKEN").expect("RV_KCHAT_TOKEN");
    let server = std::env::args().nth(1).unwrap_or_else(|| "kchat.infomaniak.com".into());
    let url = session::normalize_server(&server).unwrap();
    assert_eq!(rv_core::server::probe(&url).await.unwrap().genre, "kchat");
    let info = session::login_as(&url, ServerKind::Auto, "", &token, None).await.unwrap();
    assert_eq!(info.mattermost, Some(Flavor::Kchat));
    println!("ok  signed in on {}", info.base_url);

    let rest = mattermost::client(info.base_url.parse().unwrap(), Some(Flavor::Kchat));
    rest.set_credentials(Some(Credentials { auth_token: token.clone(), user_id: info.user_id.clone() }));
    let me = info.user_id.clone();
    let dm = rest.post("channels/direct", CallOptions::body(json!([me, me]))).await.unwrap();
    let rid = dm["id"].as_str().unwrap().to_owned();

    let dir = tempfile::tempdir().unwrap();
    let s = Session::start(info.clone(), &dir.path().join("kchat.sqlite")).unwrap();
    let mut events = s.events();
    until("rooms listed, the DM with myself among them", || s.store.rooms().iter().any(|r| r.rid == rid)).await;
    let online = tokio::time::timeout(Duration::from_secs(20), async {
        loop {
            if let Ok(SessionEvent::Connection(Connection::Online)) = events.recv().await {
                return;
            }
        }
    })
    .await;
    assert!(online.is_ok(), "Pusher never authenticated");
    println!("ok  Pusher channels authorized");
    s.open_room(&rid, "d").await.unwrap();

    let tag = format!("{:08x}", fastrand::u32(..));
    let outside = format!("rocket-vibe kChat smoke {tag} (from another client)");
    let pending = mattermost::pending_post_id(&me, &format!("{:024x}", fastrand::u128(..)));
    let body = json!({"channel_id": rid, "message": outside, "pending_post_id": pending});
    rest.post("posts", CallOptions::body(body)).await.unwrap();
    until("a post made elsewhere arrives live", || {
        s.store.messages(&rid, 50).iter().any(|m| m.text.as_deref() == Some(&outside))
    })
    .await;

    let mine = format!("rocket-vibe kChat smoke {tag}");
    s.send(&rid, &mine).await;
    until("my post accepted, once", || {
        s.store.pending_outbox().is_empty()
            && s.store.messages(&rid, 50).iter().filter(|m| m.text.as_deref() == Some(&mine)).count() == 1
    })
    .await;
    let list = rest.get(&format!("channels/{rid}/posts"), CallOptions::params([("per_page", "20")])).await.unwrap();
    let copies = mattermost::sync::ordered(&list).iter().filter(|p| p["message"] == mine.as_str()).count();
    assert_eq!(copies, 1, "duplicated on the server");
    let id = s.store.messages(&rid, 50).into_iter().find(|m| m.text.as_deref() == Some(&mine)).unwrap().id;

    s.react(&id, ":thumbsup:", true).await.unwrap();
    until("reaction stored", || {
        s.store.messages_by_id(std::slice::from_ref(&id))[0]
            .reactions
            .as_deref()
            .is_some_and(|r| r.contains("thumbsup"))
    })
    .await;
    s.edit(&rid, &id, &format!("{mine} edited")).await.unwrap();
    until("edit stored", || s.store.messages_by_id(std::slice::from_ref(&id))[0].edited).await;

    let file = dir.path().join("note.txt");
    std::fs::write(&file, format!("file {tag}")).unwrap();
    s.attach(&rid, &file, "note.txt", "text/plain", Some(&format!("caption {tag}")), false).await.unwrap();
    until("file posted", || {
        s.store.messages(&rid, 50).iter().any(|m| m.text.as_deref() == Some(&format!("caption {tag}")))
    })
    .await;

    let posted: Vec<String> = s
        .store
        .messages(&rid, 50)
        .into_iter()
        .filter(|m| m.text.as_deref().is_some_and(|t| t.contains(&tag)))
        .map(|m| m.id)
        .collect();
    for id in &posted {
        s.delete(&rid, id).await.unwrap();
    }
    until("cleaned up", || s.store.messages_by_id(&posted).is_empty()).await;
    s.shutdown();
    println!("ALL OK");
}
