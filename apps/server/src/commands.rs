//! Slash commands run on the server: each one is an operation the API already
//! offers (room settings, membership, departure, joining, direct message,
//! profile), reached by name with its parameters as typed, under the same
//! checks as the operation itself. The text commands (`/shrug`...) are written
//! by the client and never come here (`rv_protocol::commands`).
use crate::{
    App,
    auth::{Account, identifier, random_token},
    error::{Error, Result},
    profiles, room_details, store,
};
use axum::http::StatusCode;
use rv_protocol::{
    RoomKind, SendMessage,
    commands::RunCommand,
    parity::{LeaveRoom, UpdateRoom},
    profiles::UpdateProfile,
};

fn unknown() -> Error {
    Error::new(StatusCode::NOT_FOUND, "unknown_command")
}

/// A user named the way people type it: `@alice` or `alice`.
fn username(token: &str) -> Result<&str> {
    let name = token.strip_prefix('@').unwrap_or(token);
    if identifier(name) {
        Ok(name)
    } else {
        Err(Error::invalid())
    }
}

/// An operation id of its own for each command run: a command is not replayed.
fn operation() -> String {
    random_token()
}

pub async fn run(app: &App, actor: &Account, input: RunCommand) -> Result<()> {
    let room = input.room_id.as_str();
    if !identifier(room) || input.params.len() > 4096 {
        return Err(Error::invalid());
    }
    let params = input.params.trim();
    let mut words = params.split_whitespace();
    match input.command.as_str() {
        "topic" => {
            let details = room_details::read(app, actor, room).await?;
            let settings = UpdateRoom {
                operation_id: operation(),
                expected_revision: details.revision,
                name: details.room.name,
                private: matches!(details.room.kind, RoomKind::Private),
                topic: params.into(),
                description: details.description,
                announcement: details.announcement,
                read_only: details.read_only,
                voice: None,
            };
            room_details::apply(app, actor, room, room_details::Command::Settings(settings))
                .await?;
        }
        "leave" => {
            let details = room_details::read(app, actor, room).await?;
            let leave = LeaveRoom {
                operation_id: operation(),
                expected_revision: details.revision,
            };
            room_details::apply(app, actor, room, room_details::Command::Leave(leave)).await?;
        }
        "invite" => {
            let names: Vec<&str> = words.map(username).collect::<Result<_>>()?;
            if names.is_empty() || names.len() > 20 {
                return Err(Error::invalid());
            }
            for name in names {
                let user = profiles::lookup(app, name).await?.user;
                store::membership(app, actor, room, &user.id, false).await?;
            }
        }
        "kick" => {
            let (Some(name), None) = (words.next(), words.next()) else {
                return Err(Error::invalid());
            };
            let user = profiles::lookup(app, username(name)?).await?.user;
            store::membership(app, actor, room, &user.id, true).await?;
        }
        "join" => {
            let (Some(name), None) = (words.next(), words.next()) else {
                return Err(Error::invalid());
            };
            let name = name.strip_prefix('#').unwrap_or(name);
            let target = public_room(app, actor, name).await?;
            store::join_public(app, actor, &target).await?;
        }
        "msg" => {
            let name = username(words.next().ok_or_else(Error::invalid)?)?;
            let text = params[params.find(char::is_whitespace).unwrap_or(params.len())..].trim();
            if text.is_empty() {
                return Err(Error::invalid());
            }
            let user = profiles::lookup(app, name).await?.user;
            let direct = store::direct(app, actor, &user.id).await?;
            let message = SendMessage {
                operation_id: operation(),
                text: text.into(),
                reply_to: None,
                quotes: Vec::new(),
                cards: Vec::new(),
                files: Vec::new(),
            };
            store::send(app, actor, &direct.id, message).await?;
        }
        "status" => {
            let own = profiles::own(app, actor).await?.profile;
            let update = UpdateProfile {
                operation_id: operation(),
                expected_revision: own.revision,
                username: own.user.username,
                display_name: own.user.display_name,
                bio: own.bio,
                status: own.status,
                status_text: params.into(),
            };
            profiles::update(app, actor, update).await?;
        }
        name if rv_protocol::commands::decorate(name, "").is_some() => {
            return Err(Error::new(StatusCode::BAD_REQUEST, "client_side_command"));
        }
        _ => return Err(unknown()),
    }
    Ok(())
}

/// The public room of that exact name, case aside.
async fn public_room(app: &App, actor: &Account, name: &str) -> Result<String> {
    if name.is_empty() {
        return Err(Error::invalid());
    }
    let mut after: Option<String> = None;
    // The directory searches by substring; a few pages reach the exact name.
    for _ in 0..10 {
        let page = store::public_rooms(app, actor, name, after.as_deref()).await?;
        if let Some(found) = page
            .rooms
            .iter()
            .find(|r| r.room.name.to_lowercase() == name.to_lowercase())
        {
            return Ok(found.room.id.clone());
        }
        match page.next {
            Some(next) => after = Some(next),
            None => break,
        }
    }
    Err(Error::missing())
}
