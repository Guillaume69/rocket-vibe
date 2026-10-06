use super::super::link_previews::{Access, from_entry};
use super::*;
use rv_protocol::link_previews::PreviewImage;

impl NativeStore {
    pub(in crate::native) fn preview_scope(
        &self,
        message: String,
        room: String,
        membership: String,
        image: PreviewImage,
    ) -> Access {
        let scope = serde_json::to_string(&(&self.identity, &message, &room, &membership, &image))
            .expect("serializable preview scope");
        Access { message, room, membership, image, scope }
    }
    pub(in crate::native) fn preview_access(&self, message: &str, file: &str) -> rusqlite::Result<Option<Access>> {
        let conn = self.conn.lock().unwrap();
        if !self.same(&conn)? {
            return Ok(None);
        }
        let raw:Option<(String,String,String)>=conn.query_row("SELECT m.rid,j.value,s.payload FROM native_messages m JOIN json_each(m.urls) j JOIN native_read_states s ON s.rid=m.rid WHERE m.id=?1 AND NOT m.deleted AND m.position IS NOT NULL AND json_extract(j.value,'$.native_preview.image.file_id')=?2 LIMIT 1",params![message,file],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional()?;
        raw.map(|(room, raw, state)| {
            let entry = serde_json::from_str(&raw).map_err(|_| rusqlite::Error::InvalidQuery)?;
            let (preview, _) = from_entry(&entry).ok_or(rusqlite::Error::InvalidQuery)?;
            let state: rv_protocol::parity::ReadState =
                serde_json::from_str(&state).map_err(|_| rusqlite::Error::InvalidQuery)?;
            let membership = state.membership_version.ok_or(rusqlite::Error::InvalidQuery)?;
            let image = preview.image.ok_or(rusqlite::Error::InvalidQuery)?;
            Ok(self.preview_scope(message.into(), room, membership, image))
        })
        .transpose()
    }
}
