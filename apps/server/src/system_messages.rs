//! Called inside the room mutation transaction, after its locks and room event.
use crate::{
    auth::{Account, random_token},
    error::Result,
    store,
};
use rv_protocol::{Change, User, system::SystemMessage};
use sqlx::{Postgres, Transaction, types::Json};

pub(crate) async fn user(tx: &mut Transaction<'_, Postgres>, id: &str) -> Result<User> {
    let (id, username, display_name, deleted) =
        sqlx::query_as("SELECT id,username,display_name,deleted FROM users WHERE id=$1")
            .bind(id)
            .fetch_one(&mut **tx)
            .await?;
    Ok(User {
        id,
        username,
        display_name,
        deleted,
    })
}

pub(crate) async fn publish(
    tx: &mut Transaction<'_, Postgres>,
    actor: &Account,
    room: &str,
    activity: SystemMessage,
) -> Result<()> {
    insert(tx, &actor.id, room, activity).await.map(drop)
}

/// Publishes the row and returns its id, for a row revised later (a call's outcome).
pub(crate) async fn insert(
    tx: &mut Transaction<'_, Postgres>,
    author: &str,
    room: &str,
    activity: SystemMessage,
) -> Result<String> {
    let id = format!("sys_{}", &random_token()[..24]);
    let position = store::next_position(tx).await?;
    sqlx::query("INSERT INTO messages(id,room_id,author_id,operation_id,text,position,revision,system) VALUES($1,$2,$3,$1,'',$4,$4,$5)")
        .bind(&id).bind(room).bind(author).bind(position).bind(Json(activity)).execute(&mut **tx).await?;
    let message =
        sqlx::query_as::<_, store::MessageRow>(&format!("{} WHERE m.id=$1", store::MESSAGE_SELECT))
            .bind(&id)
            .fetch_one(&mut **tx)
            .await?
            .wire();
    store::event(tx, position, room, None, Change::MessageUpsert(message)).await?;
    Ok(id)
}

/// A new revision of a row whose derived state changed, published to the room.
pub(crate) async fn revise(tx: &mut Transaction<'_, Postgres>, id: &str) -> Result<()> {
    let position = store::next_position(tx).await?;
    let room: String =
        sqlx::query_scalar("UPDATE messages SET revision=$2 WHERE id=$1 RETURNING room_id")
            .bind(id)
            .bind(position)
            .fetch_one(&mut **tx)
            .await?;
    let message =
        sqlx::query_as::<_, store::MessageRow>(&format!("{} WHERE m.id=$1", store::MESSAGE_SELECT))
            .bind(id)
            .fetch_one(&mut **tx)
            .await?
            .wire();
    store::event(tx, position, &room, None, Change::MessageUpsert(message)).await
}
