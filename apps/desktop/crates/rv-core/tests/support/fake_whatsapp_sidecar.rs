//! Synthetic IPC peer. It never contacts WhatsApp.
use serde_json::{Value, json};

/// A 32x32 blue PNG: a photo the render shows plainly.
const PHOTO: &str = "iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAKklEQVR42mOQq7hDU8QwasGoBaMWjFowasGoBaMWjFowasGoBaMWDBULAKHFyEyREEL5AAAAAElFTkSuQmCC";
use std::io::{self, BufRead};
/// What a linked device receives once connected: conversations, names, a
/// photo, a reaction, a reply, an unread count, the account.
fn linked() {
    // A photo and a voice note: their files come with `download`.
    println!(
        "{}",
        json!({"type":"message","message":{
            "id":"alice@s.whatsapp.net:fake-photo","chat":"alice@s.whatsapp.net","name":"Alice",
            "sender":"alice@s.whatsapp.net","author":"Alice","text":"La vue d'ici",
            "ts":1791810604000_i64,"mine":false,"kind":"image","mime":"image/png","width":32,"height":32,"size":132
        }})
    );
    println!(
        "{}",
        json!({"type":"message","message":{
            "id":"alice@s.whatsapp.net:fake-voice","chat":"alice@s.whatsapp.net","name":"Alice",
            "sender":"alice@s.whatsapp.net","author":"Alice","text":"",
            "ts":1791810606000_i64,"mine":false,"kind":"voice","mime":"audio/ogg; codecs=opus","seconds":7,"size":4000
        }})
    );
    println!(
        "{}",
        json!({"type":"message","message":{
            "id":"alice@s.whatsapp.net:fake-received","chat":"alice@s.whatsapp.net","name":"Alice",
            "sender":"alice@s.whatsapp.net","author":"Alice","text":"Bonjour ! On se retrouve ce soir ?",
            "ts":1791810600000_i64,"mine":false
        }})
    );
    println!(
        "{}",
        json!({"type":"message","message":{
            "id":"friends@g.us:fake-group","chat":"friends@g.us","name":"Les amis",
            "sender":"bob@s.whatsapp.net","author":"Bob","text":"Le groupe est prêt.",
            "ts":1791810000000_i64,"mine":false
        }})
    );
    println!(
        "{}",
        json!({"type":"names","names":{
            "alice@s.whatsapp.net":"Alice Martin","friends@g.us":"Les amis","bob@s.whatsapp.net":"Bob"
        }})
    );
    println!("{}", json!({"type":"avatar","jid":"alice@s.whatsapp.net","data":PHOTO}));
    println!("{}", json!({"type":"avatar","jid":"33600000000@s.whatsapp.net","data":PHOTO}));
    println!(
        "{}",
        json!({"type":"reaction","reaction":{
            "message":"alice@s.whatsapp.net:fake-received","sender":"alice@s.whatsapp.net","emoji":"❤️","ts":1
        }})
    );
    println!(
        "{}",
        json!({"type":"message","message":{
            "id":"alice@s.whatsapp.net:fake-reply","chat":"alice@s.whatsapp.net","name":"Alice",
            "sender":"alice@s.whatsapp.net","author":"Alice","text":"Vers 20 h ?",
            "ts":1791810610000_i64,"mine":false,"reply_to":"alice@s.whatsapp.net:fake-received",
            "quote_sender":"alice@s.whatsapp.net","quote_text":"Bonjour ! On se retrouve ce soir ?"
        }})
    );
    println!("{}", json!({"type":"chat","jid":"friends@g.us","unread":2}));
    println!("{}", json!({"type":"account","jid":"33600000000@s.whatsapp.net","name":"Moi-même"}));
    println!("{}", json!({"type":"status","state":"connected"}));
}
fn now() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as i64)
}
fn main() {
    let mut input = io::stdin().lock().lines();
    let Some(Ok(first)) = input.next() else { return };
    let init: Value = serde_json::from_str(&first).expect("init");
    assert_eq!(init["type"], "start");
    // A state file reading "paired" is an account already linked: it connects
    // at once, like the real helper; otherwise a pairing attempt.
    let args: Vec<String> = std::env::args().collect();
    let paired = args
        .iter()
        .position(|a| a == "--state")
        .and_then(|i| std::fs::read_to_string(&args[i + 1]).ok())
        .is_some_and(|content| content.starts_with("paired"));
    println!("{}", json!({"type":"status","state":"loaded"}));
    // A frame of a newer helper: the client skips it.
    println!("{}", json!({"type":"a_frame_from_a_newer_helper","value":1}));
    println!("{}", json!({"type":"status","state":"connecting"}));
    if paired {
        linked();
    } else {
        println!("{}", json!({"type":"qr","code":"RV-WHATSAPP-TEST-NOT-A-LOGIN","expires_ms":60000}));
        // The GTK smoke's stand-in for a phone scanning the QR.
        if let Some(delay) = std::env::var("RV_FAKE_WHATSAPP_SCAN_MS").ok().and_then(|v| v.parse().ok()) {
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(delay));
                linked();
            });
        }
    }
    for line in input {
        let command: Value = serde_json::from_str(&line.expect("line")).expect("command");
        match command["type"].as_str() {
            Some("connect") => {
                linked();
            }
            // A pairing code for any number long enough to be international.
            Some("pair_phone") => {
                let digits = command["text"].as_str().unwrap_or_default();
                if digits.len() >= 8 {
                    println!("{}", json!({"type":"pairing_code","code":"RVWA2468"}));
                } else {
                    println!("{}", json!({"type":"error","code":"phone_invalid"}));
                }
            }
            // Bob in the contacts; any number WhatsApp "knows".
            // A file sent: a voice note when recorded, a photo when an image.
            Some("upload") => {
                let mime = command["mime"].as_str().unwrap_or_default();
                let kind = if command["voice"] == true {
                    "voice"
                } else if mime.starts_with("image/") {
                    "image"
                } else {
                    "document"
                };
                println!(
                    "{}",
                    json!({"type":"message","message":{
                        "id":format!("{}:{}",command["chat"].as_str().unwrap(),command["id"].as_str().unwrap()),
                        "chat":command["chat"],"name":"Alice","sender":"me","author":"","text":command["text"],
                        "ts":1791810670000_i64,"mine":true,"status":"","kind":kind,"mime":mime,
                        "file_name":command["name"],"size":132,"width":32,"height":32
                    }})
                );
                println!("{}", json!({"type":"sent","id":command["id"],"state":""}));
            }
            // The photo is the PNG above; the voice note only needs to exist.
            Some("download") => {
                let id = command["id"].as_str().unwrap_or_default();
                let bytes = match id {
                    "alice@s.whatsapp.net:fake-photo" => {
                        use base64::Engine;
                        base64::engine::general_purpose::STANDARD.decode(PHOTO).unwrap_or_default()
                    }
                    "alice@s.whatsapp.net:fake-voice" => vec![0_u8; 64],
                    _ => Vec::new(),
                };
                let path = std::env::temp_dir().join(format!("rv-fake-whatsapp-{}", id.replace([':', '@'], "_")));
                let path = if !bytes.is_empty() && std::fs::write(&path, bytes).is_ok() {
                    path.to_string_lossy().into_owned()
                } else {
                    String::new()
                };
                println!("{}", json!({"type":"file","id":id,"path":path}));
            }
            Some("search") => {
                let text = command["text"].as_str().unwrap_or_default().to_lowercase();
                let digits: String = text.chars().filter(char::is_ascii_digit).collect();
                let people = if text.contains("bob") {
                    json!([{"jid":"bob@s.whatsapp.net","name":"Bob"}])
                } else if digits.len() >= 6 {
                    json!([{"jid":format!("{digits}@s.whatsapp.net"),"name":format!("+{digits}")}])
                } else {
                    json!([])
                };
                println!("{}", json!({"type":"found","id":command["id"],"people":people}));
            }
            Some("read") => {
                println!("{}", json!({"type":"chat","jid":command["chat"],"unread":0}));
            }
            Some("react") => {
                println!(
                    "{}",
                    json!({"type":"reaction","reaction":{"message":command["id"],"sender":"me","emoji":command["text"],"ts":2}})
                );
            }
            Some("send") if command["chat"] == "refused@s.whatsapp.net" => {
                println!("{}", json!({"type":"error","code":"invalid_send","id":command["id"]}));
            }
            Some("send") => {
                println!(
                    "{}",
                    json!({"type":"message","message":{
                        "id":format!("{}:{}",command["chat"].as_str().unwrap(),command["id"].as_str().unwrap()),
                        "chat":command["chat"],"name":"Alice","sender":"me","author":"",
                        "text":command["text"],"ts":1791810660000_i64,"mine":true,"status":"","receipt":"read"
                    }})
                );
                println!("{}", json!({"type":"sent","id":command["id"],"state":""}));
                // A contact who answers at once: a new message to notify.
                if command["chat"] == "ping@s.whatsapp.net" {
                    println!(
                        "{}",
                        json!({"type":"message","message":{
                            "id":format!("ping@s.whatsapp.net:pong-{}", command["id"].as_str().unwrap()),
                            "chat":"ping@s.whatsapp.net","name":"Ping",
                            "sender":"ping@s.whatsapp.net","author":"Ping","text":"pong","ts":now(),"mine":false
                        }})
                    );
                    println!("{}", json!({"type":"chat","jid":"ping@s.whatsapp.net","unread":1}));
                }
            }
            Some("logout") => {
                println!("{}", json!({"type":"status","state":"logged_out"}));
                break;
            }
            Some("stop") => break,
            // What the window says as it is used, with nothing to answer.
            Some("presence" | "typing" | "reject_call") => {}
            _ => panic!("unexpected command"),
        }
    }
}
