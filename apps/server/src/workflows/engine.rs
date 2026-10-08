//! Runs: leased like the push and mail queues, executed step by step with the
//! step index and context saved after each, so a crash resumes where it stopped.
//! Every post carries the operation id `wf-<run>-<step>`: a step replayed after a
//! crash returns the message already sent, never a second one.
use super::{room_context, schedule, start, template::render, user_context};
use crate::{
    App,
    auth::{self, Account, random_token},
    error::{Error, Result},
};
use axum::http::StatusCode;
use chrono::{DateTime, Duration, Utc};
use rv_protocol::{
    SendMessage,
    workflows::{
        FORM_DAYS, FormFieldKind, FormRecipient, HTTP_RESPONSE_BYTES, Step, TRIGGER_ROOM, Trigger,
    },
};
use serde_json::{Value, json};
use sqlx::{FromRow, Postgres, Transaction, types::Json};
use std::net::SocketAddr;

/// The engine's session of a bot, created with its first workflow.
pub(crate) async fn ensure_session(tx: &mut Transaction<'_, Postgres>, bot: &str) -> Result<()> {
    let exists: bool =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM bot_keys WHERE bot_id=$1 AND internal)")
            .bind(bot)
            .fetch_one(&mut **tx)
            .await?;
    if exists {
        return Ok(());
    }
    let device = random_token()[..32].to_owned();
    sqlx::query("INSERT INTO session_devices(id,user_id,label) VALUES($1,$2,'Workflows')")
        .bind(&device)
        .bind(bot)
        .execute(&mut **tx)
        .await?;
    sqlx::query("INSERT INTO bot_keys(id,bot_id,device_id,label,hint,internal) VALUES($1,$2,$3,'Workflows','',true)")
        .bind(&random_token()[..24])
        .bind(bot)
        .bind(&device)
        .execute(&mut **tx)
        .await?;
    // Its token is never kept: only the engine, holding the hash, uses it.
    sqlx::query("INSERT INTO sessions(token_hash,user_id,expires_at,device_id) VALUES($1,$2,clock_timestamp()+interval '100 years',$3)")
        .bind(auth::hash_token(&random_token()))
        .bind(bot)
        .bind(&device)
        .execute(&mut **tx)
        .await?;
    Ok(())
}

/// Removes a bot's engine session once no workflow uses the bot.
pub(crate) async fn release_session(tx: &mut Transaction<'_, Postgres>, bot: &str) -> Result<()> {
    sqlx::query("DELETE FROM session_devices WHERE id=(SELECT device_id FROM bot_keys WHERE bot_id=$1 AND internal) AND NOT EXISTS(SELECT 1 FROM workflows WHERE bot_id=$1)")
        .bind(bot)
        .execute(&mut **tx)
        .await?;
    Ok(())
}

async fn bot_account(app: &App, workflow: &str) -> Option<(Account, Vec<String>)> {
    let row: Option<(String, Vec<String>)> = sqlx::query_as("SELECT s.token_hash,b.scopes FROM workflows w JOIN bots b ON b.user_id=w.bot_id JOIN bot_keys k ON k.bot_id=w.bot_id AND k.internal JOIN sessions s ON s.device_id=k.device_id WHERE w.id=$1")
        .bind(workflow)
        .fetch_optional(&app.pool)
        .await
        .ok()?;
    let (hash, scopes) = row?;
    Some((auth::authenticate(app, &hash).await.ok()?, scopes))
}

/// One tick: due schedules start their runs, then due runs advance.
pub async fn drain(app: &App) -> Result<()> {
    schedules(app).await?;
    let lease = random_token();
    let runs: Vec<RunRow> = sqlx::query_as("WITH due AS (SELECT id FROM workflow_runs WHERE state IN ('pending','waiting') AND wake_at<=clock_timestamp() AND (lease_expires_at IS NULL OR lease_expires_at<=clock_timestamp()) ORDER BY wake_at,id LIMIT 8 FOR UPDATE SKIP LOCKED) UPDATE workflow_runs r SET lease_id=$1,lease_expires_at=clock_timestamp()+interval '2 minutes',attempts=attempts+1 FROM due WHERE r.id=due.id RETURNING r.id,r.workflow_id,r.definition,r.context,r.step,r.attempts")
        .bind(&lease)
        .fetch_all(&app.pool)
        .await?;
    for run in runs {
        if let Err(error) = advance(app, &lease, run).await {
            tracing::error!(code = error.code, "workflow run iteration failed");
        }
    }
    Ok(())
}

async fn schedules(app: &App) -> Result<()> {
    let mut tx = app.pool.begin().await?;
    let due: Vec<(String, Json<Trigger>)> = sqlx::query_as("SELECT id,trigger FROM workflows WHERE enabled AND next_fire_at<=clock_timestamp() ORDER BY next_fire_at LIMIT 20 FOR UPDATE SKIP LOCKED")
        .fetch_all(&mut *tx)
        .await?;
    let now = Utc::now();
    for (id, trigger) in due {
        let Trigger::Schedule {
            every,
            time,
            days,
            timezone,
            room,
        } = trigger.0
        else {
            continue;
        };
        // A firing missed while the server was down happens once, not once per miss.
        let next = schedule::time(&time)
            .zip(schedule::zone(&timezone))
            .and_then(|(at, zone)| schedule::next(every, at, &days, zone, now));
        sqlx::query("UPDATE workflows SET next_fire_at=$2 WHERE id=$1")
            .bind(&id)
            .bind(next)
            .execute(&mut *tx)
            .await?;
        let trigger = json!({"kind": "schedule", "room": room_context(&mut tx, &room).await?, "at": now.to_rfc3339()});
        match start(&mut tx, &id, json!({"trigger": trigger})).await {
            Ok(_) => {}
            Err(error) if error.status == StatusCode::TOO_MANY_REQUESTS => {}
            Err(error) => return Err(error),
        }
    }
    tx.commit().await?;
    Ok(())
}

#[derive(FromRow)]
struct RunRow {
    id: String,
    workflow_id: String,
    definition: Json<Vec<Step>>,
    context: Json<Value>,
    step: i32,
    attempts: i32,
}

enum Outcome {
    Next,
    /// Continue at `step` once `until` has passed (a wait, an open form).
    Sleep {
        step: usize,
        until: DateTime<Utc>,
    },
    /// The same step again later (a budget, a transient failure).
    Retry(u64),
    Fail(String),
}

const MAX_ATTEMPTS: i32 = 50;

async fn advance(app: &App, lease: &str, run: RunRow) -> Result<()> {
    if run.attempts > MAX_ATTEMPTS {
        return finish(app, lease, &run.id, "failed", Some("workflow_retries")).await;
    }
    let Some((account, scopes)) = bot_account(app, &run.workflow_id).await else {
        return finish(app, lease, &run.id, "failed", Some("bot_unavailable")).await;
    };
    let steps = run.definition.0;
    let mut context = run.context.0;
    let mut step = run.step.max(0) as usize;
    for _ in 0..=steps.len() {
        let Some(current) = steps.get(step) else {
            return finish(app, lease, &run.id, "done", None).await;
        };
        context["now"] = json!(Utc::now().to_rfc3339());
        let outcome = execute(app, &account, &scopes, &run.id, step, current, &mut context).await;
        let (next, state, wake) = match outcome {
            Outcome::Next => (step + 1, "pending", None),
            Outcome::Sleep { step, until } => (step, "waiting", Some(until)),
            Outcome::Retry(seconds) => (
                step,
                "pending",
                Some(Utc::now() + Duration::seconds(seconds.clamp(1, 3600) as i64)),
            ),
            Outcome::Fail(code) => {
                save(app, lease, &run.id, step, &context, "pending", None, false).await?;
                return finish(app, lease, &run.id, "failed", Some(&code)).await;
            }
        };
        let release = wake.is_some();
        if !save(app, lease, &run.id, next, &context, state, wake, release).await? {
            // Cancelled meanwhile (the workflow was disabled or deleted).
            return Ok(());
        }
        if release {
            return Ok(());
        }
        step = next;
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
async fn save(
    app: &App,
    lease: &str,
    run: &str,
    step: usize,
    context: &Value,
    state: &str,
    wake: Option<DateTime<Utc>>,
    release: bool,
) -> Result<bool> {
    let saved = sqlx::query("UPDATE workflow_runs SET step=$3,context=$4,state=$5,wake_at=COALESCE($6,clock_timestamp()),lease_id=CASE WHEN $7 THEN NULL ELSE lease_id END,lease_expires_at=CASE WHEN $7 THEN NULL ELSE lease_expires_at END,attempts=CASE WHEN $5='waiting' THEN 0 ELSE attempts END,updated_at=clock_timestamp() WHERE id=$1 AND lease_id=$2 AND state IN ('pending','waiting')")
        .bind(run)
        .bind(lease)
        .bind(step as i32)
        .bind(Json(context))
        .bind(state)
        .bind(wake)
        .bind(release)
        .execute(&app.pool)
        .await?
        .rows_affected();
    Ok(saved > 0)
}

async fn finish(app: &App, lease: &str, run: &str, state: &str, error: Option<&str>) -> Result<()> {
    sqlx::query("UPDATE workflow_runs SET state=$3,error=$4,lease_id=NULL,lease_expires_at=NULL,updated_at=clock_timestamp() WHERE id=$1 AND lease_id=$2 AND state IN ('pending','waiting')")
        .bind(run)
        .bind(lease)
        .bind(state)
        .bind(error)
        .execute(&app.pool)
        .await?;
    Ok(())
}

fn text_at<'a>(context: &'a Value, path: &[&str]) -> Option<&'a str> {
    path.iter()
        .try_fold(context, |value, key| value.get(key))
        .and_then(Value::as_str)
}

fn room_of(context: &Value, room: &str) -> Option<String> {
    if room == TRIGGER_ROOM {
        text_at(context, &["trigger", "room", "id"]).map(str::to_owned)
    } else {
        Some(room.to_owned())
    }
}

fn operation(run: &str, step: usize) -> String {
    format!("wf-{run}-{step}")
}

fn failure(error: Error) -> Outcome {
    if error.status == StatusCode::TOO_MANY_REQUESTS {
        Outcome::Retry(error.retry_after.unwrap_or(60))
    } else {
        Outcome::Fail(error.code.to_owned())
    }
}

#[allow(clippy::too_many_arguments)]
async fn execute(
    app: &App,
    bot: &Account,
    scopes: &[String],
    run: &str,
    step: usize,
    current: &Step,
    context: &mut Value,
) -> Outcome {
    let writes = scopes.iter().any(|s| s == "messages:write");
    match current {
        Step::Message {
            room,
            text,
            cards,
            in_thread,
            save_as,
        } => {
            if !writes {
                return Outcome::Fail("bot_scope_missing".into());
            }
            let Some(room) = room_of(context, room) else {
                return Outcome::Fail("workflow_room".into());
            };
            let reply_to = in_thread
                .then(|| text_at(context, &["trigger", "thread"]).map(str::to_owned))
                .flatten();
            let input = SendMessage {
                operation_id: operation(run, step),
                text: render(text, context),
                reply_to,
                quotes: Vec::new(),
                cards: cards.clone(),
                files: Vec::new(),
            };
            match crate::store::send(app, bot, &room, input).await {
                Ok(message) => {
                    if let Some(name) = save_as {
                        context[name] = json!({"message_id": message.id});
                    }
                    Outcome::Next
                }
                Err(error) => failure(error),
            }
        }
        Step::Wait { seconds } => Outcome::Sleep {
            step: step + 1,
            until: Utc::now() + Duration::seconds(*seconds as i64),
        },
        Step::Http {
            method,
            url,
            headers,
            body,
            save_as,
            continue_on_error,
        } => {
            let url = render(url, context);
            let headers: Vec<(String, String)> = headers
                .iter()
                .map(|h| (h.name.clone(), render(&h.value, context)))
                .collect();
            let body = body.as_deref().map(|b| render(b, context));
            match call(app, method.as_str(), &url, &headers, body).await {
                Ok((status, response)) => {
                    if let Some(name) = save_as {
                        context[name] = json!({"status": status, "body": response});
                    }
                    if (200..300).contains(&status) || *continue_on_error {
                        Outcome::Next
                    } else {
                        Outcome::Fail("http_failed".into())
                    }
                }
                Err(code) => {
                    if *continue_on_error {
                        if let Some(name) = save_as {
                            context[name] = json!({"status": 0, "error": code});
                        }
                        Outcome::Next
                    } else {
                        Outcome::Fail(code.into())
                    }
                }
            }
        }
        Step::Form {
            room,
            recipient,
            title,
            fields,
            save_as,
        } => {
            form(
                app, bot, writes, run, step, context, room, *recipient, title, fields, save_as,
            )
            .await
        }
    }
}

#[allow(clippy::too_many_arguments)]
async fn form(
    app: &App,
    bot: &Account,
    writes: bool,
    run: &str,
    step: usize,
    context: &mut Value,
    room: &str,
    recipient: FormRecipient,
    title: &str,
    fields: &[rv_protocol::workflows::FormField],
    save_as: &str,
) -> Outcome {
    type Posted = Option<(Option<Json<Value>>, Option<String>, DateTime<Utc>)>;
    let posted: std::result::Result<Posted, _> = sqlx::query_as(
        "SELECT answers,answered_by,expires_at FROM workflow_forms WHERE run_id=$1 AND step=$2",
    )
    .bind(run)
    .bind(step as i32)
    .fetch_optional(&app.pool)
    .await;
    match posted {
        Err(error) => return failure(error.into()),
        Ok(Some((answers, Some(by), _))) => {
            let mut tx = match app.pool.begin().await {
                Ok(tx) => tx,
                Err(error) => return failure(error.into()),
            };
            let by = match user_context(&mut tx, &by).await {
                Ok(by) => by,
                Err(error) => return failure(error),
            };
            // A person is answered by id: the run sees the username, and the person.
            let mut answers = answers.map(|a| a.0).unwrap_or(json!({}));
            let mut people = serde_json::Map::new();
            for field in fields.iter().filter(|f| f.kind == FormFieldKind::Person) {
                let Some(id) = answers
                    .get(&field.id)
                    .and_then(Value::as_str)
                    .map(str::to_owned)
                else {
                    continue;
                };
                let person = match user_context(&mut tx, &id).await {
                    Ok(person) => person,
                    Err(error) => return failure(error),
                };
                answers[&field.id] = person["username"].clone();
                people.insert(field.id.clone(), person);
            }
            let _ = tx.commit().await;
            context[save_as] = json!({"answers": answers, "by": by, "people": people});
            return Outcome::Next;
        }
        Ok(Some((_, None, expires))) => {
            return if expires <= Utc::now() {
                Outcome::Fail("form_expired".into())
            } else {
                Outcome::Sleep {
                    step,
                    until: expires,
                }
            };
        }
        Ok(None) => {}
    }
    if !writes {
        return Outcome::Fail("bot_scope_missing".into());
    }
    let Some(room) = room_of(context, room) else {
        return Outcome::Fail("workflow_room".into());
    };
    let recipient = match recipient {
        FormRecipient::Anyone => None,
        FormRecipient::TriggerUser => match text_at(context, &["trigger", "user", "id"]) {
            Some(id) => Some(id.to_owned()),
            None => return Outcome::Fail("workflow_form".into()),
        },
    };
    let expires = Utc::now() + Duration::days(FORM_DAYS);
    let result: Result<()> = async {
        let mut tx = app.pool.begin().await?;
        let message = crate::store::send_in_tx(
            &mut tx,
            bot,
            &room,
            SendMessage {
                operation_id: operation(run, step),
                text: title.to_owned(),
                reply_to: None,
                quotes: Vec::new(),
                cards: Vec::new(),
                files: Vec::new(),
            },
            &[],
            None,
        )
        .await?;
        sqlx::query("INSERT INTO workflow_forms(message_id,run_id,step,room_id,recipient_id,title,fields,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(message_id) DO NOTHING")
            .bind(&message.id)
            .bind(run)
            .bind(step as i32)
            .bind(&room)
            .bind(&recipient)
            .bind(title)
            .bind(Json(fields))
            .bind(expires)
            .execute(&mut *tx)
            .await?;
        // The message was journaled before it carried its form.
        crate::store::republish(&mut tx, &room, &message.id).await?;
        tx.commit().await?;
        Ok(())
    }
    .await;
    match result {
        Ok(()) => Outcome::Sleep {
            step,
            until: expires,
        },
        Err(error) => failure(error),
    }
}

/// One request to a public address (the link-preview collector's rule), no
/// redirect, 10 s, the response cut at 64 KiB: JSON when it parses, else text.
async fn call(
    app: &App,
    method: &str,
    raw: &str,
    headers: &[(String, String)],
    body: Option<String>,
) -> std::result::Result<(u16, Value), &'static str> {
    let url = reqwest::Url::parse(raw.trim()).map_err(|_| "http_url")?;
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err("http_url");
    }
    let host = url.host_str().ok_or("http_url")?.to_owned();
    let port = url.port_or_known_default().ok_or("http_url")?;
    let addresses: Vec<SocketAddr> = tokio::time::timeout(
        std::time::Duration::from_secs(5),
        tokio::net::lookup_host((host.as_str(), port)),
    )
    .await
    .map_err(|_| "http_failed")?
    .map_err(|_| "http_failed")?
    .collect();
    if addresses.is_empty()
        || (!app.private_http
            && addresses
                .iter()
                .any(|a| !crate::link_previews::public_address(a.ip())))
    {
        return Err("http_address");
    }
    // Pin the checked addresses: a second lookup cannot rebind to a private one.
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(std::time::Duration::from_secs(10))
        .resolve_to_addrs(&host, &addresses)
        .build()
        .map_err(|_| "http_failed")?;
    let method = reqwest::Method::from_bytes(method.as_bytes()).map_err(|_| "http_url")?;
    let mut request = client.request(method, url);
    let mut typed = false;
    for (name, value) in headers {
        typed |= name.eq_ignore_ascii_case("content-type");
        request = request.header(name, value);
    }
    if let Some(body) = body {
        if !typed && serde_json::from_str::<Value>(&body).is_ok() {
            request = request.header("content-type", "application/json");
        }
        request = request.body(body);
    }
    let mut response = request.send().await.map_err(|_| "http_failed")?;
    let status = response.status().as_u16();
    let mut bytes = Vec::new();
    while let Ok(Some(chunk)) = response.chunk().await {
        let room = HTTP_RESPONSE_BYTES.saturating_sub(bytes.len());
        bytes.extend_from_slice(&chunk[..chunk.len().min(room)]);
        if bytes.len() >= HTTP_RESPONSE_BYTES {
            break;
        }
    }
    let body = serde_json::from_slice(&bytes)
        .unwrap_or_else(|_| Value::String(String::from_utf8_lossy(&bytes).into_owned()));
    Ok((status, body))
}
