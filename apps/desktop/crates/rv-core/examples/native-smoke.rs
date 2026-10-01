//! Real-server desktop/mobile scenario, driven by scripts/native-desktop-peer.ts.
use rv_client::NativeClient;
use rv_core::native::NativeSession;
use rv_core::session::Connection;
use rv_protocol::SendMessage;
use std::time::Duration;

async fn until(mut check: impl FnMut() -> bool) {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
    while !check() {
        assert!(tokio::time::Instant::now() < deadline, "native desktop condition timed out");
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}
async fn remote_has(client: &NativeClient, rid: &str, text: &str) {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
    loop {
        if client.history(rid, None).await.unwrap().messages.iter().any(|m| m.text == text) {
            return;
        }
        assert!(tokio::time::Instant::now() < deadline, "mobile peer timed out");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}
async fn marker(client: &NativeClient, rid: &str, text: &str) {
    client
        .send(rid, &SendMessage { operation_id: format!("{:032x}", fastrand::u128(..)), text: text.into() })
        .await
        .unwrap();
}
fn room(s: &NativeSession, name: &str) -> Option<String> {
    s.store.rooms().unwrap().into_iter().find(|r| r.name == name).map(|r| r.id)
}
fn has(s: &NativeSession, rid: &str, text: &str) -> bool {
    s.store.messages(rid, 1000).unwrap().iter().any(|m| m.text == text)
}
#[tokio::main]
async fn main() {
    let base = std::env::var("RV_PEER_URL").unwrap();
    let password = std::env::var("RV_PEER_PASSWORD").unwrap();
    let url = base.parse().unwrap();
    let info = rv_core::session::login(&url, "desktop", &password, None).await.unwrap();
    assert!(info.native.is_some());
    let path = std::env::temp_dir().join(format!("rv-native-smoke-{:032x}.sqlite", fastrand::u128(..)));
    let mut desktop = NativeSession::start(info.clone(), &path).unwrap();
    until(|| {
        desktop.status().connection == Connection::Online
            && room(&desktop, "native-pilot").is_some()
            && room(&desktop, "native-withdrawal").is_some()
    })
    .await;
    let rid = room(&desktop, "native-pilot").unwrap();
    let private = room(&desktop, "native-withdrawal").unwrap();
    until(|| has(&desktop, &rid, "Message du mobile") && has(&desktop, &private, "Private before withdrawal")).await;
    let discovery = desktop.spotlight("native-discovery").await.unwrap();
    let discovered = discovery
        .into_iter()
        .find_map(|hit| match hit {
            rv_core::rooms::Found::Room { id, .. } => Some(id),
            _ => None,
        })
        .unwrap();
    assert!(!desktop.store.rooms().unwrap().iter().any(|r| r.id == discovered));
    assert_eq!(desktop.join_public(&discovered).await.unwrap(), discovered);
    until(|| {
        desktop.status().connection == Connection::Online
            && desktop.store.rooms().unwrap().iter().any(|r| r.id == discovered)
    })
    .await;
    let mut control = NativeClient::new(&base).unwrap();
    control.restore(info.auth_token.clone());
    desktop.suspend();
    until(|| desktop.status().connection == Connection::Offline).await;
    let id = desktop.send(&rid, "Queued from desktop SQLite").unwrap();
    assert_eq!(desktop.store.pending().unwrap().len(), 1);
    desktop.store.set_draft(&rid, "Draft survives reopening").unwrap();
    marker(&control, &rid, "desktop-offline-trigger").await;
    remote_has(&control, &rid, "mobile-missed-while-desktop-offline").await;
    assert!(!has(&desktop, &rid, "mobile-missed-while-desktop-offline"));
    desktop.shutdown();
    drop(desktop);
    tokio::task::yield_now().await;
    desktop = NativeSession::start(info.clone(), &path).unwrap();
    until(|| {
        desktop.status().connection == Connection::Online
            && desktop.store.pending().unwrap().is_empty()
            && has(&desktop, &rid, "mobile-missed-while-desktop-offline")
    })
    .await;
    assert_eq!(desktop.store.draft(&rid).unwrap(), "Draft survives reopening");
    let history = control.history(&rid, None).await.unwrap();
    assert_eq!(history.messages.iter().filter(|m| m.id == id).count(), 1);
    let (message, rights) = desktop.message_action_context(&id).await.unwrap();
    assert!(rights.edit && rights.delete);
    desktop.edit(&rid, &id, &message.revision, "Edited from desktop SQLite").await.unwrap();
    until(|| has(&desktop, &rid, "Edited from desktop SQLite")).await;
    let (message, _) = desktop.message_action_context(&id).await.unwrap();
    desktop.delete(&rid, &id, &message.revision).await.unwrap();
    until(|| !desktop.store.messages(&rid, 1000).unwrap().iter().any(|m| m.id == id)).await;
    let created = desktop.create_room("Created by desktop", true).await.unwrap();
    until(|| {
        room(&desktop, "Created by desktop").as_deref() == Some(&created)
            && desktop.status().connection == Connection::Online
    })
    .await;
    desktop.invite(&created, "mobile").await.unwrap();
    let public = desktop.create_room("Desktop public discovery", false).await.unwrap();
    until(|| {
        desktop.status().connection == Connection::Online
            && desktop.store.rooms().unwrap().iter().any(|r| r.id == public)
    })
    .await;
    marker(&control, &rid, "desktop-public-created").await;
    remote_has(&control, &rid, "mobile-public-joined").await;
    remote_has(&control, &public, "Mobile joined desktop public").await;
    let dm = desktop.direct("mobile").await.unwrap();
    until(|| {
        desktop.status().connection == Connection::Online && desktop.store.rooms().unwrap().iter().any(|r| r.id == dm)
    })
    .await;
    let same = desktop.direct("mobile").await.unwrap();
    assert_eq!(dm, same);
    until(|| desktop.status().connection == Connection::Online).await;
    desktop.suspend();
    until(|| desktop.status().connection == Connection::Offline).await;
    desktop.send(&private, "Must never be sent after withdrawal").unwrap();
    marker(&control, &rid, "desktop-request-withdrawal").await;
    remote_has(&control, &rid, "mobile-withdrawal-complete").await;
    desktop.shutdown();
    drop(desktop);
    tokio::task::yield_now().await;
    desktop = NativeSession::start(info, &path).unwrap();
    until(|| desktop.status().connection == Connection::Online && desktop.store.pending().unwrap().is_empty()).await;
    assert!(desktop.store.messages(&private, 1000).unwrap().is_empty());
    assert!(room(&desktop, "native-withdrawal").is_none());
    marker(&control, &rid, "desktop-core-complete").await;
    desktop.logout().await.unwrap();
    assert!(control.me().await.is_err());
    desktop.shutdown();
    drop(desktop);
    tokio::time::sleep(Duration::from_millis(50)).await;
    std::fs::remove_file(path).unwrap();
    println!(
        "Native desktop core: mobile exchange, edit/delete commands, public discovery/join, on-disk outbox replay, drafts, DM, creation and withdrawal passed"
    );
}
