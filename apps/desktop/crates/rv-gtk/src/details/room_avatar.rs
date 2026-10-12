use super::{centered, t};
use adw::prelude::*;
use gtk::{gio, glib};
use rv_core::provider::Chat;
use std::rc::Rc;

/// Rocket.Chat publishes its avatar etag after accepting the upload. The
/// open dialog follows that event instead of keeping an early placeholder.
pub(super) fn follow(
    parent: &adw::Dialog,
    session: std::sync::Arc<rv_core::session::Session>,
    rid: String,
    show: Rc<dyn Fn(String)>,
) {
    use rv_core::session::SessionEvent;
    use tokio::sync::broadcast::error::RecvError;
    let mut events = session.events();
    let (sender, receiver) = async_channel::unbounded();
    let forward = crate::runtime().spawn(async move {
        loop {
            if let Some(room) = session.store.rooms().into_iter().find(|room| room.rid == rid) {
                let path =
                    rv_core::media::avatar_path(rv_core::media::AvatarTarget::Room(&rid), room.avatar_etag.as_deref());
                if sender.send(path).await.is_err() {
                    return;
                }
            }
            loop {
                match events.recv().await {
                    Ok(SessionEvent::Avatar) | Err(RecvError::Lagged(_)) => break,
                    Ok(SessionEvent::Expired) | Err(RecvError::Closed) => return,
                    Ok(_) => {}
                }
            }
        }
    });
    let abort = forward.abort_handle();
    parent.connect_closed(move |_| abort.abort());
    glib::spawn_future_local(async move {
        while let Ok(path) = receiver.recv().await {
            show(path);
        }
    });
}

/// The same native picker for both server kinds. Changes apply immediately.
pub(super) fn controls(parent: &adw::Dialog, chat: Chat, rid: String) -> gtk::Widget {
    let content = gtk::Box::builder().orientation(gtk::Orientation::Vertical).spacing(4).build();
    let change = gtk::Button::builder().label(t("room_avatar.change")).css_classes(["room-avatar-change"]).build();
    let status = centered("", &["details-sub"]);
    content.append(&change);
    content.append(&status);
    let active = Rc::new(std::cell::Cell::new(true));
    let live = active.clone();
    parent.connect_closed(move |_| live.set(false));
    change.connect_clicked(move |button| {
        button.set_sensitive(false);
        status.set_text("");
        let filter = gtk::FileFilter::new();
        filter.add_mime_type("image/png");
        filter.add_mime_type("image/jpeg");
        let filters = gio::ListStore::new::<gtk::FileFilter>();
        filters.append(&filter);
        let chooser = gtk::FileDialog::builder().title(t("room_avatar.change")).filters(&filters).modal(true).build();
        let window = button.root().and_downcast::<gtk::Window>();
        let (chat, rid, status, button, active) =
            (chat.clone(), rid.clone(), status.clone(), button.clone(), active.clone());
        chooser.open(window.as_ref(), None::<&gio::Cancellable>, move |result| {
            if !active.get() {
                return;
            }
            let Some(path) = result.ok().and_then(|f| f.path()) else {
                button.set_sensitive(true);
                return;
            };
            let mime = crate::attach::mime_of(&path);
            glib::spawn_future_local(async move {
                let done = crate::on_tokio(async move {
                    match chat {
                        Chat::Legacy(s) => {
                            s.set_room_avatar(&rid, &path, &mime).await.map(|_| ()).map_err(|e| e.to_string())
                        }
                        Chat::WhatsApp(_) => Err("unsupported".into()),
                        Chat::Native(s) => {
                            let size = tokio::fs::metadata(&path).await.map_err(|e| e.to_string())?.len();
                            if size == 0 || size > 2 * 1024 * 1024 {
                                return Err("avatar_too_large".into());
                            }
                            let bytes = tokio::fs::read(path).await.map_err(|e| e.to_string())?;
                            let details = s.room_details(&rid).await.map_err(|e| e.code().to_owned())?;
                            let input = rv_core::native::profiles::AvatarCommand {
                                operation_id: rv_core::native::room_operation_id(),
                                expected_revision: details.revision,
                            };
                            s.set_room_avatar(
                                &rid,
                                input,
                                rv_core::native::store::AvatarUpload::from_bytes(mime, &bytes),
                            )
                            .await
                            .map_err(|e| e.code().to_owned())?;
                            Ok(())
                        }
                    }
                })
                .await;
                if !active.get() {
                    return;
                }
                button.set_sensitive(true);
                match done {
                    Ok(()) => status.set_text(t("settings.saved")),
                    Err(error) => {
                        eprintln!("Channel image refused: {error}");
                        status.set_text(t("room_avatar.failed"));
                    }
                }
            });
        });
    });
    content.upcast()
}
