//! A room's notes: one markdown document per room, saved whole against the
//! revision the editor read. A save publishes the room, so open clients refetch.
use crate::{
    App,
    auth::{Account, lock_active},
    error::{Error, Result},
    room_details,
};
use axum::http::StatusCode;
use chrono::{DateTime, SecondsFormat, Utc};
use rv_protocol::parity::{RoomNotes, UpdateRoomNotes};

/// Bytes of markdown a room's notes may hold.
pub const NOTES_BYTES: usize = 64 * 1024;

type NotesRow = (String, i64, Option<String>, Option<DateTime<Utc>>);

pub async fn read(app: &App, actor: &Account, room: &str) -> Result<RoomNotes> {
    let details = room_details::read(app, actor, room).await?;
    if !details.permissions.read {
        return Err(Error::forbidden());
    }
    let row: Option<NotesRow> = sqlx::query_as(
        "SELECT n.body,n.revision,u.username,n.updated_at FROM room_notes n LEFT JOIN users u ON u.id=n.updated_by WHERE n.room_id=$1",
    )
    .bind(room)
    .fetch_optional(&app.pool)
    .await?;
    let editable = details.permissions.send && !details.room.encrypted;
    Ok(wire(room, row, editable))
}

pub async fn write(
    app: &App,
    actor: &Account,
    room: &str,
    input: UpdateRoomNotes,
) -> Result<RoomNotes> {
    if input.body.len() > NOTES_BYTES || !revision_shaped(&input.expected_revision) {
        return Err(Error::invalid());
    }
    let details = room_details::read(app, actor, room).await?;
    if details.room.encrypted {
        return Err(Error::new(StatusCode::CONFLICT, "notes_encrypted_room"));
    }
    if !details.permissions.send {
        return Err(Error::forbidden());
    }
    let mut tx = app.pool.begin().await?;
    lock_active(&mut tx, actor).await?;
    room_details::admission(&mut tx, &actor.id).await?;
    let member: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM rooms r JOIN members m ON m.room_id=r.id AND m.user_id=$2 WHERE r.id=$1 FOR UPDATE OF r)",
    )
    .bind(room)
    .bind(&actor.id)
    .fetch_one(&mut *tx)
    .await?;
    if !member {
        return Err(Error::missing());
    }
    let current: Option<i64> =
        sqlx::query_scalar("SELECT revision FROM room_notes WHERE room_id=$1")
            .bind(room)
            .fetch_optional(&mut *tx)
            .await?;
    if current.unwrap_or(0).to_string() != input.expected_revision {
        return Err(Error::new(StatusCode::CONFLICT, "revision_conflict"));
    }
    let row: (i64, DateTime<Utc>) = sqlx::query_as(
        "INSERT INTO room_notes(room_id,body,revision,updated_by,updated_at) VALUES($1,$2,1,$3,clock_timestamp()) \
         ON CONFLICT(room_id) DO UPDATE SET body=EXCLUDED.body,revision=room_notes.revision+1,updated_by=EXCLUDED.updated_by,updated_at=EXCLUDED.updated_at \
         RETURNING revision,updated_at",
    )
    .bind(room)
    .bind(&input.body)
    .bind(&actor.id)
    .fetch_one(&mut *tx)
    .await?;
    room_details::publish(&mut tx, room).await?;
    tx.commit().await?;
    Ok(wire(
        room,
        Some((input.body, row.0, Some(actor.username.clone()), Some(row.1))),
        true,
    ))
}

fn revision_shaped(value: &str) -> bool {
    !value.is_empty() && value.len() <= 20 && value.bytes().all(|b| b.is_ascii_digit())
}

fn wire(room: &str, row: Option<NotesRow>, editable: bool) -> RoomNotes {
    let (body, revision, updated_by, updated_at) = row.unwrap_or_default();
    RoomNotes {
        room_id: room.to_owned(),
        body,
        revision: revision.to_string(),
        updated_by,
        updated_at: updated_at.map(|at| at.to_rfc3339_opts(SecondsFormat::Millis, true)),
        editable,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_room_without_notes_reads_as_revision_zero() {
        let notes = wire("r1", None, true);
        assert_eq!(notes.revision, "0");
        assert_eq!(notes.body, "");
        assert!(notes.updated_by.is_none() && notes.updated_at.is_none());
    }

    #[test]
    fn expected_revisions_are_decimal_counters() {
        assert!(revision_shaped("0"));
        assert!(revision_shaped("42"));
        assert!(!revision_shaped(""));
        assert!(!revision_shaped("-1"));
        assert!(!revision_shaped("1e3"));
        assert!(!revision_shaped(&"9".repeat(21)));
    }
}
