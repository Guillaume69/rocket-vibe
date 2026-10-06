//! Durable FCM HTTP v1 delivery. SQL leases contain identifiers, never content.
use crate::{
    App, auth,
    auth::Account,
    error::{Error, Result},
};
use axum::http::StatusCode;
use gcp_auth::TokenProvider;
use rv_protocol::push::{PushContent, PushRegistration, RegisterPush};
use serde_json::{Value, json};
use sqlx::{Postgres, Transaction};
use std::{path::Path, time::Duration};

const SCOPE: &str = "https://www.googleapis.com/auth/firebase.messaging";
const ATTEMPTS: i32 = 6;

pub struct Sender {
    credentials: gcp_auth::CustomServiceAccount,
    http: reqwest::Client,
    endpoint: String,
    oauth: tokio::sync::Mutex<()>,
}
impl Sender {
    pub fn from_file(path: &Path) -> std::result::Result<Self, &'static str> {
        let credentials = gcp_auth::CustomServiceAccount::from_file(path)
            .map_err(|_| "Invalid FCM service account")?;
        let project = credentials
            .project_id()
            .filter(|p| auth::identifier(p))
            .ok_or("FCM service account requires a project_id")?;
        let endpoint = format!("https://fcm.googleapis.com/v1/projects/{project}/messages:send");
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(15))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|_| "FCM HTTP initialization failed")?;
        Ok(Self {
            credentials,
            http,
            endpoint,
            oauth: tokio::sync::Mutex::new(()),
        })
    }

    async fn deliver(&self, body: &Value) -> Outcome {
        // Both OAuth and delivery happen after the claim transaction committed.
        let Ok(Ok(token)) = tokio::time::timeout(Duration::from_secs(25), async {
            let _guard = self.oauth.lock().await;
            self.credentials.token(&[SCOPE]).await
        })
        .await
        else {
            tracing::warn!("FCM OAuth unavailable");
            return Outcome::Retry(60);
        };
        send_http(&self.http, &self.endpoint, token.as_str(), body).await
    }
}

#[derive(Debug, PartialEq)]
enum Outcome {
    Delivered,
    InvalidToken,
    Retired,
    Retry(i64),
}

#[derive(sqlx::FromRow)]
struct Lease {
    id: String,
    device_id: String,
    user_id: String,
    message_id: String,
    generation: String,
    data_epoch: String,
    instance_id: String,
    room_id: String,
    reply_to: Option<String>,
    token: String,
    lease_id: String,
    attempts: i32,
}
fn payload(job: &Lease) -> Value {
    let mut data = json!({"product":"rocketvibe","instanceId":job.instance_id,
        "dataEpoch":job.data_epoch,"userId":job.user_id,"deviceId":job.device_id,
        "notificationId":job.id,"rid":job.room_id,"messageId":job.message_id});
    if let Some(root) = &job.reply_to {
        data["tmid"] = json!(root);
    }
    json!({"message":{"token":job.token,"data":data,"android":{"priority":"high","ttl":"86400s"}}})
}
async fn send_http(http: &reqwest::Client, endpoint: &str, bearer: &str, body: &Value) -> Outcome {
    let Ok(mut response) = http
        .post(endpoint)
        .bearer_auth(bearer)
        .json(body)
        .send()
        .await
    else {
        return Outcome::Retry(60);
    };
    let status = response.status();
    let retry = response
        .headers()
        .get("retry-after")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| {
            v.parse::<i64>().ok().or_else(|| {
                chrono::DateTime::parse_from_rfc2822(v).ok().map(|time| {
                    (time.with_timezone(&chrono::Utc) - chrono::Utc::now()).num_seconds()
                })
            })
        })
        .unwrap_or(60)
        .clamp(60, 86400);
    // FCM error descriptions may echo registration tokens; never log the body.
    let mut bytes = Vec::new();
    loop {
        match response.chunk().await {
            Ok(Some(chunk)) if bytes.len() + chunk.len() <= 65536 => {
                bytes.extend_from_slice(&chunk)
            }
            Ok(None) => break,
            _ => return Outcome::Retry(retry),
        }
    }
    let body: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    if status.is_success()
        && body
            .get("name")
            .and_then(Value::as_str)
            .is_some_and(|s| !s.is_empty())
    {
        return Outcome::Delivered;
    }
    if body
        .pointer("/error/details")
        .and_then(Value::as_array)
        .is_some_and(|details| {
            details.iter().any(|d| {
                d["@type"] == "type.googleapis.com/google.firebase.fcm.v1.FcmError"
                    && d["errorCode"] == "UNREGISTERED"
            })
        })
    {
        return Outcome::InvalidToken;
    }
    if matches!(status.as_u16(), 400 | 403 | 404) {
        Outcome::Retired
    } else {
        Outcome::Retry(retry)
    }
}

pub async fn register(
    app: &App,
    actor: &Account,
    hash: &str,
    input: RegisterPush,
) -> Result<PushRegistration> {
    if input.token.is_empty()
        || input.token.len() > 4096
        || !input.token.bytes().all(|b| b.is_ascii_graphic())
    {
        return Err(Error::invalid());
    }
    let mut tx = app.pool.begin().await?;
    auth::lock_active(&mut tx, actor).await?;
    let device: String=sqlx::query_scalar("SELECT device_id FROM sessions WHERE token_hash=$1 AND user_id=$2 AND expires_at>now() FOR SHARE")
        .bind(hash).bind(&actor.id).fetch_optional(&mut *tx).await?.ok_or_else(Error::unauthorized)?;
    let (instance, epoch): (String, String) =
        sqlx::query_as("SELECT instance_id,data_epoch FROM instance WHERE singleton FOR SHARE")
            .fetch_one(&mut *tx)
            .await?;
    sqlx::query("INSERT INTO push_devices(device_id,user_id,data_epoch,token) VALUES($1,$2,$3,$4) ON CONFLICT(device_id) DO UPDATE SET token=EXCLUDED.token,data_epoch=EXCLUDED.data_epoch,generation=CASE WHEN (push_devices.token,push_devices.data_epoch) IS DISTINCT FROM (EXCLUDED.token,EXCLUDED.data_epoch) THEN gen_random_uuid()::text ELSE push_devices.generation END,updated_at=now()")
        .bind(&device).bind(&actor.id).bind(&epoch).bind(input.token).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(PushRegistration {
        device_id: device,
        instance_id: instance,
        data_epoch: epoch,
    })
}
pub async fn unregister(app: &App, actor: &Account, hash: &str) -> Result<()> {
    let mut tx = app.pool.begin().await?;
    auth::lock_active(&mut tx, actor).await?;
    sqlx::query("DELETE FROM push_devices d USING sessions s WHERE d.device_id=s.device_id AND s.token_hash=$1 AND s.user_id=$2")
        .bind(hash).bind(&actor.id).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(())
}
pub(crate) async fn enqueue(tx: &mut Transaction<'_, Postgres>, message: &str) -> Result<()> {
    sqlx::query("INSERT INTO push_notifications(device_id,user_id,message_id,data_epoch,generation,membership_version,activation_version) SELECT device_id,user_id,message_id,data_epoch,generation,membership_version,activation_version FROM eligible_push_recipients WHERE message_id=$1 ON CONFLICT(message_id,device_id) DO NOTHING")
        .bind(message).execute(&mut **tx).await?;
    Ok(())
}

async fn claim(app: &App) -> Result<Vec<Lease>> {
    let mut tx = app.pool.begin().await?;
    auth::mutation_deadlines(&mut tx).await?;
    // Fenced leases allow several worker processes. Stale / revoked eligibility
    // is retired before contacting FCM; an already in-flight push has only IDs.
    sqlx::query("UPDATE push_notifications n SET state='retired',lease_id=NULL,lease_expires_at=NULL WHERE n.id IN (SELECT n.id FROM push_notifications n WHERE n.state='pending' AND (n.expires_at<=now() OR (n.attempts>=$1 AND (n.lease_expires_at IS NULL OR n.lease_expires_at<=now())) OR NOT EXISTS(SELECT 1 FROM eligible_push_recipients e WHERE e.message_id=n.message_id AND e.device_id=n.device_id AND e.generation=n.generation AND e.membership_version=n.membership_version AND e.activation_version=n.activation_version AND e.data_epoch=n.data_epoch)) LIMIT 100 FOR UPDATE OF n SKIP LOCKED)")
        .bind(ATTEMPTS).execute(&mut *tx).await?;
    let jobs=sqlx::query_as("WITH selected AS (SELECT n.id FROM push_notifications n JOIN eligible_push_recipients e ON e.message_id=n.message_id AND e.device_id=n.device_id AND e.generation=n.generation AND e.membership_version=n.membership_version AND e.activation_version=n.activation_version AND e.data_epoch=n.data_epoch WHERE n.state='pending' AND n.attempts<$1 AND n.expires_at>now() AND n.available_at<=now() AND (n.lease_expires_at IS NULL OR n.lease_expires_at<=now()) ORDER BY n.available_at,n.id LIMIT 4 FOR UPDATE OF n SKIP LOCKED), leased AS (UPDATE push_notifications n SET attempts=attempts+1,lease_id=gen_random_uuid()::text,lease_expires_at=now()+interval '60 seconds' FROM selected s WHERE s.id=n.id RETURNING n.*) SELECT n.id,n.device_id,n.user_id,n.message_id,n.generation,n.data_epoch,e.instance_id,e.room_id,e.reply_to,e.token,n.lease_id,n.attempts FROM leased n JOIN eligible_push_recipients e ON e.message_id=n.message_id AND e.device_id=n.device_id AND e.generation=n.generation AND e.membership_version=n.membership_version AND e.activation_version=n.activation_version AND e.data_epoch=n.data_epoch")
        .bind(ATTEMPTS).fetch_all(&mut *tx).await?;
    tx.commit().await?;
    Ok(jobs)
}
async fn acknowledge(app: &App, job: &Lease, outcome: Outcome) -> Result<()> {
    let mut tx = app.pool.begin().await?;
    auth::mutation_deadlines(&mut tx).await?;
    // Rotation, unregister and a reclaimed lease make late results harmless.
    let device: Option<String> = sqlx::query_scalar(
        "SELECT device_id FROM push_devices WHERE device_id=$1 AND generation=$2 FOR UPDATE",
    )
    .bind(&job.device_id)
    .bind(&job.generation)
    .fetch_optional(&mut *tx)
    .await?;
    let live: Option<String>=sqlx::query_scalar("SELECT id FROM push_notifications WHERE id=$1 AND lease_id=$2 AND state='pending' AND generation=$3 AND lease_expires_at>now() FOR UPDATE")
        .bind(&job.id).bind(&job.lease_id).bind(&job.generation).fetch_optional(&mut *tx).await?;
    if device.is_some() && live.is_some() {
        if outcome == Outcome::InvalidToken {
            sqlx::query("DELETE FROM push_devices WHERE device_id=$1 AND generation=$2")
                .bind(&job.device_id)
                .bind(&job.generation)
                .execute(&mut *tx)
                .await?;
        } else {
            let (state, delay) = match outcome {
                Outcome::Delivered => ("delivered", 0),
                Outcome::Retry(delay) if job.attempts < ATTEMPTS => {
                    let jitter =
                        u8::from_str_radix(&auth::random_token()[..2], 16).unwrap_or(0) as i64 % 31;
                    (
                        "pending",
                        delay.max(60 * (1_i64 << job.attempts.min(6))) + jitter,
                    )
                }
                _ => ("retired", 0),
            };
            sqlx::query("UPDATE push_notifications SET state=$3,lease_id=NULL,lease_expires_at=NULL,available_at=now()+$4*interval '1 second' WHERE id=$1 AND lease_id=$2 AND state='pending'")
                .bind(&job.id).bind(&job.lease_id).bind(state).bind(delay).execute(&mut *tx).await?;
        }
    }
    tx.commit().await?;
    Ok(())
}
pub async fn drain(app: &App) -> Result<usize> {
    let Some(sender) = &app.push else {
        return Ok(0);
    };
    let jobs = claim(app).await?;
    let rings = claim_voice(app).await?;
    let count = jobs.len() + rings.len();
    let results = futures_util::future::join_all(
        jobs.iter()
            .map(|job| async { acknowledge(app, job, sender.deliver(&payload(job)).await).await }),
    )
    .await;
    let voice = futures_util::future::join_all(rings.iter().map(|job| async {
        acknowledge_voice(app, job, sender.deliver(&voice_payload(job)).await).await
    }))
    .await;
    for result in results.into_iter().chain(voice) {
        result?;
    }
    Ok(count)
}

/// A ring or its end, for one device of the callee. Ids only; the app reads
/// the ring with GET /api/v1/voice/rings/{id}.
#[derive(sqlx::FromRow)]
struct VoiceLease {
    id: String,
    ring_id: String,
    device_id: String,
    user_id: String,
    room_id: String,
    kind: String,
    token: String,
    data_epoch: String,
    instance_id: String,
    lease_id: String,
    attempts: i32,
}
const VOICE_ATTEMPTS: i32 = 3;
fn voice_payload(job: &VoiceLease) -> Value {
    let kind = if job.kind == "ring" {
        "voice_ring"
    } else {
        "voice_ring_end"
    };
    json!({"message":{"token":job.token,"data":{"product":"rocketvibe","type":kind,
        "instanceId":job.instance_id,"dataEpoch":job.data_epoch,"userId":job.user_id,
        "deviceId":job.device_id,"ringId":job.ring_id,"rid":job.room_id},
        "android":{"priority":"high","ttl":"30s"}}})
}
async fn claim_voice(app: &App) -> Result<Vec<VoiceLease>> {
    let mut tx = app.pool.begin().await?;
    auth::mutation_deadlines(&mut tx).await?;
    // A ring nobody needs anymore never reaches FCM: resolved, or a rotated token.
    sqlx::query("UPDATE voice_pushes p SET state='retired',lease_id=NULL,lease_expires_at=NULL WHERE p.id IN (SELECT p.id FROM voice_pushes p JOIN voice_rings v ON v.id=p.ring_id LEFT JOIN push_devices d ON d.device_id=p.device_id AND d.generation=p.generation WHERE p.state='pending' AND (p.expires_at<=now() OR d.device_id IS NULL OR (p.kind='ring' AND v.state<>'ringing') OR (p.attempts>=$1 AND (p.lease_expires_at IS NULL OR p.lease_expires_at<=now()))) LIMIT 100 FOR UPDATE OF p SKIP LOCKED)")
        .bind(VOICE_ATTEMPTS).execute(&mut *tx).await?;
    let jobs = sqlx::query_as("WITH selected AS (SELECT p.id FROM voice_pushes p WHERE p.state='pending' AND p.attempts<$1 AND p.expires_at>now() AND p.available_at<=now() AND (p.lease_expires_at IS NULL OR p.lease_expires_at<=now()) ORDER BY p.available_at,p.id LIMIT 8 FOR UPDATE OF p SKIP LOCKED), leased AS (UPDATE voice_pushes p SET attempts=attempts+1,lease_id=gen_random_uuid()::text,lease_expires_at=now()+interval '20 seconds' FROM selected s WHERE s.id=p.id RETURNING p.*) SELECT p.id,p.ring_id,p.device_id,d.user_id,v.room_id,p.kind,d.token,d.data_epoch,i.instance_id,p.lease_id,p.attempts FROM leased p JOIN push_devices d ON d.device_id=p.device_id AND d.generation=p.generation JOIN voice_rings v ON v.id=p.ring_id JOIN instance i ON i.singleton")
        .bind(VOICE_ATTEMPTS).fetch_all(&mut *tx).await?;
    tx.commit().await?;
    Ok(jobs)
}
async fn acknowledge_voice(app: &App, job: &VoiceLease, outcome: Outcome) -> Result<()> {
    let mut tx = app.pool.begin().await?;
    auth::mutation_deadlines(&mut tx).await?;
    if outcome == Outcome::InvalidToken {
        sqlx::query("DELETE FROM push_devices WHERE device_id=$1 AND generation=(SELECT generation FROM voice_pushes WHERE id=$2)")
            .bind(&job.device_id).bind(&job.id).execute(&mut *tx).await?;
    } else {
        // A ring is worth seconds: retry fast, a few times, then give up.
        let (state, delay) = match outcome {
            Outcome::Delivered => ("delivered", 0),
            Outcome::Retry(_) if job.attempts < VOICE_ATTEMPTS => ("pending", 2),
            _ => ("retired", 0),
        };
        sqlx::query("UPDATE voice_pushes SET state=$3,lease_id=NULL,lease_expires_at=NULL,available_at=now()+$4*interval '1 second' WHERE id=$1 AND lease_id=$2 AND state='pending'")
            .bind(&job.id).bind(&job.lease_id).bind(state).bind(delay).execute(&mut *tx).await?;
    }
    tx.commit().await?;
    Ok(())
}

pub(crate) async fn content(
    app: &App,
    actor: &Account,
    hash: &str,
    id: &str,
) -> Result<PushContent> {
    let row: Option<(String,String,String,String)>=sqlx::query_as("SELECT n.message_id,n.device_id,e.instance_id,n.data_epoch FROM push_notifications n JOIN eligible_push_recipients e ON e.message_id=n.message_id AND e.device_id=n.device_id AND e.generation=n.generation AND e.membership_version=n.membership_version AND e.activation_version=n.activation_version AND e.data_epoch=n.data_epoch JOIN sessions s ON s.device_id=n.device_id WHERE n.id=$1 AND n.user_id=$2 AND s.token_hash=$3 AND s.expires_at>now() AND n.expires_at>now() AND n.state<>'retired'")
        .bind(id).bind(&actor.id).bind(hash).fetch_optional(&app.pool).await?;
    let (message_id, device_id, instance_id, data_epoch) = row.ok_or_else(Error::missing)?;
    let message = crate::message_actions::read(app, actor, &message_id).await?;
    let room = crate::room_details::read(app, actor, &message.room_id)
        .await?
        .room;
    Ok(PushContent {
        notification_id: id.into(),
        device_id,
        instance_id,
        data_epoch,
        room,
        message,
    })
}

// Held through HTTP body submission by delivery::ReadProof. A revoked family,
// token generation, membership, read or message revision cannot expose old text.
pub(crate) async fn lock_content(
    conn: &mut sqlx::PgConnection,
    hash: &str,
    value: &PushContent,
) -> Result<()> {
    let valid: Option<String>=sqlx::query_scalar("SELECT n.id FROM push_notifications n JOIN push_devices d ON d.device_id=n.device_id JOIN messages m ON m.id=n.message_id JOIN room_read_states r ON r.room_id=m.room_id AND r.user_id=n.user_id JOIN eligible_push_recipients e ON e.message_id=n.message_id AND e.device_id=n.device_id AND e.generation=n.generation AND e.membership_version=n.membership_version AND e.activation_version=n.activation_version AND e.data_epoch=n.data_epoch JOIN sessions s ON s.device_id=n.device_id WHERE n.id=$1 AND s.token_hash=$2 AND n.expires_at>now() AND n.state<>'retired' AND m.revision=$3 FOR SHARE OF n,d,m,r")
        .bind(&value.notification_id).bind(hash).bind(value.message.revision.parse::<i64>().map_err(|_|Error::internal())?).fetch_optional(conn).await?;
    valid.ok_or_else(|| Error::new(StatusCode::NOT_FOUND, "not_found"))?;
    Ok(())
}

#[cfg(test)]
mod tests;
