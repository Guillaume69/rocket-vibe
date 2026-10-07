//! rv-screen-audio: what this Linux computer plays, as raw 48 kHz stereo
//! 16-bit little-endian PCM on stdout, for rv-voice to publish beside a shared
//! screen. A PipeWire capture node is linked, port by port, to every audio
//! output stream but those of the processes named by `--exclude <pid>` (the
//! call and the app's own sounds); without any, to all of them. It runs until
//! its stdout closes (rv-voice stopped the share, or died).
//!
//! Its own binary because libwebrtc's weak PipeWire stubs would take the place
//! of libpipewire's functions inside rv-voice (Cargo.toml).

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.first().map(String::as_str) == Some("--version") {
        println!("rv-screen-audio {}", env!("CARGO_PKG_VERSION"));
        return;
    }
    let mut excluded = Vec::new();
    let mut rest = args.iter();
    while let Some(arg) = rest.next() {
        match (arg.as_str(), rest.next().and_then(|pid| pid.parse::<u32>().ok())) {
            ("--exclude", Some(pid)) => excluded.push(pid),
            _ => {
                eprintln!("usage: rv-screen-audio [--exclude <pid>]...");
                std::process::exit(2);
            }
        }
    }
    if let Err(error) = capture::run(&excluded) {
        eprintln!("rv-screen-audio: {error}");
        std::process::exit(1);
    }
}

#[cfg(target_os = "linux")]
mod capture {
    use pipewire as pw;
    use pw::properties::properties;
    use pw::spa;
    use pw::types::ObjectType;
    use std::cell::RefCell;
    use std::collections::HashMap;
    use std::io::Write;
    use std::rc::Rc;

    const NODE_NAME: &str = "rv-screen-audio";
    const RATE: u32 = 48_000;
    const CHANNELS: u32 = 2;

    struct Port {
        node: u32,
        output: bool,
        channel: String,
    }

    /// An audio output stream, bound to read its info: the registry's
    /// announcement does not carry its process, its info or its client's does.
    struct Stream {
        info: bool,
        pid: Option<u32>,
        client: Option<u32>,
        _proxy: pw::node::Node,
        _listener: pw::node::NodeListener,
    }

    struct Client {
        /// None until its info arrived.
        pid: Option<Option<u32>>,
        _proxy: pw::client::Client,
        _listener: pw::client::ClientListener,
    }

    /// What the registry told so far, and the links this capture made.
    #[derive(Default)]
    struct Graph {
        excluded: Vec<u32>,
        streams: HashMap<u32, Stream>,
        clients: HashMap<u32, Client>,
        /// Audio output streams whose sound goes into the capture.
        sources: Vec<u32>,
        ours: Option<u32>,
        ports: HashMap<u32, Port>,
        links: HashMap<(u32, u32), pw::link::Link>,
    }

    fn pid(props: Option<&spa::utils::dict::DictRef>, keys: &[&str]) -> Option<u32> {
        let props = props?;
        keys.iter().find_map(|key| props.get(key)).and_then(|pid| pid.parse().ok())
    }

    /// Which of the capture's two channels a source channel feeds.
    fn feeds(channel: &str) -> &'static [&'static str] {
        match channel {
            "FL" | "RL" | "SL" => &["FL"],
            "FR" | "RR" | "SR" => &["FR"],
            "MONO" | "FC" | "LFE" | "" => &["FL", "FR"],
            _ => &[],
        }
    }

    impl Graph {
        /// A stream goes in once its process is known and is not the call's;
        /// one whose process cannot be told goes in too.
        fn decide(&mut self) {
            let mut decided = Vec::new();
            for (id, stream) in &self.streams {
                if !stream.info || self.sources.contains(id) {
                    continue;
                }
                let pid = match (stream.pid, stream.client) {
                    (Some(pid), _) => Some(pid),
                    (None, Some(client)) => match self.clients.get(&client).map(|c| c.pid) {
                        Some(Some(pid)) => pid,
                        // Its client's info has not arrived yet.
                        _ => continue,
                    },
                    (None, None) => None,
                };
                if pid.is_none_or(|pid| !self.excluded.contains(&pid)) {
                    decided.push(*id);
                }
            }
            self.sources.extend(decided);
        }

        /// Links every source port to the capture's matching input port, once.
        fn relink(&mut self, core: &pw::core::CoreRc) {
            let Some(ours) = self.ours else { return };
            let inputs: HashMap<&str, u32> = self
                .ports
                .iter()
                .filter(|(_, p)| p.node == ours && !p.output)
                .map(|(id, p)| (p.channel.as_str(), *id))
                .collect();
            let wanted: Vec<(u32, u32, u32)> = self
                .ports
                .iter()
                .filter(|(_, p)| p.output && self.sources.contains(&p.node))
                .flat_map(|(id, p)| {
                    feeds(&p.channel).iter().filter_map(|c| inputs.get(c)).map(|input| (p.node, *id, *input))
                })
                .collect();
            for (node, output, input) in wanted {
                if self.links.contains_key(&(output, input)) {
                    continue;
                }
                let link = core.create_object::<pw::link::Link>(
                    "link-factory",
                    &properties! {
                        "link.output.node" => node.to_string(),
                        "link.output.port" => output.to_string(),
                        "link.input.node" => ours.to_string(),
                        "link.input.port" => input.to_string(),
                        "object.linger" => "false",
                    },
                );
                if let Ok(link) = link {
                    self.links.insert((output, input), link);
                }
            }
        }

        fn forget(&mut self, id: u32) {
            self.streams.remove(&id);
            self.clients.remove(&id);
            self.sources.retain(|node| *node != id);
            self.ports.retain(|port, p| *port != id && p.node != id);
            self.links.retain(|(output, input), _| *output != id && *input != id);
        }
    }

    pub(super) fn run(excluded: &[u32]) -> Result<(), pw::Error> {
        pw::init();
        let mainloop = pw::main_loop::MainLoopRc::new(None)?;
        let context = pw::context::ContextRc::new(&mainloop, None)?;
        let core = context.connect_rc(None)?;
        let registry = core.get_registry_rc()?;
        let own = std::process::id();
        let graph = Rc::new(RefCell::new(Graph { excluded: excluded.to_vec(), ..Graph::default() }));

        let (seen, linker, gone, binder) = (graph.clone(), core.clone(), graph.clone(), registry.clone());
        let _registry = registry
            .add_listener_local()
            .global(move |global| {
                let Some(props) = global.props else { return };
                let mut graph = seen.borrow_mut();
                match global.type_ {
                    ObjectType::Client => {
                        let Ok(proxy) = binder.bind::<pw::client::Client, _>(global) else { return };
                        let (id, graph_info, core_info) = (global.id, seen.clone(), linker.clone());
                        let listener = proxy
                            .add_listener_local()
                            .info(move |info| {
                                let mut graph = graph_info.borrow_mut();
                                let pid = pid(info.props(), &["application.process.id", "pipewire.sec.pid"]);
                                if let Some(client) = graph.clients.get_mut(&id) {
                                    client.pid = Some(pid);
                                }
                                graph.decide();
                                graph.relink(&core_info);
                            })
                            .register();
                        graph.clients.insert(id, Client { pid: None, _proxy: proxy, _listener: listener });
                    }
                    ObjectType::Node => {
                        if props.get("node.name") == Some(NODE_NAME)
                            && pid(Some(props), &["application.process.id"]).is_none_or(|pid| pid == own)
                        {
                            graph.ours = Some(global.id);
                        } else if props.get("media.class") == Some("Stream/Output/Audio") {
                            let Ok(proxy) = binder.bind::<pw::node::Node, _>(global) else { return };
                            let (id, graph_info, core_info) = (global.id, seen.clone(), linker.clone());
                            let listener = proxy
                                .add_listener_local()
                                .info(move |info| {
                                    let mut graph = graph_info.borrow_mut();
                                    if let Some(stream) = graph.streams.get_mut(&id) {
                                        stream.info = true;
                                        stream.pid = pid(info.props(), &["application.process.id"]);
                                        stream.client = pid(info.props(), &["client.id"]);
                                    }
                                    graph.decide();
                                    graph.relink(&core_info);
                                })
                                .register();
                            graph.streams.insert(
                                global.id,
                                Stream { info: false, pid: None, client: None, _proxy: proxy, _listener: listener },
                            );
                        }
                    }
                    ObjectType::Port => {
                        let (Some(node), Some(direction)) = (props.get("node.id"), props.get("port.direction")) else {
                            return;
                        };
                        // A sink's monitor ports would bring the call back in.
                        if props.get("port.monitor") == Some("true") {
                            return;
                        }
                        let Ok(node) = node.parse() else { return };
                        let channel = props.get("audio.channel").unwrap_or_default().to_owned();
                        graph.ports.insert(global.id, Port { node, output: direction == "out", channel });
                    }
                    _ => return,
                }
                graph.relink(&linker);
            })
            .global_remove(move |id| gone.borrow_mut().forget(id))
            .register();

        let stream = pw::stream::StreamBox::new(
            &core,
            NODE_NAME,
            properties! {
                *pw::keys::MEDIA_TYPE => "Audio",
                *pw::keys::MEDIA_CATEGORY => "Capture",
                *pw::keys::MEDIA_ROLE => "Screen",
                *pw::keys::NODE_NAME => NODE_NAME,
                *pw::keys::NODE_DESCRIPTION => "RocketVibe screen sound",
                // Linked by hand: the session manager must not plug a microphone in.
                "node.autoconnect" => "false",
            },
        )?;
        let quitter = mainloop.clone();
        let _stream = stream
            .add_local_listener_with_user_data(())
            .process(move |stream, _| {
                let Some(mut buffer) = stream.dequeue_buffer() else { return };
                let Some(data) = buffer.datas_mut().first_mut() else { return };
                let size = data.chunk().size() as usize;
                let Some(bytes) = data.data() else { return };
                let bytes = &bytes[..size.min(bytes.len())];
                // The reader went away: the share stopped.
                let mut out = std::io::stdout().lock();
                if out.write_all(bytes).and_then(|()| out.flush()).is_err() {
                    quitter.quit();
                }
            })
            .register()?;
        let mut format = spa::param::audio::AudioInfoRaw::new();
        format.set_format(spa::param::audio::AudioFormat::S16LE);
        format.set_rate(RATE);
        format.set_channels(CHANNELS);
        let mut position = [0; spa::param::audio::MAX_CHANNELS];
        position[0] = spa::sys::SPA_AUDIO_CHANNEL_FL;
        position[1] = spa::sys::SPA_AUDIO_CHANNEL_FR;
        format.set_position(position);
        let object = spa::pod::Object {
            type_: spa::utils::SpaTypes::ObjectParamFormat.as_raw(),
            id: spa::param::ParamType::EnumFormat.as_raw(),
            properties: format.into(),
        };
        let values = spa::pod::serialize::PodSerializer::serialize(
            std::io::Cursor::new(Vec::new()),
            &spa::pod::Value::Object(object),
        )
        .map_err(|_| pw::Error::CreationFailed)?
        .0
        .into_inner();
        let mut params = [spa::pod::Pod::from_bytes(&values).ok_or(pw::Error::CreationFailed)?];
        stream.connect(spa::utils::Direction::Input, None, pw::stream::StreamFlags::MAP_BUFFERS, &mut params)?;
        // Silence writes nothing, so a dead reader goes unnoticed: leave once
        // rv-voice, the parent, is gone.
        let (parent, orphaned) = (std::os::unix::process::parent_id(), mainloop.clone());
        let timer = mainloop.loop_().add_timer(move |_| {
            if std::os::unix::process::parent_id() != parent {
                orphaned.quit();
            }
        });
        let every = std::time::Duration::from_millis(500);
        let _ = timer.update_timer(Some(every), Some(every));
        mainloop.run();
        Ok(())
    }
}

#[cfg(not(target_os = "linux"))]
mod capture {
    pub(super) fn run(_excluded: &[u32]) -> Result<(), &'static str> {
        Err("Linux only")
    }
}
