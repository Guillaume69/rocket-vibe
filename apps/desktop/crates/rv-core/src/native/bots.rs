//! Bot accounts (RFC 0003, `docs/protocol/BOTS.md`): the bots a person owns,
//! their scopes and their keys. A key comes back once, from `create_bot_key`,
//! and nothing here keeps it: the UI shows it and forgets it.
use super::{Error, NativeSession, room_operation_id};
pub use rv_protocol::bots::{
    AVATAR_BYTES, Bot, BotKey, BotKeyCreated, BotReference, BotRoute, BotScope, BotScopeRoutes, DESCRIPTION_BYTES,
    DISPLAY_NAME_BYTES, KEY_DAYS, LABEL_BYTES,
};

impl NativeSession {
    /// The server offers bot accounts (its `bots` capability).
    pub fn bots_supported(&self) -> bool {
        self.capabilities.lock().unwrap().as_ref().is_some_and(|c| c.bots)
    }
    fn bot_access(&self) -> Result<(), Error> {
        self.ready()?;
        if !self.bots_supported() {
            return Err(Error::Protocol("unsupported_feature"));
        }
        Ok(())
    }
    /// The routes each scope opens, as the server's gate admits them.
    pub async fn bot_reference(&self) -> Result<BotReference, Error> {
        self.bot_access()?;
        let reference = self.client.bot_reference().await?;
        self.ready()?;
        Ok(reference)
    }
    /// Whether this account may create a bot: an administrator always, anyone
    /// when the instance opened bots to everyone.
    pub async fn can_create_bot(&self) -> Result<bool, Error> {
        self.bot_access()?;
        let permissions = self.client.account_permissions().await?;
        self.ready()?;
        Ok(permissions.create_bot)
    }
    /// The bots I own, live ones only (a deleted bot is gone from the list).
    pub async fn bots(&self) -> Result<Vec<Bot>, Error> {
        self.bot_access()?;
        self.refresh_credentials().await?;
        self.bot_access()?;
        let list = self.client.bots(false).await?;
        self.ready()?;
        *self.bot_avatars.lock().unwrap() =
            list.bots.iter().filter_map(|bot| Some((bot.user.id.clone(), bot.avatar_file_id.clone()?))).collect();
        Ok(list.bots)
    }
    pub async fn create_bot(
        &self,
        username: &str,
        display_name: &str,
        description: &str,
        scopes: &[BotScope],
    ) -> Result<Bot, Error> {
        self.bot_access()?;
        let (username, display_name, description) = (username.trim(), display_name.trim(), description.trim());
        if username.is_empty() || description.len() > DESCRIPTION_BYTES {
            return Err(Error::Protocol("invalid_request"));
        }
        let input = rv_protocol::bots::CreateBot {
            operation_id: room_operation_id(),
            username: username.into(),
            display_name: if display_name.is_empty() { username } else { display_name }.into(),
            description: description.into(),
            scopes: sorted(scopes),
        };
        self.refresh_credentials().await?;
        self.bot_access()?;
        let bot = self.client.create_bot(&input).await?;
        self.ready()?;
        Ok(self.remember(bot))
    }
    /// Changes the display name, the description and/or the scopes; None
    /// keeps a field. A display name is trimmed and never empty.
    pub async fn update_bot(
        &self,
        id: &str,
        display_name: Option<&str>,
        description: Option<&str>,
        scopes: Option<&[BotScope]>,
    ) -> Result<Bot, Error> {
        self.bot_access()?;
        let (display_name, description) = (display_name.map(str::trim), description.map(str::trim));
        if description.is_some_and(|d| d.len() > DESCRIPTION_BYTES)
            || display_name
                .is_some_and(|n| n.is_empty() || n.len() > DISPLAY_NAME_BYTES || n.chars().any(char::is_control))
        {
            return Err(Error::Protocol("invalid_request"));
        }
        let input = rv_protocol::bots::UpdateBot {
            operation_id: room_operation_id(),
            display_name: display_name.map(str::to_owned),
            description: description.map(str::to_owned),
            scopes: scopes.map(sorted),
        };
        self.refresh_credentials().await?;
        self.bot_access()?;
        let bot = self.client.update_bot(id, &input).await?;
        self.ready()?;
        Ok(self.remember(bot))
    }
    /// Sets the bot's photo (`mime` PNG or JPEG, at most `AVATAR_BYTES`) or,
    /// with None, removes it. Its owner only (the bot itself cannot).
    pub async fn set_bot_avatar(&self, id: &str, upload: Option<(&str, Vec<u8>)>) -> Result<Bot, Error> {
        self.bot_access()?;
        if let Some((mime, bytes)) = &upload {
            if !matches!(*mime, "image/png" | "image/jpeg") || bytes.is_empty() {
                return Err(Error::Protocol("invalid_avatar"));
            }
            if bytes.len() > AVATAR_BYTES {
                return Err(Error::Protocol("avatar_too_large"));
            }
        }
        self.refresh_credentials().await?;
        self.bot_access()?;
        let bot = self.client.set_bot_avatar(id, upload).await.map_err(|error| match error {
            rv_client::Error::InvalidAvatar => Error::Protocol("invalid_avatar"),
            other => Error::Network(other),
        })?;
        self.ready()?;
        Ok(self.remember(bot))
    }
    /// Keeps the bot's photo as the one `profile_avatar` may serve for it.
    fn remember(&self, bot: Bot) -> Bot {
        let mut avatars = self.bot_avatars.lock().unwrap();
        match &bot.avatar_file_id {
            Some(file) => avatars.insert(bot.user.id.clone(), file.clone()),
            None => avatars.remove(&bot.user.id),
        };
        bot
    }
    /// Final: the keys are revoked, the bot leaves its rooms and its username
    /// is never given again.
    pub async fn delete_bot(&self, id: &str) -> Result<(), Error> {
        self.bot_access()?;
        self.refresh_credentials().await?;
        self.bot_access()?;
        self.client.delete_bot(id).await?;
        self.bot_avatars.lock().unwrap().remove(id);
        self.ready()
    }
    pub async fn bot_keys(&self, id: &str) -> Result<Vec<BotKey>, Error> {
        self.bot_access()?;
        self.refresh_credentials().await?;
        self.bot_access()?;
        let list = self.client.bot_keys(id).await?;
        self.ready()?;
        Ok(list.keys)
    }
    /// The only answer carrying the key. Needs a recent sign-in
    /// (`reauthentication_required`); `expires_in_days` None: it never expires.
    pub async fn create_bot_key(
        &self,
        id: &str,
        label: &str,
        expires_in_days: Option<u32>,
    ) -> Result<BotKeyCreated, Error> {
        self.bot_access()?;
        let label = label.trim();
        if label.is_empty() || label.len() > LABEL_BYTES || expires_in_days.is_some_and(|d| d == 0 || d > KEY_DAYS) {
            return Err(Error::Protocol("invalid_request"));
        }
        let input =
            rv_protocol::bots::CreateBotKey { operation_id: room_operation_id(), label: label.into(), expires_in_days };
        self.refresh_credentials().await?;
        self.bot_access()?;
        let created = self.client.create_bot_key(id, &input).await?;
        self.ready()?;
        if !rv_protocol::bots::is_key(&created.key) {
            return Err(Error::Protocol("invalid_request"));
        }
        Ok(created)
    }
    pub async fn revoke_bot_key(&self, bot: &str, key: &str) -> Result<(), Error> {
        self.bot_access()?;
        self.refresh_credentials().await?;
        self.bot_access()?;
        self.client.revoke_bot_key(bot, key).await?;
        self.ready()
    }
}

/// Scopes in their canonical order, each once.
fn sorted(scopes: &[BotScope]) -> Vec<BotScope> {
    BotScope::ALL.into_iter().filter(|s| scopes.contains(s)).collect()
}

/// The i18n key of the sentence for a refusal's code and HTTP status (0: no
/// answer), the same in both desktop apps. A code with its own sentence wins;
/// any other 429 is a rate limit.
pub fn error_key(code: &str, status: u16) -> &'static str {
    match code {
        "bots_disabled" => "bots.error_disabled",
        "bot_limit" => "bots.error_limit",
        "bot_create_limit" => "bots.error_create_limit",
        "username_taken" => "bots.error_username_taken",
        "bot_key_limit" => "bots.error_key_limit",
        "bot_disabled" => "bots.error_bot_disabled",
        "bot_key_replayed" => "bots.error_key_replayed",
        "reauthentication_required" => "bots.error_reauth",
        "invalid_request" => "bots.error_invalid",
        "not_found" => "bots.error_not_found",
        "bot_encrypted_room" => "bots.error_encrypted_room",
        "crypto_bot_member" => "bots.error_crypto_member",
        "invalid_avatar" => "bots.error_invalid_avatar",
        "avatar_too_large" => "bots.error_avatar_too_large",
        "avatar_busy" => "bots.error_avatar_busy",
        "storage_unavailable" => "bots.error_storage_unavailable",
        "offline" | "connection_failed" | "session_closed" => "native.offline",
        _ if status == 429 => "bots.error_rate_limited",
        _ => "bots.failed",
    }
}

/// `error_key` for a failed call.
pub fn failure_key(error: &Error) -> &'static str {
    let status = match error {
        Error::Network(rv_client::Error::Server { status, .. }) => *status,
        _ => 0,
    };
    error_key(error.code(), status)
}

/// The i18n key of what a scope lets a key do.
pub fn scope_key(scope: BotScope) -> &'static str {
    match scope {
        BotScope::RoomsRead => "bots.scope.rooms_read",
        BotScope::MessagesWrite => "bots.scope.messages_write",
        BotScope::FilesWrite => "bots.scope.files_write",
        BotScope::ReactionsWrite => "bots.scope.reactions_write",
        BotScope::RoomsJoin => "bots.scope.rooms_join",
        BotScope::UsersRead => "bots.scope.users_read",
        BotScope::DmWrite => "bots.scope.dm_write",
    }
}

/// The routes one scope opens in a reference; `None`: those open to every key.
pub fn routes(reference: &BotReference, scope: Option<BotScope>) -> Vec<BotRoute> {
    reference.groups.iter().filter(|g| g.scope == scope).flat_map(|g| g.routes.iter().cloned()).collect()
}

/// A route as the settings list it: method, path, then the further scopes it
/// needs (`POST /api/v1/uploads/{id}/complete + messages:write`).
pub fn route_text(route: &BotRoute) -> String {
    let mut text = format!("{} {}", route.method, route.path);
    for scope in &route.also {
        text.push_str(" + ");
        text.push_str(scope.as_str());
    }
    text
}

/// A first call with a new key: a message posted in a room, ready to paste
/// once the room's id is filled in. On Windows it is a `cmd.exe` line
/// (`curl.exe`, double quotes only); a POSIX shell line elsewhere.
pub fn example(base_url: &str, key: &str) -> String {
    example_for(base_url, key, cfg!(windows))
}

fn example_for(base_url: &str, key: &str, windows: bool) -> String {
    let url = format!("{}/api/v1/rooms/<ROOM_ID>/messages", base_url.trim_end_matches('/'));
    let headers = format!("-H \"Authorization: Bearer {key}\" -H \"Content-Type: application/json\"");
    if windows {
        format!(r#"curl.exe -X POST "{url}" {headers} -d "{{\"operation_id\":\"hello-1\",\"text\":\"Hello\"}}""#)
    } else {
        format!(r#"curl -X POST "{url}" {headers} -d '{{"operation_id":"hello-1","text":"Hello"}}'"#)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_scope_and_bot_refusal_has_words() {
        for scope in BotScope::ALL {
            assert!(!crate::i18n::t(scope_key(scope)).is_empty());
        }
        for code in [
            "bots_disabled",
            "bot_limit",
            "bot_create_limit",
            "username_taken",
            "bot_key_limit",
            "bot_disabled",
            "bot_key_replayed",
            "reauthentication_required",
            "invalid_request",
            "not_found",
            "bot_encrypted_room",
            "crypto_bot_member",
            "invalid_avatar",
            "avatar_too_large",
            "avatar_busy",
            "storage_unavailable",
            "something_else",
        ] {
            assert!(!crate::i18n::t(error_key(code, 409)).is_empty(), "{code}");
        }
        assert_eq!(error_key("bot_key_replayed", 409), "bots.error_key_replayed");
        assert_eq!(error_key("avatar_too_large", 0), "bots.error_avatar_too_large");
        assert_eq!(error_key("bot_create_limit", 429), "bots.error_create_limit");
        assert_eq!(error_key("avatar_busy", 429), "bots.error_avatar_busy", "a code with its own words wins");
        assert_eq!(error_key("bot_rate_limited", 429), "bots.error_rate_limited");
        assert_eq!(error_key("rate_limited", 429), "bots.error_rate_limited");
        assert!(!crate::i18n::t("bots.error_rate_limited").is_empty());
        assert_eq!(error_key("invalid_username", 400), "bots.failed");
        let limited = Error::Network(rv_client::Error::Server {
            status: 429,
            code: "auth_rate_limited".into(),
            request_id: None,
            retry_after: Some(3),
        });
        assert_eq!(failure_key(&limited), "bots.error_rate_limited");
        assert_eq!(failure_key(&Error::Protocol("invalid_avatar")), "bots.error_invalid_avatar");
    }

    #[test]
    fn scopes_are_sent_once_in_order() {
        assert_eq!(
            sorted(&[BotScope::DmWrite, BotScope::RoomsRead, BotScope::DmWrite]),
            vec![BotScope::RoomsRead, BotScope::DmWrite]
        );
    }

    #[test]
    fn the_example_names_the_server_and_the_key() {
        let text = example_for("https://chat.example/", "rvb_abc", false);
        assert_eq!(
            text,
            r#"curl -X POST "https://chat.example/api/v1/rooms/<ROOM_ID>/messages" -H "Authorization: Bearer rvb_abc" -H "Content-Type: application/json" -d '{"operation_id":"hello-1","text":"Hello"}'"#
        );
        assert_eq!(
            example("https://chat.example/", "rvb_abc"),
            example_for("https://chat.example", "rvb_abc", cfg!(windows))
        );
    }

    #[test]
    fn the_windows_example_pastes_into_cmd() {
        let text = example_for("https://chat.example/", "rvb_abc", true);
        assert_eq!(
            text,
            r#"curl.exe -X POST "https://chat.example/api/v1/rooms/<ROOM_ID>/messages" -H "Authorization: Bearer rvb_abc" -H "Content-Type: application/json" -d "{\"operation_id\":\"hello-1\",\"text\":\"Hello\"}""#
        );
        // cmd.exe has no single quotes: none may reach curl.
        assert!(!text.contains('\''));
    }

    #[test]
    fn a_route_names_the_further_scopes_it_needs() {
        let upload = BotRoute {
            method: "POST".into(),
            path: "/api/v1/uploads/{id}/complete".into(),
            also: vec![BotScope::MessagesWrite],
        };
        assert_eq!(route_text(&upload), "POST /api/v1/uploads/{id}/complete + messages:write");
        let me = BotRoute { method: "GET".into(), path: "/api/v1/me".into(), also: vec![] };
        assert_eq!(route_text(&me), "GET /api/v1/me");
    }

    #[test]
    fn routes_are_read_by_scope() {
        let reference = BotReference {
            key_prefix: "rvb_".into(),
            groups: vec![
                BotScopeRoutes {
                    scope: None,
                    routes: vec![BotRoute { method: "GET".into(), path: "/api/v1/me".into(), also: vec![] }],
                },
                BotScopeRoutes {
                    scope: Some(BotScope::MessagesWrite),
                    routes: vec![BotRoute {
                        method: "POST".into(),
                        path: "/api/v1/rooms/{room}/messages".into(),
                        also: vec![],
                    }],
                },
            ],
            sends_per_minute: 60,
            direct_per_minute: 10,
        };
        assert_eq!(routes(&reference, None)[0].path, "/api/v1/me");
        assert_eq!(routes(&reference, Some(BotScope::MessagesWrite))[0].method, "POST");
        assert!(routes(&reference, Some(BotScope::DmWrite)).is_empty());
    }
}
