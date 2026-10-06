//! Whether an account other than the open one has unread messages, for the
//! dot on its button in the server rail. One cheap read per check; the
//! account's store and live connection are never touched.

use std::sync::Arc;

use serde_json::Value;

use crate::rest::{CallOptions, Credentials, RestClient, RestError};
use crate::session::SessionInfo;

/// The rule of the room list (`rooms::unread_rooms`) over `subscriptions.get`:
/// an open subscription with unread messages or an alert.
pub fn subscriptions_unread(response: &Value) -> bool {
    response.get("update").and_then(Value::as_array).is_some_and(|subscriptions| {
        subscriptions.iter().any(|s| {
            s.get("open").and_then(Value::as_bool) != Some(false)
                && (s.get("unread").and_then(Value::as_i64).unwrap_or(0) > 0
                    || s.get("alert").and_then(Value::as_bool) == Some(true))
        })
    })
}

/// A Rocket.Chat account: `subscriptions.get`. A refused token is an error
/// here, never a sign-out: that account is not the open one.
pub async fn rocket_chat(info: &SessionInfo) -> Result<bool, RestError> {
    let base = url::Url::parse(&info.base_url).map_err(|_| RestError::incomplete("invalid server address"))?;
    let rest = RestClient::new(base);
    rest.set_credentials(Some(Credentials { auth_token: info.auth_token.clone(), user_id: info.user_id.clone() }));
    Ok(subscriptions_unread(&rest.get("subscriptions.get", CallOptions::default()).await?))
}

/// A RocketVibe account: its rooms' read states. The bearer comes through the
/// credential provider when there is one, which renews it under its lease.
pub async fn native(
    info: SessionInfo,
    credentials: Option<Arc<dyn crate::native::credentials::Provider>>,
) -> Result<bool, crate::native::Error> {
    let info = match credentials {
        Some(provider) => provider.resume(info).await?,
        None => info,
    };
    let mut client = rv_client::NativeClient::new(&info.base_url)?;
    client.restore(info.auth_token);
    Ok(client.rooms().await?.iter().any(|room| crate::native::read_presentation::badges(room.read_state.as_deref()).2))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn unread_follows_the_room_list() {
        assert!(!subscriptions_unread(&json!({"update": []})));
        assert!(!subscriptions_unread(&json!({"update": [{"unread": 0, "alert": false}]})));
        assert!(subscriptions_unread(&json!({"update": [{"unread": 2}]})));
        assert!(subscriptions_unread(&json!({"update": [{"unread": 0, "alert": true}]})));
        assert!(!subscriptions_unread(&json!({"update": [{"unread": 3, "open": false}]})), "a hidden room");
    }
}
