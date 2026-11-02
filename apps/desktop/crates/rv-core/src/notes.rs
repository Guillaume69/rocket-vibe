//! A room's notes, as every provider that keeps them is shown: one markdown
//! document, read whole and saved whole against the revision it was read at.

/// The server's answer to a save made on a revision someone else replaced.
pub const CONFLICT: &str = "revision_conflict";

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Notes {
    pub markdown: String,
    /// Opaque; handed back on save.
    pub revision: String,
    pub editable: bool,
    /// Who saved last, as the provider names them.
    pub updated_by: Option<String>,
    /// RFC 3339.
    pub updated_at: Option<String>,
}

impl Notes {
    /// When they were last saved, in milliseconds since the epoch.
    pub fn updated_ms(&self) -> Option<i64> {
        let at = chrono::DateTime::parse_from_rfc3339(self.updated_at.as_deref()?).ok()?;
        Some(at.timestamp_millis())
    }
}

impl From<rv_protocol::parity::RoomNotes> for Notes {
    fn from(notes: rv_protocol::parity::RoomNotes) -> Self {
        Notes {
            markdown: notes.body,
            revision: notes.revision,
            editable: notes.editable,
            updated_by: notes.updated_by,
            updated_at: notes.updated_at,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn vibez_notes_keep_their_revision_and_editor() {
        let notes = Notes::from(rv_protocol::parity::RoomNotes {
            room_id: "r1".into(),
            body: "# Plan".into(),
            revision: "3".into(),
            updated_by: Some("alice".into()),
            updated_at: Some("2026-11-02T10:00:00.000Z".into()),
            editable: false,
        });
        assert_eq!(notes.markdown, "# Plan");
        assert_eq!(notes.revision, "3");
        assert_eq!(notes.updated_by.as_deref(), Some("alice"));
        assert!(!notes.editable);
        assert_eq!(notes.updated_ms(), Some(1_793_613_600_000));
        assert_eq!(Notes::default().updated_ms(), None);
    }
}
