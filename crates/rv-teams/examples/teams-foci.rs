//! Read-only probe: can our refresh token be redeemed, under the
//! family-of-client-ids (FOCI) scheme, for the Teams *web* client so a call
//! window could be pre-signed-in? Only the user's own account is touched; no
//! messages, no writes.
//!
//!   TEAMS_PROBE_STORE=/path/to/token.json \
//!     cargo run --example teams-foci        (from crates/rv-teams)
//!
//! It first redeems the stored token for its OWN public client (1fec8e78),
//! which proves the token is live and reports its `foci` flag, then feeds the
//! rotated token to the Teams web client (5e3ce6c0). Prints outcomes only
//! (status, error code, which fields came back, the `foci` flag) and never a
//! token value. The rotated refresh token is written back so the store stays
//! usable.

use std::fs;

use serde_json::Value;

const LOGIN: &str = "https://login.microsoftonline.com";
const OWN_CLIENT: &str = "1fec8e78-bce4-4aaf-ab1b-5451cc387264";
const WEB_CLIENT: &str = "5e3ce6c0-2b1f-4285-8d4b-75ee78787346";

async fn redeem(tenant: &str, client: &str, refresh: &str, scope: &str) -> (u16, Value) {
    let fields = [
        ("client_id", client),
        ("grant_type", "refresh_token"),
        ("refresh_token", refresh),
        ("scope", scope),
    ];
    let body = url::form_urlencoded::Serializer::new(String::new()).extend_pairs(&fields).finish();
    let http = reqwest::Client::builder().timeout(std::time::Duration::from_secs(30)).build().unwrap();
    let response = http
        .post(format!("{LOGIN}/{tenant}/oauth2/v2.0/token"))
        .header("content-type", "application/x-www-form-urlencoded")
        .header("origin", "https://teams.microsoft.com")
        .body(body)
        .send()
        .await
        .unwrap();
    let status = response.status().as_u16();
    (status, response.json().await.unwrap_or(Value::Null))
}

fn report(tag: &str, status: u16, v: &Value) {
    let present = |k: &str| v[k].as_str().map(|t| !t.is_empty()).unwrap_or(false);
    println!(
        "[{tag}] status={status} error={:?} access_token={} refresh_token={} foci={:?}",
        v["error"].as_str().unwrap_or(""),
        present("access_token"),
        present("refresh_token"),
        v["foci"].as_str().unwrap_or(""),
    );
    if let Some(d) = v["error_description"].as_str() {
        println!("    {}", d.lines().next().unwrap_or("").chars().take(160).collect::<String>());
    }
}

#[tokio::main]
async fn main() {
    let path = std::env::var("TEAMS_PROBE_STORE").expect("set TEAMS_PROBE_STORE");
    let mut store: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
    let tenant = store["tenant_id"].as_str().unwrap().to_owned();
    let mut refresh = store["refresh"].as_str().unwrap().to_owned();

    let save = |store: &mut Value, token: &str| {
        store["refresh"] = Value::String(token.to_owned());
        let _ = fs::write(&path, serde_json::to_vec_pretty(store).unwrap());
    };

    let (status, v) =
        redeem(&tenant, OWN_CLIENT, &refresh, "https://api.spaces.skype.com/.default openid profile offline_access").await;
    report("own 1fec8e78", status, &v);
    match v["refresh_token"].as_str().filter(|t| !t.is_empty()) {
        None => {
            println!("\n==> Stored token is stale; FOCI result inconclusive, re-sign-in to re-probe.");
            return;
        }
        Some(rotated) => {
            refresh = rotated.to_owned();
            save(&mut store, &refresh);
        }
    }

    println!("\n==> FOCI redemption for the Teams web client:");
    for scope in [
        "https://api.spaces.skype.com/.default openid profile offline_access",
        "https://ic3.teams.office.com/.default openid profile offline_access",
    ] {
        let audience = scope.split('/').nth(2).unwrap_or("");
        let (status, v) = redeem(&tenant, WEB_CLIENT, &refresh, scope).await;
        report(&format!("web 5e3ce6c0 [{audience}]"), status, &v);
        if let Some(rotated) = v["refresh_token"].as_str().filter(|t| !t.is_empty()) {
            refresh = rotated.to_owned();
            save(&mut store, &refresh);
        }
    }
}
