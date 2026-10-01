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
    delivery::{ReadProof, Scope},
    error::{Error, Result},
    limits, message_actions, permissions, reactions, snapshots, store, sync,
};

pub fn router(app: App) -> Router {
    Router::new()
        .route("/.well-known/rocketvibe", get(discovery))
        .route("/health/live", get(|| async { StatusCode::NO_CONTENT }))
        .route("/health/ready", get(ready))
        .route("/api/v1/auth/login", post(login))
        .route("/api/v1/auth/logout", post(logout))
        .route("/api/v1/me", get(me))
        .route("/api/v1/me/permissions", get(account_permissions))
        .route("/api/v1/users", get(users))
        .route("/api/v1/rooms", get(rooms).post(create_room))
        .route("/api/v1/rooms/public", get(public_rooms))
        .route("/api/v1/rooms/discover", get(public_rooms))
        .route("/api/v1/rooms/{room}/permissions", get(room_permissions))
        .route(
            "/api/v1/messages/{message}/permissions",
            get(message_permissions),
        )
        .route(
            "/api/v1/messages/{message}",
            get(message).patch(edit_message).delete(delete_message),
        )
        .route(
            "/api/v1/messages/{message}/reactions",
            axum::routing::put(set_reaction),
        )
        .route("/api/v1/rooms/{room}/join", post(join_public))
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

async fn read_access(
    app: &App,
    headers: &HeaderMap,
    scope: Scope<'_>,
) -> Result<(auth::Account, String, ReadProof)> {
    let hash = auth::bearer(headers)?;
    let account = auth::authenticate(app, &hash).await?;
    let proof = ReadProof::capture(app, &account, scope).await?;
    Ok((account, hash, proof))
}

fn batch_rooms(batch: &rv_protocol::SyncBatch) -> Vec<String> {
    batch
        .changes
        .iter()
        .filter_map(|change| match change {
            rv_protocol::Change::RoomUpsert(room) => Some(room.id.clone()),
            rv_protocol::Change::MessageUpsert(message) => Some(message.room_id.clone()),
            rv_protocol::Change::RoomRemoved { .. } => None,
        })
        .collect()
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
            idempotent_room_creation: true,
            room_discovery: true,
            fine_permissions: true,
            editing: true,
            deletion: true,
            reactions: true,
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

async fn me(State(app): State<App>, headers: HeaderMap) -> Result<Response> {
    let (account, hash, proof) = read_access(&app, &headers, Scope::None).await?;
    proof.json(&app, &hash, &account.user(), &[], None).await
}

async fn users(State(app): State<App>, headers: HeaderMap) -> Result<Response> {
    let (_, hash, proof) = read_access(&app, &headers, Scope::None).await?;
    let users: Vec<(String, String, String)> = sqlx::query_as(
        "SELECT id,username,display_name FROM users WHERE NOT disabled ORDER BY username LIMIT 100",
    )
    .fetch_all(&app.pool)
    .await?;
    let users: Vec<_> = users
        .into_iter()
        .map(|(id, username, display_name)| rv_protocol::User {
            id,
            username,
            display_name,
        })
        .collect();
    proof.json(&app, &hash, &users, &[], None).await
}

async fn account_permissions(State(app): State<App>, headers: HeaderMap) -> Result<Response> {
    let (account, hash, proof) = read_access(&app, &headers, Scope::None).await?;
    let permissions = permissions::account(&app, &account).await?;
    proof.json(&app, &hash, &permissions, &[], None).await
}

async fn room_permissions(
    State(app): State<App>,
    headers: HeaderMap,
    Path(room): Path<String>,
) -> Result<Response> {
    let (account, hash, proof) = read_access(&app, &headers, Scope::Room(&room)).await?;
    let permissions = permissions::room(&app, &account, &room).await?;
    proof.json(&app, &hash, &permissions, &[room], None).await
}

async fn message_permissions(
    State(app): State<App>,
    headers: HeaderMap,
    Path(message): Path<String>,
) -> Result<Response> {
    let (account, hash, proof) = read_access(&app, &headers, Scope::All).await?;
    let (room, permissions) = permissions::message(&app, &account, &message).await?;
    proof.json(&app, &hash, &permissions, &[room], None).await
}

async fn message(
    State(app): State<App>,
    headers: HeaderMap,
    Path(message): Path<String>,
) -> Result<Response> {
    let (account, hash, proof) = read_access(&app, &headers, Scope::All).await?;
    let message = message_actions::read(&app, &account, &message).await?;
    proof
        .json(
            &app,
            &hash,
            &message,
            std::slice::from_ref(&message.room_id),
            None,
        )
        .await
}

async fn edit_message(
    State(app): State<App>,
    headers: HeaderMap,
    Path(id): Path<String>,
    input: Input<rv_protocol::parity::EditMessage>,
) -> Result<Response> {
    let actor = account(&app, &headers).await?;
    message_actions::apply(
        &app,
        &actor,
        &id,
        message_actions::Command::Edit(body(input)?),
    )
    .await?;
    message(State(app), headers, Path(id)).await
}

async fn delete_message(
    State(app): State<App>,
    headers: HeaderMap,
    Path(id): Path<String>,
    input: Input<rv_protocol::parity::DeleteMessage>,
) -> Result<Response> {
    let actor = account(&app, &headers).await?;
    message_actions::apply(
        &app,
        &actor,
        &id,
        message_actions::Command::Delete(body(input)?),
    )
    .await?;
    message(State(app), headers, Path(id)).await
}

async fn set_reaction(
    State(app): State<App>,
    headers: HeaderMap,
    Path(id): Path<String>,
    input: Input<rv_protocol::parity::SetReaction>,
) -> Result<Response> {
    let actor = account(&app, &headers).await?;
    reactions::apply(&app, &actor, &id, body(input)?).await?;
    message(State(app), headers, Path(id)).await
}

async fn rooms(State(app): State<App>, headers: HeaderMap) -> Result<Response> {
    let (account, hash, proof) = read_access(&app, &headers, Scope::All).await?;
    let rooms = store::rooms(&app, &account).await?;
    let ids = rooms.iter().map(|r| r.id.clone()).collect::<Vec<_>>();
    proof.json(&app, &hash, &rooms, &ids, None).await
}
async fn create_room(
    State(app): State<App>,
    headers: HeaderMap,
    input: Input<CreateRoom>,
) -> Result<Response> {
    let hash = auth::bearer(&headers)?;
    let account = auth::authenticate(&app, &hash).await?;
    let room = store::create_room(&app, &account, body(input)?).await?;
    let proof = ReadProof::capture(&app, &account, Scope::Room(&room.id)).await?;
    proof
        .json(&app, &hash, &room, std::slice::from_ref(&room.id), None)
        .await
}

#[derive(Deserialize)]
struct Directory {
    q: Option<String>,
    after: Option<String>,
}

async fn public_rooms(
    State(app): State<App>,
    headers: HeaderMap,
    Query(input): Query<Directory>,
) -> Result<Response> {
    let (account, hash, proof) = read_access(&app, &headers, Scope::None).await?;
    let page = store::public_rooms(
        &app,
        &account,
        input.q.as_deref().unwrap_or(""),
        input.after.as_deref(),
    )
    .await?;
    proof.public_json(&app, &hash, &page).await
}

async fn join_public(
    State(app): State<App>,
    headers: HeaderMap,
    Path(room): Path<String>,
) -> Result<Response> {
    let hash = auth::bearer(&headers)?;
    let account = auth::authenticate(&app, &hash).await?;
    let room = store::join_public(&app, &account, &room).await?;
    let proof = ReadProof::capture(&app, &account, Scope::Room(&room.id)).await?;
    proof
        .json(&app, &hash, &room, std::slice::from_ref(&room.id), None)
        .await
}
async fn direct(
    State(app): State<App>,
    headers: HeaderMap,
    input: Input<DirectMessage>,
) -> Result<Response> {
    let hash = auth::bearer(&headers)?;
    let account = auth::authenticate(&app, &hash).await?;
    let room = store::direct(&app, &account, &body(input)?.user_id).await?;
    let proof = ReadProof::capture(&app, &account, Scope::Room(&room.id)).await?;
    proof
        .json(&app, &hash, &room, std::slice::from_ref(&room.id), None)
        .await
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
) -> Result<Response> {
    let (account, hash, proof) = read_access(&app, &headers, Scope::Room(&room)).await?;
    let message = store::send(&app, &account, &room, body(input)?).await?;
    proof.json(&app, &hash, &message, &[room], None).await
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
) -> Result<Response> {
    let before = input
        .before
        .map(|s| s.parse::<i64>().map_err(|_| Error::invalid()))
        .transpose()?;
    let limit = input.limit.unwrap_or(50);
    if !(1..=100).contains(&limit) {
        return Err(Error::invalid());
    }
    let (account, hash, proof) = read_access(&app, &headers, Scope::Room(&room)).await?;
    let messages = store::history(&app, &account, &room, before, limit).await?;
    proof.json(&app, &hash, &messages, &[room], None).await
}

async fn snapshot(State(app): State<App>, headers: HeaderMap) -> Result<Response> {
    let (account, hash, proof) = read_access(&app, &headers, Scope::All).await?;
    let snapshot = sync::snapshot(&app, &account).await?;
    let rooms = snapshot
        .rooms
        .iter()
        .map(|r| r.id.clone())
        .collect::<Vec<_>>();
    proof.json(&app, &hash, &snapshot, &rooms, None).await
}
async fn begin_snapshot(State(app): State<App>, headers: HeaderMap) -> Result<Response> {
    let (account, hash, proof) = read_access(&app, &headers, Scope::All).await?;
    let page = snapshots::begin(&app, &account).await?;
    proof
        .json(&app, &hash, &page, &[], Some(&page.snapshot_id))
        .await
}
async fn snapshot_page(
    State(app): State<App>,
    headers: HeaderMap,
    Path(token): Path<String>,
) -> Result<Response> {
    let (account, hash, proof) = read_access(&app, &headers, Scope::All).await?;
    let page = snapshots::page(&app, &account, &token).await?;
    proof
        .json(&app, &hash, &page, &[], Some(&page.snapshot_id))
        .await
}
#[derive(Deserialize)]
struct Changes {
    cursor: String,
}
async fn changes(
    State(app): State<App>,
    headers: HeaderMap,
    Query(input): Query<Changes>,
) -> Result<Response> {
    let (account, hash, proof) = read_access(&app, &headers, Scope::All).await?;
    let batch = sync::changes(&app, &account, &input.cursor, 100).await?;
    proof
        .json(&app, &hash, &batch, &batch_rooms(&batch), None)
        .await
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
                let proof = match ReadProof::capture(&app,&account,Scope::All).await { Ok(p) => p, Err(_) => break };
                let batch = match sync::changes(&app, &account, &cursor, 100).await { Ok(b) => b, Err(_) => break };
                // Send empty batches too when their cursor advanced over private events.
                // An idle batch is also a heartbeat. Clients can detect a half-open
                // socket without advancing their durable cursor or sending a token.
                if batch.cursor == cursor && last_sent.elapsed() < Duration::from_secs(15) { continue; }
                let Ok(text) = serde_json::to_string(&batch) else { break };
                let _lease = match proof.lock(&app,&session_hash,&batch_rooms(&batch),None).await {
                    Ok(lease) => lease,
                    Err(error) if error.code=="delivery_revalidate" => continue,
                    Err(_) => break,
                };
                if !matches!(tokio::time::timeout(Duration::from_secs(5), ws.send(WsMessage::Text(text.into()))).await, Ok(Ok(()))) { break; }
                cursor = batch.cursor.clone();
                last_sent = tokio::time::Instant::now();
            }
        }
    }
    let _ = tokio::time::timeout(Duration::from_secs(5), ws.close()).await;
}
