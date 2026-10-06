//! Voice sessions (docs/protocol/VOICE.md): LiveKit join grants for current
//! members, a worker mirroring the SFU into `voice_sessions`, and the rings of
//! direct calls. Media never crosses this server.
use crate::{
    App,
    auth::{self, Account},
    error::{Error, Result},
    livekit::{self, LiveKit},
    system_messages,
};
use axum::http::StatusCode;
use rv_protocol::{
    User,
    system::SystemMessage,
    voice::{AnswerRing, JoinVoice, RingState, VoiceGrant, VoiceRing},
};
use sqlx::{Postgres, Transaction};
use std::collections::HashSet;

/// How long a ring rings, and how long its outcome stays in the live snapshot.
const RING_SECONDS: i32 = 30;
const RESOLVED_SECONDS: i32 = 10;
/// A join must reach the SFU within this delay; observed sessions are renewed every pass.
const SESSION_SECONDS: i32 = 30;
/// pg_try_advisory_lock key: one process polls the SFU.
const WORKER_LOCK: i64 = 0x0072_7676_6f69_6365;

pub(crate) fn unavailable() -> Error {
    Error::new(StatusCode::SERVICE_UNAVAILABLE, "voice_unavailable")
}

fn livekit(app: &App) -> Result<&LiveKit> {
    app.livekit.as_deref().ok_or_else(unavailable)
}

/// A new data generation never meets an old session, and an encrypted
/// session (`rve:`) never meets a plaintext one.
pub(crate) fn sfu_room(epoch: &str, room: &str, e2ee: bool) -> String {
    let prefix = if e2ee { "rve" } else { "rv" };
    format!("{prefix}:{epoch}:{room}")
}

fn parse_sfu_room(name: &str) -> Option<(&str, &str, bool)> {
    let (e2ee, rest) = match name.strip_prefix("rve:") {
        Some(rest) => (true, rest),
        None => (false, name.strip_prefix("rv:")?),
    };
    let (epoch, room) = rest.split_once(':')?;
    (auth::identifier(epoch) && auth::identifier(room)).then_some((epoch, room, e2ee))
}

/// Plain members of a read-only room listen without publishing.
fn may_publish(role: &str, read_only: bool) -> bool {
    !read_only || matches!(role, "owner" | "moderator")
}

struct Scope {
    role: String,
    read_only: bool,
    direct: bool,
    epoch: String,
    encrypted: bool,
}

async fn lock_scope(
    tx: &mut Transaction<'_, Postgres>,
    actor: &Account,
    room: &str,
    membership: &str,
    epoch: &str,
    e2ee: bool,
) -> Result<Scope> {
    let (_, current) = crate::live::device(tx, actor).await?;
    let grant: Option<(String, String, bool, String, bool)> = sqlx::query_as("SELECT m.role,s.membership_version,r.read_only,r.kind,EXISTS(SELECT 1 FROM e2ee_groups g WHERE g.room_id=r.id) FROM members m JOIN rooms r ON r.id=m.room_id JOIN room_read_states s ON s.room_id=m.room_id AND s.user_id=m.user_id WHERE m.room_id=$1 AND m.user_id=$2 FOR SHARE OF m,s,r")
        .bind(room).bind(&actor.id).fetch_optional(&mut **tx).await?;
    let (role, version, read_only, kind, encrypted) = grant.ok_or_else(Error::missing)?;
    if version != membership {
        return Err(Error::new(StatusCode::CONFLICT, "membership_replaced"));
    }
    if current != epoch {
        return Err(Error::new(StatusCode::CONFLICT, "data_epoch_changed"));
    }
    // An encrypted room's voice is end-to-end encrypted too: frames under a key
    // only the group's devices derive. A client that cannot is refused.
    if encrypted && !e2ee {
        return Err(Error::new(StatusCode::FORBIDDEN, "voice_encrypted_room"));
    }
    Ok(Scope {
        role,
        read_only,
        direct: kind == "direct",
        epoch: current,
        encrypted,
    })
}

#[derive(sqlx::FromRow)]
struct RingRow {
    id: String,
    room_id: String,
    caller_id: String,
    caller_username: String,
    caller_display_name: String,
    callee_id: String,
    callee_username: String,
    callee_display_name: String,
    state: String,
    remaining_ms: i64,
}
const RING_SELECT: &str = "SELECT v.id,v.room_id,a.id AS caller_id,a.username AS caller_username,a.display_name AS caller_display_name,b.id AS callee_id,b.username AS callee_username,b.display_name AS callee_display_name,v.state,GREATEST(0,floor(extract(epoch FROM v.expires_at-clock_timestamp())*1000))::bigint AS remaining_ms FROM voice_rings v JOIN users a ON a.id=v.caller_id JOIN users b ON b.id=v.callee_id";

fn ring_state(state: &str) -> RingState {
    match state {
        "answered" => RingState::Answered,
        "declined" => RingState::Declined,
        "missed" => RingState::Missed,
        "cancelled" => RingState::Cancelled,
        _ => RingState::Ringing,
    }
}

impl RingRow {
    fn wire(self) -> VoiceRing {
        let state = ring_state(&self.state);
        VoiceRing {
            id: self.id,
            room_id: self.room_id,
            caller: User {
                id: self.caller_id,
                username: self.caller_username,
                display_name: self.caller_display_name,
            },
            callee: User {
                id: self.callee_id,
                username: self.callee_username,
                display_name: self.callee_display_name,
            },
            expires_in_ms: if state == RingState::Ringing {
                u32::try_from(self.remaining_ms).unwrap_or(0)
            } else {
                0
            },
            state,
        }
    }
}

async fn ring_wire(tx: &mut Transaction<'_, Postgres>, id: &str) -> Result<VoiceRing> {
    Ok(
        sqlx::query_as::<_, RingRow>(&format!("{RING_SELECT} WHERE v.id=$1"))
            .bind(id)
            .fetch_one(&mut **tx)
            .await?
            .wire(),
    )
}

/// The rings a reader sees in the live snapshot: ringing, or resolved moments ago.
pub(crate) async fn live_rings(
    tx: &mut Transaction<'_, Postgres>,
    user: &str,
) -> Result<Vec<VoiceRing>> {
    let rows: Vec<RingRow> = sqlx::query_as(&format!("{RING_SELECT} JOIN instance i ON i.singleton AND i.data_epoch=v.data_epoch WHERE (v.caller_id=$1 OR v.callee_id=$1) AND ((v.state='ringing' AND v.expires_at>clock_timestamp()) OR v.resolved_at>clock_timestamp()-make_interval(secs => $2)) ORDER BY v.created_at LIMIT 16"))
        .bind(user).bind(RESOLVED_SECONDS).fetch_all(&mut **tx).await?;
    Ok(rows.into_iter().map(RingRow::wire).collect())
}

/// Resolves a ring, revises its call row and stops the callee's devices ringing.
async fn resolve(tx: &mut Transaction<'_, Postgres>, id: &str, state: &str) -> Result<()> {
    let message: Option<String> = sqlx::query_scalar("UPDATE voice_rings SET state=$2,resolved_at=clock_timestamp(),answered_at=CASE WHEN $2='answered' THEN clock_timestamp() END WHERE id=$1 AND state='ringing' RETURNING message_id")
        .bind(id).bind(state).fetch_optional(&mut **tx).await?;
    if let Some(message) = message {
        system_messages::revise(tx, &message).await?;
        sqlx::query("INSERT INTO voice_pushes(ring_id,device_id,generation,kind) SELECT ring_id,device_id,generation,'end' FROM voice_pushes WHERE ring_id=$1 AND kind='ring' ON CONFLICT DO NOTHING")
            .bind(id).execute(&mut **tx).await?;
    }
    Ok(())
}

async fn start_ring(
    tx: &mut Transaction<'_, Postgres>,
    actor: &Account,
    room: &str,
    epoch: &str,
) -> Result<Option<String>> {
    let callee: Option<(String, String)> = sqlx::query_as("SELECT u.id,u.chosen_status FROM members m JOIN users u ON u.id=m.user_id WHERE m.room_id=$1 AND m.user_id<>$2 AND NOT u.disabled")
        .bind(room).bind(&actor.id).fetch_optional(&mut **tx).await?;
    let Some((callee, status)) = callee else {
        return Ok(None);
    };
    let present: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM voice_sessions WHERE user_id=$1 AND room_id=$2 AND state='connected')")
        .bind(&callee).bind(room).fetch_one(&mut **tx).await?;
    if present {
        return Ok(None);
    }
    let id = auth::random_token();
    let message = system_messages::insert(
        tx,
        &actor.id,
        room,
        SystemMessage::CallStarted {
            meeting_id: id.clone(),
        },
    )
    .await?;
    let created = sqlx::query("INSERT INTO voice_rings(id,room_id,caller_id,callee_id,message_id,data_epoch,expires_at) VALUES($1,$2,$3,$4,$5,$6,clock_timestamp()+make_interval(secs => $7)) ON CONFLICT DO NOTHING")
        .bind(&id).bind(room).bind(&actor.id).bind(&callee).bind(&message).bind(epoch).bind(RING_SECONDS)
        .execute(&mut **tx).await?;
    if created.rows_affected() == 0 {
        // Another ring started concurrently in this room; this one never existed.
        return Err(Error::conflict());
    }
    // The row now carries `call: ringing`.
    system_messages::revise(tx, &message).await?;
    // Busy means do not disturb: the call shows in the app, no device rings.
    if status != "busy" {
        sqlx::query("INSERT INTO voice_pushes(ring_id,device_id,generation,kind) SELECT $1,d.device_id,d.generation,'ring' FROM push_devices d JOIN instance i ON i.singleton AND i.data_epoch=d.data_epoch WHERE d.user_id=$2 AND EXISTS(SELECT 1 FROM sessions s WHERE s.device_id=d.device_id AND s.expires_at>now())")
            .bind(&id).bind(&callee).execute(&mut **tx).await?;
    }
    Ok(Some(id))
}

pub(crate) async fn join(
    app: &App,
    actor: &Account,
    room: &str,
    input: JoinVoice,
) -> Result<VoiceGrant> {
    let livekit = livekit(app)?;
    if !auth::identifier(room)
        || !auth::identifier(&input.membership_version)
        || !auth::identifier(&input.data_epoch)
    {
        return Err(Error::invalid());
    }
    let mut tx = app.pool.begin().await?;
    let scope = lock_scope(
        &mut tx,
        actor,
        room,
        &input.membership_version,
        &input.data_epoch,
        input.e2ee,
    )
    .await?;
    let previous: Option<(String, String, bool)> = sqlx::query_as(
        "SELECT room_id,data_epoch,e2ee FROM voice_sessions WHERE user_id=$1 FOR UPDATE",
    )
    .bind(&actor.id)
    .fetch_optional(&mut *tx)
    .await?;
    // Rejoining the same session keeps what the SFU reported; another room starts over.
    sqlx::query("INSERT INTO voice_sessions(user_id,room_id,data_epoch,state,e2ee,expires_at) VALUES($1,$2,$3,'joining',$5,clock_timestamp()+make_interval(secs => $4)) ON CONFLICT(user_id) DO UPDATE SET state=CASE WHEN voice_sessions.room_id=EXCLUDED.room_id AND voice_sessions.data_epoch=EXCLUDED.data_epoch AND voice_sessions.e2ee=EXCLUDED.e2ee THEN voice_sessions.state ELSE 'joining' END,screen=voice_sessions.screen AND voice_sessions.room_id=EXCLUDED.room_id,joined_at=CASE WHEN voice_sessions.room_id=EXCLUDED.room_id THEN voice_sessions.joined_at ELSE clock_timestamp() END,room_id=EXCLUDED.room_id,data_epoch=EXCLUDED.data_epoch,e2ee=EXCLUDED.e2ee,expires_at=GREATEST(voice_sessions.expires_at,EXCLUDED.expires_at)")
        .bind(&actor.id).bind(room).bind(&scope.epoch).bind(SESSION_SECONDS).bind(scope.encrypted).execute(&mut *tx).await?;
    let mut ring_id = None;
    if scope.direct {
        // Calling someone who is calling you answers their call.
        let incoming: Option<String> = sqlx::query_scalar("SELECT id FROM voice_rings WHERE room_id=$1 AND callee_id=$2 AND state='ringing' AND expires_at>clock_timestamp() FOR UPDATE")
            .bind(room).bind(&actor.id).fetch_optional(&mut *tx).await?;
        if let Some(id) = incoming {
            resolve(&mut tx, &id, "answered").await?;
            ring_id = Some(id);
        } else if input.ring {
            let ringing: Option<String> = sqlx::query_scalar("SELECT id FROM voice_rings WHERE room_id=$1 AND state='ringing' AND caller_id=$2 FOR UPDATE")
                .bind(room).bind(&actor.id).fetch_optional(&mut *tx).await?;
            ring_id = match ringing {
                Some(id) => Some(id),
                None => start_ring(&mut tx, actor, room, &scope.epoch).await?,
            };
        }
    }
    let ring = match &ring_id {
        Some(id) => Some(ring_wire(&mut tx, id).await?),
        None => None,
    };
    let can_publish = may_publish(&scope.role, scope.read_only);
    let (token, expires) = livekit.join_token(
        &actor.id,
        &actor.display_name,
        &sfu_room(&scope.epoch, room, scope.encrypted),
        can_publish,
    )?;
    tx.commit().await?;
    if let Some((old_room, old_epoch, old_e2ee)) = previous
        && (old_room != room || old_epoch != scope.epoch || old_e2ee != scope.encrypted)
    {
        evict(
            app,
            sfu_room(&old_epoch, &old_room, old_e2ee),
            actor.id.clone(),
        );
    }
    Ok(VoiceGrant {
        room_id: room.into(),
        url: livekit.url().into(),
        token: token.to_string(),
        expires_at: expires.to_rfc3339(),
        can_publish,
        ring,
        e2ee: scope.encrypted,
    })
}

/// Best effort: the worker repeats it on its next pass if the SFU missed it.
fn evict(app: &App, room: String, identity: String) {
    let Some(livekit) = app.livekit.clone() else {
        return;
    };
    tokio::spawn(async move {
        if let Err(error) = livekit.remove(&room, &identity).await {
            tracing::debug!(code = error.code, "voice eviction deferred to the worker");
        }
    });
}

pub(crate) async fn leave(app: &App, actor: &Account) -> Result<()> {
    livekit(app)?;
    let mut tx = app.pool.begin().await?;
    auth::lock_active(&mut tx, actor).await?;
    let session: Option<(String, String, bool)> = sqlx::query_as(
        "DELETE FROM voice_sessions WHERE user_id=$1 RETURNING room_id,data_epoch,e2ee",
    )
    .bind(&actor.id)
    .fetch_optional(&mut *tx)
    .await?;
    let ringing: Vec<String> = sqlx::query_scalar(
        "SELECT id FROM voice_rings WHERE caller_id=$1 AND state='ringing' FOR UPDATE",
    )
    .bind(&actor.id)
    .fetch_all(&mut *tx)
    .await?;
    for id in ringing {
        resolve(&mut tx, &id, "cancelled").await?;
    }
    tx.commit().await?;
    if let Some((room, epoch, e2ee)) = session {
        evict(app, sfu_room(&epoch, &room, e2ee), actor.id.clone());
    }
    Ok(())
}

pub(crate) async fn read_ring(app: &App, actor: &Account, id: &str) -> Result<VoiceRing> {
    livekit(app)?;
    if !auth::identifier(id) {
        return Err(Error::invalid());
    }
    let row: RingRow = sqlx::query_as(&format!("{RING_SELECT} JOIN instance i ON i.singleton AND i.data_epoch=v.data_epoch WHERE v.id=$1 AND (v.caller_id=$2 OR v.callee_id=$2)"))
        .bind(id).bind(&actor.id).fetch_optional(&app.pool).await?.ok_or_else(Error::missing)?;
    Ok(row.wire())
}

pub(crate) async fn accept(
    app: &App,
    actor: &Account,
    id: &str,
    input: AnswerRing,
) -> Result<VoiceGrant> {
    let ring = read_ring(app, actor, id).await?;
    if ring.callee.id != actor.id {
        return Err(Error::forbidden());
    }
    if ring.state != RingState::Ringing {
        return Err(Error::new(StatusCode::CONFLICT, "ring_ended"));
    }
    // A join in a direct room answers the ring the peer started.
    join(
        app,
        actor,
        &ring.room_id,
        JoinVoice {
            membership_version: input.membership_version,
            data_epoch: input.data_epoch,
            ring: false,
            e2ee: input.e2ee,
        },
    )
    .await
}

pub(crate) async fn decline(app: &App, actor: &Account, id: &str) -> Result<()> {
    let ring = read_ring(app, actor, id).await?;
    if ring.callee.id != actor.id {
        return Err(Error::forbidden());
    }
    let mut tx = app.pool.begin().await?;
    auth::lock_active(&mut tx, actor).await?;
    resolve(&mut tx, id, "declined").await?;
    tx.commit().await?;
    Ok(())
}

/// Claims the room's one screen share for the account's session, then lets
/// the SFU take its screen. `409 screen_taken` while someone else shares.
pub(crate) async fn claim_screen(app: &App, actor: &Account) -> Result<()> {
    share(app, actor, true).await
}
pub(crate) async fn release_screen(app: &App, actor: &Account) -> Result<()> {
    share(app, actor, false).await
}
async fn share(app: &App, actor: &Account, on: bool) -> Result<()> {
    let livekit = livekit(app)?;
    let mut tx = app.pool.begin().await?;
    auth::lock_active(&mut tx, actor).await?;
    let session: Option<(String, String, String, bool)> = sqlx::query_as(
        "SELECT room_id,data_epoch,state,e2ee FROM voice_sessions WHERE user_id=$1 FOR UPDATE",
    )
    .bind(&actor.id)
    .fetch_optional(&mut *tx)
    .await?;
    let Some((room, epoch, state, e2ee)) = session else {
        return Err(Error::new(StatusCode::CONFLICT, "voice_not_connected"));
    };
    let grant: Option<(String, bool)> = sqlx::query_as("SELECT m.role,r.read_only FROM members m JOIN rooms r ON r.id=m.room_id WHERE m.room_id=$1 AND m.user_id=$2 FOR SHARE OF m")
        .bind(&room).bind(&actor.id).fetch_optional(&mut *tx).await?;
    let (role, read_only) = grant.ok_or_else(Error::missing)?;
    if on {
        if state != "connected" {
            return Err(Error::new(StatusCode::CONFLICT, "voice_not_connected"));
        }
        if !may_publish(&role, read_only) {
            return Err(Error::forbidden());
        }
        // Claims of one room queue here; the unique index is the last word.
        sqlx::query("SELECT pg_advisory_xact_lock(hashtext('voice-screen:'||$1))")
            .bind(&room)
            .execute(&mut *tx)
            .await?;
        let taken: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM voice_sessions WHERE room_id=$1 AND screen AND user_id<>$2)",
        )
        .bind(&room)
        .bind(&actor.id)
        .fetch_one(&mut *tx)
        .await?;
        if taken {
            return Err(Error::new(StatusCode::CONFLICT, "screen_taken"));
        }
    }
    sqlx::query("UPDATE voice_sessions SET screen=$2 WHERE user_id=$1")
        .bind(&actor.id)
        .bind(on)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    // The worker repeats it if the SFU misses this one.
    livekit
        .permit(
            &sfu_room(&epoch, &room, e2ee),
            &actor.id,
            &livekit::sources(may_publish(&role, read_only), on),
        )
        .await
}

/// One pass of the voice worker. Several processes may run it; one polls.
pub async fn reconcile(app: &App) -> Result<()> {
    let Some(livekit) = app.livekit.as_deref() else {
        return Ok(());
    };
    let mut lock = app.pool.acquire().await?;
    let mine: bool = sqlx::query_scalar("SELECT pg_try_advisory_lock($1)")
        .bind(WORKER_LOCK)
        .fetch_one(&mut *lock)
        .await?;
    if !mine {
        return Ok(());
    }
    let result = pass(app, livekit).await;
    sqlx::query("SELECT pg_advisory_unlock($1)")
        .bind(WORKER_LOCK)
        .execute(&mut *lock)
        .await?;
    result
}

struct Seen {
    sfu_room: String,
    epoch: String,
    room: String,
    e2ee: bool,
    participant: livekit::Participant,
}

async fn observe(livekit: &LiveKit) -> Result<Vec<Seen>> {
    let mut seen = Vec::new();
    for name in livekit.rooms().await? {
        let Some((epoch, room, e2ee)) = parse_sfu_room(&name) else {
            continue;
        };
        let (epoch, room) = (epoch.to_owned(), room.to_owned());
        for participant in livekit.participants(&name).await? {
            seen.push(Seen {
                sfu_room: name.clone(),
                epoch: epoch.clone(),
                room: room.clone(),
                e2ee,
                participant,
            });
        }
    }
    Ok(seen)
}

async fn pass(app: &App, livekit: &LiveKit) -> Result<()> {
    // An unreachable SFU only lets sessions expire; nothing is evicted blindly.
    let seen = match observe(livekit).await {
        Ok(seen) => Some(seen),
        Err(error) => {
            tracing::warn!(code = error.code, "voice worker cannot read the SFU");
            None
        }
    };
    let mut evictions = Vec::new();
    let mut permissions = Vec::new();
    let mut tx = app.pool.begin().await?;
    let epoch: String = sqlx::query_scalar("SELECT data_epoch FROM instance WHERE singleton")
        .fetch_one(&mut *tx)
        .await?;
    if let Some(seen) = &seen {
        let users: Vec<&str> = seen
            .iter()
            .map(|s| s.participant.identity.as_str())
            .collect();
        let rooms: Vec<&str> = seen.iter().map(|s| s.room.as_str()).collect();
        // An encrypted room's session is its `rve:` room only: plaintext
        // participants left from before the group existed are evicted.
        let grants: Vec<(String, String, String, bool, bool)> = sqlx::query_as("SELECT o.user_id,o.room_id,m.role,r.read_only,EXISTS(SELECT 1 FROM e2ee_groups g WHERE g.room_id=r.id) FROM unnest($1::text[],$2::text[]) AS o(user_id,room_id) JOIN users u ON u.id=o.user_id AND NOT u.disabled JOIN members m ON m.user_id=o.user_id AND m.room_id=o.room_id JOIN rooms r ON r.id=o.room_id")
            .bind(&users).bind(&rooms).fetch_all(&mut *tx).await?;
        let sessions: Vec<(String, String, String, bool, bool)> = sqlx::query_as(
            "SELECT user_id,room_id,data_epoch,screen,e2ee FROM voice_sessions ORDER BY user_id FOR UPDATE",
        )
        .fetch_all(&mut *tx)
        .await?;
        let mut kept = HashSet::new();
        for s in seen {
            let identity = &s.participant.identity;
            let grant = grants.iter().find(|(u, r, _, _, encrypted)| {
                u == identity && *r == s.room && *encrypted == s.e2ee
            });
            // A join elsewhere wins over this connection.
            let moved = sessions.iter().any(|(u, r, e, _, e2ee)| {
                u == identity && (*r != s.room || *e != s.epoch || *e2ee != s.e2ee)
            });
            let screen = sessions
                .iter()
                .any(|(u, r, _, screen, _)| u == identity && *r == s.room && *screen);
            let Some((_, _, role, read_only, _)) = grant.filter(|_| s.epoch == epoch && !moved)
            else {
                evictions.push((s.sfu_room.clone(), identity.clone()));
                continue;
            };
            sqlx::query("INSERT INTO voice_sessions(user_id,room_id,data_epoch,state,muted,deafened,camera,e2ee,expires_at) VALUES($1,$2,$3,'connected',$4,$5,$6,$8,clock_timestamp()+make_interval(secs => $7)) ON CONFLICT(user_id) DO UPDATE SET state='connected',muted=EXCLUDED.muted,deafened=EXCLUDED.deafened,camera=EXCLUDED.camera,e2ee=EXCLUDED.e2ee,expires_at=EXCLUDED.expires_at,joined_at=CASE WHEN voice_sessions.room_id=EXCLUDED.room_id THEN voice_sessions.joined_at ELSE clock_timestamp() END,room_id=EXCLUDED.room_id,data_epoch=EXCLUDED.data_epoch")
                .bind(identity).bind(&s.room).bind(&s.epoch).bind(s.participant.muted).bind(s.participant.deafened).bind(s.participant.camera).bind(SESSION_SECONDS).bind(s.e2ee)
                .execute(&mut *tx).await?;
            kept.insert(identity.clone());
            // The SFU's permissions follow the room's rights and the screen claim.
            let allowed = livekit::sources(may_publish(role, *read_only), screen);
            if allowed != s.participant.sources {
                permissions.push((s.sfu_room.clone(), identity.clone(), allowed));
            }
        }
        // Connected sessions the SFU no longer reports are over.
        let kept: Vec<String> = kept.into_iter().collect();
        sqlx::query("DELETE FROM voice_sessions WHERE state='connected' AND NOT (user_id=ANY($1))")
            .bind(&kept)
            .execute(&mut *tx)
            .await?;
    }
    sqlx::query("DELETE FROM voice_sessions WHERE expires_at<=clock_timestamp()")
        .execute(&mut *tx)
        .await?;
    // Rings: an answer seen on the SFU, the caller gone, or the delay over.
    let open: Vec<(String, Option<String>)> = sqlx::query_as("SELECT v.id,CASE WHEN EXISTS(SELECT 1 FROM voice_sessions s WHERE s.user_id=v.callee_id AND s.room_id=v.room_id AND s.state='connected') THEN 'answered' WHEN NOT EXISTS(SELECT 1 FROM voice_sessions s WHERE s.user_id=v.caller_id AND s.room_id=v.room_id) THEN 'cancelled' WHEN v.expires_at<=clock_timestamp() THEN 'missed' END FROM voice_rings v WHERE v.state='ringing' ORDER BY v.id FOR UPDATE")
        .fetch_all(&mut *tx).await?;
    for (id, outcome) in open {
        if let Some(outcome) = outcome {
            resolve(&mut tx, &id, &outcome).await?;
        }
    }
    // An answered call ends when its room's session is empty: the row gets its duration.
    let ended: Vec<String> = sqlx::query_scalar("UPDATE voice_rings v SET ended_at=clock_timestamp() WHERE v.state='answered' AND v.ended_at IS NULL AND NOT EXISTS(SELECT 1 FROM voice_sessions s WHERE s.room_id=v.room_id) RETURNING v.message_id")
        .fetch_all(&mut *tx).await?;
    for message in ended {
        system_messages::revise(&mut tx, &message).await?;
    }
    tx.commit().await?;
    for (room, identity) in evictions {
        if let Err(error) = livekit.remove(&room, &identity).await {
            tracing::warn!(code = error.code, "voice eviction failed");
        }
    }
    for (room, identity, allowed) in permissions {
        if let Err(error) = livekit.permit(&room, &identity, &allowed).await {
            tracing::warn!(code = error.code, "voice permission update failed");
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sfu_rooms_round_trip_and_reject_foreign_names() {
        let name = sfu_room("epoch1", "room1", false);
        assert_eq!(parse_sfu_room(&name), Some(("epoch1", "room1", false)));
        let name = sfu_room("epoch1", "room1", true);
        assert_eq!(name, "rve:epoch1:room1");
        assert_eq!(parse_sfu_room(&name), Some(("epoch1", "room1", true)));
        assert_eq!(parse_sfu_room("lobby"), None);
        assert_eq!(parse_sfu_room("rv:epoch1"), None);
        assert_eq!(parse_sfu_room("rv::room"), None);
    }

    #[test]
    fn read_only_rooms_let_only_owners_and_moderators_publish() {
        assert!(may_publish("member", false));
        assert!(!may_publish("member", true));
        assert!(may_publish("moderator", true));
        assert!(may_publish("owner", true));
    }
}
