//! The peer of the GTK reload benchmark (`apps/desktop/scripts/native-reload-smoke.sh`).
//! It fills an open room and a dozen others for `reload-gtk`, then, once GTK has
//! the open room on screen, sends a timed burst: one message in three to the open
//! room, the rest elsewhere. GTK's `rocket-vibe-reload` trace measures what each
//! change costs, the case at stake being traffic in rooms that are not on screen.
//! Markers are files in `RV_RELOAD_DIR`: `ready` (rooms filled), `open` (written by
//! GTK), `done` (burst sent).
use std::path::Path;
use std::time::Duration;

use rv_client::NativeClient;
use rv_protocol::{CreateRoom, SendMessage};

const OTHER_ROOMS: usize = 12;
const HISTORY: usize = 300;
const BURST: usize = 60;
const BURST_GAP: Duration = Duration::from_millis(250);

fn operation() -> String {
    format!("{:032x}", fastrand::u128(..))
}

fn message(text: String) -> SendMessage {
    SendMessage { cards: Vec::new(), reply_to: None, quotes: vec![], operation_id: operation(), text, files: vec![] }
}

async fn room(client: &NativeClient, name: &str, member: &str) -> String {
    let room = client
        .create_room(&CreateRoom { name: name.into(), private: false, operation_id: Some(operation()), voice: false })
        .await
        .expect("create a benchmark room");
    client.add_member(&room.id, member).await.expect("add reload-gtk to the room");
    room.id
}

async fn wait_for(path: &Path) {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(180);
    while !path.exists() {
        assert!(tokio::time::Instant::now() < deadline, "GTK never wrote {}", path.display());
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

#[tokio::main]
async fn main() {
    let base = std::env::var("RV_PEER_URL").unwrap();
    let password = std::env::var("RV_PEER_PASSWORD").unwrap();
    let dir = std::path::PathBuf::from(std::env::var("RV_RELOAD_DIR").unwrap());
    let mut client = NativeClient::new(&base).unwrap();
    client.login("reload-peer", &password).await.expect("reload-peer signs in");
    let gtk = client
        .users()
        .await
        .unwrap()
        .into_iter()
        .find(|u| u.username == "reload-gtk")
        .expect("the reload-gtk account exists")
        .id;

    let open = room(&client, "Reload plain", &gtk).await;
    let mut others = Vec::new();
    for i in 0..OTHER_ROOMS {
        others.push(room(&client, &format!("Reload other {i}"), &gtk).await);
    }
    for i in 0..HISTORY {
        client.send(&open, &message(format!("history {i}"))).await.unwrap();
    }
    std::fs::write(dir.join("ready"), "").unwrap();
    println!("reload peer: {} rooms, {HISTORY} messages of history", OTHER_ROOMS + 1);

    wait_for(&dir.join("open")).await;
    let started = tokio::time::Instant::now();
    for i in 0..BURST {
        let target = if i % 3 == 0 { &open } else { &others[i % OTHER_ROOMS] };
        client.send(target, &message(format!("burst {i}"))).await.unwrap();
        tokio::time::sleep(BURST_GAP).await;
    }
    std::fs::write(dir.join("done"), "").unwrap();
    println!("reload peer: {BURST} messages in {:.1} s", started.elapsed().as_secs_f64());
}
