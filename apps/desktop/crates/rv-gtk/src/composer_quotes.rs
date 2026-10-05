//! The existing ordinary editor owns the caption. Only private references and
//! previews are held by this short-lived coordinator.
use super::*;
use rv_core::native::{
    NativeSession,
    crypto::enrollment::rooms::messages::{QuoteComposer, QuoteSelection},
    security::Guard,
};

#[derive(Default)]
pub(super) struct State {
    pub(super) actor: RefCell<Option<QuoteComposer>>,
    pub(super) epoch: Cell<u64>,
    pub(super) binding: Cell<u64>,
    pub(super) busy: Cell<bool>,
    pub(super) sending: Cell<bool>,
    pub(super) files: Cell<bool>,
    mapped: Cell<u64>,
    window: RefCell<Option<(gtk::Window, glib::SignalHandlerId)>>,
}
impl State {
    fn detach(&self) {
        if let Some((window, signal)) = self.window.take() {
            window.disconnect(signal);
        }
    }
}
impl Drop for State {
    fn drop(&mut self) {
        self.detach();
        if let Some(actor) = self.actor.take() {
            actor.close();
        }
    }
}
impl Composer {
    fn quote_visible(&self) -> bool {
        self.root.is_mapped() && self.quote_author.window.borrow().as_ref().is_some_and(|(w, _)| w.is_active())
    }
    pub(super) fn close_ordinary_quote(&self) -> bool {
        let state = &self.quote_author;
        state.epoch.set(state.epoch.get().wrapping_add(1));
        let had = state.busy.replace(false) || state.actor.borrow().is_some();
        if let Some(actor) = state.actor.take() {
            actor.close();
        }
        if had {
            self.attach.set_sensitive(state.files.get());
            self.mic.set_sensitive(state.files.get());
        }
        had
    }
    fn mask_ordinary_quote(&self) {
        if self.close_ordinary_quote() {
            self.clear_reply();
        }
    }
    pub(super) fn watch_ordinary_quotes(self: &Rc<Self>) {
        let weak = Rc::downgrade(self);
        self.root.connect_map(move |_| {
            let Some(this) = weak.upgrade() else { return };
            let state = &this.quote_author;
            state.mapped.set(state.mapped.get().wrapping_add(1));
            state.detach();
            if let Some(window) = this.root.root().and_downcast::<gtk::Window>() {
                let weak = Rc::downgrade(&this);
                let signal = window.connect_is_active_notify(move |window| {
                    if !window.is_active()
                        && let Some(this) = weak.upgrade()
                    {
                        this.mask_ordinary_quote();
                    }
                });
                state.window.replace(Some((window, signal)));
            }
            let (weak, mapped) = (Rc::downgrade(&this), state.mapped.get());
            glib::timeout_add_local(std::time::Duration::from_secs(10), move || {
                let Some(this) = weak.upgrade().filter(|p| p.quote_author.mapped.get() == mapped && p.root.is_mapped())
                else {
                    return glib::ControlFlow::Break;
                };
                this.refresh_ordinary_quote();
                glib::ControlFlow::Continue
            });
        });
        let weak = Rc::downgrade(self);
        self.root.connect_unmap(move |_| {
            if let Some(this) = weak.upgrade() {
                this.quote_author.mapped.set(this.quote_author.mapped.get().wrapping_add(1));
                this.quote_author.detach();
                this.mask_ordinary_quote();
            }
        });
    }
    pub fn set_ordinary_private_quote(
        self: &Rc<Self>,
        session: Arc<NativeSession>,
        room: String,
        root: Option<String>,
        selected: QuoteSelection,
    ) {
        self.clear_reply();
        if !self.quote_visible() || !self.staged.is_empty() {
            self.report(t("quote.unavailable").into());
            return;
        }
        self.quote_author.busy.set(true);
        let (weak, epoch) = (Rc::downgrade(self), self.quote_author.epoch.get());
        let path = glib::user_data_dir().join("rocket-vibe-rs/native-crypto");
        glib::spawn_future_local(async move {
            let source = selected.clone();
            let result = crate::on_tokio(async move {
                let actor = session
                    .crypto_settings(Guard::new(), path, Arc::new(rv_crypto::protected::system::Keyring))
                    .await?
                    .quote_composer(room, root)
                    .await?;
                match actor.select_source_quote(source.reference.room_id, source.reference.message_id).await {
                    Ok(preview) => Ok::<_, rv_core::native::crypto::Error>((actor, preview)),
                    Err(error) => {
                        actor.close();
                        Err(error)
                    }
                }
            })
            .await;
            let Some(this) = weak.upgrade().filter(|p| p.quote_author.epoch.get() == epoch && p.quote_visible()) else {
                if let Ok((actor, _)) = result {
                    actor.close();
                }
                return;
            };
            this.quote_author.busy.set(false);
            match result {
                Ok((actor, preview)) if preview.selection == selected && actor.check().is_ok() => {
                    this.set_private_reply(preview);
                    this.quote_author.actor.replace(Some(actor));
                    this.attach.set_sensitive(false);
                    this.mic.set_sensitive(false);
                }
                Ok((actor, _)) => {
                    actor.close();
                    this.report(t("quote.unavailable").into());
                }
                Err(_) => this.report(t("quote.unavailable").into()),
            }
        });
    }
    pub(super) fn refresh_ordinary_quote(self: &Rc<Self>) {
        let state = &self.quote_author;
        if !self.quote_visible() || state.busy.get() || state.sending.get() {
            return;
        }
        let (Some(actor), Some(selected)) = (state.actor.borrow().clone(), self.private_reply()) else { return };
        state.busy.set(true);
        self.reply_title.set_label(t("quote.unavailable"));
        self.reply_preview.set_label("");
        let (weak, epoch) = (Rc::downgrade(self), state.epoch.get());
        glib::spawn_future_local(async move {
            let result = crate::on_tokio(async move { actor.refresh().await }).await;
            let Some(this) = weak.upgrade().filter(|p| p.quote_author.epoch.get() == epoch && p.quote_visible()) else {
                return;
            };
            this.quote_author.busy.set(false);
            if this.private_reply().as_ref() != Some(&selected) {
                return;
            }
            match result {
                Ok(Some(preview)) if preview.selection == selected => this.refresh_private_reply(Some(preview)),
                _ => this.clear_reply(),
            }
        });
    }
    /// True means this private selection owns the send, including refusal;
    /// callers must never fall back to ordinary unverified enqueue.
    pub fn send_private_reference(self: &Rc<Self>, text: String) -> bool {
        if self.private_access.borrow().is_some() {
            return false;
        }
        let Some(selected) = self.private_reply() else { return false };
        let state = &self.quote_author;
        if state.busy.get() || state.sending.get() || !self.quote_visible() {
            return true;
        }
        let Some(actor) = state.actor.borrow().clone() else { return true };
        state.sending.set(true);
        let (weak, epoch, binding, caption) =
            (Rc::downgrade(self), state.epoch.get(), state.binding.get(), text.clone());
        glib::spawn_future_local(async move {
            let source = selected.clone();
            let result = crate::on_tokio(async move { actor.send(text, vec![source]).await }).await;
            let Some(this) = weak.upgrade().filter(|p| p.quote_author.binding.get() == binding) else { return };
            this.quote_author.sending.set(false);
            match result {
                Ok(_) => {
                    if this.text() == caption {
                        this.set_text("");
                    }
                    if this.quote_author.epoch.get() == epoch && this.private_reply().as_ref() == Some(&selected) {
                        this.clear_reply();
                    }
                }
                Err(_) if this.quote_author.epoch.get() == epoch => this.report(t("quote.unavailable").into()),
                Err(_) => (),
            }
        });
        true
    }
}
