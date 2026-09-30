use axum::{
    Json, Router,
    extract::{
        DefaultBodyLimit, Path, Query, State, WebSocketUpgrade,
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
use std::time::Duration;

use crate::{
    App, auth,
    error::{Error, Result},
    store, sync,
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
        capabilities: Default::default(),
    }))
}

async fn login(State(app): State<App>, input: Input<Login>) -> Result<Json<rv_protocol::Session>> {
    let login = body(input)?;
    Ok(Json(
        auth::login(&app, login.username, login.password).await?,
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
    let ticket = auth::random_token();
    let expires_at = Utc::now() + chrono::Duration::seconds(30);
    sqlx::query("INSERT INTO socket_tickets(token_hash,session_hash,expires_at) VALUES($1,$2,$3)")
        .bind(auth::hash_token(&ticket))
        .bind(hash)
        .bind(expires_at)
        .execute(&app.pool)
        .await?;
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
    sync::changes(&app, &user, &input.cursor, 1).await?;
    Ok(upgrade
        .max_message_size(1024)
        .max_frame_size(1024)
        .on_upgrade(move |ws| stream(app, ws, session_hash, input.cursor))
        .into_response())
}

async fn stream(app: App, mut ws: WebSocket, session_hash: String, mut cursor: String) {
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
    let _ = ws.close().await;
}
