use super::*;

impl NativeSession {
    /// Resolve the message under the current membership. A link's thread hint
    /// cannot redirect the reader to another room or override the actual root.
    pub async fn resolve_room_link(&self, mut link: crate::links::RoomLink) -> Result<crate::links::RoomLink, Error> {
        self.ready()?;
        if !crate::links::fits(&link, &self.info) {
            return Err(Error::Protocol("invalid_link"));
        }
        let projection = self.store.projection_token();
        let membership = self
            .store
            .read_state(&link.rid)?
            .and_then(|s| s.membership_version)
            .ok_or(Error::Protocol("delivery_revalidate"))?;
        self.identity().await?;
        if let Some(id) = link.message.as_ref().or(link.root.as_ref()) {
            let message = self.client.message(id).await?;
            if message.room_id != link.rid || message.deleted {
                return Err(Error::Protocol("message_deleted"));
            }
            let root = message.reply_to.clone();
            if link.message.is_some() && link.root.as_ref().is_some_and(|hint| root.as_ref() != Some(hint)) {
                return Err(Error::Protocol("invalid_link"));
            }
            if link.message.is_none() && root.is_some() {
                return Err(Error::Protocol("invalid_link"));
            }
            self.identity().await?;
            self.ready()?;
            if self.store.read_state(&link.rid)?.and_then(|s| s.membership_version).as_deref() != Some(&membership)
                || !self.store.ingest_at(std::slice::from_ref(&message), projection)?
            {
                return Err(Error::Protocol("delivery_revalidate"));
            }
            if link.message.is_some() {
                link.root = root;
            }
        }
        self.ready()?;
        if projection != self.store.projection_token()
            || self.store.read_state(&link.rid)?.and_then(|s| s.membership_version).as_deref() != Some(&membership)
        {
            return Err(Error::Protocol("delivery_revalidate"));
        }
        Ok(link)
    }
}
