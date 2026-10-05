use super::*;
use rv_core::native::crypto::enrollment::rooms::messages::QuoteReader;
use std::sync::Weak;

#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct NativeQuoteCards {
    pub message_id: String,
    pub quotes: Vec<crate::model::Quote>,
}
#[derive(uniffi::Object)]
pub struct NativeCryptoQuoteReader {
    access: QuoteReader,
    session: Weak<NativeSession>,
    room: String,
}
impl NativeCryptoQuoteReader {
    pub(crate) async fn open(
        session: Arc<NativeSession>,
        dirs: Arc<accounts::Dirs>,
        room: String,
    ) -> Result<Arc<Self>, Error> {
        let settings = session
            .crypto_settings(
                Guard::new(),
                dirs.data.join("native-crypto"),
                Arc::new(rv_crypto::protected::system::Keyring),
            )
            .await?;
        let access = settings.quote_reader(room.clone()).await?;
        Ok(Arc::new(Self { access, session: Arc::downgrade(&session), room }))
    }
}
impl Drop for NativeCryptoQuoteReader {
    fn drop(&mut self) {
        self.access.close();
    }
}
#[uniffi::export]
impl NativeCryptoQuoteReader {
    pub fn close(&self) {
        self.access.close();
    }
    pub fn is_closed(&self) -> bool {
        self.access.check().is_err()
    }
    pub async fn refresh(&self, limit: u32, root: Option<String>) -> Result<Vec<NativeQuoteCards>, RvError> {
        self.access.check().map_err(error)?;
        let session = self.session.upgrade().ok_or_else(|| RvError::Local { message: "session_closed".into() })?;
        let (access, room) = (self.access.clone(), self.room.clone());
        let rows = on_tokio(async move {
            let rows = match root {
                Some(root) => session.store.thread_messages(&room, &root),
                None => session.store.messages(&room, limit.clamp(1, 10_000) as usize),
            }
            .map_err(rv_core::native::Error::from)?;
            let rows = rows.into_iter().map(|row| row.presentation(&room, &session.info.user_id)).collect();
            let rows = access.project(rows).await?;
            Ok::<_, Error>((rows, session.info.user_id.clone(), session.info.username.clone()))
        })
        .await
        .map_err(error)?;
        let result = rv_core::timeline::group(rows.0)
            .into_iter()
            .map(|row| {
                let item = crate::model::message(row, &rows.1, &rows.2);
                NativeQuoteCards { message_id: item.id, quotes: item.quotes }
            })
            .collect();
        self.access.check().map_err(error)?;
        Ok(result)
    }
}
