//! Disposable browser/GTK interoperability. The existing desktop controllers
//! create a real installation in Secret Service, then the actual GTK composer
//! and timeline exchange MLS messages with the production browser frontend.
use super::check;
use crate::{on_tokio, window::AppWindow};
use adw::prelude::*;
use gtk::glib;
use rv_core::native::{crypto::enrollment::peers::RootChoice, security::Guard};
use std::{path::PathBuf, rc::Rc, sync::Arc, time::Duration};

struct Fixture {
    room: String,
    peer: String,
    fingerprint: String,
}

pub(super) fn install(window: &Rc<AppWindow>) {
    let Ok(directory) = std::env::var("RV_SMOKE_WEB_CRYPTO") else { return };
    let weak = Rc::downgrade(window);
    let mut polls = 0;
    glib::timeout_add_local(Duration::from_millis(100), move || {
        let Some(window) = weak.upgrade() else { return glib::ControlFlow::Break };
        polls += 1;
        if let Some(session) = window.chat.native_session()
            && session.crypto_settings_supported()
            && session.status().connection == rv_core::session::Connection::Online
        {
            assert!(session.info.username.starts_with("gtkweb"));
            assert!(
                ["http://host.docker.internal:3417", "http://host.docker.internal:3420"]
                    .contains(&session.info.base_url.trim_end_matches('/')),
                "GTK interoperability requires a dedicated local bench"
            );
            let directory = PathBuf::from(&directory);
            glib::spawn_future_local(async move {
                run(window.clone(), directory).await;
                window.window.application().expect("application").quit();
            });
            return glib::ControlFlow::Break;
        }
        if polls >= 300 {
            check("GTK encrypted interoperability connected", false, polls);
            window.window.application().expect("application").quit();
            return glib::ControlFlow::Break;
        }
        glib::ControlFlow::Continue
    });
}

async fn run(window: Rc<AppWindow>, directory: PathBuf) {
    let value: serde_json::Value =
        serde_json::from_slice(&std::fs::read(directory.join("fixture.json")).unwrap()).unwrap();
    let fixture = Fixture {
        room: value["room"].as_str().unwrap().to_owned(),
        peer: value["peer"].as_str().unwrap().to_owned(),
        fingerprint: value["fingerprint"].as_str().unwrap().to_owned(),
    };
    let session = window.chat.native_session().unwrap();
    let path = glib::user_data_dir().join("rocket-vibe-rs/native-crypto");
    let room = fixture.room.clone();
    let setup = on_tokio(async move {
        let access =
            session.crypto_settings(Guard::new(), path, Arc::new(rv_crypto::protected::system::Keyring)).await?;
        let view = access.refresh().await?;
        let view = access.begin(view.remote_fingerprint).await?;
        let preview = access.preview(view.request_code).await?;
        let code = access.approve(preview).await?;
        let view = access.install(code).await?;
        assert!(matches!(view.stage, rv_core::native::crypto::enrollment::Stage::Ready));
        let peer = access.peer(fixture.peer).await?;
        assert_eq!(peer.fingerprint, fixture.fingerprint);
        let peer = access.pin_peer(peer, RootChoice::FirstContact, fixture.fingerprint.clone(), String::new()).await?;
        let peer = access.pin_peer(peer, RootChoice::Verify, fixture.fingerprint, String::new()).await?;
        assert_eq!(peer.devices.len(), 1);
        let device = peer.devices[0].id.clone();
        let preview = access.preview_peer_device(peer, device).await?;
        access.approve_peer_device(preview).await?;
        let group = access.room(room).await?;
        let observed = group.refresh().await?;
        let observed = group.publish_packages(observed.revision).await?;
        assert!(!observed.has_event);
        Ok::<_, rv_core::native::crypto::Error>((group, view.root_fingerprint))
    })
    .await;
    let (group, fingerprint) = match setup {
        Ok(value) => value,
        Err(error) => {
            eprintln!("GTK browser crypto setup: {error}");
            check("GTK encrypted interoperability installation", false, 0);
            return;
        }
    };
    std::fs::write(
        directory.join("ready.json"),
        serde_json::to_vec(&serde_json::json!({"fingerprint": fingerprint})).unwrap(),
    )
    .unwrap();
    let accepted = on_tokio(async move {
        for _ in 0..600 {
            let view = group.refresh().await?;
            if view.has_event {
                let view = group.preview_event(view.revision).await?;
                let fingerprint = view.review.as_ref().unwrap().fingerprint.clone();
                let view = group.confirm(view.revision, fingerprint).await?;
                assert!(matches!(view.phase, rv_core::native::crypto::enrollment::rooms::Phase::Acknowledged));
                return Ok::<_, rv_core::native::crypto::Error>(());
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        panic!("GTK encrypted interoperability admission timed out");
    })
    .await;
    if let Err(error) = accepted {
        eprintln!("GTK browser crypto admission: {error}");
        check("GTK encrypted interoperability admission", false, 0);
        return;
    }
    window.chat.open_room(&fixture.room);
    std::fs::write(directory.join("admitted"), b"ready").unwrap();
    let mut sent = false;
    for _ in 0..900 {
        let texts = window.chat.message_texts();
        if !sent && texts.iter().any(|text| text.contains("Private browser to GTK")) {
            check("GTK renders browser MLS message", true, 1);
            assert!(!texts.iter().any(|text| text.contains("Browser before desktop admission")));
            window.chat.composer().set_text("Private GTK to browser");
            window.chat.composer().submit_now();
            sent = true;
        }
        if sent && texts.iter().any(|text| text.contains("Browser confirms GTK decryption")) {
            check("GTK receives encrypted browser acknowledgment", true, 1);
            std::fs::write(directory.join("round-trip-passed"), b"passed").unwrap();
            history(window, directory, &fixture.room).await;
            return;
        }
        glib::timeout_future(Duration::from_millis(100)).await;
    }
    check("GTK encrypted interoperability round trip", false, sent);
}

/// A real browser seeds more than one private page after admission. Open the
/// room afresh, then follow the same jump callback that search results use.
async fn history(window: Rc<AppWindow>, directory: PathBuf, room: &str) {
    let history = directory.join("history.json");
    // The external browser performs 204 accepted encrypted writes through the
    // real worker; slower CI machines can take longer than ten minutes.
    for _ in 0..45000 {
        if history.exists() {
            break;
        }
        glib::timeout_future(Duration::from_millis(100)).await;
    }
    let value: serde_json::Value =
        serde_json::from_slice(&std::fs::read(history).expect("browser history fixture")).unwrap();
    let oldest = value["oldest"].as_str().unwrap();
    let newest = value["newest"].as_str().unwrap();
    let id = value["id"].as_str().unwrap();
    let count = value["count"].as_u64().unwrap();
    assert!(count > 200);
    let session = window.chat.native_session().unwrap();
    // The identity comparison created this pair's ordinary DM. Opening it and
    // returning uses real room navigation, dropping the previous private view.
    let other = session.store.rooms().unwrap().into_iter().find(|r| r.id != room).expect("comparison DM");
    window.chat.open_room(&other.id);
    window.chat.open_room(room);
    let mut latest = false;
    for _ in 0..1200 {
        let texts = window.chat.message_texts();
        if texts.iter().any(|text| text == newest) {
            assert!(!texts.iter().any(|text| text == oldest), "the oldest result is outside the latest 200 rows");
            latest = true;
            break;
        }
        glib::timeout_future(Duration::from_millis(100)).await;
    }
    assert!(latest, "the latest private page loaded");
    // Let the room's pending read completion settle before searching backwards.
    glib::timeout_future(Duration::from_secs(2)).await;
    window.chat.jump_to(id);
    for _ in 0..1200 {
        let texts = window.chat.message_texts();
        if texts.iter().any(|text| text == oldest) && texts.iter().any(|text| text == newest) {
            assert_eq!(texts.iter().filter(|text| text.as_str() == oldest).count(), 1);
            assert_eq!(texts.iter().filter(|text| text.as_str() == newest).count(), 1);
            let first = texts.iter().position(|text| text == oldest).unwrap();
            let last = texts.iter().position(|text| text == newest).unwrap();
            assert!(first < last, "older rows retain native sequence order");
            let stored = session.store.messages(room, 1000).unwrap();
            assert!(stored.iter().all(|row| !row.text.contains("Private history")));
            assert!(!session.store.draft(room).unwrap().contains("Private GTK to browser"));
            let database =
                glib::user_data_dir().join("rocket-vibe-rs").join(rv_core::native::database_name(&session.info));
            assert!(database.is_file(), "the actual ordinary session store exists");
            let mut wal = database.as_os_str().to_os_string();
            wal.push("-wal");
            for file in [database, PathBuf::from(wal)] {
                if file.is_file() {
                    let bytes = std::fs::read(file).unwrap();
                    for private in [b"Private history".as_slice(), b"Private GTK to browser".as_slice()] {
                        assert!(
                            !bytes.windows(private.len()).any(|window| window == private),
                            "private timeline or draft text cannot enter ordinary SQLite or its WAL"
                        );
                    }
                }
            }
            check("GTK opens an older private search result without dropping or duplicating newer rows", true, count);
            std::fs::write(directory.join("passed"), b"passed").unwrap();
            return;
        }
        glib::timeout_future(Duration::from_millis(100)).await;
    }
    check("GTK older private search result", false, count);
}
