//! Ephemeral private quote cards over the existing ordinary SQL presentation.
use adw::prelude::*;
use rv_core::native::{NativeSession, crypto::enrollment::rooms::messages::QuoteReader, security::Guard};
use std::{
    cell::{Cell, RefCell},
    rc::{Rc, Weak},
    sync::{Arc, Weak as SyncWeak},
};

#[derive(Clone)]
struct Scope {
    session: SyncWeak<NativeSession>,
    room: String,
    membership: Option<String>,
    root: Option<String>,
    limit: usize,
    unread: Option<String>,
}
impl Scope {
    fn current(&self) -> Option<Arc<NativeSession>> {
        self.session.upgrade().filter(|s| {
            !s.is_closed()
                && self.membership.is_some()
                && s.store.read_state(&self.room).ok().flatten().and_then(|r| r.membership_version) == self.membership
                && s.store.rooms().ok().is_some_and(|rooms| rooms.iter().any(|r| r.id == self.room && !r.encrypted))
        })
    }
    fn rows(&self, session: &NativeSession) -> Result<Vec<rv_core::native::store::MessageRow>, rv_core::native::Error> {
        let rows = match &self.root {
            Some(root) => session.store.thread_messages(&self.room, root),
            None => session.store.messages(&self.room, self.limit),
        };
        rows.map_err(Into::into)
    }
}
pub struct QuoteCards {
    list: Weak<crate::message_list::MessageList>,
    scope: RefCell<Option<Scope>>,
    reader: RefCell<Option<QuoteReader>>,
    generation: Cell<u64>,
    mapped: Cell<u64>,
    window: RefCell<Option<(gtk::Window, gtk::glib::SignalHandlerId)>>,
}
impl QuoteCards {
    pub fn new(list: &Rc<crate::message_list::MessageList>) -> Rc<Self> {
        let this = Rc::new(Self {
            list: Rc::downgrade(list),
            scope: RefCell::default(),
            reader: RefCell::default(),
            generation: Cell::new(0),
            mapped: Cell::new(0),
            window: RefCell::default(),
        });
        let weak = Rc::downgrade(&this);
        list.root.connect_map(move |_| {
            let Some(this) = weak.upgrade() else { return };
            this.mapped.set(this.mapped.get().wrapping_add(1));
            this.detach_window();
            if let Some(window) = this.list.upgrade().and_then(|l| l.root.root()).and_downcast::<gtk::Window>() {
                let weak = Rc::downgrade(&this);
                let signal = window.connect_is_active_notify(move |_| {
                    if let Some(this) = weak.upgrade() {
                        this.reload();
                    }
                });
                this.window.replace(Some((window, signal)));
            }
            this.reload();
            let (weak, mapped) = (Rc::downgrade(&this), this.mapped.get());
            gtk::glib::timeout_add_local(std::time::Duration::from_secs(10), move || {
                let Some(this) = weak.upgrade().filter(|p| p.mapped.get() == mapped && p.is_mapped()) else {
                    return gtk::glib::ControlFlow::Break;
                };
                if this.visible() {
                    this.reload();
                }
                gtk::glib::ControlFlow::Continue
            });
        });
        let weak = Rc::downgrade(&this);
        list.root.connect_unmap(move |_| {
            if let Some(this) = weak.upgrade() {
                this.mapped.set(this.mapped.get().wrapping_add(1));
                this.detach_window();
                this.mask();
            }
        });
        this
    }
    fn detach_window(&self) {
        if let Some((window, signal)) = self.window.take() {
            window.disconnect(signal);
        }
    }
    fn is_mapped(&self) -> bool {
        self.list.upgrade().is_some_and(|l| l.root.is_mapped())
    }
    fn visible(&self) -> bool {
        self.is_mapped() && self.window.borrow().as_ref().is_some_and(|(w, _)| w.is_active())
    }
    fn invalidate(&self) {
        self.generation.set(self.generation.get().wrapping_add(1));
        if let Some(reader) = self.reader.take() {
            reader.close();
        }
    }
    fn display(&self, scope: &Scope, session: &NativeSession, rows: Vec<rv_core::native::store::MessageRow>) {
        if let Some(list) = self.list.upgrade() {
            list.set_native_rows(
                rv_core::native::read_presentation::group(
                    rows,
                    &scope.room,
                    &session.info.user_id,
                    scope.unread.as_deref(),
                ),
                &session.info.user_id,
            );
        }
    }
    fn mask(&self) {
        self.invalidate();
        if let Some(scope) = self.scope.borrow().clone() {
            if let Some(session) = scope.current()
                && let Ok(rows) = scope.rows(&session)
            {
                self.display(&scope, &session, rows);
                return;
            }
            if let Some(list) = self.list.upgrade() {
                list.clear();
            }
        }
    }
    pub fn close(&self) {
        self.mask();
        self.scope.take();
    }
    pub fn show(
        self: &Rc<Self>,
        session: &Arc<NativeSession>,
        room: &str,
        root: Option<&str>,
        limit: usize,
        unread: Option<String>,
    ) {
        self.scope.replace(Some(Scope {
            session: Arc::downgrade(session),
            room: room.into(),
            membership: session.store.read_state(room).ok().flatten().and_then(|r| r.membership_version),
            root: root.map(String::from),
            limit,
            unread,
        }));
        self.reload();
    }
    fn reload(self: &Rc<Self>) {
        self.mask();
        let Some(scope) = self.scope.borrow().clone().filter(|_| self.visible()) else { return };
        let Some(session) = scope.current().filter(|s| s.crypto_settings_supported()) else { return };
        let Ok(baseline) = scope.rows(&session) else { return };
        let rows = baseline
            .clone()
            .into_iter()
            .map(|row| row.presentation(&scope.room, &session.info.user_id))
            .collect::<Vec<_>>();
        if !QuoteReader::needed(&rows) {
            return;
        }
        let (weak, generation, room) = (Rc::downgrade(self), self.generation.get(), scope.room.clone());
        let path = gtk::glib::user_data_dir().join("rocket-vibe-rs/native-crypto");
        gtk::glib::spawn_future_local(async move {
            let result = crate::on_tokio(async move {
                let reader = session
                    .crypto_settings(Guard::new(), path, Arc::new(rv_crypto::protected::system::Keyring))
                    .await?
                    .quote_reader(room)
                    .await?;
                match reader.project(rows).await {
                    Ok(rows) => Ok::<_, rv_core::native::crypto::Error>((reader, rows)),
                    Err(error) => {
                        reader.close();
                        Err(error)
                    }
                }
            })
            .await;
            let Some(this) = weak.upgrade().filter(|p| p.generation.get() == generation && p.visible()) else {
                if let Ok((reader, _)) = result {
                    reader.close();
                }
                return;
            };
            let Some(session) = scope.current().filter(|s| scope.rows(s).ok().as_ref() == Some(&baseline)) else {
                if let Ok((reader, _)) = result {
                    reader.close();
                }
                this.mask();
                return;
            };
            if let Ok((reader, projected)) = result {
                if reader.check().is_err() {
                    reader.close();
                    this.mask();
                    return;
                }
                let mut display = rv_core::native::read_presentation::group(
                    baseline,
                    &scope.room,
                    &session.info.user_id,
                    scope.unread.as_deref(),
                );
                for (target, row) in display.iter_mut().zip(projected) {
                    target.row.attachments = row.attachments;
                }
                this.reader.replace(Some(reader));
                if let Some(list) = this.list.upgrade() {
                    list.set_native_rows(display, &session.info.user_id);
                }
            }
        });
    }
}
impl Drop for QuoteCards {
    fn drop(&mut self) {
        self.invalidate();
        self.detach_window();
    }
}
