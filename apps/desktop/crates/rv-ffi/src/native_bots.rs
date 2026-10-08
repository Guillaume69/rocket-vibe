//! Bot accounts (RFC 0003): my bots, their scopes and keys, over rv-core's
//! `native::bots`. Scopes cross as their wire names (`rooms:read`...). A new
//! key crosses once, in `NativeBotKeyCreated`, and nothing here keeps it.
use crate::{model::RvError, native::NativeChat, native::native_error, on_tokio};
use rv_core::native::bots::{self, Bot, BotKey, BotRoute, BotScope};

#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct NativeBot {
    pub id: String,
    pub username: String,
    pub display_name: String,
    pub description: String,
    /// Wire names, in canonical order.
    pub scopes: Vec<String>,
    pub created_at: String,
    /// Deactivated by an administrator, or with its owner.
    pub disabled: bool,
    pub live_keys: u32,
}

#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct NativeBotKey {
    pub id: String,
    pub label: String,
    /// The key's last four characters.
    pub hint: String,
    pub created_at: String,
    pub expires_at: Option<String>,
    pub last_used_at: Option<String>,
}

/// The key, shown once, and a first call filled with it and the server's address.
#[derive(Clone, PartialEq, Eq, uniffi::Record)]
pub struct NativeBotKeyCreated {
    pub key: String,
    pub info: NativeBotKey,
    pub example: String,
}

#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct NativeBotRoute {
    pub method: String,
    pub path: String,
}

#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct NativeBotScopeRoutes {
    pub scope: String,
    pub routes: Vec<NativeBotRoute>,
}

/// What a key can reach, from the table the server enforces.
#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct NativeBotReference {
    pub key_prefix: String,
    /// Open to every key, whatever its scopes.
    pub always: Vec<NativeBotRoute>,
    /// Every scope, in canonical order, with the routes it opens.
    pub scopes: Vec<NativeBotScopeRoutes>,
    pub sends_per_minute: u32,
    pub direct_per_minute: u32,
}

fn bot(b: Bot) -> NativeBot {
    NativeBot {
        id: b.user.id,
        username: b.user.username,
        display_name: b.user.display_name,
        description: b.description,
        scopes: b.scopes.into_iter().map(|s| s.as_str().to_owned()).collect(),
        created_at: b.created_at,
        disabled: b.disabled,
        live_keys: b.live_keys,
    }
}

fn key(k: BotKey) -> NativeBotKey {
    NativeBotKey {
        id: k.id,
        label: k.label,
        hint: k.hint,
        created_at: k.created_at,
        expires_at: k.expires_at,
        last_used_at: k.last_used_at,
    }
}

fn route(r: BotRoute) -> NativeBotRoute {
    NativeBotRoute { method: r.method, path: r.path }
}

/// Unknown names are dropped: the server would refuse them anyway.
fn scopes(names: &[String]) -> Vec<BotScope> {
    names.iter().filter_map(|n| BotScope::parse(n)).collect()
}

#[uniffi::export]
impl NativeChat {
    /// The server offers bot accounts.
    pub fn bots_supported(&self) -> bool {
        self.session.bots_supported()
    }
    pub async fn bot_reference(&self) -> Result<NativeBotReference, RvError> {
        let s = self.session.clone();
        let reference = on_tokio(async move { s.bot_reference().await }).await.map_err(native_error)?;
        Ok(NativeBotReference {
            key_prefix: reference.key_prefix.clone(),
            always: bots::routes(&reference, None).into_iter().map(route).collect(),
            scopes: BotScope::ALL
                .into_iter()
                .map(|scope| NativeBotScopeRoutes {
                    scope: scope.as_str().to_owned(),
                    routes: bots::routes(&reference, Some(scope)).into_iter().map(route).collect(),
                })
                .collect(),
            sends_per_minute: reference.sends_per_minute,
            direct_per_minute: reference.direct_per_minute,
        })
    }
    /// An administrator always may; anyone when the instance allows it.
    pub async fn can_create_bot(&self) -> Result<bool, RvError> {
        let s = self.session.clone();
        on_tokio(async move { s.can_create_bot().await }).await.map_err(native_error)
    }
    pub async fn bots(&self) -> Result<Vec<NativeBot>, RvError> {
        let s = self.session.clone();
        Ok(on_tokio(async move { s.bots().await }).await.map_err(native_error)?.into_iter().map(bot).collect())
    }
    pub async fn create_bot(
        &self,
        username: String,
        display_name: String,
        description: String,
        scopes: Vec<String>,
    ) -> Result<NativeBot, RvError> {
        let (s, chosen) = (self.session.clone(), self::scopes(&scopes));
        on_tokio(async move { s.create_bot(&username, &display_name, &description, &chosen).await })
            .await
            .map(bot)
            .map_err(native_error)
    }
    /// None keeps a field as it is.
    pub async fn update_bot(
        &self,
        id: String,
        description: Option<String>,
        scopes: Option<Vec<String>>,
    ) -> Result<NativeBot, RvError> {
        let (s, chosen) = (self.session.clone(), scopes.as_deref().map(self::scopes));
        on_tokio(async move { s.update_bot(&id, description.as_deref(), chosen.as_deref()).await })
            .await
            .map(bot)
            .map_err(native_error)
    }
    /// Final: keys revoked, rooms left, username retired.
    pub async fn delete_bot(&self, id: String) -> Result<(), RvError> {
        let s = self.session.clone();
        on_tokio(async move { s.delete_bot(&id).await }).await.map_err(native_error)
    }
    pub async fn bot_keys(&self, id: String) -> Result<Vec<NativeBotKey>, RvError> {
        let s = self.session.clone();
        Ok(on_tokio(async move { s.bot_keys(&id).await }).await.map_err(native_error)?.into_iter().map(key).collect())
    }
    /// The key, once. Needs a recent sign-in (`reauthentication_required`).
    pub async fn create_bot_key(
        &self,
        id: String,
        label: String,
        expires_in_days: Option<u32>,
    ) -> Result<NativeBotKeyCreated, RvError> {
        let s = self.session.clone();
        let base = self.session.info.base_url.clone();
        let created = on_tokio(async move { s.create_bot_key(&id, &label, expires_in_days).await })
            .await
            .map_err(native_error)?;
        Ok(NativeBotKeyCreated {
            example: bots::example(&base, &created.key),
            key: created.key,
            info: key(created.info),
        })
    }
    pub async fn revoke_bot_key(&self, bot: String, key: String) -> Result<(), RvError> {
        let s = self.session.clone();
        on_tokio(async move { s.revoke_bot_key(&bot, &key).await }).await.map_err(native_error)
    }
}

/// Every scope's wire name, in the order the settings list them.
#[uniffi::export]
pub fn bot_scopes() -> Vec<String> {
    BotScope::ALL.into_iter().map(|s| s.as_str().to_owned()).collect()
}

/// The i18n key of what a scope lets a key do; the "always" one for anything else.
#[uniffi::export]
pub fn bot_scope_key(scope: String) -> String {
    BotScope::parse(&scope).map_or("bots.scope.always", bots::scope_key).to_owned()
}

/// The i18n key of the text for a bot refusal's code, as the GTK app shows it.
#[uniffi::export]
pub fn bot_error_key(code: String) -> String {
    bots::error_key(&code).to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scopes_cross_by_their_wire_names() {
        assert_eq!(bot_scopes().len(), BotScope::ALL.len());
        assert_eq!(bot_scope_key("dm:write".into()), "bots.scope.dm_write");
        assert_eq!(bot_scope_key("admin".into()), "bots.scope.always");
        assert_eq!(scopes(&["rooms:read".into(), "admin".into()]), vec![BotScope::RoomsRead]);
        assert_eq!(bot_error_key("bot_key_replayed".into()), "bots.error_key_replayed");
    }
}
