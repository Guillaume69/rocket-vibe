use super::messages::{NativePrivateQuotePreview, NativePrivateQuoteSelection};
use super::*;
use rv_core::native::crypto::enrollment::rooms::messages::QuoteComposer;

#[derive(uniffi::Object)]
pub struct NativeCryptoQuoteComposer {
    access: QuoteComposer,
    username: String,
}
impl NativeCryptoQuoteComposer {
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
            access: settings.quote_composer(room, thread).await?,
            username: session.info.username.clone(),
        }))
    }
}
impl Drop for NativeCryptoQuoteComposer {
    fn drop(&mut self) {
        self.access.close();
    }
}
#[uniffi::export]
impl NativeCryptoQuoteComposer {
    pub fn close(&self) {
        self.access.close();
    }
    pub fn is_closed(&self) -> bool {
        self.access.check().is_err()
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
        Ok(messages::preview(value, &self.username))
    }
    pub async fn refresh(&self) -> Result<Option<NativePrivateQuotePreview>, RvError> {
        let access = self.access.clone();
        let value = on_tokio(async move { access.refresh().await }).await.map_err(error)?;
        self.access.check().map_err(error)?;
        Ok(value.map(|v| messages::preview(v, &self.username)))
    }
    pub async fn send(&self, text: String, quotes: Vec<NativePrivateQuoteSelection>) -> Result<String, RvError> {
        let selected = quotes.into_iter().map(messages::selection).collect::<Result<Vec<_>, _>>()?;
        let access = self.access.clone();
        on_tokio(async move { access.send(text, selected).await }).await.map_err(error)
    }
}
