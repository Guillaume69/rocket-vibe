//! Room commands use a private receipt before every retry. An acknowledgement
//! never overwrites current metadata, and only the original form is replayed.
use super::{
    Error, NativeSession, permanent_command_error,
    store::{RoomOperation, SavedRoomOperation},
};
pub use rv_protocol::parity::{ChangeRoomRole, LeaveRoom, RoomDetails, RoomMemberPage, RoomRole, UpdateRoom};
use std::sync::atomic::Ordering;

pub fn room_operation_id() -> String {
    format!("{:032x}", fastrand::u128(..))
}

impl NativeSession {
    pub async fn room_members(
        &self,
        room: &str,
        after: Option<&str>,
        revision: Option<&str>,
    ) -> Result<RoomMemberPage, Error> {
        self.ready()?;
        if !self.capabilities.lock().unwrap().as_ref().is_some_and(|c| c.room_info) {
            return Err(Error::Protocol("unsupported_feature"));
        }
        let projection = self.store.projection_token();
        let generation = self.security_generation.load(Ordering::SeqCst);
        self.identity().await?;
        self.room_operation_generation(generation)?;
        let page = self.client.room_members(room, after, revision).await?;
        self.identity().await?;
        self.room_operation_generation(generation)?;
        if page.room_id != room || revision.is_some_and(|v| v != page.revision) {
            return Err(Error::Protocol("invalid_room_members"));
        }
        if projection != self.store.projection_token() || !self.store.rooms()?.iter().any(|r| r.id == room) {
            return Err(Error::Protocol("delivery_revalidate"));
        }
        Ok(page)
    }
    pub async fn update_room(&self, room: &str, input: UpdateRoom) -> Result<(), Error> {
        self.submit_room_operation(room, RoomOperation::Settings { input }).await
    }
    pub async fn change_room_role(&self, room: &str, target: &str, input: ChangeRoomRole) -> Result<(), Error> {
        self.submit_room_operation(room, RoomOperation::Role { target: target.into(), input }).await
    }
    pub async fn leave_room(&self, room: &str, input: LeaveRoom) -> Result<(), Error> {
        self.submit_room_operation(room, RoomOperation::Leave { input }).await
    }
    pub async fn resume_room_operation(&self, room: &str) -> Result<(), Error> {
        self.ready()?;
        let saved = self.store.room_operation(room)?.ok_or(Error::Protocol("room_operation_missing"))?;
        if saved.failed {
            return Err(Error::Protocol("room_action_failed"));
        }
        self.finish_room_operation(&saved).await
    }
    pub async fn dismiss_room_operation(&self, room: &str, operation: &str) -> Result<bool, Error> {
        self.ready()?;
        let _guard = self.command_lock.lock().await;
        self.ready()?;
        Ok(self.store.dismiss_room_operation(room, operation)?)
    }
    async fn submit_room_operation(&self, room: &str, command: RoomOperation) -> Result<(), Error> {
        self.ready()?;
        if !self.room_command_supported(&command) {
            return Err(Error::Protocol("unsupported_feature"));
        }
        let saved = self.store.stage_room_operation(room, command)?.ok_or(Error::Protocol("room_action_pending"))?;
        self.finish_room_operation(&saved).await
    }
    async fn finish_room_operation(&self, saved: &SavedRoomOperation) -> Result<(), Error> {
        let result = self.apply_room_operation(saved).await;
        if let Err(error) = &result {
            if permanent_command_error(error) {
                self.store.fail_room_operation(&saved.room, saved.command.id(), error.code())?;
            } else if error.terminal() {
                self.shutdown();
                self.set_failure(error);
            } else {
                self.wake.notify_one();
            }
        }
        result
    }
    fn room_command_supported(&self, command: &RoomOperation) -> bool {
        self.capabilities.lock().unwrap().as_ref().is_some_and(|c| match command {
            RoomOperation::Settings { .. } => c.room_settings,
            RoomOperation::Role { .. } => c.room_roles,
            RoomOperation::Leave { .. } => c.room_leave,
        })
    }
    fn room_operation_generation(&self, generation: u64) -> Result<(), Error> {
        self.ready()?;
        if generation != self.security_generation.load(Ordering::SeqCst) {
            return Err(Error::Protocol("session_closed"));
        }
        Ok(())
    }
    pub(super) async fn apply_room_operation(&self, saved: &SavedRoomOperation) -> Result<(), Error> {
        let _guard = self.command_lock.lock().await;
        self.ready()?;
        let generation = self.security_generation.load(Ordering::SeqCst);
        let live = || -> Result<bool, Error> {
            Ok(self
                .store
                .room_operation(&saved.room)?
                .is_some_and(|current| !current.failed && current.command.id() == saved.command.id()))
        };
        if !live()? {
            return Ok(());
        }
        self.identity().await?;
        self.room_operation_generation(generation)?;
        if !live()? {
            return Ok(());
        }
        let receipt = match self.client.room_command_receipt(&saved.room, saved.command.id()).await {
            Ok(receipt) => receipt,
            Err(rv_client::Error::Server { status: 404, code, .. }) if code == "not_found" => {
                self.room_operation_generation(generation)?;
                if !live()? {
                    return Ok(());
                }
                if !self.room_command_supported(&saved.command) {
                    return Err(Error::Protocol("unsupported_feature"));
                }
                match &saved.command {
                    RoomOperation::Settings { input } => self.client.update_room(&saved.room, input).await?,
                    RoomOperation::Role { target, input } => {
                        self.client.change_room_role(&saved.room, target, input).await?
                    }
                    RoomOperation::Leave { input } => self.client.leave_room(&saved.room, input).await?,
                }
            }
            Err(error) => return Err(error.into()),
        };
        self.identity().await?;
        self.room_operation_generation(generation)?;
        if receipt.operation_id != saved.command.id() || receipt.room_id != saved.room {
            return Err(Error::Protocol("invalid_room_receipt"));
        }
        // A concurrent journal withdrawal may already have purged this intent.
        // Exact-id acknowledgement cannot erase a later form after rejoining.
        self.store.confirm_room_operation(&receipt)?;
        Ok(())
    }
}
