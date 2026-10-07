//! Speaks the rv-voice sidecar protocol without any audio, for tests/voice.rs.
//! Argument `old`: announce another protocol version; `silent`: never say hello.
//! Connect URLs: `fake://crash` exits without a word, `fake://refused` fails to
//! connect, `fake://moved` is taken over by another device right after joining.
//! `fake://no-screen` cancels every screen share as a closed picker would.
//! The token is used as the local identity, followed by `#<key>` in an
//! encrypted session (the key `SetKey` replaces), so tests see what it got.
//! Video: once connected, a 4 by 2 frame of `peer`'s camera; the camera and the
//! screen send a 2 by 2 preview of this side, and an end marker when stopped.
//! `ListScreens` names one screen and one window, with a 2 by 2 thumbnail of the
//! window; `SetInputVolume` answers an input level of half the volume.
use rv_voice_protocol::frames::{self, Header, Source};
use rv_voice_protocol::{
    Command, ConnectionState, Device, Event, Participant, ScreenKind, ScreenSource, VERSION, thumbnail,
};
use std::io::{BufRead, Write};
use std::net::TcpStream;

fn frame(stream: &mut Option<TcpStream>, source: Source, identity: &str, width: u32, height: u32) {
    let pixels = vec![200u8; (width * height * 4) as usize];
    let header = Header { source, identity: identity.into(), width, height };
    if let Some(stream) = stream {
        let _ = stream.write_all(&frames::message(&header, &pixels));
    }
}

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
    let mut url = String::new();
    let mut video: Option<TcpStream> = None;
    let publish = |me: &Participant| emit(Event::Participants { participants: vec![me.clone(), peer.clone()] });
    for line in std::io::stdin().lock().lines() {
        let Ok(line) = line else { break };
        let Ok(command) = serde_json::from_str::<Command>(&line) else {
            emit(Event::Error { code: "invalid_command".into() });
            continue;
        };
        match command {
            Command::Connect { url: joined, token, e2ee_key } => {
                url = joined;
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
                frame(&mut video, Source::Camera, "peer", 4, 2);
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
            Command::Video { address, token } => {
                video = TcpStream::connect(address).ok();
                if let Some(stream) = &mut video {
                    let _ = stream.write_all(&frames::handshake(&token));
                }
            }
            Command::SetCamera { enabled } => {
                me.camera = enabled;
                let identity = me.identity.clone();
                if enabled {
                    frame(&mut video, Source::Camera, &identity, 2, 2)
                } else {
                    frame(&mut video, Source::Camera, &identity, 0, 0)
                }
                publish(&me);
            }
            // The preview's width tells the test whether the call's voices were
            // asked for, its height the chosen quality's lines by 360.
            Command::StartScreenShare { with_call, source: _, quality } => {
                if url == "fake://no-screen" {
                    emit(Event::Error { code: "screen_cancelled".into() });
                    continue;
                }
                me.screen = true;
                let identity = me.identity.clone();
                let height = quality.map_or(2, |q| q.height / 360);
                frame(&mut video, Source::Screen, &identity, if with_call { 4 } else { 2 }, height);
                publish(&me);
            }
            Command::ListScreens => {
                emit(Event::Screens {
                    screens: vec![
                        ScreenSource { id: "screen:0".into(), kind: ScreenKind::Screen, title: String::new() },
                        ScreenSource { id: "window:7".into(), kind: ScreenKind::Window, title: "Editor".into() },
                    ],
                });
                frame(&mut video, Source::Screen, &thumbnail("window:7"), 2, 2);
            }
            Command::SetInputVolume { volume } => emit(Event::InputLevel { level: volume / 2.0 }),
            Command::SetParticipantVolume { .. }
            | Command::SetOutputVolume { .. }
            | Command::SetNoiseSuppression { .. } => {}
            Command::StopScreenShare => {
                me.screen = false;
                let identity = me.identity.clone();
                frame(&mut video, Source::Screen, &identity, 0, 0);
                publish(&me);
            }
            Command::Disconnect => return ended("client_initiated"),
        }
    }
}
