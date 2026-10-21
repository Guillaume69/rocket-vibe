//! The chat service's URLs and the HTTP calls the sync makes.

use std::time::Duration;

use reqwest::Method;
use serde_json::Value;

use super::auth::refusal;
use crate::rest::RestError;

/// A path under a service base, its opaque segments (conversation ids) percent-encoded.
pub fn service_url(base: &str, segments: &[&str], query: &str) -> Result<url::Url, RestError> {
    let mut url = url::Url::parse(base).map_err(|_| refusal("route", 0))?;
    url.path_segments_mut().map_err(|_| refusal("route", 0))?.pop_if_empty().extend(segments);
    if !query.is_empty() {
        url.set_query(Some(query));
    }
    Ok(url)
}

/// What a call answered: its status and body (Null when empty or not JSON).
pub struct Answer {
    pub status: u16,
    pub body: Value,
}

pub fn http() -> reqwest::Client {
    crate::tls::ensure_provider();
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(30))
        .build()
        .expect("Teams HTTP client")
}

/// One call with the given header; a status of 400 or more is an error.
pub async fn call(
    http: &reqwest::Client,
    method: Method,
    url: url::Url,
    header: (&str, &str),
    body: Option<&Value>,
) -> Result<Answer, RestError> {
    let mut request = http.request(method, url).header(header.0, header.1);
    if let Some(body) = body {
        request = request.json(body);
    }
    let response = request.send().await.map_err(|e| RestError::network(e.to_string()))?;
    let status = response.status().as_u16();
    let retry_after = response.headers().get("retry-after").and_then(|v| v.to_str().ok()).and_then(|v| v.parse().ok());
    let bytes = response.bytes().await.map_err(|e| RestError::network(e.to_string()))?;
    let body = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    if status >= 400 {
        let mut error = refusal(&format!("http_{status}"), status);
        error.retry_after = retry_after;
        return Err(error);
    }
    Ok(Answer { status, body })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn conversation_ids_are_encoded_as_segments() {
        let url = service_url(
            "https://teams.microsoft.com/api/chatsvc/fr/v1",
            &["users", "ME", "conversations", "19:a/b@thread.v2", "messages"],
            "pageSize=50",
        )
        .unwrap();
        assert_eq!(
            url.as_str(),
            "https://teams.microsoft.com/api/chatsvc/fr/v1/users/ME/conversations/19:a%2Fb@thread.v2/messages?pageSize=50"
        );
    }
}
