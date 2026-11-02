//! Read-only probe: can our refresh token (the Teams desktop/mobile public
//! client) be redeemed for the calling stack's audience,
//! `https://ic3.teams.office.com`, which every calling request of Teams' web
//! app carries (cc.skype.com, conv.skype.com, broker.skype.com, epconv)?
//! Only the user's own account is touched; nothing is sent to the calling
//! stack, no call is created.
//!
//!   TEAMS_PROBE_STORE=/path/to/token.json \
//!     cargo run --example teams-ic3        (from crates/rv-teams)
//!
//! Prints outcomes only (status, error code, and the access token's decoded
//! `aud`, `scp` and `appid`), never a token value. The rotated refresh token
//! is written back so the store stays usable.
//!
//! With `TEAMS_PROBE_IC3_GET=<url>` (an expired broker `subscribe` link from a
//! capture) it also GETs that link without a token and with the minted one:
//! a different answer means the calling stack accepted the token.

use std::fs;

use base64::Engine;
use serde_json::Value;

const LOGIN: &str = "https://login.microsoftonline.com";
const CLIENT: &str = "1fec8e78-bce4-4aaf-ab1b-5451cc387264";

async fn redeem(tenant: &str, refresh: &str, scope: &str) -> (u16, Value) {
    let fields = [("client_id", CLIENT), ("grant_type", "refresh_token"), ("refresh_token", refresh), ("scope", scope)];
    let body = url::form_urlencoded::Serializer::new(String::new()).extend_pairs(&fields).finish();
    let http = reqwest::Client::builder().timeout(std::time::Duration::from_secs(30)).build().unwrap();
    let response = http
        .post(format!("{LOGIN}/{tenant}/oauth2/v2.0/token"))
        .header("content-type", "application/x-www-form-urlencoded")
        .body(body)
        .send()
        .await
        .unwrap();
    let status = response.status().as_u16();
    (status, response.json().await.unwrap_or(Value::Null))
}

fn claims(token: &str) -> Value {
    token
        .split('.')
        .nth(1)
        .and_then(|part| base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(part.trim_end_matches('=')).ok())
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or(Value::Null)
}

#[tokio::main]
async fn main() {
    let path = std::env::var("TEAMS_PROBE_STORE").expect("set TEAMS_PROBE_STORE");
    let mut store: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
    let tenant = store["tenant_id"].as_str().unwrap().to_owned();
    let mut refresh = store["refresh"].as_str().unwrap().to_owned();
    let mut minted = String::new();
    for scope in [
        "https://ic3.teams.office.com/.default openid profile offline_access",
        "https://ic3.teams.office.com/Teams.AccessAsUser.All openid profile offline_access",
    ] {
        let (status, v) = redeem(&tenant, &refresh, scope).await;
        let token = v["access_token"].as_str().unwrap_or("");
        let c = claims(token);
        println!(
            "[{}] status={status} error={:?} access_token={} aud={:?} scp={:?} appid={:?}",
            scope.split(' ').next().unwrap_or(""),
            v["error"].as_str().unwrap_or(""),
            !token.is_empty(),
            c["aud"].as_str().unwrap_or(""),
            c["scp"].as_str().unwrap_or(""),
            c["appid"].as_str().unwrap_or(""),
        );
        if let Some(d) = v["error_description"].as_str() {
            println!("    {}", d.lines().next().unwrap_or("").chars().take(160).collect::<String>());
        }
        if let Some(rotated) = v["refresh_token"].as_str().filter(|t| !t.is_empty()) {
            refresh = rotated.to_owned();
            store["refresh"] = Value::String(refresh.clone());
            let _ = fs::write(&path, serde_json::to_vec_pretty(&store).unwrap());
        }
        if !token.is_empty() {
            minted = token.to_owned();
        }
    }
    let Ok(link) = std::env::var("TEAMS_PROBE_IC3_GET") else { return };
    let http = reqwest::Client::builder().timeout(std::time::Duration::from_secs(30)).build().unwrap();
    for (tag, bearer) in [("no token", None), ("ic3 token", Some(&minted))] {
        let mut request = http.get(&link);
        if let Some(bearer) = bearer.filter(|b| !b.is_empty()) {
            request = request.bearer_auth(bearer);
        }
        match request.send().await {
            Ok(response) => {
                let status = response.status().as_u16();
                let body = response.text().await.unwrap_or_default();
                println!("[GET {tag}] status={status} body={:?}", body.chars().take(160).collect::<String>());
            }
            Err(e) => println!("[GET {tag}] error={e}"),
        }
    }
}
