use axum::{
    Extension, Json, Router,
    extract::{
        ConnectInfo, DefaultBodyLimit, Path, Query, State, WebSocketUpgrade,
        ws::{Message as WsMessage, WebSocket},
    },
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use chrono::{DateTime, Utc};
use futures_util::SinkExt;
use rv_protocol::{
    CreateRoom, DirectMessage, Discovery, Login, SendMessage, SocketTicket, VERSION,
};
use serde::Deserialize;
use std::{net::SocketAddr, time::Duration};

use crate::{
    App, auth,
    error::{Error, Result},
    limits, snapshots, store, sync,
};

pub fn router(app: App) -> Router {
    Router::new()
        .route("/.well-known/rocketvibe", get(discovery))
        .route("/health/live", get(|| async { StatusCode::NO_CONTENT }))
        .route("/health/ready", get(ready))
        .route("/api/v1/auth/login", post(login))
        .route("/api/v1/auth/logout", post(logout))
        .route("/api/v1/me", get(me))
        .route("/api/v1/users", get(users))
        .route("/api/v1/rooms", get(rooms).post(create_room))
        .route("/api/v1/direct-messages", post(direct))
        .route(
            "/api/v1/rooms/{room}/members/{user}",
            post(add_member).delete(remove_member),
        )
        .route("/api/v1/rooms/{room}/messages", get(history).post(send))
        .route("/api/v1/sync/snapshot", get(snapshot))
        .route("/api/v1/sync/snapshots", post(begin_snapshot))
        .route("/api/v1/sync/snapshots/{token}", get(snapshot_page))
        .route("/api/v1/sync/changes", get(changes))
        .route("/api/v1/sync/ticket", post(ticket))
        .route("/api/v1/sync/socket", get(socket))
        .fallback(|| async { Error::missing() })
        .layer(DefaultBodyLimit::max(64 * 1024))
        .with_state(app)
}

type Input<T> = std::result::Result<Json<T>, axum::extract::rejection::JsonRejection>;
fn body<T>(input: Input<T>) -> Result<T> {
    input.map(|Json(v)| v).map_err(|_| Error::invalid())
}

async fn account(app: &App, headers: &HeaderMap) -> Result<auth::Account> {
    auth::authenticate(app, &auth::bearer(headers)?).await
}

async fn ready(State(app): State<App>) -> Result<StatusCode> {
    sqlx::query("SELECT 1 FROM instance WHERE singleton")
        .fetch_one(&app.pool)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn discovery(State(app): State<App>) -> Result<Json<Discovery>> {
    let (instance_id, data_epoch): (String, String) =
        sqlx::query_as("SELECT instance_id,data_epoch FROM instance WHERE singleton")
            .fetch_one(&app.pool)
            .await?;
    Ok(Json(Discovery {
        product: "rocketvibe".into(),
        instance_id,
        data_epoch,
        server_version: env!("CARGO_PKG_VERSION").into(),
        protocol_versions: vec![VERSION],
        api_path: "/api/v1".into(),
        capabilities: rv_protocol::Capabilities {
            snapshot_paging: true,
            ..Default::default()
        },
    }))
}

async fn login(
    State(app): State<App>,
    peer: Option<Extension<ConnectInfo<SocketAddr>>>,
    input: Input<Login>,
) -> Result<Json<rv_protocol::Session>> {
    let login = body(input)?;
    Ok(Json(
        auth::login_from(
            &app,
            login.username,
            login.password,
            peer.map(|p| p.0.0.ip()),
        )
        .await?,
    ))
}

async fn logout(State(app): State<App>, headers: HeaderMap) -> Result<StatusCode> {
    let hash = auth::bearer(&headers)?;
    auth::authenticate(&app, &hash).await?;
    sqlx::query("DELETE FROM sessions WHERE token_hash=$1")
        .bind(hash)
        .execute(&app.pool)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn me(State(app): State<App>, headers: HeaderMap) -> Result<Json<rv_protocol::User>> {
    Ok(Json(account(&app, &headers).await?.user()))
}

async fn users(State(app): State<App>, headers: HeaderMap) -> Result<Json<Vec<rv_protocol::User>>> {
    account(&app, &headers).await?;
    let users: Vec<(String, String, String)> = sqlx::query_as(
        "SELECT id,username,display_name FROM users WHERE NOT disabled ORDER BY username LIMIT 100",
    )
    .fetch_all(&app.pool)
    .await?;
    Ok(Json(
        users
            .into_iter()
            .map(|(id, username, display_name)| rv_protocol::User {
                id,
                username,
                display_name,
            })
            .collect(),
    ))
}

async fn rooms(State(app): State<App>, headers: HeaderMap) -> Result<Json<Vec<rv_protocol::Room>>> {
    Ok(Json(
        store::rooms(&app, &account(&app, &headers).await?).await?,
    ))
}
async fn create_room(
    State(app): State<App>,
    headers: HeaderMap,
    input: Input<CreateRoom>,
) -> Result<Json<rv_protocol::Room>> {
    Ok(Json(
        store::create_room(&app, &account(&app, &headers).await?, body(input)?).await?,
    ))
}
async fn direct(
    State(app): State<App>,
    headers: HeaderMap,
    input: Input<DirectMessage>,
) -> Result<Json<rv_protocol::Room>> {
    Ok(Json(
        store::direct(&app, &account(&app, &headers).await?, &body(input)?.user_id).await?,
    ))
}

async fn add_member(
    State(app): State<App>,
    headers: HeaderMap,
    Path((room, user)): Path<(String, String)>,
) -> Result<StatusCode> {
    store::membership(&app, &account(&app, &headers).await?, &room, &user, false).await?;
    Ok(StatusCode::NO_CONTENT)
}
async fn remove_member(
    State(app): State<App>,
    headers: HeaderMap,
    Path((room, user)): Path<(String, String)>,
) -> Result<StatusCode> {
    store::membership(&app, &account(&app, &headers).await?, &room, &user, true).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn send(
    State(app): State<App>,
    headers: HeaderMap,
    Path(room): Path<String>,
    input: Input<SendMessage>,
) -> Result<Json<rv_protocol::Message>> {
    Ok(Json(
        store::send(&app, &account(&app, &headers).await?, &room, body(input)?).await?,
    ))
}

#[derive(Deserialize)]
struct History {
    before: Option<String>,
    limit: Option<i64>,
}
async fn history(
    State(app): State<App>,
    headers: HeaderMap,
    Path(room): Path<String>,
    Query(input): Query<History>,
) -> Result<Json<rv_protocol::MessagePage>> {
    let before = input
        .before
        .map(|s| s.parse::<i64>().map_err(|_| Error::invalid()))
        .transpose()?;
    let limit = input.limit.unwrap_or(50);
    if !(1..=100).contains(&limit) {
        return Err(Error::invalid());
    }
    Ok(Json(
        store::history(&app, &account(&app, &headers).await?, &room, before, limit).await?,
    ))
}

async fn snapshot(
    State(app): State<App>,
    headers: HeaderMap,
) -> Result<Json<rv_protocol::Snapshot>> {
    Ok(Json(
        sync::snapshot(&app, &account(&app, &headers).await?).await?,
    ))
}
async fn begin_snapshot(
    State(app): State<App>,
    headers: HeaderMap,
) -> Result<Json<rv_protocol::SnapshotPage>> {
    Ok(Json(
        snapshots::begin(&app, &account(&app, &headers).await?).await?,
    ))
}
async fn snapshot_page(
    State(app): State<App>,
    headers: HeaderMap,
    Path(token): Path<String>,
) -> Result<Json<rv_protocol::SnapshotPage>> {
    Ok(Json(
        snapshots::page(&app, &account(&app, &headers).await?, &token).await?,
    ))
}
#[derive(Deserialize)]
struct Changes {
    cursor: String,
}
async fn changes(
    State(app): State<App>,
    headers: HeaderMap,
    Query(input): Query<Changes>,
) -> Result<Json<rv_protocol::SyncBatch>> {
    Ok(Json(
        sync::changes(&app, &account(&app, &headers).await?, &input.cursor, 100).await?,
    ))
}

async fn ticket(State(app): State<App>, headers: HeaderMap) -> Result<Json<SocketTicket>> {
    let hash = auth::bearer(&headers)?;
    auth::authenticate(&app, &hash).await?;
    app.socket_slots.check(&hash)?;
    let ticket = auth::random_token();
    let expires_at = Utc::now() + chrono::Duration::seconds(30);
    let mut tx = app.pool.begin().await?;
    // Serialize ticket reservations with each other and session deletion. A
    // retained ticket cannot resurrect a session that expired during admission.
    let active: Option<String> = sqlx::query_scalar(
        "SELECT token_hash FROM sessions WHERE token_hash=$1 AND expires_at>now() FOR NO KEY UPDATE",
    ).bind(&hash).fetch_optional(&mut *tx).await?;
    if active.is_none() {
        return Err(Error::unauthorized());
    }
    sqlx::query("DELETE FROM socket_tickets WHERE session_hash=$1 AND expires_at<=now()")
        .bind(&hash)
        .execute(&mut *tx)
        .await?;
    let count: i64 =
        sqlx::query_scalar("SELECT count(*) FROM socket_tickets WHERE session_hash=$1")
            .bind(&hash)
            .fetch_one(&mut *tx)
            .await?;
    if count >= limits::TICKETS_PER_SESSION {
        return Err(Error::throttled("ticket_limit", 30));
    }
    sqlx::query("INSERT INTO socket_tickets(token_hash,session_hash,expires_at) VALUES($1,$2,$3)")
        .bind(auth::hash_token(&ticket))
        .bind(hash)
        .bind(expires_at)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(Json(SocketTicket {
        ticket,
        expires_at: expires_at.to_rfc3339(),
    }))
}

#[derive(Deserialize)]
struct Socket {
    ticket: String,
    cursor: String,
}
async fn socket(
    State(app): State<App>,
    Query(input): Query<Socket>,
    upgrade: WebSocketUpgrade,
) -> Result<Response> {
    if input.ticket.len() != 64 || input.cursor.len() != 64 {
        return Err(Error::invalid());
    }
    let consumed: Option<(String,DateTime<Utc>)> = sqlx::query_as("DELETE FROM socket_tickets WHERE token_hash=$1 AND expires_at>now() RETURNING session_hash,expires_at")
        .bind(auth::hash_token(&input.ticket)).fetch_optional(&app.pool).await?;
    let Some((session_hash, _)) = consumed else {
        return Err(Error::unauthorized());
    };
    let user = auth::authenticate(&app, &session_hash).await?;
    let slot = app.socket_slots.acquire(&session_hash)?;
    sync::changes(&app, &user, &input.cursor, 1).await?;
    Ok(upgrade
        .max_message_size(1024)
        .max_frame_size(1024)
        .on_upgrade(move |ws| stream(app, ws, session_hash, input.cursor, slot))
        .into_response())
}

async fn stream(
    app: App,
    mut ws: WebSocket,
    session_hash: String,
    mut cursor: String,
    _slot: limits::SocketSlot,
) {
    let mut interval = tokio::time::interval(Duration::from_millis(250));
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut last_sent = tokio::time::Instant::now();
    // The database journal is the queue. No unbounded in-memory broadcast channel.
    loop {
        tokio::select! {
            incoming = ws.recv() => match incoming {
                Some(Ok(WsMessage::Close(_))) | None | Some(Err(_)) => break,
                Some(Ok(WsMessage::Text(_))) | Some(Ok(WsMessage::Binary(_))) => break,
                _ => (),
            },
            _ = interval.tick() => {
                let account = match auth::authenticate(&app, &session_hash).await { Ok(a) => a, Err(_) => break };
                let batch = match sync::changes(&app, &account, &cursor, 100).await { Ok(b) => b, Err(_) => break };
                // Send empty batches too when their cursor advanced over private events.
                // An idle batch is also a heartbeat. Clients can detect a half-open
                // socket without advancing their durable cursor or sending a token.
                if batch.cursor == cursor && last_sent.elapsed() < Duration::from_secs(15) { continue; }
                cursor = batch.cursor.clone();
                let Ok(text) = serde_json::to_string(&batch) else { break };
                if !matches!(tokio::time::timeout(Duration::from_secs(5), ws.send(WsMessage::Text(text.into()))).await, Ok(Ok(()))) { break; }
                last_sent = tokio::time::Instant::now();
            }
        }
    }
    let _ = tokio::time::timeout(Duration::from_secs(5), ws.close()).await;
}
