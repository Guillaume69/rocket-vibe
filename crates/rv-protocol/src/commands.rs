//! Slash commands: the catalogue the server publishes, under the names and
//! i18n keys of Rocket.Chat's own commands so clients describe both alike,
//! and the request that runs one in a room.
//!
//! The text commands (`/me`, `/shrug`, ...) only decorate a message: the
//! client writes the text (`decorate`) and sends it like any other, which is
//! what lets them work in an encrypted room the server cannot read. The others
//! act on the server (`POST /api/v1/commands/run`).
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
pub struct SlashCommand {
    /// The name typed after `/`.
    pub command: String,
    /// i18n key of what follows the name (`Slash_Topic_Params`), or literal
    /// text (`@username`), as Rocket.Chat's `commands.list` gives it.
    pub params: String,
    /// i18n key of the description (`Slash_Shrug_Description`).
    pub description: String,
    /// Written by the client (`decorate`), never sent to `commands/run`.
    pub client_side: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
pub struct CommandList {
    pub commands: Vec<SlashCommand>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct RunCommand {
    pub room_id: String,
    pub command: String,
    /// Everything after the name, trimmed.
    pub params: String,
}

/// (name, params key, description key, client side), sorted by name.
const CATALOGUE: &[(&str, &str, &str, bool)] = &[
    (
        "gimme",
        "your_message_optional",
        "Slash_Gimme_Description",
        true,
    ),
    ("invite", "@username", "Invite_user_to_join_channel", false),
    ("join", "#channel", "Join_the_given_channel", false),
    ("kick", "@username", "Remove_someone_from_room", false),
    ("leave", "", "Leave_the_current_channel", false),
    (
        "lennyface",
        "your_message_optional",
        "Slash_LennyFace_Description",
        true,
    ),
    ("me", "your_message", "Displays_action_text", true),
    (
        "msg",
        "@username <message>",
        "Direct_message_someone",
        false,
    ),
    (
        "shrug",
        "your_message_optional",
        "Slash_Shrug_Description",
        true,
    ),
    (
        "status",
        "Slash_Status_Params",
        "Slash_Status_Description",
        false,
    ),
    (
        "tableflip",
        "your_message_optional",
        "Slash_Tableflip_Description",
        true,
    ),
    (
        "topic",
        "Slash_Topic_Params",
        "Slash_Topic_Description",
        false,
    ),
    (
        "unflip",
        "your_message_optional",
        "Slash_TableUnflip_Description",
        true,
    ),
];

/// Every command a RocketVibe server offers.
pub fn catalogue() -> CommandList {
    CommandList {
        commands: CATALOGUE
            .iter()
            .map(|(command, params, description, client_side)| SlashCommand {
                command: (*command).into(),
                params: (*params).into(),
                description: (*description).into(),
                client_side: *client_side,
            })
            .collect(),
    }
}

/// The message a text command writes, as Rocket.Chat's own does; `Some(None)`
/// when there is nothing to send (`/me` alone), `None` for any other command.
pub fn decorate(command: &str, params: &str) -> Option<Option<String>> {
    let params = params.trim();
    let around = |before: &str, after: &str| {
        let parts = [before, params, after];
        Some(Some(
            parts
                .iter()
                .filter(|p| !p.is_empty())
                .copied()
                .collect::<Vec<_>>()
                .join(" "),
        ))
    };
    match command {
        "me" => Some((!params.is_empty()).then(|| format!("_{params}_"))),
        "gimme" => around("༼ つ ◕_◕ ༽つ", ""),
        "lennyface" => around("", "( ͡° ͜ʖ ͡°)"),
        "shrug" => around("", "¯\\_(ツ)_/¯"),
        "tableflip" => around("", "(╯°□°）╯︵ ┻━┻"),
        "unflip" => around("", "┬─┬ ノ( ゜-゜ノ)"),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn text_commands_write_what_rocket_chat_writes() {
        assert_eq!(decorate("shrug", ""), Some(Some("¯\\_(ツ)_/¯".into())));
        assert_eq!(
            decorate("shrug", " oh well "),
            Some(Some("oh well ¯\\_(ツ)_/¯".into()))
        );
        assert_eq!(
            decorate("gimme", "coffee"),
            Some(Some("༼ つ ◕_◕ ༽つ coffee".into()))
        );
        assert_eq!(
            decorate("tableflip", ""),
            Some(Some("(╯°□°）╯︵ ┻━┻".into()))
        );
        assert_eq!(decorate("me", "waves"), Some(Some("_waves_".into())));
        assert_eq!(decorate("me", "  "), Some(None));
        assert_eq!(decorate("topic", "x"), None);
    }

    #[test]
    fn the_catalogue_marks_exactly_the_text_commands() {
        for command in catalogue().commands {
            assert_eq!(
                command.client_side,
                decorate(&command.command, "x").is_some(),
                "{}",
                command.command
            );
        }
    }
}
