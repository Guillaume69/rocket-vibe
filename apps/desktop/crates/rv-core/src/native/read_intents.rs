//! Read retries keep observed positions; favorite retries recover a receipt
//! before sending the original CAS. Neither queue controls socket health.
use super::{
    Error, NativeSession, diagnostics, permanent_command_error,
    store::{PendingRead, SavedFavorite},
};
use std::{sync::atomic::Ordering, time::Duration};
use tokio::time::Instant;

impl NativeSession {
    pub fn mark_observed_read(&self, room: &str, message: &str) -> Result<bool, Error> {
        self.state_staging_supported(false)?;
        let changed = self.store.stage_read(room, message)?;
        if changed {
            self.wake.notify_one();
        }
        Ok(changed)
    }
    pub fn set_favorite(&self, room: &str, present: bool) -> Result<(), Error> {
        self.state_staging_supported(true)?;
        self.store.stage_favorite(room, present)?.ok_or(Error::Protocol("favorite_action_pending"))?;
        self.wake.notify_one();
        Ok(())
    }
    pub fn dismiss_failed_favorite(&self, room: &str, operation: &str) -> Result<bool, Error> {
        if self.is_closed() {
            return Err(Error::Protocol("session_closed"));
        }
        Ok(self.store.dismiss_failed_favorite(room, operation)?)
    }
    pub fn resume_favorite(&self, room: &str) -> Result<(), Error> {
        self.state_staging_supported(true)?;
        let saved = self.store.favorite_intent(room)?.ok_or(Error::Protocol("favorite_action_missing"))?;
        if saved.phase == "failed" {
            return Err(Error::Protocol("favorite_action_failed"));
        }
        self.wake.notify_one();
        Ok(())
    }
    fn state_staging_supported(&self, favorite: bool) -> Result<(), Error> {
        if self.is_closed() {
            return Err(Error::Protocol("session_closed"));
        }
        if !self
            .capabilities
            .lock()
            .unwrap()
            .as_ref()
            .is_some_and(|c| if favorite { c.favorites } else { c.read_markers })
        {
            return Err(Error::Protocol("unsupported_feature"));
        }
        Ok(())
    }
    pub(super) fn state_retry_deadline(&self) -> Option<Instant> {
        [*self.read_retry.lock().unwrap(), *self.favorite_retry.lock().unwrap()].into_iter().flatten().min()
    }
    fn state_generation(&self, generation: u64, projection: u64, room: &str, membership: &str) -> Result<(), Error> {
        self.ready()?;
        if generation != self.security_generation.load(Ordering::SeqCst) {
            return Err(Error::Protocol("session_closed"));
        }
        if projection != self.store.projection_token()
            || self.store.read_state(room)?.as_ref().and_then(|s| s.membership_version.as_deref()) != Some(membership)
        {
            return Err(Error::Protocol("delivery_revalidate"));
        }
        Ok(())
    }
    fn state_defer(&self, favorite: bool, error: &Error) {
        let seconds = diagnostics(error).1.unwrap_or(2).clamp(1, 300);
        let deadline = Instant::now() + Duration::from_secs(seconds) + Duration::from_millis(fastrand::u64(0..250));
        *if favorite { self.favorite_retry.lock().unwrap() } else { self.read_retry.lock().unwrap() } = Some(deadline);
    }
    pub(super) async fn flush_state_intents(&self) -> Result<(), Error> {
        let _guard = self.state_intent_lock.lock().await;
        self.ready()?;
        if self.favorite_retry.lock().unwrap().is_none_or(|t| t <= Instant::now()) {
            *self.favorite_retry.lock().unwrap() = None;
            for saved in self.store.pending_favorites()? {
                match self.apply_favorite(&saved).await {
                    Ok(()) => (),
                    Err(error) if error.terminal() => return Err(error),
                    Err(error) if saved.phase == "pending" && permanent_command_error(&error) => {
                        self.store.fail_favorite(&saved.room, &saved.input.operation_id, error.code())?
                    }
                    Err(error) => {
                        self.state_defer(true, &error);
                        break;
                    }
                }
            }
        }
        if self.read_retry.lock().unwrap().is_none_or(|t| t <= Instant::now()) {
            *self.read_retry.lock().unwrap() = None;
            for saved in self.store.pending_reads()? {
                if let Err(error) = self.apply_observed_read(&saved).await {
                    if error.terminal() {
                        return Err(error);
                    }
                    // A read quota never delays messages/favorites or closes
                    // an otherwise healthy journal socket.
                    self.state_defer(false, &error);
                    break;
                }
            }
            if self.read_retry.lock().unwrap().is_none() && !self.store.pending_reads()?.is_empty() {
                *self.read_retry.lock().unwrap() = Some(Instant::now() + Duration::from_millis(100));
            }
        }
        Ok(())
    }
    async fn apply_observed_read(&self, saved: &PendingRead) -> Result<(), Error> {
        let generation = self.security_generation.load(Ordering::SeqCst);
        let projection = self.store.projection_token();
        self.state_generation(generation, projection, &saved.room, &saved.membership)?;
        self.identity().await?;
        self.state_generation(generation, projection, &saved.room, &saved.membership)?;
        if !self.capabilities.lock().unwrap().as_ref().is_some_and(|c| c.read_markers) {
            return Err(Error::Protocol("unsupported_feature"));
        }
        let current = self.client.room_read_state(&saved.room).await?;
        self.identity().await?;
        self.state_generation(generation, projection, &saved.room, &saved.membership)?;
        if current.room_id != saved.room {
            return Err(Error::Protocol("invalid_read_state"));
        }
        if !self.store.cache_read_state(&current, projection)? {
            return Err(Error::Protocol("delivery_revalidate"));
        }
        let state = self.store.read_state(&saved.room)?.ok_or(Error::Protocol("delivery_revalidate"))?;
        if state.root_position.parse::<u64>().map_err(|_| Error::Protocol("invalid_read_state"))?
            >= saved.root_position.parse::<u64>().map_err(|_| Error::Protocol("invalid_read_state"))?
        {
            return Ok(());
        }
        self.state_generation(generation, projection, &saved.room, &saved.membership)?;
        let confirmed = self
            .client
            .mark_room_read(
                &saved.room,
                &rv_protocol::parity::MarkRead {
                    root_position: saved.root_position.clone(),
                    reply_position: "0".into(),
                },
            )
            .await?;
        self.identity().await?;
        self.state_generation(generation, projection, &saved.room, &saved.membership)?;
        if confirmed.room_id != saved.room {
            return Err(Error::Protocol("invalid_read_state"));
        }
        if !self.store.cache_read_state(&confirmed, projection)? {
            return Err(Error::Protocol("delivery_revalidate"));
        }
        Ok(())
    }
    async fn apply_favorite(&self, saved: &SavedFavorite) -> Result<(), Error> {
        let _guard = self.command_lock.lock().await;
        let generation = self.security_generation.load(Ordering::SeqCst);
        let projection = self.store.projection_token();
        self.state_generation(generation, projection, &saved.room, &saved.membership)?;
        let live = || -> Result<bool, Error> {
            Ok(self
                .store
                .favorite_intent(&saved.room)?
                .is_some_and(|s| s.phase != "failed" && s.input.operation_id == saved.input.operation_id))
        };
        if !live()? {
            return Ok(());
        }
        self.identity().await?;
        self.state_generation(generation, projection, &saved.room, &saved.membership)?;
        if saved.phase == "pending" {
            let receipt = match self.client.room_command_receipt(&saved.room, &saved.input.operation_id).await {
                Ok(receipt) => receipt,
                Err(rv_client::Error::Server { status: 404, code, .. }) if code == "not_found" => {
                    self.state_generation(generation, projection, &saved.room, &saved.membership)?;
                    if !live()? {
                        return Ok(());
                    }
                    if !self.capabilities.lock().unwrap().as_ref().is_some_and(|c| c.favorites) {
                        return Err(Error::Protocol("unsupported_feature"));
                    }
                    self.client.set_room_favorite(&saved.room, &saved.input).await?
                }
                Err(error) => return Err(error.into()),
            };
            self.identity().await?;
            self.state_generation(generation, projection, &saved.room, &saved.membership)?;
            if receipt.operation_id != saved.input.operation_id || receipt.room_id != saved.room {
                return Err(Error::Protocol("invalid_favorite_receipt"));
            }
            if !self.store.confirm_favorite_receipt(&receipt, projection)? {
                return Ok(());
            }
        }
        let current = self.client.room_read_state(&saved.room).await?;
        self.identity().await?;
        self.state_generation(generation, projection, &saved.room, &saved.membership)?;
        if current.room_id != saved.room {
            return Err(Error::Protocol("invalid_read_state"));
        }
        if !self.store.cache_read_state(&current, projection)? {
            return Err(Error::Protocol("delivery_revalidate"));
        }
        // A valid receipt may precede the read projection. Keep its durable
        // floor until fresh state covers it, without submitting another PUT.
        if live()? {
            *self.favorite_retry.lock().unwrap() = Some(Instant::now() + Duration::from_secs(2));
        }
        Ok(())
    }
}
