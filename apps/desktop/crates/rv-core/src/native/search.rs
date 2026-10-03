//! Ephemeral search results reuse the existing message renderer.
use super::{Error, markdown};
use rv_protocol::search::SearchPage;
use std::collections::HashSet;

pub(super) fn present(page: SearchPage, room: &str, membership: &str) -> Result<Vec<crate::normalize::Message>, Error> {
    if page.membership_version != membership {
        return Err(Error::Protocol("delivery_revalidate"));
    }
    if page.messages.len() > 50 || page.has_more && page.messages.is_empty() {
        return Err(Error::Protocol("invalid_search_page"));
    }
    let mut ids = HashSet::new();
    let mut before = u64::MAX;
    let mut hits = Vec::new();
    for m in page.messages {
        let position = m
            .position
            .parse::<u64>()
            .ok()
            .filter(|p| *p > 0 && p.to_string() == m.position)
            .ok_or(Error::Protocol("invalid_search_page"))?;
        if m.room_id != room || m.deleted || m.system.is_some() || position >= before || !ids.insert(m.id.clone()) {
            return Err(Error::Protocol("invalid_search_page"));
        }
        before = position;
        let ts = chrono::DateTime::parse_from_rfc3339(&m.created_at)
            .map_err(|_| Error::Protocol("invalid_search_page"))?
            .timestamp_millis();
        let document = m.body.map(|d| *d).unwrap_or_else(|| rv_protocol::markdown::parse(&m.text));
        super::files::validate_descriptors(&m.files, room)?;
        let files = super::files::attachments(&m.files)?;
        hits.push(crate::normalize::Message {
            id: m.id,
            rid: m.room_id,
            text: Some(m.text),
            ts,
            author_id: m.author.id.clone(),
            author_name: Some(m.author.username.clone()),
            thread_id: m.reply_to,
            md: Some(
                serde_json::to_string(&markdown::tree(&document))
                    .map_err(|_| Error::Protocol("invalid_search_page"))?,
            ),
            attachments: if files.is_empty() {
                None
            } else {
                Some(serde_json::to_string(&files).map_err(|_| Error::Protocol("invalid_file"))?)
            },
            ..Default::default()
        });
    }
    Ok(hits)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn search_preserves_exact_positions_and_never_accepts_other_rooms_or_old_grants() {
        let fixture: serde_json::Value =
            serde_json::from_str(include_str!("../../../../../../docs/protocol/v1.fixture.json")).unwrap();
        let m: rv_protocol::Message = serde_json::from_value(fixture["message"].clone()).unwrap();
        let page = SearchPage { membership_version: "grant".into(), messages: vec![m.clone()], has_more: false };
        let hits = present(page.clone(), &m.room_id, "grant").unwrap();
        assert_eq!(hits[0].text.as_deref(), Some(m.text.as_str()));
        assert!(hits[0].md.is_some());
        assert!(present(page.clone(), "other", "grant").is_err());
        assert_eq!(present(page.clone(), &m.room_id, "new").unwrap_err().code(), "delivery_revalidate");
        let mut bad = page.clone();
        bad.messages.push(m.clone());
        assert!(present(bad, &m.room_id, "grant").is_err());
        let mut bad = page.clone();
        bad.messages[0].deleted = true;
        assert!(present(bad, &m.room_id, "grant").is_err());
        let mut bad = page;
        bad.messages[0].position = "09007199254740993".into();
        assert!(present(bad, &m.room_id, "grant").is_err());
    }
}
