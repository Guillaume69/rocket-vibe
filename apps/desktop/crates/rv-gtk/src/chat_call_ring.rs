//! A call started by the other member of a Rocket.Chat or kChat direct room
//! (`rv_core::call_ring`) rings with the voice dialog and ringtone: Accept
//! opens the call window and Decline tells the server. Escape and backdrop
//! clicks keep the prompt ringing until an answer or the remote call ending.

use std::rc::Rc;
use std::sync::Arc;

use adw::prelude::*;
use gtk::glib;
use rv_core::call_ring::IncomingCall;
use rv_core::session::Session;

use super::ChatPage;
use crate::i18n::{t, tf};
use crate::on_tokio;
use crate::runtime;
use crate::sounds::Sound;

impl ChatPage {
    /// Shows, keeps or closes the prompt to match the session's ringing call.
    pub fn call_ring(self: &Rc<Self>, session: &Arc<Session>, call: Option<&IncomingCall>) {
        let shown = self.incoming_call.borrow().as_ref().map(|(id, _)| id.clone());
        match call {
            Some(call) if shown.as_deref() == Some(call.call_id.as_str()) => return,
            Some(call) => {
                self.close_call_ring();
                self.call_dialog(session, call.clone());
            }
            None => self.close_call_ring(),
        }
        // A muted account's call shows its prompt silently.
        self.voice.set_tone(call.filter(|_| !crate::rail::is_muted(&session.info)).map(|_| Sound::Ringtone));
    }

    /// A call or voice ring prompt is on screen.
    pub fn ringing(&self) -> bool {
        self.incoming_call.borrow().is_some() || self.voice_ringing()
    }

    /// The account is going: its call stops ringing here.
    pub fn end_call_ring(&self) {
        if self.incoming_call.borrow().is_some() {
            self.close_call_ring();
            self.voice.set_tone(None);
        }
    }

    fn close_call_ring(&self) {
        if let Some((_, dialog)) = self.incoming_call.take() {
            dialog.force_close();
        }
    }

    fn call_dialog(self: &Rc<Self>, session: &Arc<Session>, call: IncomingCall) {
        let room = session.store.rooms().into_iter().find(|r| r.rid == call.rid).map(|r| r.name).unwrap_or_default();
        let caller = call.caller_name.clone().unwrap_or_else(|| room.clone());
        let dialog = crate::widgets::incoming_call_alert(&tf("voice_session.incoming_from", &[("name", &caller)]));
        let (weak, session, id) = (Rc::downgrade(self), session.clone(), call.call_id.clone());
        dialog.connect_response(None, move |dialog, response| {
            let Some(this) = weak.upgrade() else { return };
            // Closed because the ring ended elsewhere: nothing to answer.
            if this.incoming_call.borrow().as_ref().is_none_or(|(shown, _)| shown != &id) {
                return;
            }
            this.incoming_call.replace(None);
            this.voice.set_tone(None);
            // Alert response buttons call close(), which can-close forbids.
            // Retire the ring before forcing closure, including notification answers.
            dialog.force_close();
            match response {
                "accept" => {
                    session.dismiss_call();
                    let (weak, session, id, room) = (Rc::downgrade(&this), session.clone(), id.clone(), room.clone());
                    glib::spawn_future_local(async move {
                        let url = on_tokio(async move { session.join_call(&id).await }).await;
                        let Some(this) = weak.upgrade() else { return };
                        match url {
                            Ok(url) => this.open_call(&url, &room),
                            Err(_) => this.toast(t("call.failed").to_owned()),
                        }
                    });
                }
                "decline" => {
                    let (session, id) = (session.clone(), id.clone());
                    runtime().spawn(async move { session.decline_call(&id).await });
                }
                _ => session.dismiss_call(),
            }
        });
        if let Some(window) = self.split.root().and_downcast::<gtk::Window>()
            && !window.is_visible()
        {
            window.present();
        }
        self.incoming_call.replace(Some((call.call_id, dialog.clone())));
        crate::widgets::present(&dialog, Some(&self.split));
    }

    /// The system notification's Accept or Decline, as the dialog's buttons.
    pub fn answer_call_ring(&self, accept: bool) {
        let dialog = self.incoming_call.borrow().as_ref().map(|(_, d)| d.clone());
        if let Some(dialog) = dialog {
            dialog.emit_by_name::<()>("response", &[&if accept { "accept" } else { "decline" }]);
        }
    }
}
