//! Called inside the room mutation transaction, after its locks and room event.
use crate::{
    auth::{Account, random_token},
    error::Result,
    store,
};
use rv_protocol::{Change, User, system::SystemMessage};
use sqlx::{Postgres, Transaction, types::Json};

pub(crate) async fn user(tx: &mut Transaction<'_, Postgres>, id: &str) -> Result<User> {
    let (id, username, display_name) =
        sqlx::query_as("SELECT id,username,display_name FROM users WHERE id=$1")
            .bind(id)
            .fetch_one(&mut **tx)
            .await?;
    Ok(User {
        id,
        username,
        display_name,
    })
}

pub(crate) async fn publish(
    tx: &mut Transaction<'_, Postgres>,
    actor: &Account,
    room: &str,
    activity: SystemMessage,
) -> Result<()> {
    let id = format!("sys_{}", &random_token()[..24]);
    let position = store::next_position(tx).await?;
    sqlx::query("INSERT INTO messages(id,room_id,author_id,operation_id,text,position,revision,system) VALUES($1,$2,$3,$1,'',$4,$4,$5)")
        .bind(&id).bind(room).bind(&actor.id).bind(position).bind(Json(activity)).execute(&mut **tx).await?;
    let message =
        sqlx::query_as::<_, store::MessageRow>(&format!("{} WHERE m.id=$1", store::MESSAGE_SELECT))
            .bind(&id)
            .fetch_one(&mut **tx)
            .await?
            .wire();
    store::event(tx, position, room, None, Change::MessageUpsert(message)).await
}
