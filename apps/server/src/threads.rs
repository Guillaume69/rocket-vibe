//! Same-room roots and replies, with independent monotone thread reads, the
//! room's thread list and who follows each thread.
use crate::{
    App,
    auth::{Account, identifier, lock_active},
    error::{Error, Result},
    room_reads,
    store::{self, MESSAGE_SELECT, MessageRow},
};
use axum::http::StatusCode;
use rv_protocol::{
    Change, MarkThreadRead, Message, PersonalFollow, ThreadEntry, ThreadList, ThreadPage,
    ThreadReadState,
    parity::{QuoteReference, SetMark},
};
use sqlx::{Postgres, Transaction};

pub(crate) fn send_fingerprint(
    room: &str,
    text: &str,
    quotes: &[QuoteReference],
    root: Option<&str>,
) -> String {
    match root {
        None => store::quoted_send_fingerprint(room, text, quotes),
        Some(root) => {
            crate::auth::hash_token(&serde_json::json!([room, text, quotes, root]).to_string())
        }
    }
}

pub(crate) async fn validate_root(
    tx: &mut Transaction<'_, Postgres>,
    room: &str,
    root: &str,
) -> Result<()> {
    let row: Option<(Option<String>, bool, bool)> = sqlx::query_as(
        "SELECT reply_to,deleted,system IS NOT NULL FROM messages WHERE id=$1 AND room_id=$2",
    )
    .bind(root)
    .bind(room)
    .fetch_optional(&mut **tx)
    .await?;
    let (parent, deleted, system) = row.ok_or_else(Error::missing)?;
    if deleted {
        return Err(Error::new(StatusCode::GONE, "thread_root_deleted"));
    }
    if parent.is_some() || system {
        return Err(Error::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "invalid_thread_root",
        ));
    }
    Ok(())
}

pub(crate) async fn refresh(
    tx: &mut Transaction<'_, Postgres>,
    room: &str,
    root: &str,
) -> Result<()> {
    let revision = store::next_position(tx).await?;
    sqlx::query("UPDATE messages SET revision=$2 WHERE id=$1")
        .bind(root)
        .bind(revision)
        .execute(&mut **tx)
        .await?;
    let message = sqlx::query_as::<_, MessageRow>(&format!("{MESSAGE_SELECT} WHERE m.id=$1"))
        .bind(root)
        .fetch_one(&mut **tx)
        .await?
        .wire();
    store::event(tx, revision, room, None, Change::MessageUpsert(message)).await
}

pub(crate) async fn root_room(
    conn: &mut sqlx::PgConnection,
    user: &str,
    root: &str,
) -> Result<String> {
    if !identifier(root) {
        return Err(Error::invalid());
    }
    sqlx::query_scalar("SELECT m.room_id FROM messages m JOIN members a ON a.room_id=m.room_id WHERE m.id=$1 AND a.user_id=$2 AND m.reply_to IS NULL AND m.system IS NULL")
        .bind(root).bind(user).fetch_optional(conn).await?.ok_or_else(Error::missing)
}

async fn state(
    conn: &mut sqlx::PgConnection,
    user: &str,
    root: &str,
    room: &str,
) -> Result<ThreadReadState> {
    let (membership,position,revision,unread):(String,i64,i64,i64)=sqlx::query_as("SELECT s.membership_version,GREATEST(s.reply_position,COALESCE(t.position,0)),GREATEST(s.revision,COALESCE(t.revision,0)),(SELECT count(*) FROM messages m WHERE m.reply_to=$1 AND m.position>GREATEST(s.reply_position,COALESCE(t.position,0)) AND m.author_id<>s.user_id AND NOT m.deleted) FROM room_read_states s LEFT JOIN thread_read_states t ON t.root_id=$1 AND t.user_id=s.user_id WHERE s.room_id=$2 AND s.user_id=$3")
        .bind(root).bind(room).bind(user).fetch_one(conn).await?;
    Ok(ThreadReadState {
        root_id: root.into(),
        room_id: room.into(),
        membership_version: membership,
        position: position.to_string(),
        revision: revision.to_string(),
        unread: unread.to_string(),
    })
}

pub async fn page(
    app: &App,
    actor: &Account,
    root: &str,
    before: Option<i64>,
    limit: i64,
) -> Result<ThreadPage> {
    let mut tx = app.pool.begin().await?;
    sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ")
        .execute(&mut *tx)
        .await?;
    let room = root_room(&mut tx, &actor.id, root).await?;
    let parent = sqlx::query_as::<_, MessageRow>(&format!("{MESSAGE_SELECT} WHERE m.id=$1"))
        .bind(root)
        .fetch_one(&mut *tx)
        .await?
        .wire();
    let mut messages = sqlx::query_as::<_, MessageRow>(&format!(
        "{MESSAGE_SELECT} WHERE m.reply_to=$1 AND m.position<$2 ORDER BY m.position DESC LIMIT $3"
    ))
    .bind(root)
    .bind(before.unwrap_or(i64::MAX))
    .bind(limit + 1)
    .fetch_all(&mut *tx)
    .await?
    .into_iter()
    .map(MessageRow::wire)
    .collect::<Vec<_>>();
    let has_more = messages.len() > limit as usize;
    messages.truncate(limit as usize);
    // Resolve root and replies together from the same authorized view.
    messages.insert(0, parent);
    crate::marks::personalize(&mut tx, &actor.id, &mut messages).await?;
    crate::quotes::personalize(&mut tx, &actor.id, &mut messages).await?;
    let parent = messages.remove(0);
    let read_state = state(&mut tx, &actor.id, root, &room).await?;
    tx.commit().await?;
    Ok(ThreadPage {
        root: parent,
        messages,
        has_more,
        read_state,
    })
}

pub async fn mark(
    app: &App,
    actor: &Account,
    root: &str,
    input: MarkThreadRead,
) -> Result<ThreadReadState> {
    let position = room_reads::position(&input.position)?;
    let mut tx = app.pool.begin().await?;
    lock_active(&mut tx, actor).await?;
    let room = root_room(&mut tx, &actor.id, root).await?;
    room_reads::lock_room(&mut tx, &room).await?;
    store::require_member(&mut tx, &room, &actor.id).await?;
    let highest: i64 =
        sqlx::query_scalar("SELECT COALESCE(max(position),0) FROM messages WHERE reply_to=$1")
            .bind(root)
            .fetch_one(&mut *tx)
            .await?;
    if position > highest {
        return Err(Error::new(StatusCode::CONFLICT, "invalid_read_position"));
    }
    let current = state(&mut tx, &actor.id, root, &room).await?;
    if position > room_reads::position(&current.position)? {
        room_reads::admission(&mut tx, &actor.id).await?;
        let revision = store::next_position(&mut tx).await?;
        sqlx::query("INSERT INTO thread_read_states(root_id,room_id,user_id,position,revision) VALUES($1,$2,$3,$4,$5) ON CONFLICT(root_id,user_id) DO UPDATE SET position=GREATEST(thread_read_states.position,excluded.position),revision=excluded.revision")
            .bind(root).bind(&room).bind(&actor.id).bind(position).bind(revision).execute(&mut *tx).await?;
        sqlx::query("UPDATE room_read_states SET revision=$3 WHERE room_id=$1 AND user_id=$2")
            .bind(&room)
            .bind(&actor.id)
            .bind(revision)
            .execute(&mut *tx)
            .await?;
        room_reads::publish(&mut tx, &room, Some(&actor.id), revision).await?;
    }
    let result = state(&mut tx, &actor.id, root, &room).await?;
    tx.commit().await?;
    Ok(result)
}

/// The reader's follow state of these roots, beside `personal_star`. A root
/// with replies and no row reads as not followed at revision 0.
pub(crate) async fn personalize(
    conn: &mut sqlx::PgConnection,
    user: &str,
    messages: &mut [Message],
) -> Result<()> {
    let root = |m: &Message| m.reply_to.is_none() && m.system.is_none() && !m.deleted;
    let ids: Vec<_> = messages
        .iter()
        .filter(|m| root(m))
        .map(|m| m.id.clone())
        .collect();
    if ids.is_empty() {
        return Ok(());
    }
    let rows: Vec<(String, bool, i64)> = sqlx::query_as(
        "SELECT root_id,present,revision FROM thread_follows WHERE user_id=$1 AND root_id=ANY($2)",
    )
    .bind(user)
    .bind(&ids)
    .fetch_all(conn)
    .await?;
    for message in messages.iter_mut().filter(|m| root(m)) {
        message.personal_follow = match rows.iter().find(|r| r.0 == message.id) {
            Some(row) => Some(Box::new(PersonalFollow {
                present: row.1,
                revision: row.2.to_string(),
            })),
            None if message.thread.is_some() => Some(Box::new(PersonalFollow {
                present: false,
                revision: "0".into(),
            })),
            None => None,
        };
    }
    Ok(())
}

/// Sets `user`'s follow of `root` and tells that account's sessions with a
/// private upsert of the root. Returns whether anything changed.
async fn set_follow(
    tx: &mut Transaction<'_, Postgres>,
    room: &str,
    root: &str,
    user: &str,
    present: bool,
) -> Result<bool> {
    let current: Option<bool> = sqlx::query_scalar(
        "SELECT present FROM thread_follows WHERE root_id=$1 AND user_id=$2 FOR UPDATE",
    )
    .bind(root)
    .bind(user)
    .fetch_optional(&mut **tx)
    .await?;
    // An unfollow before any reply is kept too: the first reply will not override it.
    if current == Some(present) {
        return Ok(false);
    }
    let revision = store::next_position(tx).await?;
    sqlx::query("INSERT INTO thread_follows(root_id,room_id,user_id,present,revision) VALUES($1,$2,$3,$4,$5) ON CONFLICT(root_id,user_id) DO UPDATE SET present=excluded.present,revision=excluded.revision")
        .bind(root).bind(room).bind(user).bind(present).bind(revision).execute(&mut **tx).await?;
    let mut message = sqlx::query_as::<_, MessageRow>(&format!("{MESSAGE_SELECT} WHERE m.id=$1"))
        .bind(root)
        .fetch_one(&mut **tx)
        .await?
        .wire();
    crate::marks::personalize(tx, user, std::slice::from_mut(&mut message)).await?;
    store::event(
        tx,
        revision,
        room,
        Some(user),
        Change::MessageUpsert(message),
    )
    .await?;
    Ok(true)
}

/// A reply makes its author follow the thread again (like Rocket.Chat), and
/// the root's author too the first time, unless they already chose.
pub(crate) async fn take_part(
    tx: &mut Transaction<'_, Postgres>,
    room: &str,
    root: &str,
    author: &str,
) -> Result<()> {
    set_follow(tx, room, root, author, true).await?;
    let first: Option<String> = sqlx::query_scalar(
        "SELECT m.author_id FROM messages m JOIN members a ON a.room_id=m.room_id AND a.user_id=m.author_id WHERE m.id=$1 AND m.author_id<>$2 AND NOT EXISTS(SELECT 1 FROM thread_follows f WHERE f.root_id=m.id AND f.user_id=m.author_id)",
    )
    .bind(root)
    .bind(author)
    .fetch_optional(&mut **tx)
    .await?;
    if let Some(first) = first {
        set_follow(tx, room, root, &first, true).await?;
    }
    Ok(())
}

/// `PUT /messages/{id}/follow`: a reply's id acts on its root. Idempotent per
/// operation, like stars. Returns the root's id.
pub async fn follow(app: &App, account: &Account, id: &str, input: SetMark) -> Result<String> {
    if !identifier(id) || !identifier(&input.operation_id) {
        return Err(Error::invalid());
    }
    let hash =
        crate::auth::hash_token(&serde_json::json!(["follow", id, input.present]).to_string());
    let mut tx = app.pool.begin().await?;
    lock_active(&mut tx, account).await?;
    let (room, parent): (String, Option<String>) =
        sqlx::query_as("SELECT room_id,reply_to FROM messages WHERE id=$1")
            .bind(id)
            .fetch_optional(&mut *tx)
            .await?
            .ok_or_else(Error::missing)?;
    let root = parent.unwrap_or_else(|| id.to_owned());
    store::require_member(&mut tx, &room, &account.id).await?;
    let receipt: Option<String> = sqlx::query_scalar(
        "SELECT command_hash FROM message_actions WHERE user_id=$1 AND operation_id=$2",
    )
    .bind(&account.id)
    .bind(&input.operation_id)
    .fetch_optional(&mut *tx)
    .await?;
    if let Some(previous) = receipt {
        if previous != hash {
            return Err(Error::conflict());
        }
        tx.commit().await?;
        return Ok(root);
    }
    let used: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM messages WHERE author_id=$1 AND operation_id=$2) OR EXISTS(SELECT 1 FROM room_creation_requests WHERE user_id=$1 AND operation_id=$2) OR EXISTS(SELECT 1 FROM room_commands WHERE user_id=$1 AND operation_id=$2) OR EXISTS(SELECT 1 FROM e2ee_application_messages WHERE user_id=$1 AND operation_id=$2)")
        .bind(&account.id).bind(&input.operation_id).fetch_one(&mut *tx).await?;
    if used {
        return Err(Error::conflict());
    }
    let (deleted, system): (bool, bool) =
        sqlx::query_as("SELECT deleted,system IS NOT NULL FROM messages WHERE id=$1")
            .bind(&root)
            .fetch_one(&mut *tx)
            .await?;
    if deleted {
        return Err(Error::new(StatusCode::GONE, "message_deleted"));
    }
    if system {
        return Err(Error::forbidden());
    }
    crate::limits::message_action(&mut tx, &account.id).await?;
    set_follow(&mut tx, &room, &root, &account.id, input.present).await?;
    sqlx::query("INSERT INTO message_actions(user_id,operation_id,command_hash,message_id) VALUES($1,$2,$3,$4)")
        .bind(&account.id).bind(&input.operation_id).bind(hash).bind(id).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(root)
}

/// `GET /rooms/{id}/threads`: the room's roots that have live replies, latest
/// reply first, paged by that reply's position. Plaintext threads only: an
/// encrypted room's roots are opaque routing the server does not list.
pub async fn list(
    app: &App,
    actor: &Account,
    room: &str,
    following: bool,
    before: Option<i64>,
    limit: i64,
) -> Result<ThreadList> {
    let mut tx = app.pool.begin().await?;
    sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ")
        .execute(&mut *tx)
        .await?;
    store::require_member(&mut tx, room, &actor.id).await?;
    let mut rows: Vec<(String, i64)> = sqlx::query_as("SELECT r.reply_to,max(r.position) AS last FROM messages r JOIN messages m ON m.id=r.reply_to WHERE r.room_id=$1 AND r.reply_to IS NOT NULL AND NOT r.deleted AND NOT m.deleted AND (NOT $3 OR EXISTS(SELECT 1 FROM thread_follows f WHERE f.root_id=r.reply_to AND f.user_id=$4 AND f.present)) GROUP BY r.reply_to HAVING max(r.position)<$2 ORDER BY last DESC LIMIT $5")
        .bind(room)
        .bind(before.unwrap_or(i64::MAX))
        .bind(following)
        .bind(&actor.id)
        .bind(limit + 1)
        .fetch_all(&mut *tx)
        .await?;
    let has_more = rows.len() > limit as usize;
    rows.truncate(limit as usize);
    let ids: Vec<_> = rows.iter().map(|r| r.0.clone()).collect();
    let mut roots: Vec<Message> =
        sqlx::query_as::<_, MessageRow>(&format!("{MESSAGE_SELECT} WHERE m.id=ANY($1)"))
            .bind(&ids)
            .fetch_all(&mut *tx)
            .await?
            .into_iter()
            .map(MessageRow::wire)
            .collect();
    crate::marks::personalize(&mut tx, &actor.id, &mut roots).await?;
    crate::quotes::personalize(&mut tx, &actor.id, &mut roots).await?;
    let unread: Vec<(String, i64)> = sqlx::query_as("SELECT r.reply_to,count(*) FROM messages r JOIN room_read_states s ON s.room_id=r.room_id AND s.user_id=$2 LEFT JOIN thread_read_states t ON t.root_id=r.reply_to AND t.user_id=$2 WHERE r.reply_to=ANY($1) AND NOT r.deleted AND r.author_id<>$2 AND r.position>GREATEST(s.reply_position,COALESCE(t.position,0)) GROUP BY r.reply_to")
        .bind(&ids)
        .bind(&actor.id)
        .fetch_all(&mut *tx)
        .await?;
    tx.commit().await?;
    let next = if has_more {
        rows.last().map(|r| r.1.to_string())
    } else {
        None
    };
    let mut threads = Vec::with_capacity(rows.len());
    for (id, last) in rows {
        let Some(index) = roots.iter().position(|m| m.id == id) else {
            continue;
        };
        let root = roots.swap_remove(index);
        threads.push(ThreadEntry {
            following: root.personal_follow.as_ref().is_some_and(|f| f.present),
            unread: unread
                .iter()
                .find(|u| u.0 == id)
                .map_or(0, |u| u.1)
                .to_string(),
            last_reply_position: last.to_string(),
            root,
        });
    }
    Ok(ThreadList { threads, next })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::auth;
    use rv_protocol::{CreateRoom, SendMessage};
    use sqlx::PgPool;

    const PASSWORD: &str = "disposable-threads-test-password";

    async fn account(app: &App, name: &str) -> Account {
        auth::create_user(app, name, PASSWORD.into(), false)
            .await
            .unwrap();
        let session = auth::login(app, name.into(), PASSWORD.into())
            .await
            .unwrap();
        auth::authenticate(app, &auth::hash_token(&session.token))
            .await
            .unwrap()
    }

    fn say(id: &str, root: Option<&str>, also_in_room: bool) -> SendMessage {
        SendMessage {
            also_in_room,
            operation_id: id.into(),
            text: format!("text of {id}"),
            reply_to: root.map(Into::into),
            quotes: vec![],
            cards: vec![],
            files: vec![],
        }
    }

    fn mark(id: &str, present: bool) -> SetMark {
        SetMark {
            operation_id: id.into(),
            present,
        }
    }

    async fn room(app: &App, owner: &Account, members: &[&Account]) -> String {
        let room = store::create_room(
            app,
            owner,
            CreateRoom {
                name: "Threads".into(),
                private: true,
                operation_id: None,
                voice: false,
            },
        )
        .await
        .unwrap();
        for member in members {
            store::membership(app, owner, &room.id, &member.id, false)
                .await
                .unwrap();
        }
        room.id
    }

    async fn ids(app: &App, who: &Account, room: &str, following: bool) -> Vec<String> {
        list(app, who, room, following, None, 50)
            .await
            .unwrap()
            .threads
            .into_iter()
            .map(|t| t.root.id)
            .collect()
    }

    /// Private root upserts in the journal for `user`, carrying their follow state.
    async fn private_follow_events(app: &App, user: &str, root: &str) -> Vec<bool> {
        let rows: Vec<sqlx::types::Json<Change>> = sqlx::query_scalar(
            "SELECT change FROM journal WHERE recipient_id=$1 AND change->>'type'='message_upsert' AND change#>>'{data,id}'=$2 ORDER BY position",
        )
        .bind(user)
        .bind(root)
        .fetch_all(&app.pool)
        .await
        .unwrap();
        rows.into_iter()
            .map(|change| match change.0 {
                Change::MessageUpsert(message) => message.personal_follow.unwrap().present,
                _ => unreachable!(),
            })
            .collect()
    }

    #[sqlx::test]
    async fn the_list_puts_the_latest_reply_first_and_pages(pool: PgPool) {
        let app = App::from_pool(pool).await.unwrap();
        let alice = account(&app, "threads-alice").await;
        let bob = account(&app, "threads-bob").await;
        let carol = account(&app, "threads-carol").await;
        let room = room(&app, &alice, &[&bob, &carol]).await;
        for root in ["root-1", "root-2", "root-3"] {
            store::send(&app, &alice, &room, say(root, None, false))
                .await
                .unwrap();
        }
        // root-3 has no reply: not a thread. root-1 gets the latest reply.
        for (reply, root) in [("re-1", "root-1"), ("re-2", "root-2"), ("re-3", "root-1")] {
            store::send(&app, &bob, &room, say(reply, Some(root), false))
                .await
                .unwrap();
        }
        assert_eq!(ids(&app, &carol, &room, false).await, ["root-1", "root-2"]);
        let first = list(&app, &carol, &room, false, None, 1).await.unwrap();
        assert_eq!(first.threads.len(), 1);
        assert_eq!(first.threads[0].root.id, "root-1");
        assert_eq!(first.threads[0].root.thread.as_ref().unwrap().replies, "2");
        assert_eq!(first.threads[0].unread, "2");
        assert!(!first.threads[0].following);
        let before = room_reads::position(first.next.as_ref().unwrap()).unwrap();
        let second = list(&app, &carol, &room, false, Some(before), 1)
            .await
            .unwrap();
        assert_eq!(second.threads[0].root.id, "root-2");
        assert!(second.next.is_none());
        // The replier and the root's author follow both; a bystander none.
        assert_eq!(ids(&app, &bob, &room, true).await, ["root-1", "root-2"]);
        assert_eq!(ids(&app, &alice, &room, true).await, ["root-1", "root-2"]);
        assert!(ids(&app, &carol, &room, true).await.is_empty());
        // A deleted reply leaves the order; a root whose replies are all gone leaves the list.
        sqlx::query("UPDATE messages SET deleted=true WHERE id='re-2'")
            .execute(&app.pool)
            .await
            .unwrap();
        assert_eq!(ids(&app, &carol, &room, false).await, ["root-1"]);
        // Members only.
        let dave = account(&app, "threads-dave").await;
        assert!(list(&app, &dave, &room, false, None, 50).await.is_err());
    }

    #[sqlx::test]
    async fn following_is_idempotent_private_and_comes_back_with_a_reply(pool: PgPool) {
        let app = App::from_pool(pool).await.unwrap();
        let alice = account(&app, "follow-alice").await;
        let bob = account(&app, "follow-bob").await;
        let carol = account(&app, "follow-carol").await;
        let room = room(&app, &alice, &[&bob, &carol]).await;
        store::send(&app, &alice, &room, say("root", None, false))
            .await
            .unwrap();
        store::send(&app, &bob, &room, say("reply-1", Some("root"), false))
            .await
            .unwrap();
        // The replier and the root's author were told, each privately.
        assert_eq!(private_follow_events(&app, &bob.id, "root").await, [true]);
        assert_eq!(private_follow_events(&app, &alice.id, "root").await, [true]);
        // Carol follows through a reply's id: it acts on the root.
        assert_eq!(
            follow(&app, &carol, "reply-1", mark("op-follow", true))
                .await
                .unwrap(),
            "root"
        );
        // The same operation again changes nothing; another body under it conflicts.
        follow(&app, &carol, "reply-1", mark("op-follow", true))
            .await
            .unwrap();
        assert!(
            follow(&app, &carol, "reply-1", mark("op-follow", false))
                .await
                .is_err()
        );
        // A new operation to the same state publishes nothing more.
        follow(&app, &carol, "root", mark("op-follow-2", true))
            .await
            .unwrap();
        assert_eq!(private_follow_events(&app, &carol.id, "root").await, [true]);
        assert_eq!(ids(&app, &carol, &room, true).await, ["root"]);
        // Reads of the root carry the reader's own state, and only theirs.
        let page = page(&app, &carol, "root", None, 50).await.unwrap();
        assert!(page.root.personal_follow.unwrap().present);
        // Bob unfollows: a reply by someone else does not bring it back...
        follow(&app, &bob, "root", mark("op-unfollow", false))
            .await
            .unwrap();
        assert!(ids(&app, &bob, &room, true).await.is_empty());
        store::send(&app, &alice, &room, say("reply-2", Some("root"), false))
            .await
            .unwrap();
        assert!(ids(&app, &bob, &room, true).await.is_empty());
        // ...his own reply does, like Rocket.Chat.
        store::send(&app, &bob, &room, say("reply-3", Some("root"), false))
            .await
            .unwrap();
        assert_eq!(ids(&app, &bob, &room, true).await, ["root"]);
        assert_eq!(
            private_follow_events(&app, &bob.id, "root").await,
            [true, false, true]
        );
        // An unfollow by the root's author before anyone replies holds.
        store::send(&app, &alice, &room, say("quiet", None, false))
            .await
            .unwrap();
        follow(&app, &alice, "quiet", mark("op-quiet", false))
            .await
            .unwrap();
        store::send(&app, &bob, &room, say("reply-q", Some("quiet"), false))
            .await
            .unwrap();
        assert_eq!(ids(&app, &alice, &room, true).await, ["root"]);
        // Outsiders and unknown messages: missing.
        let dave = account(&app, "follow-dave").await;
        assert!(
            follow(&app, &dave, "root", mark("op-dave", true))
                .await
                .is_err()
        );
        assert!(
            follow(&app, &carol, "nothing", mark("op-none", true))
                .await
                .is_err()
        );
    }

    #[sqlx::test]
    async fn a_reply_also_sent_to_the_room_shows_in_its_history_on_request(pool: PgPool) {
        let app = App::from_pool(pool).await.unwrap();
        let alice = account(&app, "shown-alice").await;
        let room = room(&app, &alice, &[]).await;
        store::send(&app, &alice, &room, say("root", None, false))
            .await
            .unwrap();
        // Only a reply can be shown in the room.
        assert!(
            store::send(&app, &alice, &room, say("lonely", None, true))
                .await
                .is_err()
        );
        let shown = store::send(&app, &alice, &room, say("shown", Some("root"), true))
            .await
            .unwrap();
        assert!(shown.also_in_room);
        assert_eq!(shown.reply_to.as_deref(), Some("root"));
        store::send(&app, &alice, &room, say("hidden", Some("root"), false))
            .await
            .unwrap();
        // A replay keeps it; the same operation without the flag conflicts.
        assert!(
            store::send(&app, &alice, &room, say("shown", Some("root"), true))
                .await
                .unwrap()
                .also_in_room
        );
        assert!(
            store::send(&app, &alice, &room, say("shown", Some("root"), false))
                .await
                .is_err()
        );
        let history = |also| {
            let (app, alice, room) = (&app, &alice, &room);
            async move {
                store::history(app, alice, room, None, 50, also)
                    .await
                    .unwrap()
                    .messages
                    .into_iter()
                    .filter(|m| m.system.is_none())
                    .map(|m| m.id)
                    .collect::<Vec<_>>()
            }
        };
        // Older clients keep a timeline of roots only.
        assert_eq!(history(false).await, ["root"]);
        assert_eq!(history(true).await, ["shown", "root"]);
        // It stays a reply of its thread.
        let thread = page(&app, &alice, "root", None, 50).await.unwrap();
        assert_eq!(
            thread
                .messages
                .iter()
                .map(|m| m.id.as_str())
                .collect::<Vec<_>>(),
            ["hidden", "shown"]
        );
    }
}
