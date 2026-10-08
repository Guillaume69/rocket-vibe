//! Slash commands: the server's list (`commands.list`), what the composer
//! offers after a leading `/`, and the draft a send turns into a command.
//! Their answers (errors, `/help`) come back as private messages on
//! `stream-notify-user/<uid>/message`, never in the REST response.

use serde_json::Value;

use crate::i18n::Lang;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Command {
    pub name: String,
    /// Shown after the name, as typed: `@username`, `#channel`, "your message".
    pub params: String,
    pub description: String,
    /// Any one of these lets me run it; empty means anyone.
    pub permissions: Vec<String>,
}

/// The commands `commands.list` returns, their i18n keys put in words.
pub fn parse_list(response: &Value, lang: Lang) -> Vec<Command> {
    let list = response.get("commands").and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[]);
    list.iter()
        .filter_map(|c| {
            let name = c.get("command").and_then(Value::as_str).filter(|n| !n.is_empty())?;
            let text = |key: &str| c.get(key).and_then(Value::as_str).map(|k| words(k, lang)).unwrap_or_default();
            let permissions = match c.get("permission") {
                Some(Value::String(p)) => vec![p.clone()],
                Some(Value::Array(ps)) => ps.iter().filter_map(Value::as_str).map(str::to_owned).collect(),
                _ => Vec::new(),
            };
            Some(Command {
                name: name.to_owned(),
                params: text("params"),
                description: text("description"),
                permissions,
            })
        })
        .collect()
}

/// The command name being typed: the draft starts with `/` and the cursor
/// has not left its first word.
pub fn query(before_cursor: &str) -> Option<&str> {
    let name = before_cursor.strip_prefix('/')?;
    (!name.contains(char::is_whitespace) && !name.contains('/')).then_some(name)
}

/// Commands whose name starts with `prefix`, the ones I may run when my
/// permissions are known, sorted by name.
pub fn complete<'a>(
    commands: &'a [Command],
    prefix: &str,
    granted: Option<&[String]>,
    limit: usize,
) -> Vec<&'a Command> {
    let prefix = prefix.to_lowercase();
    let mut out: Vec<&Command> = commands
        .iter()
        .filter(|c| c.name.to_lowercase().starts_with(&prefix))
        .filter(|c| match granted {
            Some(granted) => c.permissions.is_empty() || c.permissions.iter().any(|p| granted.contains(p)),
            None => true,
        })
        .collect();
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out.truncate(limit);
    out
}

/// The commands a RocketVibe server lists (`rv_protocol::commands`), in the
/// shape of Rocket.Chat's so both read alike.
pub fn parse_native(list: &rv_protocol::commands::CommandList, lang: Lang) -> Vec<Command> {
    parse_list(&serde_json::to_value(list).unwrap_or_default(), lang)
}

/// What running a draft as a command left to do.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Run {
    /// A text command (`/shrug`): send this message, the way any other goes.
    Message(String),
    /// Done by the server, or nothing to send (`/me` alone).
    Done,
}

/// A text command is written here rather than by the server, so it works in
/// an encrypted room too: the same text Rocket.Chat's own command writes.
pub fn text(name: &str, params: &str) -> Option<Run> {
    rv_protocol::commands::decorate(name, params).map(|text| text.map_or(Run::Done, Run::Message))
}

/// The i18n key of what a RocketVibe server's refusal of a command means.
pub fn error_key(code: &str) -> Option<&'static str> {
    match code {
        "not_found" | "unknown_command" => Some("command.not_found"),
        "permission_denied" => Some("command.forbidden"),
        "invalid_request" => Some("command.invalid"),
        "crypto_required" => Some("command.encrypted"),
        "workflow_unavailable" => Some("command.workflow_unavailable"),
        "workflow_rate_limited" => Some("command.workflow_rate_limited"),
        "workflow_busy" => Some("command.workflow_busy"),
        _ => None,
    }
}

/// (name, params) of a draft that reads as a command: `/name` first, then
/// whatever follows it. The caller checks the name is one the server knows.
pub fn split(text: &str) -> Option<(&str, &str)> {
    let rest = text.trim_start().strip_prefix('/')?;
    let (name, params) = rest.split_once(char::is_whitespace).unwrap_or((rest, ""));
    (!name.is_empty() && !name.contains('/')).then(|| (name, params.trim()))
}

/// (key, French, English) of the core commands' descriptions and parameters.
const WORDS: &[(&str, &str, &str)] = &[
    ("Archive", "Archiver le salon", "Archive the room"),
    ("Unarchive", "Désarchiver le salon", "Unarchive the room"),
    ("Ban_user_from_room", "Bannir quelqu'un du salon", "Ban someone from the room"),
    ("Unban_user_from_room", "Lever le bannissement", "Unban someone from the room"),
    ("Create_A_New_Channel", "Créer un salon", "Create a new channel"),
    ("Show_the_keyboard_shortcut_list", "Afficher les raccourcis clavier", "Show the keyboard shortcuts"),
    ("Hide_room", "Masquer le salon", "Hide the room"),
    ("Invite_user_to_join_channel", "Inviter quelqu'un dans ce salon", "Invite someone to this room"),
    (
        "Invite_user_to_join_channel_all_to",
        "Inviter tous les membres d'ici dans [#salon]",
        "Invite everyone here to [#channel]",
    ),
    (
        "Invite_user_to_join_channel_all_from",
        "Inviter ici tous les membres de [#salon]",
        "Invite everyone from [#channel] here",
    ),
    ("Join_the_given_channel", "Rejoindre le salon", "Join the channel"),
    ("Remove_someone_from_room", "Retirer quelqu'un du salon", "Remove someone from the room"),
    ("Leave_the_current_channel", "Quitter ce salon", "Leave this room"),
    ("Displays_action_text", "Écrire une action", "Write an action"),
    ("Direct_message_someone", "Écrire en privé à quelqu'un", "Message someone directly"),
    ("Mute_someone_in_room", "Rendre quelqu'un muet ici", "Mute someone in the room"),
    ("Unmute_someone_in_room", "Rendre la parole à quelqu'un", "Unmute someone in the room"),
    ("Slash_Status_Description", "Changer ton message de statut", "Set your status message"),
    ("Slash_Status_Params", "message de statut", "status message"),
    ("Slash_Topic_Description", "Changer le sujet du salon", "Set the room's topic"),
    ("Slash_Topic_Params", "sujet", "topic"),
    ("Slash_Gimme_Description", "Met ༼ つ ◕_◕ ༽つ devant ton message", "Puts ༼ つ ◕_◕ ༽つ before your message"),
    ("Slash_LennyFace_Description", "Met ( ͡° ͜ʖ ͡°) après ton message", "Puts ( ͡° ͜ʖ ͡°) after your message"),
    ("Slash_Shrug_Description", "Met ¯\\_(ツ)_/¯ après ton message", "Puts ¯\\_(ツ)_/¯ after your message"),
    ("Slash_Tableflip_Description", "Met (╯°□°）╯︵ ┻━┻ après ton message", "Puts (╯°□°）╯︵ ┻━┻ after your message"),
    (
        "Slash_TableUnflip_Description",
        "Met ┬─┬ ノ( ゜-゜ノ) après ton message",
        "Puts ┬─┬ ノ( ゜-゜ノ) after your message",
    ),
    ("your_message", "ton message", "your message"),
    ("your_message_optional", "ton message (facultatif)", "your message (optional)"),
];

/// The server sends i18n keys (`Slash_Shrug_Description`) where the web
/// client has its catalog: ours covers the core commands, and an app's key
/// at least reads as words.
fn words(key: &str, lang: Lang) -> String {
    if let Some((_, fr, en)) = WORDS.iter().find(|(k, _, _)| *k == key) {
        return match lang {
            Lang::Fr => fr,
            Lang::En => en,
        }
        .to_string();
    }
    // A Rocket.Chat app namespaces its keys: `app-<id>.GIPHY_Search_Term`.
    let key = match key.split_once('.') {
        Some((app, own)) if app.starts_with("app-") && !app.contains(char::is_whitespace) => own,
        _ => key,
    };
    let looks_like_key = !key.contains(char::is_whitespace) && key.contains('_') && key.chars().any(char::is_uppercase);
    if looks_like_key { key.replace('_', " ") } else { key.to_owned() }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn list() -> Vec<Command> {
        parse_list(
            &json!({"commands": [
                {"command": "shrug", "params": "your_message_optional", "description": "Slash_Shrug_Description", "clientOnly": true},
                {"command": "kick", "params": "@username", "description": "Remove_someone_from_room", "permission": "remove-user"},
                {"command": "leave", "description": "Leave_the_current_channel", "permission": ["leave-c", "leave-p"]},
                {"command": "poll", "params": "question", "description": "Poll_App_Create_Poll"},
                {"command": "", "description": "nameless"},
            ]}),
            Lang::En,
        )
    }

    #[test]
    fn reads_the_list_with_its_words() {
        let commands = list();
        assert_eq!(commands.len(), 4);
        assert_eq!(commands[0].params, "your message (optional)");
        assert_eq!(commands[0].description, "Puts ¯\\_(ツ)_/¯ after your message");
        assert_eq!(commands[1].params, "@username");
        assert_eq!(commands[1].permissions, ["remove-user"]);
        assert_eq!(commands[2].permissions, ["leave-c", "leave-p"]);
        assert_eq!(commands[3].description, "Poll App Create Poll");
        assert_eq!(commands[3].params, "question");
    }

    #[test]
    fn offers_names_while_the_first_word_is_typed() {
        assert_eq!(query("/"), Some(""));
        assert_eq!(query("/sh"), Some("sh"));
        assert_eq!(query("/shrug "), None);
        assert_eq!(query("hi /sh"), None);
        assert_eq!(query(" /sh"), None);
        assert_eq!(query("/usr/bin"), None);
    }

    #[test]
    fn completes_what_i_may_run() {
        let commands = list();
        let names = |found: Vec<&Command>| found.iter().map(|c| c.name.clone()).collect::<Vec<_>>();
        assert_eq!(names(complete(&commands, "", None, 10)), ["kick", "leave", "poll", "shrug"]);
        assert_eq!(names(complete(&commands, "K", None, 10)), ["kick"]);
        let granted = vec!["leave-p".to_owned()];
        assert_eq!(names(complete(&commands, "", Some(&granted), 10)), ["leave", "poll", "shrug"]);
        assert_eq!(complete(&commands, "", None, 2).len(), 2);
    }

    #[test]
    fn splits_a_command_from_its_params() {
        assert_eq!(split("/shrug"), Some(("shrug", "")));
        assert_eq!(split("/me  waves \n hello "), Some(("me", "waves \n hello")));
        assert_eq!(split("  /topic new"), Some(("topic", "new")));
        assert_eq!(split("/"), None);
        assert_eq!(split("/usr/bin is a path"), None);
        assert_eq!(split("not /a command"), None);
    }

    #[test]
    fn a_rocketvibe_list_reads_like_rocket_chat_s() {
        let commands = parse_native(&rv_protocol::commands::catalogue(), Lang::En);
        let shrug = commands.iter().find(|c| c.name == "shrug").unwrap();
        assert_eq!(shrug.params, "your message (optional)");
        assert!(shrug.permissions.is_empty());
        assert_eq!(text("shrug", "ok"), Some(Run::Message("ok ¯\\_(ツ)_/¯".into())));
        assert_eq!(text("me", ""), Some(Run::Done));
        assert_eq!(text("topic", "x"), None);
        assert_eq!(words("app-8b88-42.GIPHY_Search_Term", Lang::En), "GIPHY Search Term");
    }
}
