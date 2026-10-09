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
            assert_eq!(session.info.base_url.trim_end_matches('/'), "http://host.docker.internal:3417");
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
            std::fs::write(directory.join("passed"), b"passed").unwrap();
            return;
        }
        glib::timeout_future(Duration::from_millis(100)).await;
    }
    check("GTK encrypted interoperability round trip", false, sent);
}
