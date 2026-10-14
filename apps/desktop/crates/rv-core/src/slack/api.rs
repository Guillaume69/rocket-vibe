//! The Web API of a signed-in Slack account, as `RestClient::slack` speaks it.

use serde_json::Value;

use crate::rest::RestError;

pub const ORIGIN: &str = "https://slack.com";

/// The only methods an account may call: everything else is refused before
/// any request, so no path of another server's can ever reach Slack.
pub const METHODS: &[&str] = &[
    "auth.test",
    "rtm.connect",
    "users.conversations",
    "client.counts",
    "conversations.history",
    "conversations.replies",
    "users.info",
    "bots.info",
];

/// `RestError::error_type` of an envelope that ends the session.
pub const SESSION_REJECTED: &str = "slack-session-rejected";
pub const RATE_LIMITED: &str = "ratelimited";
/// `RestError::error` of a feature this account does not have.
pub const NOT_SUPPORTED: &str = "not-supported";
pub const RESPONSE_CAP: usize = 2_000_000;
const REJECTIONS: [&str; 5] = ["not_authed", "invalid_auth", "token_expired", "token_revoked", "account_inactive"];

pub fn not_supported(what: &str) -> RestError {
    RestError { error: Some(NOT_SUPPORTED.to_owned()), ..RestError::incomplete(&format!("{what}: not on this server")) }
}

/// Slack's `{ok, error}` envelope. Only an envelope is believed: an HTML
/// page, a proxy's JSON or a 5xx is trouble on the way, never a refusal.
pub fn interpret(method: &str, status: u16, body: &[u8], retry_after: Option<u64>) -> Result<Value, RestError> {
    let parsed: Option<Value> = serde_json::from_slice(body).ok();
    let ok = parsed.as_ref().and_then(|v| v.get("ok")).and_then(Value::as_bool);
    let failure = |message: String| RestError { status, retry_after, ..RestError::network(message) };
    if status == 429 {
        return Err(RestError { error: Some(RATE_LIMITED.to_owned()), ..failure(format!("{method}: rate limited.")) });
    }
    match (ok, parsed) {
        (Some(true), Some(body)) if (200..300).contains(&status) => Ok(body),
        (Some(false), Some(body)) if status < 500 => {
            let code = body
                .get("error")
                .and_then(Value::as_str)
                .filter(|c| !c.is_empty() && c.len() <= 64 && c.bytes().all(|b| b.is_ascii_lowercase() || b == b'_'))
                .unwrap_or("unknown_error");
            Err(RestError {
                error: Some(code.to_owned()),
                error_type: REJECTIONS.contains(&code).then(|| SESSION_REJECTED.to_owned()),
                understood: true,
                ..failure(format!("{method}: {code}"))
            })
        }
        _ => Err(failure(format!("{method}: unexpected response ({status}, {} bytes).", body.len()))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rest::is_token_rejected;

    fn answer(status: u16, body: &str) -> Result<Value, RestError> {
        interpret("auth.test", status, body.as_bytes(), Some(3))
    }

    #[test]
    fn only_a_slack_envelope_ends_the_session() {
        for code in REJECTIONS {
            let e = answer(200, &format!(r#"{{"ok":false,"error":"{code}"}}"#)).unwrap_err();
            assert!(is_token_rejected(&e), "{code}");
        }
        for (status, body) in [
            (200, r#"{"ok":false,"error":"channel_not_found"}"#),
            (401, r#"{"message":"Unauthorized"}"#),
            (502, r#"{"ok":false,"error":"invalid_auth"}"#),
            (200, "<html>sign in</html>"),
            (200, r#"{"ok":"yes"}"#),
        ] {
            assert!(!is_token_rejected(&answer(status, body).unwrap_err()), "{status} {body}");
        }
        assert_eq!(answer(200, r#"{"ok":true,"user":"me"}"#).unwrap()["user"], "me");
    }

    #[test]
    fn rate_limits_and_odd_codes() {
        let limited = answer(429, "").unwrap_err();
        assert_eq!((limited.error.as_deref(), limited.retry_after), (Some(RATE_LIMITED), Some(3)));
        let enveloped = answer(200, r#"{"ok":false,"error":"ratelimited"}"#).unwrap_err();
        assert_eq!(enveloped.error.as_deref(), Some(RATE_LIMITED));
        let odd = answer(200, r#"{"ok":false,"error":"Private <secret>"}"#).unwrap_err();
        assert_eq!(odd.error.as_deref(), Some("unknown_error"));
        assert!(!odd.message.contains("secret"));
    }
}
