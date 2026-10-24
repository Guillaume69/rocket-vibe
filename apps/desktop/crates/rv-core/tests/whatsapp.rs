use rv_core::whatsapp::{Connector, Runner, storage_key};
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
#[tokio::test(flavor = "multi_thread")]
async fn the_engine_runs_in_process_and_seals_its_state() {
    let dir = tempfile::tempdir().unwrap();
    let state = dir.path().join("state");
    let c = Connector::start(&Runner::InProcess, &state, storage_key().unwrap()).await.unwrap();
    until(&c, |s| s.loaded).await;
    c.stop();
    until(&c, |s| s.exited).await;
    let sealed = std::fs::read(&state).expect("sealed state");
    assert!(sealed.starts_with(b"RVWA2"), "a sealed state file");
}

#[tokio::test]
async fn native_connector_links_sends_and_revokes_without_a_server() {
    let c = Connector::start(
        &Runner::Helper(Path::new(env!("CARGO_BIN_EXE_fake-whatsapp-sidecar")).to_owned()),
        Path::new("synthetic"),
        storage_key().unwrap(),
    )
    .await
    .unwrap();
    until(&c, |s| s.qr.is_some()).await;
    c.reconnect().unwrap();
    until(&c, |s| s.state == "connected").await;
    assert!(c.snapshot().qr.is_none());
    assert_eq!(c.snapshot().messages.len(), 5);
    let photo = c.download("alice@s.whatsapp.net:fake-photo".into()).await.expect("photo file");
    assert!(std::fs::metadata(&photo).is_ok_and(|m| m.len() > 0));
    assert!(c.download("alice@s.whatsapp.net:fake-received".into()).await.is_err());
    until(&c, |s| s.name_of("alice@s.whatsapp.net") == Some("Alice Martin") && !s.avatars.is_empty()).await;
    c.react("alice@s.whatsapp.net:fake-received".into(), "👍".into()).unwrap();
    until(&c, |s| {
        s.reactions.get("alice@s.whatsapp.net:fake-received").and_then(|by| by.get("me")).map(String::as_str)
            == Some("👍")
    })
    .await;
    let id = c.send("alice@s.whatsapp.net".into(), "Native IPC test".into(), None).unwrap();
    until(&c, |s| s.messages.values().any(|m| m.id.ends_with(&id) && m.text == "Native IPC test" && m.mine)).await;
    c.logout().unwrap();
    until(&c, |s| s.state == "logged_out").await;
    assert!(c.snapshot().messages.is_empty());
}
#[tokio::test]
async fn stopping_reaps_the_child() {
    let c = Connector::start(
        &Runner::Helper(Path::new(env!("CARGO_BIN_EXE_fake-whatsapp-sidecar")).to_owned()),
        Path::new("synthetic"),
        storage_key().unwrap(),
    )
    .await
    .unwrap();
    until(&c, |s| s.qr.is_some()).await;
    let mut changes = c.subscribe();
    c.stop();
    until(&c, |s| s.state == "stopped" && s.exited).await;
    // The exit is announced to watchers too.
    tokio::time::timeout(Duration::from_secs(4), async {
        while !c.snapshot().exited || *changes.borrow_and_update() != c.revision() {
            changes.changed().await.ok();
        }
    })
    .await
    .expect("the exit reaches watchers");
    assert!(c.snapshot().qr.is_none());
    assert!(c.send("alice@s.whatsapp.net".into(), "must not send".into(), None).is_err());
}
#[tokio::test]
async fn a_refused_send_names_its_id_and_keeps_the_connection() {
    let c = Connector::start(
        &Runner::Helper(Path::new(env!("CARGO_BIN_EXE_fake-whatsapp-sidecar")).to_owned()),
        Path::new("synthetic"),
        storage_key().unwrap(),
    )
    .await
    .unwrap();
    until(&c, |s| s.loaded && s.qr.is_some()).await;
    c.reconnect().unwrap();
    until(&c, |s| s.state == "connected").await;
    let id = c.send("refused@s.whatsapp.net".into(), "Never leaves".into(), None).unwrap();
    until(&c, |s| s.refused.as_deref() == Some(id.as_str())).await;
    let s = c.snapshot();
    assert_eq!(s.state, "connected");
    assert!(!s.messages.keys().any(|key| key.ends_with(&id)));
    c.stop();
    until(&c, |s| s.exited).await;
}
#[tokio::test]
async fn a_phone_number_gets_a_pairing_code_and_a_bad_one_leaves_the_qr() {
    let c = Connector::start(
        &Runner::Helper(Path::new(env!("CARGO_BIN_EXE_fake-whatsapp-sidecar")).to_owned()),
        Path::new("synthetic"),
        storage_key().unwrap(),
    )
    .await
    .unwrap();
    until(&c, |s| s.qr.is_some()).await;
    c.pair_phone("336".into()).unwrap();
    until(&c, |s| s.error.as_deref() == Some("phone_invalid")).await;
    assert!(c.snapshot().qr.is_some() && c.snapshot().state != "error");
    c.pair_phone("33612345678".into()).unwrap();
    until(&c, |s| s.pairing_code.as_deref() == Some("RVWA2468")).await;
    assert!(c.snapshot().error.is_none());
    c.stop();
    until(&c, |s| s.exited).await;
}

mod session {
    use rv_core::whatsapp::{Runner, account_info, state_location, storage_key};
    use rv_core::whatsapp_session::{KeySource, Notice, WaSession};
    use std::sync::Arc;
    use std::time::Duration;

    async fn until(s: &WaSession, what: &str, condition: impl Fn(&WaSession) -> bool) {
        let mut changes = s.subscribe();
        tokio::time::timeout(Duration::from_secs(6), async {
            while !condition(s) {
                // A closed or already-seen watch answers at once: yield anyway,
                // or the test's single thread never runs the helper's worker.
                if !matches!(tokio::time::timeout(Duration::from_millis(50), changes.changed()).await, Ok(Ok(()))) {
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
            }
        })
        .await
        .unwrap_or_else(|_| panic!("timed out waiting for {what}"));
    }

    fn keys() -> KeySource {
        Arc::new(|_entry, _has_state| Box::pin(async { storage_key() }))
    }

    #[tokio::test]
    async fn a_linked_account_lists_reads_notifies_and_unlinks() {
        let data = tempfile::tempdir().unwrap();
        let (path, _) = state_location(data.path(), "t1");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, "paired").unwrap();
        let program = Runner::Helper(std::path::PathBuf::from(env!("CARGO_BIN_EXE_fake-whatsapp-sidecar")));
        let info = account_info("t1", "33600000000@s.whatsapp.net", "Moi-même");
        let s = WaSession::start(info, program, data.path().into(), keys());
        let mut notices = s.notices();
        until(&s, "connected with both chats", |s| s.snapshot().state == "connected" && s.room_rows().len() == 2).await;
        let rows = s.room_rows();
        let alice = rows.iter().find(|r| r.rid == "alice@s.whatsapp.net").unwrap();
        assert_eq!((alice.name.as_str(), alice.kind.as_str()), ("Alice Martin", "d"));
        assert!(alice.avatar_etag.is_some());
        let friends = rows.iter().find(|r| r.rid == "friends@g.us").unwrap();
        assert_eq!((friends.kind.as_str(), friends.unread), ("p", 2));
        let timeline = s.timeline("alice@s.whatsapp.net");
        assert_eq!(timeline.len(), 4);
        let photo = timeline.iter().find(|d| d.row.id.ends_with("fake-photo")).unwrap();
        let images = rv_core::media::image_attachments(photo.row.attachments.as_deref());
        assert_eq!(images[0].source, "wa-media:alice@s.whatsapp.net:fake-photo");
        assert_eq!(photo.row.text.as_deref(), Some("La vue d'ici"));
        let voice = timeline.iter().find(|d| d.row.id.ends_with("fake-voice")).unwrap();
        let files = rv_core::content::files(voice.row.attachments.as_deref());
        assert_eq!(
            (files[0].kind, files[0].url.as_str()),
            (rv_core::content::FileKind::Audio, "wa-media:alice@s.whatsapp.net:fake-voice")
        );
        // Opening the group reads it.
        s.mark_read("friends@g.us");
        until(&s, "the group read", |s| s.room_rows().iter().all(|r| r.unread == 0)).await;
        // Nothing was notified for what was there; an answer is.
        s.send("ping@s.whatsapp.net", "ping", None).unwrap();
        assert!(s.send("ping@s.whatsapp.net", "again", None).is_err() || !s.sending("ping@s.whatsapp.net"));
        let notice = tokio::time::timeout(Duration::from_secs(6), async {
            loop {
                if let Ok(Notice::Incoming(incoming)) = notices.recv().await {
                    return incoming;
                }
            }
        })
        .await
        .expect("a notification");
        assert_eq!((notice.rid.as_str(), notice.body.as_deref()), ("ping@s.whatsapp.net", Some("pong")));
        until(&s, "the ping sent", |s| !s.sending("ping@s.whatsapp.net")).await;
        // Read, then a new message brings the same count back: read again.
        let unread = |s: &WaSession| s.room_rows().iter().find(|r| r.rid == "ping@s.whatsapp.net").map(|r| r.unread);
        until(&s, "the pong unread", |s| unread(s) == Some(1)).await;
        s.mark_read("ping@s.whatsapp.net");
        until(&s, "the pong read", |s| unread(s) == Some(0)).await;
        s.send("ping@s.whatsapp.net", "ping again", None).unwrap();
        until(&s, "the second pong unread", |s| unread(s) == Some(1)).await;
        s.mark_read("ping@s.whatsapp.net");
        until(&s, "the second pong read", |s| unread(s) == Some(0)).await;
        s.unlink().await.expect("unlinked");
        assert!(s.is_closed());
    }

    #[tokio::test]
    async fn a_state_gone_ends_the_account() {
        let data = tempfile::tempdir().unwrap();
        let program = Runner::Helper(std::path::PathBuf::from(env!("CARGO_BIN_EXE_fake-whatsapp-sidecar")));
        let s = WaSession::start(account_info("gone", "1@s.whatsapp.net", ""), program, data.path().into(), keys());
        let mut notices = s.notices();
        let expired = tokio::time::timeout(Duration::from_secs(6), async {
            loop {
                if let Ok(Notice::Expired) = notices.recv().await {
                    return;
                }
            }
        })
        .await;
        assert!(expired.is_ok(), "no state, no account");
    }

    #[tokio::test]
    async fn shutting_down_keeps_the_link() {
        let data = tempfile::tempdir().unwrap();
        let (path, _) = state_location(data.path(), "t2");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, "paired").unwrap();
        let program = Runner::Helper(std::path::PathBuf::from(env!("CARGO_BIN_EXE_fake-whatsapp-sidecar")));
        let s =
            WaSession::start(account_info("t2", "33600000000@s.whatsapp.net", ""), program, data.path().into(), keys());
        until(&s, "connected", |s| s.snapshot().state == "connected").await;
        s.shutdown();
        s.exited(Duration::from_secs(6)).await;
        assert!(s.snapshot().exited && s.snapshot().state == "stopped");
        assert!(path.exists());
    }
}
