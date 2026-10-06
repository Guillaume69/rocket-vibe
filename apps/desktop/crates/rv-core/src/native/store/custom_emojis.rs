use super::NativeStore;
use rusqlite::{OptionalExtension, params};
use rv_protocol::custom_emojis::EmojiCatalog;

fn revision(value: &str) -> rusqlite::Result<i64> {
    value.parse::<i64>().ok().filter(|n| *n >= 0 && n.to_string() == value).ok_or(rusqlite::Error::InvalidQuery)
}
impl NativeStore {
    pub fn emoji_catalog(&self) -> rusqlite::Result<Option<EmojiCatalog>> {
        let conn = self.conn.lock().unwrap();
        if !self.same(&conn)? {
            return Ok(None);
        }
        let payload: Option<Option<String>> = conn
            .query_row("SELECT payload FROM native_emoji_catalog WHERE singleton=1", [], |r| r.get(0))
            .optional()?;
        let Some(payload) = payload.flatten() else { return Ok(None) };
        let catalog: EmojiCatalog = serde_json::from_str(&payload).map_err(|_| rusqlite::Error::InvalidQuery)?;
        if !rv_protocol::custom_emojis::validate(&catalog) {
            return Err(rusqlite::Error::InvalidQuery);
        }
        Ok(Some(catalog))
    }
    pub fn emoji_revision(&self) -> rusqlite::Result<String> {
        let conn = self.conn.lock().unwrap();
        if !self.same(&conn)? {
            return Ok("0".into());
        }
        Ok(conn
            .query_row("SELECT revision FROM native_emoji_catalog WHERE singleton=1", [], |r| r.get(0))
            .optional()?
            .unwrap_or_else(|| "0".into()))
    }
    pub fn invalidate_emojis(&self, incoming: &str, valid: impl Fn() -> bool) -> rusqlite::Result<bool> {
        let incoming_revision = revision(incoming)?;
        self.atomic(|tx|{
            if !valid()||!self.same(tx)?{return Ok(false);}
            let old:Option<String>=tx.query_row("SELECT revision FROM native_emoji_catalog WHERE singleton=1",[],|r|r.get(0)).optional()?;
            if old.as_deref().map(revision).transpose()?.is_some_and(|n|n>=incoming_revision){return Ok(false);}
            tx.execute("INSERT INTO native_emoji_catalog(singleton,revision,payload) VALUES(1,?1,NULL) ON CONFLICT(singleton) DO UPDATE SET revision=excluded.revision,payload=NULL",[incoming])?;
            if !valid(){return Err(rusqlite::Error::InvalidQuery);}
            Ok(true)
        })
    }
    pub fn save_emojis(&self, catalog: &EmojiCatalog, valid: impl Fn() -> bool) -> rusqlite::Result<bool> {
        if !rv_protocol::custom_emojis::validate(catalog) {
            return Err(rusqlite::Error::InvalidQuery);
        }
        let incoming = revision(&catalog.revision)?;
        let payload = serde_json::to_string(catalog).map_err(|_| rusqlite::Error::InvalidQuery)?;
        self.atomic(|tx|{
            if !valid()||!self.same(tx)?{return Ok(false);}
            let old:Option<(String,Option<String>)>=tx.query_row("SELECT revision,payload FROM native_emoji_catalog WHERE singleton=1",[],|r|Ok((r.get(0)?,r.get(1)?))).optional()?;
            if let Some((old_revision,old_payload))=old{
                if revision(&old_revision)?>incoming{return Ok(false);}
                if old_revision==catalog.revision&&let Some(old_payload)=old_payload{
                    return if old_payload==payload{Ok(true)}else{Err(rusqlite::Error::InvalidQuery)};
                }
            }
            tx.execute("INSERT INTO native_emoji_catalog(singleton,revision,payload) VALUES(1,?1,?2) ON CONFLICT(singleton) DO UPDATE SET revision=excluded.revision,payload=excluded.payload",params![catalog.revision,payload])?;
            if !valid(){return Err(rusqlite::Error::InvalidQuery);}
            Ok(true)
        })
    }
}
