//! Throwaway, READ-ONLY shape probe: device-code sign-in, then prints the raw
//! presence/profile/search responses (own data only; search uses an unlikely
//! term) between markers. No message is sent, edited or deleted.
//!   cargo run -p rv-core --example teams-shapes
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
    let me = info.user_id.clone();
    let tokens = Tokens::new(&SessionInfo {
        teams: Some(TeamsAccount {
            tenant_id: account.tenant_id.clone(),
            refresh: Zeroizing::new(account.refresh.as_str().to_owned()),
        }),
        ..info.clone()
    })
    .expect("tokens");
    let shapes = tokens.probe_shapes(&me).await;
    println!("SHAPES_BEGIN");
    println!("{}", serde_json::to_string_pretty(&shapes).unwrap_or_default());
    println!("SHAPES_END");
}
