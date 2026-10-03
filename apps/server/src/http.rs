use axum::{
    Extension, Json, Router,
    extract::{
        ConnectInfo, DefaultBodyLimit, Path, Query, State, WebSocketUpgrade,
        ws::{Message as WsMessage, WebSocket},
    },
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post, put},
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
    limits, marks, message_actions, permissions, reactions, room_details, room_reads, sessions,
    snapshots, store, sync,
};

pub fn router(app: App) -> Router {
    Router::new()
        .route("/api/v1/rooms/{room}/meetings", post(start_meeting))
        .route("/api/v1/meetings/{id}", get(meeting_info))
        .route("/api/v1/meetings/{id}/join", post(join_meeting))
        .route("/api/v1/meetings/{id}/end", post(end_meeting))
        .route(
            "/api/v1/me/push",
            put(register_push).delete(unregister_push),
        )
        .route("/api/v1/push/notifications/{id}", get(push_content))
        .route("/api/v1/emoji", get(emoji_catalog))
        .route("/api/v1/emoji/files/{id}", get(emoji_image))
        .route(
            "/api/v1/messages/{message}/previews/{id}",
            get(preview_image),
        )
        .route("/api/v1/uploads", post(prepare_upload))
        .route(
            "/api/v1/uploads/{id}",
            get(upload_status).delete(cancel_upload),
        )
        .route(
            "/api/v1/uploads/{id}/bytes",
            put(upload_bytes).layer(DefaultBodyLimit::max(crate::files::MAX_BYTES as usize)),
        )
        .route("/api/v1/uploads/{id}/complete", post(complete_upload))
        .route("/api/v1/files/{id}", get(file_download))
        .route("/.well-known/rocketvibe", get(discovery))
        .route("/api/v1/me/presence", put(set_presence))
        .route("/api/v1/rooms/{room}/typing", put(set_typing))
        .route("/api/v1/live", get(live_state))
        .route("/health/live", get(|| async { StatusCode::NO_CONTENT }))
        .route("/health/ready", get(ready))
        .route("/api/v1/auth/login", post(login))
        .route("/api/v1/auth/start", post(start_login))
        .route("/api/v1/auth/factors/verify", post(finish_factor))
        .route("/api/v1/auth/factors/email/start", post(begin_login_email))
        .route(
            "/api/v1/auth/factors/email/resume",
            post(resume_login_email),
        )
        .route("/api/v1/me/factors", get(factor_status))
        .route("/api/v1/me/email", get(email_status))
        .route("/api/v1/me/email/verification/start", post(begin_email))
        .route("/api/v1/me/email/verification/resume", post(resume_email))
        .route("/api/v1/me/email/verification/confirm", post(confirm_email))
        .route("/api/v1/me/email/verification/retire", post(retire_email))
        .route("/api/v1/me/email/removal/start", post(remove_email))
        .route(
            "/api/v1/me/email/removal/resume",
            post(resume_email_removal),
        )
        .route("/api/v1/me/reauth/start", post(begin_reauthentication))
        .route(
            "/api/v1/me/email/removal/retire",
            post(retire_email_removal),
        )
        .route("/api/v1/me/reauth", get(reauthentication_status))
        .route("/api/v1/me/reauth/finish", post(finish_reauthentication))
        .route("/api/v1/me/reauth/email/start", post(begin_proof_email))
        .route("/api/v1/me/reauth/email/resume", post(resume_proof_email))
        .route("/api/v1/me/reauth/resume", post(resume_reauthentication))
        .route("/api/v1/me/reauth/retire", post(retire_reauthentication))
        .route("/api/v1/me/factors/totp/setup", post(begin_factor))
        .route("/api/v1/me/factors/totp/enable", post(enable_factor))
        .route("/api/v1/me/factors/totp/disable", post(disable_factor))
        .route("/api/v1/me/factors/email/enable", post(enable_email_factor))
        .route(
            "/api/v1/me/factors/email/disable",
            post(disable_email_factor),
        )
        .route(
            "/api/v1/me/factors/recovery/regenerate",
            post(regenerate_backups),
        )
        .route("/api/v1/auth/invitations/accept", post(accept_invitation))
        .route("/api/v1/auth/recovery", post(recover_account))
        .route(
            "/api/v1/auth/recovery/email/start",
            post(request_email_recovery),
        )
        .route("/api/v1/auth/logout", post(logout))
        .route("/api/v1/auth/renew", post(renew_session))
        .route("/api/v1/me/sessions", get(device_sessions))
        .route("/api/v1/e2ee/devices", post(register_crypto_device))
        .route(
            "/api/v1/e2ee/rooms/{room}/transitions",
            post(submit_crypto_group).layer(DefaultBodyLimit::max(4 * 1024 * 1024)),
        )
        .route("/api/v1/e2ee/rooms/{room}/state", get(crypto_group_state))
        .route("/api/v1/e2ee/rooms/{room}/events", get(crypto_group_events))
        .route(
            "/api/v1/e2ee/rooms/{room}/operations/{operation}",
            get(crypto_group_operation),
        )
        .route(
            "/api/v1/e2ee/rooms/{room}/key-packages/{user}/{device}",
            get(crypto_available_package),
        )
        .route(
            "/api/v1/e2ee/key-packages",
            post(publish_crypto_packages).layer(DefaultBodyLimit::max(256 * 1024)),
        )
        .route("/api/v1/e2ee/users/{user}", get(crypto_directory))
        .route("/api/v1/e2ee/operations/{operation}", get(crypto_operation))
        .route(
            "/api/v1/me/sessions/{device}",
            axum::routing::patch(rename_device).delete(revoke_device),
        )
        .route("/api/v1/me", get(me).patch(update_profile))
        .route("/api/v1/me/profile", get(own_profile))
        .route(
            "/api/v1/me/preferences",
            axum::routing::patch(update_preferences),
        )
        .route(
            "/api/v1/me/avatar",
            put(update_avatar)
                .delete(reset_avatar)
                .layer(DefaultBodyLimit::max(crate::profiles::AVATAR_BYTES)),
        )
        .route("/api/v1/avatars/{id}", get(avatar))
        .route("/api/v1/me/permissions", get(account_permissions))
        .route("/api/v1/users", get(users))
        .route("/api/v1/users/lookup", get(lookup_profile))
        .route("/api/v1/users/{id}", get(user_profile))
        .route("/api/v1/rooms", get(rooms).post(create_room))
        .route("/api/v1/rooms/public", get(public_rooms))
        .route("/api/v1/rooms/discover", get(public_rooms))
        .route("/api/v1/rooms/{room}", get(room_details).patch(update_room))
        .route("/api/v1/rooms/{room}/members", get(room_members))
        .route(
            "/api/v1/rooms/{room}/members/{user}/role",
            axum::routing::put(change_room_role),
        )
        .route("/api/v1/rooms/{room}/leave", post(leave_room))
        .route(
            "/api/v1/rooms/{room}/read",
            get(room_read_state).post(mark_room_read),
        )
        .route(
            "/api/v1/rooms/{room}/favorite",
            axum::routing::put(room_favorite),
        )
        .route(
            "/api/v1/rooms/{room}/commands/{operation}",
            get(room_command_receipt),
        )
        .route("/api/v1/rooms/{room}/permissions", get(room_permissions))
        .route(
            "/api/v1/messages/{message}/permissions",
            get(message_permissions),
        )
        .route(
            "/api/v1/messages/{message}",
            get(message).patch(edit_message).delete(delete_message),
        )
        .route("/api/v1/messages/{message}/thread", get(thread))
        .route(
            "/api/v1/messages/{message}/replies",
            get(thread).post(reply),
        )
        .route(
            "/api/v1/messages/{message}/thread/read",
            post(mark_thread_read),
        )
        .route(
            "/api/v1/messages/{message}/reactions",
            axum::routing::put(set_reaction),
        )
        .route(
            "/api/v1/messages/{message}/pin",
            axum::routing::put(set_pin),
        )
        .route(
            "/api/v1/messages/{message}/star",
            axum::routing::put(set_star),
        )
        .route("/api/v1/rooms/{room}/pins", get(pins))
        .route("/api/v1/rooms/{room}/stars", get(stars))
        .route("/api/v1/rooms/{room}/join", post(join_public))
        .route("/api/v1/direct-messages", post(direct))
        .route(
            "/api/v1/rooms/{room}/members/{user}",
            post(add_member).delete(remove_member),
        )
        .route("/api/v1/rooms/{room}/messages", get(history).post(send))
        .route("/api/v1/rooms/{room}/messages/search", get(search_messages))
        .route("/api/v1/sync/snapshot", get(snapshot))
        .route("/api/v1/sync/snapshots", post(begin_snapshot))
        .route("/api/v1/sync/snapshots/{token}", get(snapshot_page))
        .route("/api/v1/sync/changes", get(changes))
        .route("/api/v1/sync/ticket", post(ticket))
        .route("/api/v1/sync/socket", get(socket))
        .fallback(|| async { Error::missing() })
        .layer(axum::middleware::from_fn(private_metadata_no_store))
        .layer(DefaultBodyLimit::max(64 * 1024))
        .with_state(app)
}

async fn private_metadata_no_store(
    request: axum::extract::Request,
    next: axum::middleware::Next,
) -> Response {
    let private = matches!(
        request.uri().path(),
        "/api/v1/auth/factors/email/start"
            | "/api/v1/auth/factors/email/resume"
            | "/api/v1/me/reauth/email/start"
            | "/api/v1/me/reauth/email/resume"
            | "/api/v1/me/factors/email/enable"
            | "/api/v1/me/factors/email/disable"
    ) || request.uri().path().starts_with("/api/v1/e2ee/");
    let mut response = next.run(request).await;
    // Rejections, including malformed input, have the same cache policy as
    // successful private receipts and delivery status.
    if private {
        response.headers_mut().insert(
            axum::http::header::CACHE_CONTROL,
            axum::http::HeaderValue::from_static("no-store"),
        );
    }
    response
}

type Input<T> = std::result::Result<Json<T>, axum::extract::rejection::JsonRejection>;
fn body<T>(input: Input<T>) -> Result<T> {
    input.map(|Json(v)| v).map_err(|_| Error::invalid())
}

fn crypto_body<T>(input: Input<T>) -> Result<T> {
    input.map(|Json(v)| v).map_err(|error| {
        if error.status() == StatusCode::PAYLOAD_TOO_LARGE {
            Error::new(StatusCode::PAYLOAD_TOO_LARGE, "crypto_body_too_large")
        } else {
            Error::invalid()
        }
    })
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
        .flat_map(|change| match change {
            rv_protocol::Change::RoomUpsert(room) => vec![room.id.clone()],
            rv_protocol::Change::MessageUpsert(message) => {
                crate::quotes::delivery_rooms(std::slice::from_ref(message))
            }
            rv_protocol::Change::RoomRemoved { .. } => Vec::new(),
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
            room_info: true,
            room_settings: true,
            room_roles: true,
            room_leave: true,
            read_markers: true,
            favorites: true,
            fine_permissions: true,
            editing: true,
            deletion: true,
            reactions: true,
            pins: true,
            stars: true,
            quotes: true,
            threads: true,
            presence: true,
            typing: true,
            search: true,
            profiles: true,
            profile_avatars: app.objects.is_some(),
            uploads: app.objects.is_some(),
            custom_emojis: app.objects.is_some(),
            link_previews: app.objects.is_some(),
            structured_cards: true,
            push: app.push.is_some(),
            calls: app.jitsi.is_some(),
            session_rotation: true,
            device_sessions: true,
            account_invitations: true,
            account_recovery: true,
            second_factors: app.auth_key.is_some(),
            reauthentication: true,
            reauthentication_retirement: true,
            email_verification: app.mail.is_some() && app.auth_key.is_some(),
            email_removal: true,
            email_factors: app.auth_key.is_some(),
            email_factor_delivery: app.mail.is_some() && app.auth_key.is_some(),
            email_recovery: app.mail.is_some() && app.auth_key.is_some(),
            ..Default::default()
        },
    }))
}

async fn start_meeting(
    State(app): State<App>,
    headers: HeaderMap,
    Path(room): Path<String>,
    input: Input<rv_protocol::meetings::StartMeeting>,
) -> Result<Response> {
    let (actor, hash, proof) = read_access(&app, &headers, Scope::Room(&room)).await?;
    let value = crate::meetings::start(&app, &actor, &room, body(input)?).await?;
    proof.meeting_json(&app, &hash, &value, None, &value).await
}
async fn meeting_info(
    State(app): State<App>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Response> {
    let (actor, hash, proof) = read_access(&app, &headers, Scope::All).await?;
    let value = crate::meetings::info(&app, &actor, &id).await?;
    proof.meeting_json(&app, &hash, &value, None, &value).await
}
async fn join_meeting(
    State(app): State<App>,
    headers: HeaderMap,
    Path(id): Path<String>,
    input: Input<rv_protocol::meetings::JoinMeeting>,
) -> Result<Response> {
    let (actor, hash, proof) = read_access(&app, &headers, Scope::All).await?;
    let value = crate::meetings::join(&app, &actor, &id, body(input)?).await?;
    proof
        .meeting_json(&app, &hash, &value.meeting, Some(&value.expires_at), &value)
        .await
}
async fn end_meeting(
    State(app): State<App>,
    headers: HeaderMap,
    Path(id): Path<String>,
    input: Input<rv_protocol::meetings::JoinMeeting>,
) -> Result<Response> {
    let (actor, hash, proof) = read_access(&app, &headers, Scope::All).await?;
    let value = crate::meetings::end(&app, &actor, &id, body(input)?).await?;
    proof.meeting_json(&app, &hash, &value, None, &value).await
}

async fn register_push(
    State(app): State<App>,
    headers: HeaderMap,
    input: Input<rv_protocol::push::RegisterPush>,
) -> Result<Response> {
    let actor = account(&app, &headers).await?;
    let hash = auth::bearer(&headers)?;
    Ok(secret_session(
        crate::push::register(&app, &actor, &hash, body(input)?).await?,
    ))
}
async fn unregister_push(State(app): State<App>, headers: HeaderMap) -> Result<StatusCode> {
    let actor = account(&app, &headers).await?;
    crate::push::unregister(&app, &actor, &auth::bearer(&headers)?).await?;
    Ok(StatusCode::NO_CONTENT)
}
async fn push_content(
    State(app): State<App>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Response> {
    let (actor, hash, proof) = read_access(&app, &headers, Scope::All).await?;
    let value = crate::push::content(&app, &actor, &hash, &id).await?;
    proof.push_json(&app, &hash, &value).await
}

async fn login(
    State(app): State<App>,
    peer: Option<Extension<ConnectInfo<SocketAddr>>>,
    input: Input<Login>,
) -> Result<Response> {
    let login = body(input)?;
    Ok(secret_session(
        auth::login_from(
            &app,
            login.username,
            login.password,
            peer.map(|p| p.0.0.ip()),
        )
        .await?,
    ))
}

async fn start_login(
    State(app): State<App>,
    peer: Option<Extension<ConnectInfo<SocketAddr>>>,
    input: Input<Login>,
) -> Result<Response> {
    let login = body(input)?;
    Ok(secret_session(
        auth::start_login(
            &app,
            login.username,
            login.password,
            peer.map(|p| p.0.0.ip()),
        )
        .await?,
    ))
}

async fn finish_factor(
    State(app): State<App>,
    peer: Option<Extension<ConnectInfo<SocketAddr>>>,
    input: Input<rv_protocol::parity::FinishFactor>,
) -> Result<Response> {
    Ok(secret_session(
        crate::factors::finish(&app, body(input)?, peer.map(|p| p.0.0.ip())).await?,
    ))
}

async fn factor_status(State(app): State<App>, headers: HeaderMap) -> Result<Response> {
    let user = account(&app, &headers).await?;
    Ok(secret_session(crate::factors::status(&app, &user).await?))
}

async fn enable_email_factor(
    State(app): State<App>,
    headers: HeaderMap,
    input: Input<rv_protocol::parity::ChangeEmailFactor>,
) -> Result<Response> {
    let user = account(&app, &headers).await?;
    Ok(secret_session(
        crate::factors::email_settings::change(&app, &user, body(input)?, true).await?,
    ))
}
async fn disable_email_factor(
    State(app): State<App>,
    headers: HeaderMap,
    input: Input<rv_protocol::parity::ChangeEmailFactor>,
) -> Result<Response> {
    let user = account(&app, &headers).await?;
    Ok(secret_session(
        crate::factors::email_settings::change(&app, &user, body(input)?, false).await?,
    ))
}
async fn begin_login_email(
    State(app): State<App>,
    peer: Option<Extension<ConnectInfo<SocketAddr>>>,
    input: Input<rv_protocol::parity::RequestFactorEmail>,
) -> Result<Response> {
    Ok(secret_session(
        crate::factors::email_delivery::begin(
            &app,
            body(input)?,
            None,
            crate::factors::email_delivery::Kind::Login,
            peer.map(|p| p.0.0.ip()),
        )
        .await?,
    ))
}
async fn resume_login_email(
    State(app): State<App>,
    input: Input<rv_protocol::parity::RequestFactorEmail>,
) -> Result<Response> {
    Ok(secret_session(
        crate::factors::email_delivery::resume(
            &app,
            body(input)?,
            None,
            crate::factors::email_delivery::Kind::Login,
        )
        .await?,
    ))
}
async fn begin_proof_email(
    State(app): State<App>,
    headers: HeaderMap,
    peer: Option<Extension<ConnectInfo<SocketAddr>>>,
    input: Input<rv_protocol::parity::RequestFactorEmail>,
) -> Result<Response> {
    let user = account(&app, &headers).await?;
    Ok(secret_session(
        crate::factors::email_delivery::begin(
            &app,
            body(input)?,
            Some(&user),
            crate::factors::email_delivery::Kind::Reauthentication,
            peer.map(|p| p.0.0.ip()),
        )
        .await?,
    ))
}
async fn resume_proof_email(
    State(app): State<App>,
    headers: HeaderMap,
    input: Input<rv_protocol::parity::RequestFactorEmail>,
) -> Result<Response> {
    let user = account(&app, &headers).await?;
    Ok(secret_session(
        crate::factors::email_delivery::resume(
            &app,
            body(input)?,
            Some(&user),
            crate::factors::email_delivery::Kind::Reauthentication,
        )
        .await?,
    ))
}
async fn email_status(State(app): State<App>, headers: HeaderMap) -> Result<Response> {
    let (user, hash, proof) = read_access(&app, &headers, Scope::None).await?;
    let value = crate::email::status(&app, &user).await?;
    let mut response = proof.json(&app, &hash, &value, &[], None).await?;
    response.headers_mut().insert(
        axum::http::header::CACHE_CONTROL,
        axum::http::HeaderValue::from_static("no-store"),
    );
    Ok(response)
}
async fn begin_email(
    State(app): State<App>,
    headers: HeaderMap,
    peer: Option<Extension<ConnectInfo<SocketAddr>>>,
    input: Input<rv_protocol::parity::BeginEmailVerification>,
) -> Result<Response> {
    let user = account(&app, &headers).await?;
    Ok(secret_session(
        crate::email::begin(&app, &user, body(input)?, peer.map(|p| p.0.0.ip())).await?,
    ))
}
async fn resume_email(
    State(app): State<App>,
    headers: HeaderMap,
    input: Input<rv_protocol::parity::ResumeEmailVerification>,
) -> Result<Response> {
    let user = account(&app, &headers).await?;
    Ok(secret_session(
        crate::email::resume(&app, &user, body(input)?).await?,
    ))
}
async fn confirm_email(
    State(app): State<App>,
    headers: HeaderMap,
    input: Input<rv_protocol::parity::ConfirmEmailVerification>,
) -> Result<Response> {
    let user = account(&app, &headers).await?;
    Ok(secret_session(
        crate::email::confirm(&app, &user, body(input)?).await?,
    ))
}
async fn retire_email(
    State(app): State<App>,
    headers: HeaderMap,
    input: Input<rv_protocol::parity::RetireEmailVerification>,
) -> Result<Response> {
    let user = account(&app, &headers).await?;
    Ok(secret_session(
        crate::email::retire(&app, &user, body(input)?).await?,
    ))
}

async fn remove_email(
    State(app): State<App>,
    headers: HeaderMap,
    input: Input<rv_protocol::parity::RemoveVerifiedEmail>,
) -> Result<Response> {
    let user = account(&app, &headers).await?;
    Ok(secret_session(
        crate::email::removal::begin(&app, &user, body(input)?).await?,
    ))
}
async fn resume_email_removal(
    State(app): State<App>,
    headers: HeaderMap,
    input: Input<rv_protocol::parity::ResumeEmailRemoval>,
) -> Result<Response> {
    let user = account(&app, &headers).await?;
    Ok(secret_session(
        crate::email::removal::resume(&app, &user, body(input)?).await?,
    ))
}

async fn retire_email_removal(
    State(app): State<App>,
    headers: HeaderMap,
    input: Input<rv_protocol::parity::RetireEmailRemoval>,
) -> Result<Response> {
    let (user, hash, proof) = read_access(&app, &headers, Scope::None).await?;
    let value = crate::email::removal::retire(&app, &user, body(input)?).await?;
    let mut response = proof.json(&app, &hash, &value, &[], None).await?;
    response.headers_mut().insert(
        axum::http::header::CACHE_CONTROL,
        axum::http::HeaderValue::from_static("no-store"),
    );
    Ok(response)
}

async fn begin_factor(
    State(app): State<App>,
    headers: HeaderMap,
    input: Input<rv_protocol::parity::BeginFactorSetup>,
) -> Result<Response> {
    let user = account(&app, &headers).await?;
    Ok(secret_session(
        crate::factors::begin(&app, &user, body(input)?).await?,
    ))
}

async fn enable_factor(
    State(app): State<App>,
    headers: HeaderMap,
    input: Input<rv_protocol::parity::EnableFactor>,
) -> Result<Response> {
    let user = account(&app, &headers).await?;
    Ok(secret_session(
        crate::factors::enable(&app, &user, body(input)?).await?,
    ))
}

async fn disable_factor(
    State(app): State<App>,
    headers: HeaderMap,
    input: Input<rv_protocol::parity::DisableFactor>,
) -> Result<StatusCode> {
    let user = account(&app, &headers).await?;
    crate::factors::disable(&app, &user, body(input)?).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn regenerate_backups(
    State(app): State<App>,
    headers: HeaderMap,
    input: Input<rv_protocol::parity::RegenerateFactorBackups>,
) -> Result<Response> {
    let user = account(&app, &headers).await?;
    Ok(secret_session(
        crate::factors::regenerate_backups(&app, &user, body(input)?).await?,
    ))
}

async fn begin_reauthentication(
    State(app): State<App>,
    headers: HeaderMap,
    peer: Option<Extension<ConnectInfo<SocketAddr>>>,
    input: Input<rv_protocol::parity::BeginReauthentication>,
) -> Result<Response> {
    let user = account(&app, &headers).await?;
    Ok(secret_session(
        crate::reauthentication::begin(&app, &user, body(input)?, peer.map(|p| p.0.0.ip())).await?,
    ))
}

async fn finish_reauthentication(
    State(app): State<App>,
    headers: HeaderMap,
    peer: Option<Extension<ConnectInfo<SocketAddr>>>,
    input: Input<rv_protocol::parity::FinishReauthentication>,
) -> Result<Response> {
    let user = account(&app, &headers).await?;
    Ok(secret_session(
        crate::reauthentication::finish(&app, &user, body(input)?, peer.map(|p| p.0.0.ip()))
            .await?,
    ))
}

async fn resume_reauthentication(
    State(app): State<App>,
    headers: HeaderMap,
    input: Input<rv_protocol::parity::ResumeReauthentication>,
) -> Result<Response> {
    let user = account(&app, &headers).await?;
    Ok(secret_session(
        crate::reauthentication::resume(&app, &user, body(input)?).await?,
    ))
}

async fn reauthentication_status(State(app): State<App>, headers: HeaderMap) -> Result<Response> {
    let user = account(&app, &headers).await?;
    Ok(secret_session(
        crate::reauthentication::status(&app, &user).await?,
    ))
}

async fn retire_reauthentication(
    State(app): State<App>,
    headers: HeaderMap,
    input: Input<rv_protocol::parity::RetireReauthentication>,
) -> Result<Response> {
    let user = account(&app, &headers).await?;
    Ok(secret_session(
        crate::reauthentication::retire(&app, &user, body(input)?).await?,
    ))
}

async fn accept_invitation(
    State(app): State<App>,
    peer: Option<Extension<ConnectInfo<SocketAddr>>>,
    input: Input<rv_protocol::parity::AcceptInvitation>,
) -> Result<Response> {
    let user = crate::invitations::accept(&app, body(input)?, peer.map(|p| p.0.0.ip())).await?;
    Ok(secret_session(user))
}

async fn recover_account(
    State(app): State<App>,
    peer: Option<Extension<ConnectInfo<SocketAddr>>>,
    input: Input<rv_protocol::parity::RecoverAccount>,
) -> Result<Response> {
    let user = crate::recovery::accept(&app, body(input)?, peer.map(|p| p.0.0.ip())).await?;
    Ok(secret_session(user))
}

async fn request_email_recovery(
    State(app): State<App>,
    peer: Option<Extension<ConnectInfo<SocketAddr>>>,
    input: Input<rv_protocol::parity::RequestEmailRecovery>,
) -> Result<Response> {
    let requested =
        crate::email_recovery::request(&app, body(input)?, peer.map(|p| p.0.0.ip())).await?;
    let mut response = secret_session(requested);
    *response.status_mut() = StatusCode::ACCEPTED;
    Ok(response)
}

fn secret_session(session: impl serde::Serialize) -> Response {
    let mut response = Json(session).into_response();
    response.headers_mut().insert(
        axum::http::header::CACHE_CONTROL,
        axum::http::HeaderValue::from_static("no-store"),
    );
    response
}

async fn logout(State(app): State<App>, headers: HeaderMap) -> Result<StatusCode> {
    let hash = auth::bearer(&headers)?;
    let account = auth::authenticate(&app, &hash).await?;
    sessions::revoke(&app, &account, None).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn renew_session(
    State(app): State<App>,
    headers: HeaderMap,
    input: Input<rv_protocol::parity::RenewSession>,
) -> Result<Response> {
    let hash = auth::bearer(&headers)?;
    Ok(secret_session(
        sessions::renew(&app, &hash, body(input)?).await?,
    ))
}
async fn device_sessions(State(app): State<App>, headers: HeaderMap) -> Result<Response> {
    let (account, hash, proof) = read_access(&app, &headers, Scope::None).await?;
    let devices = sessions::list(&app, &account).await?;
    proof.json(&app, &hash, &devices, &[], None).await
}
async fn submit_crypto_group(
    State(app): State<App>,
    headers: HeaderMap,
    Path(room): Path<String>,
    input: Input<rv_protocol::e2ee::GroupSubmission>,
) -> Result<Response> {
    let actor = account(&app, &headers).await?;
    Ok(secret_session(
        crate::e2ee::groups::submit(&app, &actor, &room, crypto_body(input)?).await?,
    ))
}
async fn crypto_group_state(
    State(app): State<App>,
    headers: HeaderMap,
    Path(room): Path<String>,
) -> Result<Response> {
    let actor = account(&app, &headers).await?;
    crate::e2ee::groups::state(&app, &actor, &room).await
}
async fn crypto_group_events(
    State(app): State<App>,
    headers: HeaderMap,
    Path(room): Path<String>,
    Query(query): Query<CryptoDirectoryQuery>,
) -> Result<Response> {
    let actor = account(&app, &headers).await?;
    crate::e2ee::groups::events(&app, &actor, &room, query.after.as_deref()).await
}
async fn crypto_group_operation(
    State(app): State<App>,
    headers: HeaderMap,
    Path((room, operation)): Path<(String, String)>,
) -> Result<Response> {
    let actor = account(&app, &headers).await?;
    crate::e2ee::groups::operation(&app, &actor, &room, &operation).await
}
async fn crypto_available_package(
    State(app): State<App>,
    headers: HeaderMap,
    Path((room, user, device)): Path<(String, String, String)>,
) -> Result<Response> {
    let actor = account(&app, &headers).await?;
    crate::e2ee::groups::available(&app, &actor, &room, &user, &device).await
}
async fn register_crypto_device(
    State(app): State<App>,
    headers: HeaderMap,
    input: Input<rv_protocol::e2ee::RegisterDevice>,
) -> Result<Response> {
    let actor = account(&app, &headers).await?;
    Ok(secret_session(
        crate::e2ee::register(&app, &actor, crypto_body(input)?).await?,
    ))
}
async fn publish_crypto_packages(
    State(app): State<App>,
    headers: HeaderMap,
    input: Input<rv_protocol::e2ee::PublishKeyPackages>,
) -> Result<Response> {
    let actor = account(&app, &headers).await?;
    Ok(secret_session(
        crate::e2ee::publish(&app, &actor, crypto_body(input)?).await?,
    ))
}
#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct CryptoDirectoryQuery {
    after: Option<String>,
}
async fn crypto_directory(
    State(app): State<App>,
    headers: HeaderMap,
    Path(user): Path<String>,
    Query(query): Query<CryptoDirectoryQuery>,
) -> Result<Response> {
    let (_actor, hash, proof) = read_access(&app, &headers, Scope::None).await?;
    let directory = crate::e2ee::directory(&app, &user, query.after.as_deref()).await?;
    proof.json(&app, &hash, &directory, &[], None).await
}
async fn crypto_operation(
    State(app): State<App>,
    headers: HeaderMap,
    Path(operation): Path<String>,
) -> Result<Response> {
    let (actor, hash, proof) = read_access(&app, &headers, Scope::None).await?;
    let receipt = crate::e2ee::operation(&app, &actor, &operation).await?;
    proof.json(&app, &hash, &receipt, &[], None).await
}
async fn rename_device(
    State(app): State<App>,
    headers: HeaderMap,
    Path(device): Path<String>,
    input: Input<rv_protocol::parity::RenameDevice>,
) -> Result<StatusCode> {
    let hash = auth::bearer(&headers)?;
    let account = auth::authenticate(&app, &hash).await?;
    sessions::rename(&app, &account, &device, body(input)?).await?;
    Ok(StatusCode::NO_CONTENT)
}
async fn revoke_device(
    State(app): State<App>,
    headers: HeaderMap,
    Path(device): Path<String>,
) -> Result<StatusCode> {
    let hash = auth::bearer(&headers)?;
    let account = auth::authenticate(&app, &hash).await?;
    sessions::revoke(&app, &account, Some(&device)).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn me(State(app): State<App>, headers: HeaderMap) -> Result<Response> {
    let (account, hash, proof) = read_access(&app, &headers, Scope::None).await?;
    proof.json(&app, &hash, &account.user(), &[], None).await
}

async fn own_profile(State(app): State<App>, headers: HeaderMap) -> Result<Response> {
    let (account, hash, proof) = read_access(&app, &headers, Scope::None).await?;
    let value = crate::profiles::own(&app, &account).await?;
    crate::profiles::response(
        &app,
        &hash,
        &proof,
        &value.profile,
        &value,
        Some(&value.preferences.revision),
    )
    .await
}
async fn user_profile(
    State(app): State<App>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Response> {
    let (_, hash, proof) = read_access(&app, &headers, Scope::None).await?;
    let profile = crate::profiles::public(&app, &id).await?;
    crate::profiles::response(&app, &hash, &proof, &profile, &profile, None).await
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ProfileQuery {
    username: String,
}
async fn lookup_profile(
    State(app): State<App>,
    headers: HeaderMap,
    Query(input): Query<ProfileQuery>,
) -> Result<Response> {
    let (_, hash, proof) = read_access(&app, &headers, Scope::None).await?;
    let profile = crate::profiles::lookup(&app, &input.username).await?;
    crate::profiles::response(&app, &hash, &proof, &profile, &profile, None).await
}
async fn update_profile(
    State(app): State<App>,
    headers: HeaderMap,
    input: Input<rv_protocol::profiles::UpdateProfile>,
) -> Result<Response> {
    let hash = auth::bearer(&headers)?;
    let account = auth::authenticate(&app, &hash).await?;
    Ok(secret_session(
        crate::profiles::update(&app, &account, body(input)?).await?,
    ))
}
async fn update_preferences(
    State(app): State<App>,
    headers: HeaderMap,
    input: Input<rv_protocol::profiles::UpdatePreferences>,
) -> Result<Response> {
    let hash = auth::bearer(&headers)?;
    let account = auth::authenticate(&app, &hash).await?;
    Ok(secret_session(
        crate::profiles::preferences(&app, &account, body(input)?).await?,
    ))
}
async fn update_avatar(
    State(app): State<App>,
    headers: HeaderMap,
    Query(input): Query<rv_protocol::profiles::AvatarCommand>,
    bytes: std::result::Result<axum::body::Bytes, axum::extract::rejection::BytesRejection>,
) -> Result<Response> {
    let hash = auth::bearer(&headers)?;
    let account = auth::authenticate(&app, &hash).await?;
    let mime = headers
        .get(axum::http::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .ok_or_else(Error::invalid)?
        .to_string();
    let bytes = bytes.map_err(|_| Error::new(StatusCode::PAYLOAD_TOO_LARGE, "avatar_too_large"))?;
    Ok(secret_session(
        crate::profiles::avatar(&app, &account, input, Some((mime, bytes))).await?,
    ))
}
async fn reset_avatar(
    State(app): State<App>,
    headers: HeaderMap,
    Query(input): Query<rv_protocol::profiles::AvatarCommand>,
) -> Result<Response> {
    let hash = auth::bearer(&headers)?;
    let account = auth::authenticate(&app, &hash).await?;
    Ok(secret_session(
        crate::profiles::avatar(&app, &account, input, None).await?,
    ))
}
async fn avatar(
    State(app): State<App>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Response> {
    let (_, hash, proof) = read_access(&app, &headers, Scope::None).await?;
    crate::profiles::avatar_response(&app, &hash, &proof, &id).await
}

async fn emoji_catalog(State(app): State<App>, headers: HeaderMap) -> Result<Response> {
    let (_, hash, proof) = read_access(&app, &headers, Scope::None).await?;
    crate::custom_emojis::catalog_response(&app, &hash, &proof).await
}
async fn preview_image(
    State(app): State<App>,
    headers: HeaderMap,
    Path((message, id)): Path<(String, String)>,
) -> Result<Response> {
    let (actor, hash, _) = read_access(&app, &headers, Scope::None).await?;
    crate::link_previews::image_response(&app, &actor, &hash, &message, &id).await
}
async fn emoji_image(
    State(app): State<App>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Response> {
    let (_, hash, proof) = read_access(&app, &headers, Scope::None).await?;
    crate::custom_emojis::image_response(&app, &hash, &proof, &id).await
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
            &crate::quotes::delivery_rooms(std::slice::from_ref(&message)),
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

async fn set_pin(
    State(app): State<App>,
    headers: HeaderMap,
    Path(id): Path<String>,
    input: Input<rv_protocol::parity::SetMark>,
) -> Result<Response> {
    let actor = account(&app, &headers).await?;
    marks::apply(&app, &actor, &id, body(input)?, false).await?;
    message(State(app), headers, Path(id)).await
}
async fn set_star(
    State(app): State<App>,
    headers: HeaderMap,
    Path(id): Path<String>,
    input: Input<rv_protocol::parity::SetMark>,
) -> Result<Response> {
    let actor = account(&app, &headers).await?;
    marks::apply(&app, &actor, &id, body(input)?, true).await?;
    message(State(app), headers, Path(id)).await
}
async fn pins(
    State(app): State<App>,
    headers: HeaderMap,
    Path(room): Path<String>,
    Query(input): Query<History>,
) -> Result<Response> {
    marked(app, headers, room, input, false).await
}
async fn stars(
    State(app): State<App>,
    headers: HeaderMap,
    Path(room): Path<String>,
    Query(input): Query<History>,
) -> Result<Response> {
    marked(app, headers, room, input, true).await
}
async fn marked(
    app: App,
    headers: HeaderMap,
    room: String,
    input: History,
    starred: bool,
) -> Result<Response> {
    let before = input
        .before
        .map(|s| s.parse::<i64>().map_err(|_| Error::invalid()))
        .transpose()?;
    let limit = input.limit.unwrap_or(50);
    if !(1..=100).contains(&limit) {
        return Err(Error::invalid());
    }
    let (actor, hash, proof) = read_access(&app, &headers, Scope::All).await?;
    let messages = marks::list(&app, &actor, &room, before, limit, starred).await?;
    let mut delivery_rooms = crate::quotes::delivery_rooms(&messages.messages);
    delivery_rooms.push(room);
    proof
        .json(&app, &hash, &messages, &delivery_rooms, None)
        .await
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

async fn room_details(
    State(app): State<App>,
    headers: HeaderMap,
    Path(room): Path<String>,
) -> Result<Response> {
    let (actor, hash, proof) = read_access(&app, &headers, Scope::Room(&room)).await?;
    let details = room_details::read(&app, &actor, &room).await?;
    proof
        .versioned_room_json(&app, &hash, &room, &details.revision, &details)
        .await
}
async fn room_read_state(
    State(app): State<App>,
    headers: HeaderMap,
    Path(room): Path<String>,
) -> Result<Response> {
    let (actor, hash, proof) = read_access(&app, &headers, Scope::Room(&room)).await?;
    let state = room_reads::read(&app, &actor, &room).await?;
    proof.json(&app, &hash, &state, &[room], None).await
}
async fn mark_room_read(
    State(app): State<App>,
    headers: HeaderMap,
    Path(room): Path<String>,
    input: Input<rv_protocol::parity::MarkRead>,
) -> Result<Response> {
    let (actor, hash, proof) = read_access(&app, &headers, Scope::Room(&room)).await?;
    let state = room_reads::mark(&app, &actor, &room, body(input)?).await?;
    proof.json(&app, &hash, &state, &[room], None).await
}
async fn room_favorite(
    State(app): State<App>,
    headers: HeaderMap,
    Path(room): Path<String>,
    input: Input<rv_protocol::parity::SetRoomFavorite>,
) -> Result<Response> {
    let hash = auth::bearer(&headers)?;
    let actor = auth::authenticate(&app, &hash).await?;
    let receipt = room_reads::favorite(&app, &actor, &room, body(input)?).await?;
    let proof = ReadProof::capture(&app, &actor, Scope::None).await?;
    proof.json(&app, &hash, &receipt, &[], None).await
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct MembersQuery {
    after: Option<String>,
    revision: Option<String>,
}
async fn room_members(
    State(app): State<App>,
    headers: HeaderMap,
    Path(room): Path<String>,
    Query(input): Query<MembersQuery>,
) -> Result<Response> {
    let (actor, hash, proof) = read_access(&app, &headers, Scope::Room(&room)).await?;
    let page = room_details::members(
        &app,
        &actor,
        &room,
        input.after.as_deref(),
        input.revision.as_deref(),
    )
    .await?;
    proof
        .versioned_room_json(&app, &hash, &room, &page.revision, &page)
        .await
}
async fn room_command(
    State(app): State<App>,
    headers: HeaderMap,
    room: String,
    command: room_details::Command,
) -> Result<Response> {
    let hash = auth::bearer(&headers)?;
    let actor = auth::authenticate(&app, &hash).await?;
    let receipt = room_details::apply(&app, &actor, &room, command).await?;
    let proof = ReadProof::capture(&app, &actor, Scope::None).await?;
    proof.json(&app, &hash, &receipt, &[], None).await
}
async fn update_room(
    state: State<App>,
    headers: HeaderMap,
    Path(room): Path<String>,
    input: Input<rv_protocol::parity::UpdateRoom>,
) -> Result<Response> {
    room_command(
        state,
        headers,
        room,
        room_details::Command::Settings(body(input)?),
    )
    .await
}
async fn change_room_role(
    state: State<App>,
    headers: HeaderMap,
    Path((room, target)): Path<(String, String)>,
    input: Input<rv_protocol::parity::ChangeRoomRole>,
) -> Result<Response> {
    room_command(
        state,
        headers,
        room,
        room_details::Command::Role {
            target,
            input: body(input)?,
        },
    )
    .await
}
async fn leave_room(
    state: State<App>,
    headers: HeaderMap,
    Path(room): Path<String>,
    input: Input<rv_protocol::parity::LeaveRoom>,
) -> Result<Response> {
    room_command(
        state,
        headers,
        room,
        room_details::Command::Leave(body(input)?),
    )
    .await
}
async fn room_command_receipt(
    State(app): State<App>,
    headers: HeaderMap,
    Path((room, operation)): Path<(String, String)>,
) -> Result<Response> {
    let (actor, hash, proof) = read_access(&app, &headers, Scope::None).await?;
    let receipt = room_details::receipt(&app, &actor, &room, &operation).await?;
    proof.json(&app, &hash, &receipt, &[], None).await
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
    let (account, hash, proof) = read_access(&app, &headers, Scope::All).await?;
    let mut message = store::send(&app, &account, &room, body(input)?).await?;
    let mut connection = app.pool.acquire().await?;
    marks::personalize(
        &mut connection,
        &account.id,
        std::slice::from_mut(&mut message),
    )
    .await?;
    crate::quotes::personalize(
        &mut connection,
        &account.id,
        std::slice::from_mut(&mut message),
    )
    .await?;
    drop(connection);
    proof
        .json(
            &app,
            &hash,
            &message,
            &crate::quotes::delivery_rooms(std::slice::from_ref(&message)),
            None,
        )
        .await
}

async fn prepare_upload(
    State(app): State<App>,
    headers: HeaderMap,
    input: Input<rv_protocol::parity::PrepareUpload>,
) -> Result<Response> {
    let (actor, hash, proof) = read_access(&app, &headers, Scope::All).await?;
    let upload = crate::files::prepare(&app, &actor, body(input)?).await?;
    proof
        .json(
            &app,
            &hash,
            &upload,
            std::slice::from_ref(&upload.file.room_id),
            None,
        )
        .await
}
async fn upload_status(
    State(app): State<App>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Response> {
    let (actor, hash, proof) = read_access(&app, &headers, Scope::All).await?;
    let upload = crate::files::status(&app, &actor, &id).await?;
    proof
        .json(
            &app,
            &hash,
            &upload,
            std::slice::from_ref(&upload.file.room_id),
            None,
        )
        .await
}
async fn upload_bytes(
    State(app): State<App>,
    headers: HeaderMap,
    Path(id): Path<String>,
    body: axum::body::Body,
) -> Result<Response> {
    let (actor, hash, proof) = read_access(&app, &headers, Scope::All).await?;
    let upload = crate::files::bytes(&app, &actor, &id, body).await?;
    proof
        .json(
            &app,
            &hash,
            &upload,
            std::slice::from_ref(&upload.file.room_id),
            None,
        )
        .await
}
async fn cancel_upload(
    State(app): State<App>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Response> {
    let (actor, hash, proof) = read_access(&app, &headers, Scope::All).await?;
    let upload = crate::files::cancel(&app, &actor, &id).await?;
    proof
        .json(
            &app,
            &hash,
            &upload,
            std::slice::from_ref(&upload.file.room_id),
            None,
        )
        .await
}
async fn complete_upload(
    State(app): State<App>,
    headers: HeaderMap,
    Path(id): Path<String>,
    input: Input<rv_protocol::parity::CompleteUpload>,
) -> Result<Response> {
    let (actor, hash, proof) = read_access(&app, &headers, Scope::All).await?;
    let mut message = crate::files::complete(&app, &actor, &id, body(input)?).await?;
    let mut connection = app.pool.acquire().await?;
    marks::personalize(
        &mut connection,
        &actor.id,
        std::slice::from_mut(&mut message),
    )
    .await?;
    crate::quotes::personalize(
        &mut connection,
        &actor.id,
        std::slice::from_mut(&mut message),
    )
    .await?;
    drop(connection);
    proof
        .json(
            &app,
            &hash,
            &message,
            &crate::quotes::delivery_rooms(std::slice::from_ref(&message)),
            None,
        )
        .await
}
async fn file_download(
    State(app): State<App>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Response> {
    let actor = account(&app, &headers).await?;
    let range = headers
        .get(axum::http::header::RANGE)
        .map(|h| h.to_str().map_err(|_| Error::invalid()))
        .transpose()?;
    crate::files::download(&app, &actor, &id, range).await
}

#[derive(Deserialize)]
struct History {
    before: Option<String>,
    limit: Option<i64>,
}
async fn reply(
    state: State<App>,
    headers: HeaderMap,
    Path(root): Path<String>,
    input: Input<SendMessage>,
) -> Result<Response> {
    let actor = account(&state.0, &headers).await?;
    let mut input = body(input)?;
    if input
        .reply_to
        .as_ref()
        .is_some_and(|parent| parent != &root)
    {
        return Err(Error::invalid());
    }
    let mut connection = state.0.pool.acquire().await?;
    let room = crate::threads::root_room(&mut connection, &actor.id, &root).await?;
    drop(connection);
    input.reply_to = Some(root);
    send(state, headers, Path(room), Ok(Json(input))).await
}
async fn thread(
    State(app): State<App>,
    headers: HeaderMap,
    Path(root): Path<String>,
    Query(input): Query<History>,
) -> Result<Response> {
    let before = input.before.map(|p| room_reads::position(&p)).transpose()?;
    let limit = input.limit.unwrap_or(50);
    if !(1..=100).contains(&limit) {
        return Err(Error::invalid());
    }
    let (actor, hash, proof) = read_access(&app, &headers, Scope::All).await?;
    let page = crate::threads::page(&app, &actor, &root, before, limit).await?;
    let mut included = page.messages.clone();
    included.push(page.root.clone());
    proof
        .json(
            &app,
            &hash,
            &page,
            &crate::quotes::delivery_rooms(&included),
            None,
        )
        .await
}
async fn mark_thread_read(
    State(app): State<App>,
    headers: HeaderMap,
    Path(root): Path<String>,
    input: Input<rv_protocol::MarkThreadRead>,
) -> Result<Response> {
    let (actor, hash, proof) = read_access(&app, &headers, Scope::All).await?;
    let state = crate::threads::mark(&app, &actor, &root, body(input)?).await?;
    proof
        .json(
            &app,
            &hash,
            &state,
            std::slice::from_ref(&state.room_id),
            None,
        )
        .await
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
    let (account, hash, proof) = read_access(&app, &headers, Scope::All).await?;
    let messages = store::history(&app, &account, &room, before, limit).await?;
    let mut delivery_rooms = crate::quotes::delivery_rooms(&messages.messages);
    delivery_rooms.push(room);
    proof
        .json(&app, &hash, &messages, &delivery_rooms, None)
        .await
}

async fn search_messages(
    State(app): State<App>,
    headers: HeaderMap,
    Path(room): Path<String>,
    Query(input): Query<rv_protocol::search::SearchMessages>,
) -> Result<Response> {
    let (actor, hash, proof) = read_access(&app, &headers, Scope::All).await?;
    let page = crate::search::messages(&app, &actor, &room, input).await?;
    let mut rooms = crate::quotes::delivery_rooms(&page.messages);
    rooms.push(room);
    proof.json(&app, &hash, &page, &rooms, None).await
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
    #[serde(default)]
    live: bool,
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
        .on_upgrade(move |ws| stream(app, ws, session_hash, input.cursor, slot, input.live))
        .into_response())
}

async fn stream(
    app: App,
    mut ws: WebSocket,
    session_hash: String,
    mut cursor: String,
    _slot: limits::SocketSlot,
    live: bool,
) {
    let mut interval = tokio::time::interval(Duration::from_millis(250));
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut last_sent = tokio::time::Instant::now();
    let mut last_live = tokio::time::Instant::now() - Duration::from_secs(2);
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
                if live && last_live.elapsed()>=Duration::from_secs(2) {
                    let state = match crate::live::state(&app,&account).await {Ok(s)=>s,Err(_)=>break};
                    let rooms=state.rooms.iter().map(|r|r.room_id.clone()).collect::<Vec<_>>();
                    let Ok(text)=serde_json::to_string(&rv_protocol::live::LiveFrame::Live(state)) else {break};
                    let _lease=match proof.lock(&app,&session_hash,&rooms,None).await {
                        Ok(lease)=>lease,Err(error) if error.code=="delivery_revalidate"=>continue,Err(_)=>break,
                    };
                    if !matches!(tokio::time::timeout(Duration::from_secs(5),ws.send(WsMessage::Text(text.into()))).await,Ok(Ok(()))) {break;}
                    last_live=tokio::time::Instant::now();
                }
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

async fn set_presence(
    State(app): State<App>,
    headers: HeaderMap,
    input: Input<rv_protocol::live::SetPresence>,
) -> Result<Json<()>> {
    crate::live::presence(&app, &account(&app, &headers).await?, body(input)?).await?;
    Ok(Json(()))
}
async fn set_typing(
    State(app): State<App>,
    headers: HeaderMap,
    Path(room): Path<String>,
    input: Input<rv_protocol::live::SetTyping>,
) -> Result<Json<()>> {
    crate::live::typing(&app, &account(&app, &headers).await?, &room, body(input)?).await?;
    Ok(Json(()))
}
async fn live_state(State(app): State<App>, headers: HeaderMap) -> Result<Response> {
    let (actor, hash, proof) = read_access(&app, &headers, Scope::All).await?;
    let state = crate::live::state(&app, &actor).await?;
    let rooms = state
        .rooms
        .iter()
        .map(|r| r.room_id.clone())
        .collect::<Vec<_>>();
    proof
        .json(
            &app,
            &hash,
            &rv_protocol::live::LiveFrame::Live(state),
            &rooms,
            None,
        )
        .await
}
