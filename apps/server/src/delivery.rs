//! Revalidate the grant that authorized a read, then retain database row locks
//! until HTTP body submission or a WebSocket flush. No process-local ACL lock.
use crate::{
    App,
    auth::Account,
    error::{Error, Result},
};
use axum::{
    body::{Body, Bytes},
    http::{StatusCode, header},
    response::Response,
};
use futures_util::Stream;
use serde::Serialize;
use sqlx::{Postgres, Transaction};
use std::{
    collections::BTreeMap,
    io,
    pin::Pin,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    task::{Context, Poll},
    time::Duration,
};
use tokio::sync::oneshot;

const DEADLINE: Duration = Duration::from_secs(5);
pub enum Scope<'a> {
    All,
    Room(&'a str),
    None,
}

pub struct ReadProof {
    user: String,
    activation_version: String,
    epoch: String,
    grants: BTreeMap<String, String>,
}

fn changed() -> Error {
    Error::new(StatusCode::CONFLICT, "delivery_revalidate")
}

impl ReadProof {
    /// Capture before reading. The nonce detects an ABA (remove, then rejoin)
    /// even if the account has permission again when its payload is ready.
    pub async fn capture(app: &App, account: &Account, scope: Scope<'_>) -> Result<Self> {
        let (all, rooms) = match scope {
            Scope::All => (true, Vec::new()),
            Scope::Room(id) => (false, vec![id]),
            Scope::None => (false, Vec::new()),
        };
        let rows: Vec<(String,Option<String>,Option<String>)> = sqlx::query_as(
            "SELECT i.data_epoch,m.room_id,m.access_version FROM instance i LEFT JOIN members m \
             ON m.user_id=$1 AND ($2 OR m.room_id=ANY($3)) WHERE i.singleton ORDER BY m.room_id LIMIT 1001")
            .bind(&account.id).bind(all).bind(rooms).fetch_all(&app.pool).await?;
        if rows.len() > 1000 {
            return Err(Error::new(StatusCode::CONFLICT, "snapshot_limit"));
        }
        let epoch = rows.first().ok_or_else(Error::internal)?.0.clone();
        let grants = rows
            .into_iter()
            .filter_map(|(_, room, version)| Some((room?, version?)))
            .collect();
        Ok(Self {
            user: account.id.clone(),
            activation_version: account.activation_version.clone(),
            epoch,
            grants,
        })
    }

    pub async fn lock(
        &self,
        app: &App,
        session: &str,
        rooms: &[String],
        snapshot: Option<&str>,
    ) -> Result<Transaction<'static, Postgres>> {
        tokio::time::timeout(DEADLINE, self.lock_inner(app, session, rooms, snapshot))
            .await
            .map_err(|_| changed())?
    }

    async fn lock_inner(
        &self,
        app: &App,
        session: &str,
        rooms: &[String],
        snapshot: Option<&str>,
    ) -> Result<Transaction<'static, Postgres>> {
        let mut tx = app.pool.begin().await?;
        sqlx::query("SET LOCAL lock_timeout='3s'")
            .execute(&mut *tx)
            .await?;
        sqlx::query("SET LOCAL statement_timeout='3s'")
            .execute(&mut *tx)
            .await?;
        let epoch: Option<String> = sqlx::query_scalar(
            "SELECT data_epoch FROM instance WHERE singleton AND data_epoch=$1 FOR KEY SHARE",
        )
        .bind(&self.epoch)
        .fetch_optional(&mut *tx)
        .await?;
        if epoch.is_none() {
            return Err(changed());
        }
        let user: Option<String> = sqlx::query_scalar(
            "SELECT activation_version FROM users WHERE id=$1 AND NOT disabled FOR KEY SHARE",
        )
        .bind(&self.user)
        .fetch_optional(&mut *tx)
        .await?;
        if user.is_none() {
            return Err(Error::unauthorized());
        }
        let session: Option<String> = sqlx::query_scalar("SELECT token_hash FROM sessions WHERE token_hash=$1 AND user_id=$2 AND expires_at>now() FOR SHARE")
            .bind(session).bind(&self.user).fetch_optional(&mut *tx).await?;
        if session.is_none() {
            return Err(Error::unauthorized());
        }
        if user.as_deref() != Some(&self.activation_version) {
            return Err(changed());
        }
        // Snapshot heads are locked after memberships, matching revocation's
        // delete-members / delete-heads order. Never hold a head while awaiting
        // a membership row being removed by that same transaction.
        let wanted: Vec<String> = if snapshot.is_some() {
            self.grants.keys().cloned().collect()
        } else {
            rooms
                .iter()
                .cloned()
                .collect::<std::collections::BTreeSet<_>>()
                .into_iter()
                .collect()
        };
        let grants: Vec<(String,String)> = sqlx::query_as("SELECT room_id,access_version FROM members WHERE user_id=$1 AND room_id=ANY($2) ORDER BY room_id FOR SHARE")
            .bind(&self.user).bind(&wanted).fetch_all(&mut *tx).await?;
        if grants.len() != wanted.len()
            || grants
                .iter()
                .any(|(room, version)| self.grants.get(room) != Some(version))
        {
            return Err(changed());
        }
        if let Some(id) = snapshot {
            let head: Option<String> = sqlx::query_scalar("SELECT id FROM snapshot_heads WHERE id=$1 AND user_id=$2 AND data_epoch=$3 AND ready AND expires_at>now() FOR KEY SHARE")
                .bind(id).bind(&self.user).bind(&self.epoch).fetch_optional(&mut *tx).await?;
            if head.is_none() {
                return Err(changed());
            }
        }
        Ok(tx)
    }

    pub async fn json(
        &self,
        app: &App,
        session: &str,
        value: &impl Serialize,
        rooms: &[String],
        snapshot: Option<&str>,
    ) -> Result<Response> {
        let bytes = Bytes::from(serde_json::to_vec(value).map_err(|_| Error::internal())?);
        let lease = self.lock(app, session, rooms, snapshot).await?;
        Ok(leased_json(bytes, lease))
    }

    pub async fn public_json(
        &self,
        app: &App,
        session: &str,
        page: &rv_protocol::PublicRoomPage,
    ) -> Result<Response> {
        let bytes = Bytes::from(serde_json::to_vec(page).map_err(|_| Error::internal())?);
        let mut lease = self.lock(app, session, &[], None).await?;
        let ids: Vec<_> = page.rooms.iter().map(|r| r.room.id.clone()).collect();
        let current:Vec<(String,String,i64)>=sqlx::query_as("SELECT id,name,revision FROM rooms WHERE kind='public' AND id=ANY($1) ORDER BY id FOR SHARE")
            .bind(&ids).fetch_all(&mut *lease).await?;
        if current.len() != page.rooms.len()
            || page.rooms.iter().any(|hit| {
                !current.iter().any(|(id, name, revision)| {
                    id == &hit.room.id
                        && name == &hit.room.name
                        && revision.to_string() == hit.room.revision
                })
            })
        {
            return Err(changed());
        }
        Ok(leased_json(bytes, lease))
    }
}

fn leased_json(bytes: Bytes, lease: Transaction<'static, Postgres>) -> Response {
    let length = bytes.len();
    let mut response = Response::new(Body::from_stream(LeasedBody::new(bytes, lease)));
    response
        .headers_mut()
        .insert(header::CONTENT_TYPE, "application/json".parse().unwrap());
    response
        .headers_mut()
        .insert(header::CONTENT_LENGTH, length.into());
    response
}

/// The task owns the transaction so an unpolled body cannot retain locks
/// indefinitely. The body is one frame: after its lease expires it cannot submit
/// any further payload, even if Hyper resumes polling it later.
struct LeasedBody {
    bytes: Option<Bytes>,
    release: Option<oneshot::Sender<()>>,
    active: Arc<AtomicBool>,
}
impl LeasedBody {
    fn new(bytes: Bytes, lease: Transaction<'static, Postgres>) -> Self {
        let (release, completed) = oneshot::channel();
        let active = Arc::new(AtomicBool::new(true));
        let live = active.clone();
        tokio::spawn(async move {
            tokio::select! { _ = completed => (), _ = tokio::time::sleep(DEADLINE) => () }
            live.store(false, Ordering::SeqCst);
            let _ = lease.rollback().await;
        });
        Self {
            bytes: Some(bytes),
            release: Some(release),
            active,
        }
    }
}
impl Stream for LeasedBody {
    type Item = std::result::Result<Bytes, io::Error>;
    fn poll_next(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        let this = self.get_mut();
        let Some(bytes) = this.bytes.take() else {
            this.release.take();
            return Poll::Ready(None);
        };
        if !this.active.load(Ordering::SeqCst) {
            return Poll::Ready(Some(Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "delivery lease expired",
            ))));
        }
        Poll::Ready(Some(Ok(bytes)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{auth, store, sync};
    use axum::{body::to_bytes, http::Request};
    use rv_protocol::{Change, CreateRoom, Room, SendMessage};
    use sqlx::PgPool;
    use tower::ServiceExt;

    struct Fixture {
        app: App,
        owner: Account,
        reader: Account,
        hash: String,
        token: String,
        room: Room,
    }
    async fn fixture(pool: PgPool) -> Fixture {
        let app = App::from_pool(pool).await.unwrap();
        for user in ["owner", "reader"] {
            auth::create_user(&app, user, "test-password-2026".into(), false)
                .await
                .unwrap();
        }
        let login = auth::login_from(&app, "owner".into(), "test-password-2026".into(), None)
            .await
            .unwrap();
        let owner = auth::authenticate(&app, &auth::hash_token(&login.token))
            .await
            .unwrap();
        let login = auth::login_from(&app, "reader".into(), "test-password-2026".into(), None)
            .await
            .unwrap();
        let hash = auth::hash_token(&login.token);
        let reader = auth::authenticate(&app, &hash).await.unwrap();
        let room = store::create_room(
            &app,
            &owner,
            CreateRoom {
                name: "Secret".into(),
                private: true,
                operation_id: None,
            },
        )
        .await
        .unwrap();
        store::membership(&app, &owner, &room.id, &reader.id, false)
            .await
            .unwrap();
        Fixture {
            app,
            owner,
            reader,
            hash,
            token: login.token,
            room,
        }
    }
    fn request(f: &Fixture, path: &str, method: &str) -> Request<Body> {
        Request::builder()
            .uri(path)
            .method(method)
            .header("authorization", format!("Bearer {}", f.token))
            .body(Body::empty())
            .unwrap()
    }
    async fn wait_for_delete(pool: &PgPool) {
        tokio::time::timeout(Duration::from_secs(2),async {
            loop {
                let blocked: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'DELETE FROM members%')")
                    .fetch_one(pool).await.unwrap();
                if blocked { break; }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        }).await.expect("the second application must actually wait on the delivery's database lock");
    }

    #[sqlx::test]
    async fn http_payloads_hold_revocation_until_the_body_is_submitted(pool: PgPool) {
        let f = fixture(pool.clone()).await;
        // Separate App objects simulate two server processes sharing PostgreSQL.
        let other = App::from_pool(pool.clone()).await.unwrap();
        for (index, route) in ["history", "snapshot", "pages", "changes"]
            .into_iter()
            .enumerate()
        {
            let initial = sync::snapshot(&f.app, &f.reader).await.unwrap();
            store::send(
                &f.app,
                &f.owner,
                &f.room.id,
                SendMessage {
                    operation_id: format!("secret-{index}"),
                    text: "private payload".into(),
                },
            )
            .await
            .unwrap();
            let path = match route {
                "history" => format!("/api/v1/rooms/{}/messages", f.room.id),
                "snapshot" => "/api/v1/sync/snapshot".into(),
                "pages" => "/api/v1/sync/snapshots".into(),
                _ => format!("/api/v1/sync/changes?cursor={}", initial.cursor),
            };
            let response = f
                .app
                .clone()
                .router()
                .oneshot(request(
                    &f,
                    &path,
                    if route == "pages" { "POST" } else { "GET" },
                ))
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::OK);
            let app = other.clone();
            let room = f.room.id.clone();
            let target = f.reader.id.clone();
            let account = f.owner.clone();
            let writer = tokio::spawn(async move {
                store::membership(&app, &account, &room, &target, true).await
            });
            wait_for_delete(&pool).await;
            assert!(!writer.is_finished());
            let bytes = to_bytes(response.into_body(), 8 * 1024 * 1024)
                .await
                .unwrap();
            assert!(String::from_utf8_lossy(&bytes).contains("private payload"));
            tokio::time::timeout(Duration::from_secs(2), writer)
                .await
                .unwrap()
                .unwrap()
                .unwrap();
            let replay = sync::changes(&f.app, &f.reader, &initial.cursor, 100)
                .await
                .unwrap();
            assert_eq!(
                replay.changes,
                vec![Change::RoomRemoved {
                    room_id: f.room.id.clone()
                }]
            );
            let refused = f
                .app
                .clone()
                .router()
                .oneshot(request(
                    &f,
                    &format!("/api/v1/rooms/{}/messages", f.room.id),
                    "GET",
                ))
                .await
                .unwrap();
            assert_eq!(refused.status(), StatusCode::NOT_FOUND);
            store::membership(&f.app, &f.owner, &f.room.id, &f.reader.id, false)
                .await
                .unwrap();
        }
    }

    #[sqlx::test]
    async fn public_metadata_cannot_be_delivered_after_its_visibility_changes(pool: PgPool) {
        let f = fixture(pool.clone()).await;
        let room = store::create_room(
            &f.app,
            &f.owner,
            CreateRoom {
                name: "Public metadata".into(),
                private: false,
                operation_id: None,
            },
        )
        .await
        .unwrap();
        let proof = ReadProof::capture(&f.app, &f.reader, Scope::None)
            .await
            .unwrap();
        let page = store::public_rooms(&f.app, &f.reader, "Public metadata", None)
            .await
            .unwrap();
        let response = proof.public_json(&f.app, &f.hash, &page).await.unwrap();
        let other = pool.clone();
        let id = room.id.clone();
        let change = tokio::spawn(async move {
            sqlx::query("UPDATE rooms SET kind='private' WHERE id=$1")
                .bind(id)
                .execute(&other)
                .await
        });
        tokio::time::timeout(Duration::from_secs(2),async {
            loop {
                let blocked:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'UPDATE rooms SET kind%')").fetch_one(&pool).await.unwrap();
                if blocked { break; }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        }).await.unwrap();
        assert!(!change.is_finished());
        to_bytes(response.into_body(), 4096).await.unwrap();
        tokio::time::timeout(Duration::from_secs(2), change)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert_eq!(
            proof
                .public_json(&f.app, &f.hash, &page)
                .await
                .unwrap_err()
                .code,
            "delivery_revalidate"
        );
        assert!(
            store::public_rooms(&f.app, &f.reader, "Public metadata", None)
                .await
                .unwrap()
                .rooms
                .is_empty()
        );
    }

    #[sqlx::test]
    async fn a_stalled_or_dropped_body_cannot_hold_revocation_forever(pool: PgPool) {
        let f = fixture(pool.clone()).await;
        for expire in [false, true] {
            let response = f
                .app
                .clone()
                .router()
                .oneshot(request(
                    &f,
                    &format!("/api/v1/rooms/{}/messages", f.room.id),
                    "GET",
                ))
                .await
                .unwrap();
            let app = f.app.clone();
            let room = f.room.id.clone();
            let target = f.reader.id.clone();
            let account = f.owner.clone();
            let writer = tokio::spawn(async move {
                store::membership(&app, &account, &room, &target, true).await
            });
            wait_for_delete(&pool).await;
            if expire {
                // Leave the body unpolled. Its independently owned lease expires.
                tokio::time::timeout(DEADLINE + Duration::from_secs(2), writer)
                    .await
                    .unwrap()
                    .unwrap()
                    .unwrap();
                assert!(
                    to_bytes(response.into_body(), 1024).await.is_err(),
                    "an expired lease must never submit a late payload"
                );
            } else {
                drop(response);
                tokio::time::timeout(Duration::from_secs(2), writer)
                    .await
                    .unwrap()
                    .unwrap()
                    .unwrap();
            }
            store::membership(&f.app, &f.owner, &f.room.id, &f.reader.id, false)
                .await
                .unwrap();
        }
    }

    #[sqlx::test]
    async fn grant_role_and_generation_changes_reject_a_prepared_payload(pool: PgPool) {
        let f = fixture(pool.clone()).await;
        let proof = ReadProof::capture(&f.app, &f.reader, Scope::Room(&f.room.id))
            .await
            .unwrap();
        store::membership(&f.app, &f.owner, &f.room.id, &f.reader.id, true)
            .await
            .unwrap();
        store::membership(&f.app, &f.owner, &f.room.id, &f.reader.id, false)
            .await
            .unwrap();
        assert_eq!(
            proof
                .lock(&f.app, &f.hash, std::slice::from_ref(&f.room.id), None)
                .await
                .unwrap_err()
                .code,
            "delivery_revalidate"
        );
        let proof = ReadProof::capture(&f.app, &f.reader, Scope::Room(&f.room.id))
            .await
            .unwrap();
        sqlx::query("UPDATE members SET role='owner' WHERE room_id=$1 AND user_id=$2")
            .bind(&f.room.id)
            .bind(&f.reader.id)
            .execute(&pool)
            .await
            .unwrap();
        assert_eq!(
            proof
                .lock(&f.app, &f.hash, std::slice::from_ref(&f.room.id), None)
                .await
                .unwrap_err()
                .code,
            "delivery_revalidate"
        );
        let proof = ReadProof::capture(&f.app, &f.reader, Scope::None)
            .await
            .unwrap();
        sqlx::query("UPDATE instance SET data_epoch=$1")
            .bind(auth::random_token())
            .execute(&pool)
            .await
            .unwrap();
        assert_eq!(
            proof
                .lock(&f.app, &f.hash, &[], None)
                .await
                .unwrap_err()
                .code,
            "delivery_revalidate"
        );
        let proof = ReadProof::capture(&f.app, &f.reader, Scope::None)
            .await
            .unwrap();
        sqlx::query("DELETE FROM sessions WHERE token_hash=$1")
            .bind(&f.hash)
            .execute(&pool)
            .await
            .unwrap();
        assert_eq!(
            proof
                .lock(&f.app, &f.hash, &[], None)
                .await
                .unwrap_err()
                .code,
            "session_rejected"
        );
    }

    #[sqlx::test]
    async fn generation_change_waits_for_delivery_but_sequence_increments_do_not(pool: PgPool) {
        let f = fixture(pool.clone()).await;
        let proof = ReadProof::capture(&f.app, &f.reader, Scope::None)
            .await
            .unwrap();
        let lease = proof.lock(&f.app, &f.hash, &[], None).await.unwrap();
        tokio::time::timeout(
            Duration::from_secs(1),
            sqlx::query("UPDATE instance SET position=position+1").execute(&pool),
        )
        .await
        .unwrap()
        .unwrap();
        let other = pool.clone();
        let restore = tokio::spawn(async move {
            sqlx::query("UPDATE instance SET data_epoch=$1")
                .bind(auth::random_token())
                .execute(&other)
                .await
        });
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert!(!restore.is_finished());
        lease.rollback().await.unwrap();
        tokio::time::timeout(Duration::from_secs(2), restore)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
    }

    #[sqlx::test]
    async fn logout_and_account_disable_wait_for_the_authorized_body(pool: PgPool) {
        let f = fixture(pool.clone()).await;
        for disable in [true, false] {
            let response = f
                .app
                .clone()
                .router()
                .oneshot(request(&f, "/api/v1/me", "GET"))
                .await
                .unwrap();
            let other = pool.clone();
            let reader = f.reader.id.clone();
            let hash = f.hash.clone();
            let revoke = tokio::spawn(async move {
                if disable {
                    sqlx::query("UPDATE users SET disabled=true WHERE id=$1")
                        .bind(reader)
                        .execute(&other)
                        .await
                } else {
                    sqlx::query("DELETE FROM sessions WHERE token_hash=$1")
                        .bind(hash)
                        .execute(&other)
                        .await
                }
            });
            tokio::time::timeout(Duration::from_secs(2),async {
                loop {
                    let blocked: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND (query LIKE 'UPDATE users SET disabled%' OR query LIKE 'DELETE FROM sessions WHERE%'))")
                        .fetch_one(&pool).await.unwrap();
                    if blocked { break; }
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
            }).await.unwrap();
            assert!(!revoke.is_finished());
            to_bytes(response.into_body(), 1024).await.unwrap();
            tokio::time::timeout(Duration::from_secs(2), revoke)
                .await
                .unwrap()
                .unwrap()
                .unwrap();
            let refused = f
                .app
                .clone()
                .router()
                .oneshot(request(&f, "/api/v1/me", "GET"))
                .await
                .unwrap();
            assert_eq!(refused.status(), StatusCode::UNAUTHORIZED);
            if disable {
                sqlx::query("UPDATE users SET disabled=false WHERE id=$1")
                    .bind(&f.reader.id)
                    .execute(&pool)
                    .await
                    .unwrap();
            }
        }
    }

    #[sqlx::test]
    async fn a_previously_authenticated_actor_cannot_commit_after_session_revocation(pool: PgPool) {
        let mut f = fixture(pool.clone()).await;
        for disable in [true, false] {
            if disable {
                sqlx::query("UPDATE users SET disabled=true WHERE id=$1")
                    .bind(&f.reader.id)
                    .execute(&pool)
                    .await
                    .unwrap();
            } else {
                sqlx::query("DELETE FROM sessions WHERE token_hash=$1")
                    .bind(&f.hash)
                    .execute(&pool)
                    .await
                    .unwrap();
            }
            assert_eq!(
                store::send(
                    &f.app,
                    &f.reader,
                    &f.room.id,
                    SendMessage {
                        operation_id: "revoked-intention".into(),
                        text: "must not commit".into()
                    }
                )
                .await
                .unwrap_err()
                .code,
                "session_rejected"
            );
            assert_eq!(
                store::create_room(
                    &f.app,
                    &f.reader,
                    CreateRoom {
                        name: "Must not exist".into(),
                        private: true,
                        operation_id: None
                    }
                )
                .await
                .unwrap_err()
                .code,
                "session_rejected"
            );
            assert_eq!(
                store::direct(&f.app, &f.reader, &f.owner.id)
                    .await
                    .unwrap_err()
                    .code,
                "session_rejected"
            );
            assert_eq!(
                store::membership(&f.app, &f.reader, &f.room.id, &f.owner.id, false)
                    .await
                    .unwrap_err()
                    .code,
                "session_rejected"
            );
            if disable {
                sqlx::query("UPDATE users SET disabled=false WHERE id=$1")
                    .bind(&f.reader.id)
                    .execute(&pool)
                    .await
                    .unwrap();
                assert_eq!(
                    store::send(
                        &f.app,
                        &f.reader,
                        &f.room.id,
                        SendMessage {
                            operation_id: "stale-activation".into(),
                            text: "must revalidate".into()
                        }
                    )
                    .await
                    .unwrap_err()
                    .code,
                    "delivery_revalidate"
                );
                f.reader = auth::authenticate(&f.app, &f.hash).await.unwrap();
            }
        }
        let counts: (i64, i64) =
            sqlx::query_as("SELECT (SELECT count(*) FROM messages),(SELECT count(*) FROM rooms)")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(
            counts,
            (0, 1),
            "no durable mutation may be written after revocation"
        );
    }
}
