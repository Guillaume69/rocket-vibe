use rv_core::whatsapp::{Connector, storage_key};
use std::path::Path;
use std::time::Duration;

async fn until(c: &Connector, condition: impl Fn(&rv_core::whatsapp::Snapshot) -> bool) {
    tokio::time::timeout(Duration::from_secs(4), async {
        loop {
            if condition(&c.snapshot()) {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("connector state");
}
#[tokio::test]
async fn native_connector_links_sends_and_revokes_without_a_server() {
    let c = Connector::start(
        Path::new(env!("CARGO_BIN_EXE_fake-whatsapp-sidecar")),
        Path::new("synthetic"),
        storage_key().unwrap(),
    )
    .await
    .unwrap();
    until(&c, |s| s.qr.is_some()).await;
    c.reconnect().unwrap();
    until(&c, |s| s.state == "connected").await;
    assert!(c.snapshot().qr.is_none());
    assert_eq!(c.snapshot().messages.len(), 2);
    until(&c, |s| s.name_of("alice@s.whatsapp.net") == Some("Alice Martin") && !s.avatars.is_empty()).await;
    c.react("alice@s.whatsapp.net:fake-received".into(), "👍".into()).unwrap();
    until(&c, |s| {
        s.reactions.get("alice@s.whatsapp.net:fake-received").and_then(|by| by.get("me")).map(String::as_str)
            == Some("👍")
    })
    .await;
    let id = c.send("alice@s.whatsapp.net".into(), "Native IPC test".into()).unwrap();
    until(&c, |s| s.messages.values().any(|m| m.id.ends_with(&id) && m.text == "Native IPC test" && m.mine)).await;
    c.logout().unwrap();
    until(&c, |s| s.state == "logged_out").await;
    assert!(c.snapshot().messages.is_empty());
}
#[tokio::test]
async fn stopping_reaps_the_child() {
    let c = Connector::start(
        Path::new(env!("CARGO_BIN_EXE_fake-whatsapp-sidecar")),
        Path::new("synthetic"),
        storage_key().unwrap(),
    )
    .await
    .unwrap();
    until(&c, |s| s.qr.is_some()).await;
    c.stop();
    until(&c, |s| s.state == "stopped" && s.exited).await;
    assert!(c.snapshot().qr.is_none());
    assert!(c.send("alice@s.whatsapp.net".into(), "must not send".into()).is_err());
}
#[tokio::test]
async fn a_refused_send_names_its_id_and_keeps_the_connection() {
    let c = Connector::start(
        Path::new(env!("CARGO_BIN_EXE_fake-whatsapp-sidecar")),
        Path::new("synthetic"),
        storage_key().unwrap(),
    )
    .await
    .unwrap();
    until(&c, |s| s.loaded && s.qr.is_some()).await;
    c.reconnect().unwrap();
    until(&c, |s| s.state == "connected").await;
    let id = c.send("refused@s.whatsapp.net".into(), "Never leaves".into()).unwrap();
    until(&c, |s| s.refused.as_deref() == Some(id.as_str())).await;
    let s = c.snapshot();
    assert_eq!(s.state, "connected");
    assert!(!s.messages.keys().any(|key| key.ends_with(&id)));
    c.stop();
    until(&c, |s| s.exited).await;
}
