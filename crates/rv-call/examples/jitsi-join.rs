//! Joins a Jitsi room, signalling only, and prints what arrives (no media, so
//! an offer is never answered): `cargo run --example jitsi-join -- <meeting url>`
//! with `JITSI_CONFIG_JS` naming a saved copy of the host's `config.js`.

use rv_call::CallSignaling;
use rv_call::jitsi::{Config, join};

#[tokio::main]
async fn main() {
    let url = std::env::args().nth(1).expect("meeting url");
    let config_js =
        std::fs::read_to_string(std::env::var("JITSI_CONFIG_JS").expect("JITSI_CONFIG_JS")).expect("config.js");
    let seconds: u64 = std::env::var("JITSI_SECONDS").ok().and_then(|s| s.parse().ok()).unwrap_or(30);
    // kMeet carries its join token as `?jwt=`, as the app reads it (`voice::meeting_token`).
    let token = url.split_once('?').and_then(|(_, q)| q.split('&').find_map(|p| p.strip_prefix("jwt="))).map(str::to_owned);
    let config = Config::from_meeting(&url, &config_js, "RocketVibe probe", token).expect("config");
    println!("joining room {} on {}", config.room, config.websocket);
    let mut session = match join(config).await {
        Ok(s) => s,
        Err(e) => {
            println!("join failed: {e}");
            return;
        }
    };
    println!("joined as endpoint {}", session.local_id());
    let deadline = tokio::time::sleep(std::time::Duration::from_secs(seconds));
    tokio::pin!(deadline);
    loop {
        tokio::select! {
            event = session.next_event() => match event {
                Some(rv_call::Event::Offer { sdp }) => {
                    let ssrcs = sdp.lines().filter(|l| l.starts_with("a=ssrc:") && l.contains("msid:")).count();
                    let candidates = sdp.lines().filter(|l| l.starts_with("a=candidate:")).count();
                    println!("offer: {} media sections, {ssrcs} remote sources, {candidates} candidates", sdp.matches("\nm=").count());
                }
                Some(rv_call::Event::IceServers(s)) => println!("ice servers: {:?}", s.iter().map(|i| &i.urls).collect::<Vec<_>>()),
                Some(rv_call::Event::Roster(m)) => println!("roster: {:?}", m.iter().map(|m| (&m.id, &m.name, m.muted)).collect::<Vec<_>>()),
                Some(other) => println!("event: {other:?}"),
                None => { println!("session gone"); return; }
            },
            _ = &mut deadline => break,
        }
    }
    session.leave().await;
    println!("left");
}
