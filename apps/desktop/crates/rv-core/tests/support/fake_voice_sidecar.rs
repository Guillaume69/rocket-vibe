//! Speaks the rv-voice sidecar protocol without any audio, for tests/voice.rs.
//! Argument `old`: announce another protocol version; `silent`: never say hello.
//! Connect URLs: `fake://crash` exits without a word, `fake://refused` fails to
//! connect, `fake://moved` is taken over by another device right after joining.
//! The token is used as the local identity, followed by `#<key>` in an
//! encrypted session (the key `SetKey` replaces), so tests see what it got.
use rv_voice_protocol::{Command, ConnectionState, Device, Event, Participant, VERSION};
use std::io::{BufRead, Write};

fn emit(event: Event) {
    let mut out = std::io::stdout().lock();
    let _ = writeln!(out, "{}", event.line());
    let _ = out.flush();
}

fn ended(reason: &str) {
    emit(Event::State { state: ConnectionState::Disconnected });
    emit(Event::Disconnected { reason: reason.into() });
}

fn main() {
    match std::env::args().nth(1).as_deref() {
        Some("silent") => return std::thread::sleep(std::time::Duration::from_secs(30)),
        Some("old") => emit(Event::Hello { version: VERSION + 1, sidecar: "old".into() }),
        _ => emit(Event::Hello { version: VERSION, sidecar: "fake".into() }),
    }
    let mut me = Participant {
        identity: String::new(),
        local: true,
        muted: false,
        deafened: false,
        speaking: false,
        level: 0.0,
        camera: false,
        screen: false,
    };
    let peer = Participant {
        identity: "peer".into(),
        local: false,
        muted: false,
        deafened: false,
        speaking: true,
        level: 0.4,
        camera: false,
        screen: false,
    };
    let mut connected = false;
    let publish = |me: &Participant| emit(Event::Participants { participants: vec![me.clone(), peer.clone()] });
    for line in std::io::stdin().lock().lines() {
        let Ok(line) = line else { break };
        let Ok(command) = serde_json::from_str::<Command>(&line) else {
            emit(Event::Error { code: "invalid_command".into() });
            continue;
        };
        match command {
            Command::Connect { url, token, e2ee_key } => {
                match url.as_str() {
                    "fake://crash" => std::process::exit(3),
                    "fake://refused" => return ended("connect_failed"),
                    _ => {}
                }
                me.identity = match e2ee_key {
                    Some(key) => format!("{token}#{key}"),
                    None => token,
                };
                emit(Event::State { state: ConnectionState::Connecting });
                emit(Event::State { state: ConnectionState::Connected });
                connected = true;
                publish(&me);
                if url == "fake://moved" {
                    return ended("duplicate_identity");
                }
            }
            Command::SetMicrophone { enabled } => {
                me.muted = !enabled;
                if connected {
                    publish(&me);
                }
            }
            Command::SetDeafened { deafened } => {
                me.deafened = deafened;
                if connected {
                    publish(&me);
                }
            }
            Command::ListDevices => emit(Event::Devices {
                inputs: vec![Device { id: "mic-1".into(), name: "Fake microphone".into(), default: true }],
                outputs: vec![Device { id: "spk-1".into(), name: "Fake speakers".into(), default: true }],
            }),
            Command::SetInput { device } | Command::SetOutput { device } => {
                if !["", "mic-1", "spk-1"].contains(&device.as_str()) {
                    emit(Event::Error { code: "device_not_found".into() });
                }
            }
            Command::SetKey { key } => {
                let Some((token, _)) = me.identity.split_once('#') else {
                    emit(Event::Error { code: "not_encrypted".into() });
                    continue;
                };
                me.identity = format!("{token}#{key}");
                publish(&me);
            }
            Command::Disconnect => return ended("client_initiated"),
        }
    }
}
