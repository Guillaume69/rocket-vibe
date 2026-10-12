//! Synthetic IPC peer. It never contacts WhatsApp.
use serde_json::{Value, json};

/// A 32x32 blue PNG: a photo the render shows plainly.
const PHOTO: &str = "iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAKklEQVR42mOQq7hDU8QwasGoBaMWjFowasGoBaMWjFowasGoBaMWDBULAKHFyEyREEL5AAAAAElFTkSuQmCC";
use std::io::{self, BufRead};
fn main() {
    let mut input = io::stdin().lock().lines();
    let Some(Ok(first)) = input.next() else { return };
    let init: Value = serde_json::from_str(&first).expect("init");
    assert_eq!(init["type"], "start");
    // Like the real helper: the replayed cache, then a pairing attempt.
    println!("{}", json!({"type":"status","state":"loaded"}));
    // A frame of a newer helper: the client skips it.
    println!("{}", json!({"type":"a_frame_from_a_newer_helper","value":1}));
    println!("{}", json!({"type":"status","state":"connecting"}));
    println!("{}", json!({"type":"qr","code":"RV-WHATSAPP-TEST-NOT-A-LOGIN","expires_ms":60000}));
    for line in input {
        let command: Value = serde_json::from_str(&line.expect("line")).expect("command");
        match command["type"].as_str() {
            Some("connect") => {
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
            }
            Some("logout") => {
                println!("{}", json!({"type":"status","state":"logged_out"}));
                break;
            }
            Some("stop") => break,
            _ => panic!("unexpected command"),
        }
    }
}
