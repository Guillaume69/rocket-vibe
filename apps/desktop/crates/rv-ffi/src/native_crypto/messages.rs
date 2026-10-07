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
pub struct NativePrivateQuoteSelection {
    pub room_id: String,
    pub message_id: String,
    pub revision: String,
    pub instance: String,
    pub data_epoch: String,
    pub membership: String,
    /// Empty for an ordinary source; exactly 32 bytes for a protected source.
    /// The shared SDK checks the source type, membership and revision again.
    pub admission: Vec<u8>,
}
#[derive(Clone, uniffi::Record)]
pub struct NativePrivateQuotePreview {
    pub selection: NativePrivateQuoteSelection,
    pub quote: crate::model::Quote,
}
pub(super) fn preview(value: messages::QuotePreview, username: &str) -> NativePrivateQuotePreview {
    let selected = value.selection;
    NativePrivateQuotePreview {
        selection: NativePrivateQuoteSelection {
            room_id: selected.reference.room_id,
            message_id: selected.reference.message_id,
            revision: selected.reference.revision,
            instance: selected.instance,
            data_epoch: selected.data_epoch,
            membership: selected.membership,
            admission: selected.admission.map(|a| a.to_vec()).unwrap_or_default(),
        },
        quote: crate::model::quote(
            rv_core::content::Quote {
                unavailable: false,
                link: String::new(),
                author: Some(value.author),
                text: value.text,
                md: None,
                images: vec![],
                files: vec![],
                quotes: vec![],
            },
            username,
        ),
    }
}
pub(super) fn selection(value: NativePrivateQuoteSelection) -> Result<messages::QuoteSelection, RvError> {
    Ok(messages::QuoteSelection {
        reference: messages::QuoteReference {
            room_id: value.room_id,
            message_id: value.message_id,
            revision: value.revision,
        },
        instance: value.instance,
        data_epoch: value.data_epoch,
        membership: value.membership,
        admission: if value.admission.is_empty() {
            None
        } else {
            Some(
                value
                    .admission
                    .try_into()
                    .map_err(|_| RvError::Local { message: "crypto_quote_unavailable".into() })?,
            )
        },
    })
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
    pub selected_quote: Option<NativePrivateQuotePreview>,
}
#[derive(uniffi::Object)]
pub struct NativeCryptoMessages {
    access: messages::Access,
    usage: Arc<rv_core::emoji_usage::EmojiUsage>,
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
            usage: crate::reactions::usage(&dirs.config, &session.info),
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
            selected_quote: view.selected_quote.map(|q| preview(q, &self.username)),
        })
    }
    pub async fn set_draft(&self, text: String) -> Result<(), RvError> {
        let access = self.access.clone();
        on_tokio(async move { access.set_draft(text).await }).await.map_err(error)
    }
    pub async fn send(&self, operation: String, text: String) -> Result<(), RvError> {
        self.send_quotes(operation, text, vec![]).await
    }
    pub async fn select_quote(&self, message_id: String) -> Result<NativePrivateQuotePreview, RvError> {
        let access = self.access.clone();
        let value = on_tokio(async move { access.select_quote(message_id).await }).await.map_err(error)?;
        self.access.check().map_err(error)?;
        Ok(preview(value, &self.username))
    }
    pub fn cancel_quote(&self) {
        self.access.cancel_quote();
    }
    pub async fn select_source_quote(
        &self,
        room_id: String,
        message_id: String,
    ) -> Result<NativePrivateQuotePreview, RvError> {
        let access = self.access.clone();
        let value =
            on_tokio(async move { access.select_source_quote(room_id, message_id).await }).await.map_err(error)?;
        self.access.check().map_err(error)?;
        Ok(preview(value, &self.username))
    }
    pub async fn send_quotes(
        &self,
        operation: String,
        text: String,
        quotes: Vec<NativePrivateQuoteSelection>,
    ) -> Result<(), RvError> {
        let selections = quotes.into_iter().map(selection).collect::<Result<Vec<_>, _>>()?;
        let (access, thread) = (self.access.clone(), self.thread.clone());
        on_tokio(async move {
            access
                .send_selected(
                    messages::SendMessage {
                        operation_id: operation,
                        text,
                        reply_to: thread,
                        quotes: selections.iter().map(|s| s.reference.clone()).collect(),
                        cards: vec![],
                        files: vec![],
                    },
                    selections,
                )
                .await
        })
        .await
        .map_err(error)
    }
    /// Whether this room's server takes (encrypted) files.
    pub fn files_available(&self) -> bool {
        self.access.files_available()
    }
    /// Seals a file on the device and sends it in a private message; a
    /// `temporary` source is deleted afterwards (E2EE_FILES.md).
    pub async fn send_file(
        &self,
        path: String,
        name: String,
        mime: String,
        caption: String,
        temporary: bool,
    ) -> Result<(), RvError> {
        let access = self.access.clone();
        let source = std::path::PathBuf::from(&path);
        let result =
            on_tokio(async move { access.send_file(source, name, mime, caption).await }).await.map_err(|e| match e {
                rv_core::native::crypto::Error::Session(rv_core::native::Error::Protocol("too-large:100")) => {
                    RvError::local("too-large:100")
                }
                e => error(e),
            });
        if temporary {
            let _ = std::fs::remove_file(&path);
        }
        result
    }
    /// Reacts to a journaled message (`present`) or withdraws the reaction.
    pub async fn react(&self, message_id: String, emoji: String, present: bool) -> Result<(), RvError> {
        if present {
            self.usage.record(&emoji);
        }
        let access = self.access.clone();
        on_tokio(async move { access.react(message_id, emoji, present).await }).await.map_err(error)
    }
    /// Private search on this device, newest first, threads included.
    pub async fn search(&self, text: String) -> Result<Vec<crate::people::SearchHit>, RvError> {
        let access = self.access.clone();
        let found = on_tokio(async move { access.search(text).await }).await.map_err(error)?;
        self.access.check().map_err(error)?;
        let ctx = rv_core::markdown::Context { me: &self.username };
        Ok(found
            .into_iter()
            .map(|m| crate::people::SearchHit {
                body: crate::markup::blocks(rv_core::markdown::render(
                    m.row.md.as_deref(),
                    m.row.text.as_deref(),
                    &ctx,
                )),
                author: m.row.author.unwrap_or_default(),
                id: m.row.id,
                ts: m.row.ts,
            })
            .collect())
    }
    /// Edits (`Some(text)`) or deletes (`None`) one of my journaled messages.
    pub async fn amend(&self, message_id: String, text: Option<String>) -> Result<(), RvError> {
        let access = self.access.clone();
        on_tokio(async move { access.amend(message_id, text).await }).await.map_err(error)
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
