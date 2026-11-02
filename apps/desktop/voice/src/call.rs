//! A call carried natively for a provider other than LiveKit: rv-call speaks the
//! provider's signalling (Jitsi Meet for now), this drives one libwebrtc peer
//! connection with it, and the audio goes through the same chain as LiveKit's
//! (audio.rs: devices, echo canceller, noise remover, per-person mix). Audio only.

use std::collections::HashMap;
use std::time::Duration;

use livekit::webrtc::ice_candidate::IceCandidate;
use livekit::webrtc::media_stream_track::MediaStreamTrack;
use livekit::webrtc::peer_connection::{AnswerOptions, PeerConnection, PeerConnectionState};
use livekit::webrtc::peer_connection_factory::native::PeerConnectionFactoryExt;
use livekit::webrtc::peer_connection_factory::{IceServer, PeerConnectionFactory, RtcConfiguration};
use livekit::webrtc::session_description::{SdpType, SessionDescription};
use rv_call::{CallSignaling, Candidate, Event as CallEvent, Member as CallMember};
use rv_voice_protocol::{Command, ConnectionState as State, Event, Participant};
use tokio::sync::mpsc;

use crate::{audio, diagnose, emit, error, level, report};

enum Peer {
    Candidate(IceCandidate),
    State(PeerConnectionState),
    Track { stream: String, id: String, track: livekit::webrtc::audio_track::RtcAudioTrack },
}

/// Runs one call until it ends, then reports `Disconnected`.
pub async fn run<S: CallSignaling>(
    joining: impl std::future::Future<Output = Result<S, rv_call::Error>>,
    fake: bool,
    commands: &mut mpsc::UnboundedReceiver<Result<Command, ()>>,
) {
    emit(Event::State { state: State::Connecting });
    let mut session = match joining.await {
        Ok(session) => session,
        Err(e) => {
            diagnose(&format!("call: join failed: {e}"));
            emit(Event::State { state: State::Disconnected });
            emit(Event::Disconnected { reason: "connect_failed".into() });
            return;
        }
    };
    let mix = audio::Mix::new();
    let (mut sound, input, output) = audio::Audio::start(mix.clone(), fake, "", "");
    report((input, output));
    let factory = PeerConnectionFactory::default();
    let microphone = factory.create_audio_track("microphone", sound.source.clone());
    let (peer_tx, mut peer_rx) = mpsc::unbounded_channel();
    let mut call = Call {
        mix,
        pc: None,
        ice: Vec::new(),
        roster: Vec::new(),
        heard: HashMap::new(),
        microphone: true,
        deafened: false,
        connected: false,
        input_level: 0.0,
        last: None,
    };
    let mut activity = tokio::time::interval(Duration::from_millis(100));
    activity.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let reason = loop {
        tokio::select! {
            command = commands.recv() => match command {
                None | Some(Ok(Command::Disconnect)) => {
                    session.leave().await;
                    break "client_initiated".to_owned();
                }
                Some(Err(())) => error("invalid_command"),
                Some(Ok(Command::SetMicrophone { enabled })) => {
                    call.microphone = enabled;
                    call.apply(&microphone);
                    let _ = session.set_muted(!enabled).await;
                }
                Some(Ok(Command::SetDeafened { deafened })) => {
                    call.deafened = deafened;
                    call.mix.set_deafened(deafened);
                    call.apply(&microphone);
                }
                Some(Ok(Command::ListDevices)) => {
                    let (inputs, outputs) = audio::devices();
                    emit(Event::Devices { inputs, outputs });
                }
                Some(Ok(Command::SetInput { device })) => report((sound.set_input(&device), audio::Opened::Chosen)),
                Some(Ok(Command::SetOutput { device })) => report((audio::Opened::Chosen, sound.set_output(&device))),
                Some(Ok(Command::SetParticipantVolume { identity, volume, muted })) => call.mix.set_gain(&identity, volume, muted),
                Some(Ok(Command::SetInputVolume { volume })) => call.mix.set_input_volume(volume),
                Some(Ok(Command::SetOutputVolume { volume })) => call.mix.set_output_volume(volume),
                Some(Ok(Command::SetNoiseSuppression { enabled })) => call.mix.set_denoise(enabled),
                Some(Ok(_)) => error("unsupported"),
            },
            event = session.next_event() => match event {
                None => break "other".to_owned(),
                Some(CallEvent::Ended(reason)) => break reason,
                Some(CallEvent::IceServers(servers)) => {
                    call.ice = servers
                        .into_iter()
                        .map(|s| IceServer { urls: s.urls, username: s.username, password: s.credential })
                        .collect();
                }
                Some(CallEvent::Offer { sdp }) => {
                    if call.pc.is_none() {
                        match open(&factory, call.ice.clone(), peer_tx.clone()) {
                            Ok(pc) => {
                                if pc.add_track(MediaStreamTrack::Audio(microphone.clone()), &[session.local_id()]).is_err() {
                                    error("publish_failed");
                                }
                                call.pc = Some(pc);
                                call.apply(&microphone);
                            }
                            Err(e) => {
                                diagnose(&format!("call: peer connection: {e}"));
                                session.leave().await;
                                break "connect_failed".to_owned();
                            }
                        }
                    }
                    let Some(pc) = &call.pc else { continue };
                    match negotiate(pc, &sdp).await {
                        Ok(answer) => {
                            if session.answer(&answer).await.is_err() {
                                break "other".to_owned();
                            }
                        }
                        Err(e) => diagnose(&format!("call: negotiation: {e}")),
                    }
                }
                Some(CallEvent::RemoteCandidate(c)) => {
                    if let (Some(pc), Ok(candidate)) = (&call.pc, IceCandidate::parse(&c.mid, 0, &c.line)) {
                        let _ = pc.add_ice_candidate(candidate).await;
                    }
                }
                Some(CallEvent::Roster(members)) => {
                    call.roster = members;
                    call.publish(session.local_id());
                }
            },
            Some(peer) = peer_rx.recv() => match peer {
                Peer::Candidate(c) => {
                    let _ = session.local_candidate(Candidate { mid: c.sdp_mid(), line: c.candidate() }).await;
                }
                Peer::State(PeerConnectionState::Connected) if !call.connected => {
                    call.connected = true;
                    emit(Event::State { state: State::Connected });
                }
                Peer::State(PeerConnectionState::Failed) => {
                    session.leave().await;
                    break "connection_failed".to_owned();
                }
                Peer::State(_) => {}
                Peer::Track { stream, id, track } => {
                    let task = sound.listen_rtc(id.clone(), stream, true, track);
                    if let Some(old) = call.heard.insert(id, task) {
                        old.abort();
                    }
                }
            },
            _ = activity.tick() => call.tick(session.local_id()),
        }
    };
    for (_, task) in call.heard.drain() {
        task.abort();
    }
    if let Some(pc) = call.pc.take() {
        pc.close();
    }
    drop(sound);
    emit(Event::State { state: State::Disconnected });
    emit(Event::Disconnected { reason });
}

fn open(
    factory: &PeerConnectionFactory,
    ice_servers: Vec<IceServer>,
    events: mpsc::UnboundedSender<Peer>,
) -> Result<PeerConnection, String> {
    let mut config = RtcConfiguration::default();
    config.ice_servers = ice_servers;
    let pc = factory.create_peer_connection(config).map_err(|e| format!("{e:?}"))?;
    let tx = events.clone();
    pc.on_ice_candidate(Some(Box::new(move |c| {
        let _ = tx.send(Peer::Candidate(c));
    })));
    let tx = events.clone();
    pc.on_connection_state_change(Some(Box::new(move |state| {
        let _ = tx.send(Peer::State(state));
    })));
    pc.on_track(Some(Box::new(move |event| {
        if let MediaStreamTrack::Audio(track) = event.track {
            let stream = event.streams.first().map(|s| s.id()).unwrap_or_default();
            let id = track.id();
            let _ = events.send(Peer::Track { stream, id, track });
        }
    })));
    Ok(pc)
}

/// The remote offer set, and the local answer made and set: its SDP.
async fn negotiate(pc: &PeerConnection, offer: &str) -> Result<String, String> {
    let offer = SessionDescription::parse(offer, SdpType::Offer).map_err(|e| format!("offer: {e:?}"))?;
    pc.set_remote_description(offer).await.map_err(|e| format!("remote: {e:?}"))?;
    let answer = pc.create_answer(AnswerOptions::default()).await.map_err(|e| format!("answer: {e:?}"))?;
    let sdp = answer.to_string();
    pc.set_local_description(answer).await.map_err(|e| format!("local: {e:?}"))?;
    Ok(sdp)
}

struct Call {
    mix: std::sync::Arc<audio::Mix>,
    pc: Option<PeerConnection>,
    ice: Vec<IceServer>,
    roster: Vec<CallMember>,
    heard: HashMap<String, tokio::task::JoinHandle<()>>,
    microphone: bool,
    deafened: bool,
    connected: bool,
    input_level: f32,
    last: Option<Vec<Participant>>,
}

impl Call {
    fn apply(&self, track: &livekit::webrtc::audio_track::RtcAudioTrack) {
        let sending = self.microphone && !self.deafened;
        self.mix.set_sending(sending);
        track.set_enabled(sending);
    }

    fn tick(&mut self, me: &str) {
        let level_now = (self.mix.input_level() * 50.0).round() / 50.0;
        if level_now != self.input_level {
            self.input_level = level_now;
            emit(Event::InputLevel { level: level_now });
        }
        self.publish(me);
    }

    fn publish(&mut self, me: &str) {
        let (speaking, loud) = self.mix.activity("", true);
        let muted = !self.microphone || self.deafened;
        let mut participants = vec![Participant {
            identity: me.to_owned(),
            local: true,
            muted,
            deafened: self.deafened,
            speaking: speaking && !muted,
            level: if muted { 0.0 } else { level(loud) },
            camera: false,
            screen: false,
            name: None,
        }];
        for m in &self.roster {
            let (speaking, loud) = self.mix.activity(&m.id, false);
            participants.push(Participant {
                identity: m.id.clone(),
                local: false,
                muted: m.muted,
                deafened: false,
                speaking,
                level: level(loud),
                camera: false,
                screen: false,
                name: Some(m.name.clone()),
            });
        }
        if self.last.as_ref() != Some(&participants) {
            self.last = Some(participants.clone());
            emit(Event::Participants { participants });
        }
    }
}
