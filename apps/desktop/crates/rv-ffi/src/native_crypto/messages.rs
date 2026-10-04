use super::*;
use rv_core::native::crypto::enrollment::rooms::messages;

#[derive(Clone, Copy, uniffi::Enum)]
pub enum NativePrivateDelivery {
    Journaled,
    Pending,
    Accepted,
    Cancelling,
    Cancelled,
}
#[derive(Clone, uniffi::Record)]
pub struct NativePrivateMessage {
    pub id: String,
    pub operation: String,
    pub position: Option<String>,
    pub observed_at: u64,
    pub delivery: NativePrivateDelivery,
}
#[derive(Clone, uniffi::Record)]
pub struct NativePrivateConversation {
    pub revision: u64,
    pub can_send: bool,
    pub catching_up: bool,
    pub has_older: bool,
    pub after: String,
    pub draft: String,
    pub items: Vec<crate::model::MessageItem>,
    pub messages: Vec<NativePrivateMessage>,
}
#[derive(uniffi::Object)]
pub struct NativeCryptoMessages {
    access: messages::Access,
    user: String,
    username: String,
    thread: Option<String>,
}
impl NativeCryptoMessages {
    pub(crate) async fn open(
        session: Arc<NativeSession>,
        dirs: Arc<accounts::Dirs>,
        room: String,
        thread: Option<String>,
    ) -> Result<Arc<Self>, Error> {
        let settings = session
            .crypto_settings(
                Guard::new(),
                dirs.data.join("native-crypto"),
                Arc::new(rv_crypto::protected::system::Keyring),
            )
            .await?;
        Ok(Arc::new(Self {
            access: settings.messages(room, thread.clone()).await?,
            user: session.info.user_id.clone(),
            username: session.info.username.clone(),
            thread,
        }))
    }
}
impl Drop for NativeCryptoMessages {
    fn drop(&mut self) {
        self.access.close();
    }
}
#[uniffi::export]
impl NativeCryptoMessages {
    pub fn close(&self) {
        self.access.close();
    }
    pub fn is_closed(&self) -> bool {
        self.access.check().is_err()
    }
    pub async fn refresh(&self, before: Option<String>, limit: u32) -> Result<NativePrivateConversation, RvError> {
        let access = self.access.clone();
        let view = on_tokio(async move { access.refresh(before, limit as usize).await }).await.map_err(error)?;
        let mut metadata = vec![];
        let mut rows = vec![];
        for message in view.messages {
            metadata.push(NativePrivateMessage {
                id: message.row.id.clone(),
                operation: message.operation,
                position: message.position,
                observed_at: message.observed_at,
                delivery: match message.delivery {
                    messages::Delivery::Journaled => NativePrivateDelivery::Journaled,
                    messages::Delivery::Pending => NativePrivateDelivery::Pending,
                    messages::Delivery::Accepted => NativePrivateDelivery::Accepted,
                    messages::Delivery::Cancelling => NativePrivateDelivery::Cancelling,
                    messages::Delivery::Cancelled => NativePrivateDelivery::Cancelled,
                },
            });
            rows.push(message.row);
        }
        let items = rv_core::timeline::group(rows)
            .into_iter()
            .map(|row| {
                let mut item = crate::model::message(row, &self.user, &self.username);
                item.avatar.clear();
                item
            })
            .collect();
        self.access.check().map_err(error)?;
        Ok(NativePrivateConversation {
            revision: view.revision,
            can_send: view.can_send,
            catching_up: view.catching_up,
            has_older: view.has_older,
            after: view.after,
            draft: view.draft,
            items,
            messages: metadata,
        })
    }
    pub async fn set_draft(&self, text: String) -> Result<(), RvError> {
        let access = self.access.clone();
        on_tokio(async move { access.set_draft(text).await }).await.map_err(error)
    }
    pub async fn send(&self, operation: String, text: String) -> Result<(), RvError> {
        let (access, thread) = (self.access.clone(), self.thread.clone());
        on_tokio(async move {
            access
                .send(messages::SendMessage {
                    operation_id: operation,
                    text,
                    reply_to: thread,
                    quotes: vec![],
                    cards: vec![],
                })
                .await
        })
        .await
        .map_err(error)
    }
    pub async fn resume(&self, operation: String) -> Result<(), RvError> {
        let access = self.access.clone();
        on_tokio(async move { access.resume(operation).await }).await.map_err(error)
    }
    pub async fn cancel(&self, operation: String) -> Result<(), RvError> {
        let access = self.access.clone();
        on_tokio(async move { access.cancel(operation).await }).await.map_err(error)
    }
}
