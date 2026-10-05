//! Volatile ordinary-room cards. The wrapped conversation is not exposed and
//! cannot author a private draft, message or ordinary SQL write.
use super::*;
use serde_json::Value;

#[derive(Clone)]
pub struct QuoteReader(pub(super) Access);
impl QuoteReader {
    pub fn close(&self) {
        self.0.close();
    }
    pub fn check(&self) -> Result<()> {
        self.0.check()
    }
    /// Resolve a copied cache window; neither the cache nor its smoothing
    /// buffers receive decrypted cards. Callers dispose the result on blur.
    pub async fn project(&self, rows: Vec<crate::store::MessageRow>) -> Result<Vec<crate::store::MessageRow>> {
        let _serial = self.0.0.serial.lock().await;
        self.0.0.room.current().await?;
        let destination = &self.0.0.room.0.id;
        let mut messages = Vec::with_capacity(rows.len());
        for mut row in rows {
            if &row.rid != destination {
                return Err(room_changed());
            }
            let mut attachments = pieces(&row)?;
            let quotes = references(&attachments)?;
            if !quotes.is_empty() {
                attachments.retain(|p| p.get("native_reference").is_none());
                row.attachments = Some(serde_json::to_string(&attachments).map_err(|_| room_changed())?);
            }
            messages.push(Message {
                operation: row.id.clone(),
                row,
                position: None,
                observed_at: 0,
                delivery: Delivery::Journaled,
                quotes,
            });
        }
        self.0.project_quotes(&mut messages).await?;
        self.check()?;
        Ok(messages.into_iter().map(|m| m.row).collect())
    }
    pub fn needed(rows: &[crate::store::MessageRow]) -> bool {
        rows.iter().any(|row| pieces(row).is_ok_and(|p| p.iter().any(|p| p.get("native_reference").is_some())))
    }
}
fn pieces(row: &crate::store::MessageRow) -> Result<Vec<Value>> {
    row.attachments
        .as_deref()
        .map(serde_json::from_str)
        .transpose()
        .map_err(|_| room_changed())
        .map(|v| v.unwrap_or_default())
}
fn references(pieces: &[Value]) -> Result<Vec<QuoteReference>> {
    let refs = pieces
        .iter()
        .filter_map(|p| p.get("native_reference"))
        .map(|r| serde_json::from_value::<QuoteReference>(r.clone()).map_err(|_| room_changed()))
        .collect::<Result<Vec<_>>>()?;
    let mut seen = BTreeSet::new();
    if refs.len() > 8
        || refs.iter().any(|r| {
            let id = |s: &str| {
                !s.is_empty()
                    && s.len() <= 128
                    && s.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-'))
            };
            !id(&r.room_id)
                || !id(&r.message_id)
                || !seen.insert((&r.room_id, &r.message_id))
                || r.revision.parse::<i64>().ok().is_none_or(|p| p <= 0 || p.to_string() != r.revision)
        })
    {
        return Err(room_changed());
    }
    Ok(refs)
}
