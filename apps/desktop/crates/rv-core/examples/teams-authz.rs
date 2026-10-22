//! Throwaway host-discovery probe. Device-code sign-in, then prints ONLY the
//! authz regionGtms service map (service URLs; no tokens, no user data).
//!   cargo run -p rv-core --example teams-authz
use rv_core::session::SessionInfo;
use rv_core::teams::TeamsAccount;
use rv_core::teams::auth::{self, Tokens};
use zeroize::Zeroizing;

#[tokio::main]
async fn main() {
    let code = auth::device_code().await.expect("device code");
    eprintln!("\n==> Open {} and enter code: {}\n", code.verification_uri, code.user_code);
    let info: SessionInfo = auth::approved(&code, || false).await.expect("approved");
    let account = info.teams.as_ref().expect("teams account");
    let tokens = Tokens::new(&SessionInfo {
        teams: Some(TeamsAccount {
            tenant_id: account.tenant_id.clone(),
            refresh: Zeroizing::new(account.refresh.as_str().to_owned()),
        }),
        ..info.clone()
    })
    .expect("tokens");
    let map = tokens.region_gtms().await.expect("authz");
    // Print only the service map (URLs), nothing else.
    println!("REGIONGTMS_BEGIN");
    if let Some(obj) = map.as_object() {
        let mut keys: Vec<_> = obj.keys().cloned().collect();
        keys.sort();
        for k in keys {
            println!("{k} = {}", obj[&k].as_str().unwrap_or(""));
        }
    }
    println!("REGIONGTMS_END");
}
