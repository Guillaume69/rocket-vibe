//! Throwaway: run the Teams core against a real tenant, read-only.
//! Reads a device-code refresh token from ~/.cache/rv-teams-probe/tokens.json
//! (fields refresh_token, tid, oid, name, client), then: catch_up_global,
//! load_history (a text chat, then its older page), and the live Trouter feed
//! for 75 s. Post a message in Teams during the window to see the push arrive.
//! No message is sent, edited or deleted.
//!   cargo run -p rv-core --example teams-probe

use std::sync::Arc;
use std::time::Duration;

use rv_core::mattermost::socket::LiveEvent;
use rv_core::store::Store;
use rv_core::teams::auth::{Tokens, set_credential_sink};
use rv_core::teams::sync::TeamsSync;
use rv_core::teams::{self, Session, TeamsAccount};
use serde_json::Value;
use zeroize::Zeroizing;

fn token_path() -> std::path::PathBuf {
    let home = std::env::var("HOME").expect("HOME");
    std::path::Path::new(&home).join(".cache/rv-teams-probe/tokens.json")
}

#[tokio::main]
async fn main() {
    let path = token_path();
    let raw = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
    let file: Value = serde_json::from_str(&raw).expect("tokens.json is JSON");
    let field = |k: &str| file[k].as_str().unwrap_or_else(|| panic!("tokens.json missing {k}")).to_owned();
    let (tid, oid, name) = (field("tid"), field("oid"), field("name"));
    let user_id = format!("8:orgid:{oid}");

    let info = Session {
        user_id: user_id.clone(),
        username: name.clone(),
        account: TeamsAccount { tenant_id: tid, refresh: Zeroizing::new(field("refresh_token")) },
    };

    // Persist the rotated refresh token so the next run still signs in.
    let sink_path = path.clone();
    set_credential_sink(move |info: &Session| {
        let account = &info.account;
        let Ok(text) = std::fs::read_to_string(&sink_path) else { return };
        let Ok(mut doc) = serde_json::from_str::<Value>(&text) else { return };
        doc["refresh_token"] = Value::String(account.refresh.as_str().to_owned());
        if let Ok(out) = serde_json::to_string(&doc) {
            let mut options = std::fs::OpenOptions::new();
            options.write(true).truncate(true).create(true);
            #[cfg(unix)]
            std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
            if let Ok(mut f) = options.open(&sink_path) {
                use std::io::Write;
                let _ = f.write_all(out.as_bytes());
            }
        }
        println!("[sink] refresh token rotated and saved");
    });

    let tokens = Tokens::new(&info);
    let store = Arc::new(Store::in_memory().expect("store"));
    let sync = TeamsSync::new(store.clone(), tokens.clone(), &user_id, &name);

    println!("== catch_up_global ==");
    match sync.catch_up_global().await {
        Ok(()) => {}
        Err(e) => {
            println!("catch_up_global FAILED: status {} {:?}", e.status, e.error);
            return;
        }
    }
    let rooms = store.rooms();
    println!("rooms: {}", rooms.len());
    for r in &rooms {
        println!("  {} [{}] {:?} last={}", r.rid, r.kind, r.name, r.last_message.is_some());
    }

    println!("== load_history (scanning for a chat with renderable text) ==");
    let mut chosen: Option<(String, Option<i64>)> = None;
    for (n, room) in rooms.iter().enumerate() {
        if n >= 15 {
            println!("  (stopped scanning at 15 rooms)");
            break;
        }
        match sync.load_history(&room.rid, None).await {
            Ok(page) => {
                let stored = store.messages(&room.rid, 1000).len();
                println!("  {} [{}] -> {} raw, {} stored", room.rid, room.kind, page.count, stored);
                if stored > 0 {
                    chosen = Some((room.rid.clone(), page.oldest_ts));
                    break;
                }
            }
            Err(e) => println!("  {} ERR status {} {:?}", room.rid, e.status, e.error),
        }
    }
    match &chosen {
        Some((rid, oldest)) => {
            println!("chosen text chat: {rid} (oldest_ts {oldest:?}), stored now: {}", store.messages(rid, 1000).len());
            println!("== load_history older page ==");
            match sync.load_history(rid, *oldest).await {
                Ok(page) => println!(
                    "  older page -> {} message(s); total stored: {}",
                    page.count,
                    store.messages(rid, 5000).len()
                ),
                Err(e) => println!("  older page ERR status {} {:?}", e.status, e.error),
            }
        }
        None => println!("no chat with text found in the scanned rooms"),
    }

    let secs: u64 = std::env::var("RV_TEAMS_LIVE_SECS").ok().and_then(|v| v.parse().ok()).unwrap_or(75);
    println!("== LIVE: opening Trouter; watching {secs} s - post a message in Teams to see a push ==");
    let sync = Arc::new(sync);
    let (handle, mut rx) = teams::live::spawn(tokens.clone());
    handle.open();
    let mut authenticated = false;
    let mut new_messages = 0u32;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(secs);
    loop {
        let left = deadline.saturating_duration_since(tokio::time::Instant::now());
        if left.is_zero() {
            break;
        }
        match tokio::time::timeout(left, rx.recv()).await {
            Err(_) => break,
            Ok(None) => break,
            Ok(Some(event)) => match event {
                LiveEvent::Authenticated => {
                    if !authenticated {
                        authenticated = true;
                        println!("[live] AUTHENTICATED");
                    }
                }
                LiveEvent::Lost => println!("[live] LOST"),
                LiveEvent::State(s) => println!("[live] state {s:?}"),
                LiveEvent::Event { name, data, .. } => {
                    let rid = rv_core::teams::translate::conversation_of(&data);
                    println!("[live] event {name} conv={rid:?}");
                    if name == "NewMessage" {
                        new_messages += 1;
                    }
                    let _ = sync.apply_event(&name, &data).await;
                }
            },
        }
    }
    handle.close();
    println!("== DONE: authenticated={authenticated} new_messages_seen={new_messages} ==");
}
