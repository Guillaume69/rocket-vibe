//! Infomaniak sign-in for kChat: authorization code + PKCE (S256) against
//! `login.infomaniak.com`, with the client id and redirect of Infomaniak's own
//! kChat app, as on mobile (`apps/mobile/providers/mattermost/kchatOAuth.ts`).
//! No scope and no `access_type=offline`: the access token does not expire and
//! no refresh token comes back. The redirect is a custom scheme no desktop
//! browser hands back, so the UIs load the page in an embedded sign-in window
//! and catch the navigation to it.

use std::time::Duration;

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use serde_json::Value;
use sha2::{Digest, Sha256};
use url::Url;

pub const KCHAT_CLIENT_ID: &str = "20af5539-a4fb-421c-b45a-f43af3d90c14";
pub const KCHAT_REDIRECT: &str = "com.infomaniak.chat://oauth2redirect";
pub const REDIRECT_SCHEME: &str = "com.infomaniak.chat";
const LOGIN: &str = "https://login.infomaniak.com";
const EXCHANGE_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Pkce {
    pub verifier: String,
    pub challenge: String,
    pub state: String,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{0}")]
pub struct OAuthError(pub String);

impl Pkce {
    pub fn new() -> Result<Pkce, OAuthError> {
        let mut verifier = [0u8; 32];
        let mut state = [0u8; 16];
        getrandom::fill(&mut verifier)
            .and_then(|()| getrandom::fill(&mut state))
            .map_err(|_| OAuthError("No randomness for the sign-in.".to_owned()))?;
        Ok(Pkce::from_bytes(&verifier, &state))
    }

    fn from_bytes(verifier: &[u8], state: &[u8]) -> Pkce {
        let verifier = URL_SAFE_NO_PAD.encode(verifier);
        let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
        Pkce { verifier, challenge, state: URL_SAFE_NO_PAD.encode(state) }
    }

    pub fn authorize_url(&self) -> String {
        let mut url = Url::parse(&format!("{LOGIN}/authorize")).expect("Infomaniak login URL");
        url.query_pairs_mut()
            .append_pair("response_type", "code")
            .append_pair("client_id", KCHAT_CLIENT_ID)
            .append_pair("redirect_uri", KCHAT_REDIRECT)
            .append_pair("code_challenge", &self.challenge)
            .append_pair("code_challenge_method", "S256")
            .append_pair("state", &self.state)
            .append_pair("hide_create_account", "")
            .append_pair("prompt", "login");
        url.into()
    }

    /// The code carried by the redirect, after checking it answers OUR request.
    pub fn code_from_redirect(&self, redirect: &str) -> Result<String, OAuthError> {
        if !is_redirect(redirect) {
            return Err(OAuthError("Not the kChat redirect.".to_owned()));
        }
        let query = redirect.split_once('?').map_or("", |(_, q)| q);
        let pairs: Vec<(String, String)> = url::form_urlencoded::parse(query.as_bytes()).into_owned().collect();
        let get = |key: &str| pairs.iter().find(|(k, _)| k == key).map(|(_, v)| v.as_str());
        if let Some(error) = get("error") {
            return Err(OAuthError(get("error_description").unwrap_or(error).to_owned()));
        }
        if get("state") != Some(self.state.as_str()) {
            return Err(OAuthError("Sign-in answer for another request.".to_owned()));
        }
        get("code")
            .filter(|c| !c.is_empty())
            .map(str::to_owned)
            .ok_or_else(|| OAuthError("Sign-in answer without a code.".to_owned()))
    }

    /// Trades the code for the Infomaniak bearer kChat sign-in takes.
    pub async fn exchange(&self, code: &str) -> Result<String, OAuthError> {
        let client =
            reqwest::Client::builder().timeout(EXCHANGE_TIMEOUT).build().map_err(|e| OAuthError(e.to_string()))?;
        let form = url::form_urlencoded::Serializer::new(String::new())
            .append_pair("grant_type", "authorization_code")
            .append_pair("code", code)
            .append_pair("code_verifier", &self.verifier)
            .append_pair("client_id", KCHAT_CLIENT_ID)
            .append_pair("redirect_uri", KCHAT_REDIRECT)
            .finish();
        let response = client
            .post(format!("{LOGIN}/token"))
            .header("Accept", "application/json")
            .header("Content-Type", "application/x-www-form-urlencoded")
            .body(form)
            .send()
            .await
            .map_err(|e| OAuthError(e.to_string()))?;
        let status = response.status().as_u16();
        let body: Value = response.json().await.unwrap_or(Value::Null);
        token_from_answer(status, &body)
    }
}

/// Whether a navigation is the sign-in's redirect, which the window must catch.
pub fn is_redirect(uri: &str) -> bool {
    uri.split_once(':').is_some_and(|(scheme, _)| scheme.eq_ignore_ascii_case(REDIRECT_SCHEME))
}

/// The pages the sign-in window may show: Infomaniak's own, over https.
pub fn is_sign_in_page(uri: &str) -> bool {
    Url::parse(uri).is_ok_and(|u| {
        u.scheme() == "https" && u.host_str().is_some_and(|h| h == "infomaniak.com" || h.ends_with(".infomaniak.com"))
    })
}

fn token_from_answer(status: u16, body: &Value) -> Result<String, OAuthError> {
    match body.get("access_token").and_then(Value::as_str) {
        Some(token) if (200..300).contains(&status) && !token.is_empty() => Ok(token.to_owned()),
        _ => Err(OAuthError(
            ["error_description", "error"]
                .iter()
                .find_map(|k| body.get(*k).and_then(Value::as_str))
                .map_or_else(|| format!("HTTP {status}"), str::to_owned),
        )),
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn s256_challenge_matches_the_rfc_7636_example() {
        let verifier = URL_SAFE_NO_PAD.decode("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk").unwrap();
        let pkce = Pkce::from_bytes(&verifier, &[0; 16]);
        assert_eq!(pkce.verifier, "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk");
        assert_eq!(pkce.challenge, "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
    }

    #[test]
    fn each_sign_in_draws_its_own_secrets() {
        let (a, b) = (Pkce::new().unwrap(), Pkce::new().unwrap());
        assert_ne!(a.verifier, b.verifier);
        assert_ne!(a.state, b.state);
        assert_eq!(a.verifier.len(), 43);
    }

    #[test]
    fn the_redirect_is_only_accepted_for_our_state() {
        let pkce = Pkce { verifier: "v".into(), challenge: "c".into(), state: "abc".into() };
        assert_eq!(pkce.code_from_redirect(&format!("{KCHAT_REDIRECT}?code=xyz&state=abc")).unwrap(), "xyz");
        assert!(pkce.code_from_redirect(&format!("{KCHAT_REDIRECT}?code=xyz&state=other")).is_err());
        assert!(pkce.code_from_redirect(&format!("{KCHAT_REDIRECT}?code=&state=abc")).is_err());
        assert!(pkce.code_from_redirect("https://evil.example/?code=xyz&state=abc").is_err());
        let refused = pkce.code_from_redirect(&format!("{KCHAT_REDIRECT}?error=access_denied&state=abc"));
        assert_eq!(refused.unwrap_err().0, "access_denied");
    }

    #[test]
    fn the_authorize_url_asks_for_s256_and_our_redirect() {
        let pkce = Pkce { verifier: "v".into(), challenge: "c".into(), state: "abc".into() };
        let url = Url::parse(&pkce.authorize_url()).unwrap();
        let get = |k: &str| url.query_pairs().find(|(key, _)| key == k).map(|(_, v)| v.into_owned());
        assert_eq!(url.host_str(), Some("login.infomaniak.com"));
        assert_eq!(get("code_challenge_method").as_deref(), Some("S256"));
        assert_eq!(get("redirect_uri").as_deref(), Some(KCHAT_REDIRECT));
        assert_eq!(get("client_id").as_deref(), Some(KCHAT_CLIENT_ID));
        assert_eq!(get("state").as_deref(), Some("abc"));
    }

    #[test]
    fn only_infomaniak_pages_and_the_redirect_are_recognised() {
        assert!(is_sign_in_page("https://login.infomaniak.com/authorize?x=1"));
        assert!(!is_sign_in_page("http://login.infomaniak.com/"));
        assert!(!is_sign_in_page("https://infomaniak.com.evil.example/"));
        assert!(is_redirect("com.infomaniak.chat://oauth2redirect?code=1"));
        assert!(!is_redirect("https://login.infomaniak.com/"));
    }

    #[test]
    fn the_token_answer_is_read_or_explained() {
        assert_eq!(token_from_answer(200, &json!({"access_token": "ik"})).unwrap(), "ik");
        let refused = json!({"error": "invalid_grant", "error_description": "Code expired"});
        assert_eq!(token_from_answer(400, &refused).unwrap_err().0, "Code expired");
        assert_eq!(token_from_answer(502, &Value::Null).unwrap_err().0, "HTTP 502");
    }
}
