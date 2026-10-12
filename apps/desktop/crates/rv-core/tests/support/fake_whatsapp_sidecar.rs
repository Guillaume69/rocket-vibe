//! Synthetic IPC peer. It never contacts WhatsApp.
use serde_json::{Value, json};
use std::io::{self, BufRead};
fn main() {
    let mut input = io::stdin().lock().lines();
    let Some(Ok(first)) = input.next() else { return };
    let init: Value = serde_json::from_str(&first).expect("init");
    assert_eq!(init["type"], "start");
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
                println!("{}", json!({"type":"status","state":"connected"}));
            }
            Some("send") => {
                println!(
                    "{}",
                    json!({"type":"message","message":{
                        "id":format!("{}:{}",command["chat"].as_str().unwrap(),command["id"].as_str().unwrap()),
                        "chat":command["chat"],"name":"Alice","sender":"me","author":"",
                        "text":command["text"],"ts":1791810660000_i64,"mine":true,"status":""
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
