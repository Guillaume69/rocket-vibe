//! A desktop session against the Mattermost bench (`docker/compose.mattermost.yml`,
//! seeded by `scripts/seed-mattermost.mjs`): `cargo run --example mattermost-smoke [url]`.
use std::time::Duration;

use rv_core::mattermost;
use rv_core::native::ServerKind;
use rv_core::rest::{CallOptions, Credentials, RestClient};
use rv_core::session::{self, Session, SessionEvent, SessionInfo};
use serde_json::json;

const PASSWORD: &str = "Rv-bench-2026!";

async fn until(what: &str, mut check: impl FnMut() -> bool) {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
    while !check() {
        assert!(tokio::time::Instant::now() < deadline, "timed out: {what}");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    println!("ok  {what}");
}

#[tokio::main]
async fn main() {
    let server = std::env::args().nth(1).unwrap_or_else(|| "http://localhost:8065".into());
    let url = session::normalize_server(&server).unwrap();
    let version = mattermost::probe(&url).await.expect("a Mattermost server");
    println!("ok  probe: Mattermost {version}");
    assert_eq!(rv_core::server::probe(&url).await.unwrap().genre, "mattermost");

    let info = session::login_as(&url, ServerKind::Auto, "rvadmin", PASSWORD, None).await.unwrap();
    assert_eq!(info.mattermost, Some(mattermost::Flavor::Mattermost));
    assert_eq!(SessionInfo::from_secret(&info.secret()).as_ref(), Some(&info));
    println!("ok  login and stored secret round trip");
    let wrong = session::login_as(&url, ServerKind::Mattermost, "rvadmin", "nope", None).await.unwrap_err();
    assert!(wrong.status == 401 && wrong.two_factor.is_none(), "{wrong:?}");
    println!("ok  a wrong password is a plain refusal");

    let bob = mattermost::login(&url, "bob", PASSWORD, None).await.unwrap();
    let peer = RestClient::mattermost(url.clone());
    peer.set_credentials(Some(Credentials { auth_token: bob.auth_token.clone(), user_id: bob.user_id.clone() }));

    let dir = tempfile::tempdir().unwrap();
    let s = Session::start(info.clone(), &dir.path().join("mm.sqlite")).unwrap();
    let mut events = s.events();
    until("rooms listed with the DM named after bob", || {
        let rooms = s.store.rooms();
        rooms.iter().any(|r| r.name == "Dev")
            && rooms.iter().any(|r| r.kind == "d" && r.dm_other_uid.as_deref() == Some(&bob.user_id))
    })
    .await;
    let dev = s.store.rooms().into_iter().find(|r| r.name == "Dev").unwrap();
    let page = s.open_room(&dev.rid, &dev.kind).await.unwrap();
    assert!(page.count > 0);
    println!("ok  history: {} posts", page.count);
    let older = s.sync.load_history(&dev.rid, &dev.kind, page.oldest_ts).await.unwrap();
    println!("ok  older page: {} posts", older.count);

    let online = tokio::time::timeout(Duration::from_secs(15), async {
        loop {
            if let Ok(SessionEvent::Connection(session::Connection::Online)) = events.recv().await {
                return;
            }
        }
    })
    .await;
    assert!(online.is_ok(), "socket never authenticated");
    println!("ok  socket authenticated");

    let tag = format!("{:08x}", fastrand::u32(..));
    let from_bob = format!("@rvadmin smoke {tag}");
    peer.post("posts", CallOptions::body(json!({"channel_id": dev.rid, "message": from_bob}))).await.unwrap();
    until("bob's post arrives live", || {
        s.store.messages(&dev.rid, 50).iter().any(|m| m.text.as_deref() == Some(&from_bob))
    })
    .await;
    let notified = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if let Ok(SessionEvent::Incoming(i)) = events.recv().await
                && i.body.as_deref().is_some_and(|b| b.contains(&tag))
            {
                return i.mentions_me;
            }
        }
    })
    .await;
    assert_eq!(notified, Ok(true), "no notification for a mention");
    println!("ok  notification with the mention");

    let mine = format!("desktop {tag}");
    s.send(&dev.rid, &mine).await;
    until("my post replaced by the server's", || {
        s.store.pending_outbox().is_empty()
            && s.store.messages(&dev.rid, 50).iter().filter(|m| m.text.as_deref() == Some(&mine)).count() == 1
    })
    .await;
    let list =
        peer.get(&format!("channels/{}/posts", dev.rid), CallOptions::params([("per_page", "30")])).await.unwrap();
    let copies = mattermost::sync::ordered(&list).iter().filter(|p| p["message"] == mine.as_str()).count();
    assert_eq!(copies, 1, "duplicated on the server");
    let id = s.store.messages(&dev.rid, 50).into_iter().find(|m| m.text.as_deref() == Some(&mine)).unwrap().id;

    s.react(&id, ":thumbsup:", true).await.unwrap();
    until("reaction stored", || {
        s.store.messages_by_id(std::slice::from_ref(&id))[0]
            .reactions
            .as_deref()
            .is_some_and(|r| r.contains("thumbsup"))
    })
    .await;
    s.edit(&dev.rid, &id, &format!("{mine} edited")).await.unwrap();
    until("edit stored", || s.store.messages_by_id(std::slice::from_ref(&id))[0].edited).await;
    s.pin(&id).await.unwrap();
    assert!(s.marked(&dev.rid, false).await.unwrap().iter().any(|m| m.id == id));
    println!("ok  pin listed");

    s.send_in(&dev.rid, &format!("reply {tag}"), Some(&id)).await;
    s.load_thread(&id).await.unwrap();
    until("thread reply stored", || s.store.thread_messages(&id).len() == 2).await;

    let found = s.search(&dev.rid, &tag).await.unwrap();
    assert!(!found.is_empty(), "search found nothing");
    println!("ok  search: {} hits", found.len());

    let file = dir.path().join("note.txt");
    std::fs::write(&file, format!("file {tag}")).unwrap();
    s.attach(&dev.rid, &file, "note.txt", "text/plain", Some(&format!("caption {tag}")), false).await.unwrap();
    until("file posted", || {
        s.store.messages(&dev.rid, 50).iter().any(|m| m.attachments.as_deref().is_some_and(|a| a.contains("note.txt")))
    })
    .await;
    let row = s.store.messages(&dev.rid, 50).into_iter().find(|m| m.text.as_deref() == Some(&format!("caption {tag}")));
    let attachments: serde_json::Value = serde_json::from_str(&row.unwrap().attachments.unwrap()).unwrap();
    if let Some(link) = attachments[0]["title_link"].as_str() {
        let bytes = s.media.fetch(link).await.unwrap();
        assert_eq!(bytes.bytes, format!("file {tag}").as_bytes());
        println!("ok  file downloaded with the bearer");
    }

    let avatar = rv_core::media::avatar_path(rv_core::media::AvatarTarget::User("bob"), None);
    assert!(s.media.fetch(&avatar).await.is_ok(), "bob's photo");
    println!("ok  avatar by username");

    let profile = s.profile("bob", false).await.unwrap();
    assert_eq!(profile.id, bob.user_id);
    let info_room = s.room_info(&dev.rid).await.unwrap();
    println!("ok  profile and room info ({} members)", info_room.members.unwrap_or(0));

    s.delete(&dev.rid, &id).await.unwrap();
    until("deleted", || s.store.messages_by_id(std::slice::from_ref(&id)).is_empty()).await;

    let rid = s.open_dm("carol").await.unwrap();
    until("DM with carol listed", || s.store.rooms().iter().any(|r| r.rid == rid)).await;

    peer.post("posts", CallOptions::body(json!({"channel_id": dev.rid, "message": format!("unread {tag}")})))
        .await
        .unwrap();
    s.open_room(&rid, "d").await.unwrap();
    tokio::time::sleep(Duration::from_millis(500)).await;
    s.shutdown();
    assert!(rv_core::account_unread::rocket_chat(&info).await.unwrap(), "unread for the rail");
    println!("ok  unread seen from outside the session");
    println!("ALL OK");
}
