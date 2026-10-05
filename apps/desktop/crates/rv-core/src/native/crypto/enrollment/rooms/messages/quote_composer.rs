//! Reference-only private authoring into an ordinary destination. Drafts stay
//! with the existing ordinary composer; private words never enter its outbox.
use super::*;

#[derive(Clone)]
pub struct QuoteComposer(pub(super) Access);
impl QuoteComposer {
    pub fn close(&self) {
        self.0.close();
    }
    pub fn check(&self) -> Result<()> {
        self.0.check()
    }
    pub fn cancel_quote(&self) {
        self.0.cancel_quote();
    }
    pub async fn select_source_quote(&self, room: String, message: String) -> Result<QuotePreview> {
        self.0.select_source_quote(room, message).await
    }
    pub async fn refresh(&self) -> Result<Option<QuotePreview>> {
        let _serial = self.0.0.serial.lock().await;
        self.0.0.room.current().await?;
        self.0.project_quotes(&mut []).await
    }
    pub async fn send(&self, text: String, selections: Vec<QuoteSelection>) -> Result<String> {
        let _serial = self.0.0.serial.lock().await;
        self.0.0.room.current().await?;
        self.0.validate_quotes(&selections).await?;
        let room = &self.0.0.room.0;
        let session = room.session.upgrade().ok_or_else(room_changed)?;
        let selected = selections
            .iter()
            .map(|s| crate::native::store::QuoteSelection {
                reference: s.reference.clone(),
                identity: crate::native::Identity { instance_id: s.instance.clone(), data_epoch: s.data_epoch.clone() },
                membership_version: s.membership.clone(),
            })
            .collect::<Vec<_>>();
        let private = selections
            .iter()
            .filter(|s| s.admission.is_some())
            .map(|s| (s.reference.room_id.clone(), s.reference.message_id.clone()))
            .collect::<BTreeSet<_>>();
        // Both checks are independent of the locked SQL connection. Membership,
        // source mode, ordinary revisions and destination are checked in SQL.
        let current = || {
            !room.closed.load(Ordering::SeqCst)
                && room.crypto.check().is_ok()
                && room.settings.check().is_ok()
                && session.store.projection_token() == room.projection
        };
        self.check()?;
        let permit = crate::native::store::VerifiedQuotes {
            selections: &selected,
            private: &private,
            draft: &text,
            current: &current,
        };
        let id = session.send_verified_quotes(
            &room.id,
            self.0.0.thread.as_deref(),
            &text,
            room.membership.as_deref(),
            &selected,
            &permit,
        )?;
        self.cancel_quote();
        // The accepted SQL intention owns its original ID from here, even if
        // the view closes immediately after commit. No second enqueue follows.
        Ok(id)
    }
}
