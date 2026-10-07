//! PostgreSQL leases shared by server processes, never written to the sync journal.
use crate::{
    App,
    auth::{self, Account},
    error::{Error, Result},
    permissions,
};
use rv_protocol::{
    User,
    live::{
        LiveFrame, LiveRoom, LiveState, PresenceEntry, PresenceStatus, SetPresence, SetTyping,
        Typist,
    },
    voice::VoiceParticipant,
};
use sqlx::{Postgres, Transaction};

const MAX_OBSERVATIONS: usize = 512;
#[derive(sqlx::FromRow)]
struct Grant {
    room_id: String,
    membership_version: String,
    peer_id: Option<String>,
    peer_username: Option<String>,
    peer_display_name: Option<String>,
}

pub(crate) async fn device(
    tx: &mut Transaction<'_, Postgres>,
    actor: &Account,
) -> Result<(String, String)> {
    auth::lock_active(tx, actor).await?;
    let (device, epoch): (String,String) = sqlx::query_as("SELECT s.device_id,i.data_epoch FROM sessions s CROSS JOIN instance i WHERE s.token_hash=$1 AND i.singleton")
        .bind(&actor.session_hash).fetch_one(&mut **tx).await?;
    // Account authorization locks serialize this budget across devices/instances.
    let (attempts,retry): (i32,i64) = sqlx::query_as("INSERT INTO live_windows(device_id,attempts,expires_at) VALUES($1,1,clock_timestamp()+interval '60 seconds') ON CONFLICT(device_id) DO UPDATE SET attempts=CASE WHEN live_windows.expires_at<=clock_timestamp() THEN 1 ELSE live_windows.attempts+1 END,expires_at=CASE WHEN live_windows.expires_at<=clock_timestamp() THEN clock_timestamp()+interval '60 seconds' ELSE live_windows.expires_at END RETURNING attempts,GREATEST(1,ceil(extract(epoch FROM expires_at-clock_timestamp())))::bigint")
        .bind(&device).fetch_one(&mut **tx).await?;
    if attempts > 60 {
        return Err(Error::throttled("live_rate_limited", retry as u64));
    }
    Ok((device, epoch))
}

pub(crate) async fn presence(app: &App, actor: &Account, input: SetPresence) -> Result<()> {
    let mut tx = app.pool.begin().await?;
    let (device, epoch) = device(&mut tx, actor).await?;
    let selected: String = sqlx::query_scalar("SELECT chosen_status FROM users WHERE id=$1")
        .bind(&actor.id)
        .fetch_one(&mut *tx)
        .await?;
    let effective = if input.status == PresenceStatus::Offline {
        PresenceStatus::Offline
    } else {
        let selected = crate::profiles::status(&selected);
        if selected == PresenceStatus::Online {
            input.status
        } else {
            selected
        }
    };
    let status = match effective {
        PresenceStatus::Online => "online",
        PresenceStatus::Away => "away",
        PresenceStatus::Busy => "busy",
        PresenceStatus::Offline => {
            sqlx::query("DELETE FROM presence_leases WHERE device_id=$1")
                .bind(&device)
                .execute(&mut *tx)
                .await?;
            sqlx::query("DELETE FROM typing_leases WHERE device_id=$1")
                .bind(&device)
                .execute(&mut *tx)
                .await?;
            tx.commit().await?;
            return Ok(());
        }
    };
    sqlx::query("INSERT INTO presence_leases(device_id,user_id,data_epoch,status,expires_at) VALUES($1,$2,$3,$4,clock_timestamp()+interval '60 seconds') ON CONFLICT(device_id) DO UPDATE SET data_epoch=EXCLUDED.data_epoch,status=EXCLUDED.status,expires_at=EXCLUDED.expires_at")
        .bind(&device).bind(&actor.id).bind(epoch).bind(status).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(())
}

pub(crate) async fn typing(app: &App, actor: &Account, room: &str, input: SetTyping) -> Result<()> {
    if !auth::identifier(room)
        || !auth::identifier(&input.membership_version)
        || input
            .root_id
            .as_deref()
            .is_some_and(|id| !auth::identifier(id))
    {
        return Err(Error::invalid());
    }
    let mut tx = app.pool.begin().await?;
    let (device, epoch) = device(&mut tx, actor).await?;
    if input.active {
        permissions::require_send(&mut tx, room, &actor.id).await?;
    }
    let grant: Option<String> = sqlx::query_scalar(
        "SELECT s.membership_version FROM members m JOIN room_read_states s ON s.room_id=m.room_id AND s.user_id=m.user_id WHERE m.room_id=$1 AND m.user_id=$2 FOR SHARE OF m,s",
    )
    .bind(room)
    .bind(&actor.id)
    .fetch_optional(&mut *tx)
    .await?;
    match grant {
        None => return Err(Error::missing()),
        Some(grant) if grant != input.membership_version => {
            return Err(Error::new(
                axum::http::StatusCode::CONFLICT,
                "membership_changed",
            ));
        }
        _ => {}
    }
    let root = input.root_id.as_deref().unwrap_or("");
    // A device has one active composer. A stopped or changed composer releases its lease.
    sqlx::query("DELETE FROM typing_leases WHERE device_id=$1")
        .bind(&device)
        .execute(&mut *tx)
        .await?;
    if input.active {
        if !root.is_empty() {
            let valid:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM messages WHERE id=$1 AND room_id=$2 AND reply_to IS NULL AND NOT deleted AND system IS NULL)")
                .bind(root).bind(room).fetch_one(&mut *tx).await?;
            if !valid {
                return Err(Error::missing());
            }
        }
        sqlx::query("INSERT INTO typing_leases(device_id,user_id,room_id,root_key,membership_version,data_epoch,expires_at) VALUES($1,$2,$3,$4,$5,$6,clock_timestamp()+interval '10 seconds')")
            .bind(device).bind(&actor.id).bind(room).bind(root).bind(input.membership_version).bind(epoch).execute(&mut *tx).await?;
    }
    tx.commit().await?;
    Ok(())
}

pub(crate) async fn state(app: &App, actor: &Account) -> Result<LiveState> {
    let mut tx = app.pool.begin().await?;
    sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ")
        .execute(&mut *tx)
        .await?;
    let grants: Vec<Grant> = sqlx::query_as(
        "SELECT m.room_id,s.membership_version,p.id AS peer_id,p.username AS peer_username,p.display_name AS peer_display_name FROM members m JOIN room_read_states s ON s.room_id=m.room_id AND s.user_id=m.user_id JOIN rooms r ON r.id=m.room_id LEFT JOIN LATERAL (SELECT u.id,u.username,u.display_name FROM members g JOIN users u ON u.id=g.user_id WHERE g.room_id=r.id AND r.kind='direct' AND g.user_id<>$1 AND NOT u.disabled ORDER BY u.id LIMIT 1) p ON true WHERE m.user_id=$1 ORDER BY m.room_id LIMIT 1001",
    )
    .bind(&actor.id)
    .fetch_all(&mut *tx)
    .await?;
    let mut state = LiveState {
        emoji_catalog_revision: Some(
            sqlx::query_scalar::<_, i64>("SELECT revision FROM emoji_catalog WHERE singleton")
                .fetch_one(&mut *tx)
                .await?
                .to_string(),
        ),
        profiles: vec![],
        ttl_ms: 8000,
        limited: false,
        presence: vec![],
        rooms: vec![],
        rings: vec![],
    };
    if grants.len() > 1000 {
        state.limited = true;
        return Ok(state);
    }
    let ids: Vec<_> = grants.iter().map(|g| &g.room_id).collect();
    let profiles:Vec<(String,String,String,String,Option<String>,String)>=sqlx::query_as("SELECT id,username,display_name,profile_version,avatar_file_id,status_text FROM users WHERE NOT disabled AND (id=$2 OR id IN (SELECT DISTINCT user_id FROM members WHERE room_id=ANY($1))) ORDER BY id LIMIT 513")
        .bind(&ids).bind(&actor.id).fetch_all(&mut *tx).await?;
    if profiles.len() > MAX_OBSERVATIONS {
        state.limited = true;
        return Ok(state);
    }
    state.profiles = profiles
        .into_iter()
        .map(
            |(id, username, display_name, revision, avatar_file_id, status_text)| {
                rv_protocol::profiles::ProfileStamp {
                    user: User {
                        id,
                        username,
                        display_name,
                        ..Default::default()
                    },
                    revision,
                    avatar_file_id,
                    status_text,
                }
            },
        )
        .collect();
    // Aggregate devices deterministically: busy, online, away, then offline (no lease).
    let people:Vec<(String,String,String,String)>=sqlx::query_as("WITH visible AS (SELECT DISTINCT user_id FROM members WHERE room_id=ANY($1)), leases AS (SELECT p.user_id,min(CASE p.status WHEN 'busy' THEN 0 WHEN 'online' THEN 1 ELSE 2 END) AS priority FROM presence_leases p JOIN visible v ON v.user_id=p.user_id CROSS JOIN instance i WHERE p.expires_at>clock_timestamp() AND p.data_epoch=i.data_epoch AND EXISTS(SELECT 1 FROM sessions s WHERE s.device_id=p.device_id AND s.expires_at>clock_timestamp()) GROUP BY p.user_id) SELECT u.id,u.username,u.display_name,CASE l.priority WHEN 0 THEN 'busy' WHEN 1 THEN 'online' ELSE 'away' END FROM leases l JOIN users u ON u.id=l.user_id WHERE NOT u.disabled ORDER BY u.id LIMIT 513")
        .bind(&ids).fetch_all(&mut *tx).await?;
    let typists:Vec<(String,String,String,String,String)>=sqlx::query_as("SELECT DISTINCT t.room_id,t.root_key,u.id,u.username,u.display_name FROM typing_leases t JOIN members m ON m.room_id=t.room_id AND m.user_id=t.user_id JOIN room_read_states g ON g.room_id=m.room_id AND g.user_id=m.user_id AND g.membership_version=t.membership_version JOIN users u ON u.id=t.user_id JOIN rooms r ON r.id=t.room_id CROSS JOIN instance i WHERE t.room_id=ANY($1) AND t.expires_at>clock_timestamp() AND t.data_epoch=i.data_epoch AND NOT u.disabled AND (NOT r.read_only OR m.role IN ('owner','moderator')) AND EXISTS(SELECT 1 FROM sessions s WHERE s.device_id=t.device_id AND s.expires_at>clock_timestamp()) AND (t.root_key='' OR EXISTS(SELECT 1 FROM messages q WHERE q.id=t.root_key AND q.room_id=t.room_id AND NOT q.deleted)) ORDER BY t.room_id,t.root_key,u.id LIMIT 513")
        .bind(&ids).fetch_all(&mut *tx).await?;
    #[allow(clippy::type_complexity)]
    let voices:Vec<(String,String,String,String,bool,bool,bool,bool)>=sqlx::query_as("SELECT s.room_id,u.id,u.username,u.display_name,s.muted,s.deafened,s.camera,s.screen FROM voice_sessions s JOIN users u ON u.id=s.user_id JOIN members m ON m.room_id=s.room_id AND m.user_id=s.user_id CROSS JOIN instance i WHERE s.room_id=ANY($1) AND s.state='connected' AND s.data_epoch=i.data_epoch AND NOT u.disabled ORDER BY s.room_id,s.joined_at,u.id LIMIT 513")
        .bind(&ids).fetch_all(&mut *tx).await?;
    if people.len() > MAX_OBSERVATIONS
        || typists.len() > MAX_OBSERVATIONS
        || voices.len() > MAX_OBSERVATIONS
    {
        state.limited = true;
        return Ok(state);
    }
    state.presence = people
        .into_iter()
        .map(|(id, username, display_name, status)| PresenceEntry {
            user: User {
                id,
                username,
                display_name,
                ..Default::default()
            },
            status: match status.as_str() {
                "busy" => PresenceStatus::Busy,
                "online" => PresenceStatus::Online,
                _ => PresenceStatus::Away,
            },
        })
        .collect();
    state.rooms = grants
        .into_iter()
        .map(|grant| LiveRoom {
            room_id: grant.room_id,
            membership_version: grant.membership_version,
            direct_peer: grant
                .peer_id
                .zip(grant.peer_username)
                .zip(grant.peer_display_name)
                .map(|((id, username), display_name)| User {
                    id,
                    username,
                    display_name,
                    ..Default::default()
                }),
            typing: vec![],
            voice: vec![],
        })
        .collect();
    for (room, id, username, display_name, muted, deafened, camera, screen) in voices {
        if let Some(room) = state.rooms.iter_mut().find(|r| r.room_id == room) {
            room.voice.push(VoiceParticipant {
                user: User {
                    id,
                    username,
                    display_name,
                    ..Default::default()
                },
                muted,
                deafened,
                camera,
                screen,
            });
        }
    }
    state.rings = crate::voice::live_rings(&mut tx, &actor.id).await?;
    for (room, root, id, username, display_name) in typists {
        if let Some(room) = state.rooms.iter_mut().find(|r| r.room_id == room) {
            room.typing.push(Typist {
                user: User {
                    id,
                    username,
                    display_name,
                    ..Default::default()
                },
                root_id: (!root.is_empty()).then_some(root),
            });
        }
    }
    tx.commit().await?;
    if serde_json::to_vec(&LiveFrame::Live(state.clone()))
        .map_err(|_| Error::internal())?
        .len()
        > 256 * 1024
    {
        state.limited = true;
        state.presence.clear();
        state.rooms.clear();
        state.rings.clear();
    }
    Ok(state)
}
