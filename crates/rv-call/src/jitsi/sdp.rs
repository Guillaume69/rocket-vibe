//! Jingle (XEP-0166/0167/0176/0320/0339) to SDP and back, the way lib-jitsi-meet's
//! `SDP.js` does it for Unified Plan, audio only: the bridge offers one `audio`
//! content carrying every remote source; libwebrtc wants one media section per
//! remote stream, so each remote audio source gets a `recvonly` section of its
//! own, after the `sendrecv` one this client sends its microphone on.

use crate::Candidate;
use crate::xml::Element;

pub const JINGLE: &str = "urn:xmpp:jingle:1";
pub const RTP: &str = "urn:xmpp:jingle:apps:rtp:1";
pub const ICE_UDP: &str = "urn:xmpp:jingle:transports:ice-udp:1";
pub const DTLS: &str = "urn:xmpp:jingle:apps:dtls:0";
pub const SSMA: &str = "urn:xmpp:jingle:apps:rtp:ssma:0";
pub const RTCP_FB: &str = "urn:xmpp:jingle:apps:rtp:rtcp-fb:0";
pub const HDREXT: &str = "urn:xmpp:jingle:apps:rtp:rtp-hdrext:0";
pub const GROUPING: &str = "urn:xmpp:jingle:apps:grouping:0";
pub const JITMEET: &str = "http://jitsi.org/jitmeet";

#[derive(Debug, Clone, PartialEq, Default)]
pub struct Payload {
    pub id: u8,
    pub name: String,
    pub clockrate: u32,
    pub channels: u32,
    pub params: Vec<(String, String)>,
    /// `rtcp-fb` type and subtype (empty when none).
    pub feedback: Vec<(String, String)>,
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct Source {
    pub ssrc: u32,
    pub name: String,
    /// `msid`, `cname`... as given.
    pub params: Vec<(String, String)>,
    /// The occupant this source belongs to (`room@muc/endpoint`), or `jvb`.
    pub owner: String,
}

impl Source {
    /// The endpoint id: the owner's resource, else the source name's prefix.
    pub fn endpoint(&self) -> String {
        if let Some((_, resource)) = self.owner.rsplit_once('/') {
            return resource.to_owned();
        }
        if !self.owner.is_empty() {
            return self.owner.clone();
        }
        self.name.split('-').next().unwrap_or_default().to_owned()
    }
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct Transport {
    pub ufrag: String,
    pub pwd: String,
    /// Hash, value, setup.
    pub fingerprint: Option<(String, String, String)>,
    pub candidates: Vec<String>,
}

/// One Jingle content: audio here, its codecs, header extensions, sources, transport.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Content {
    pub name: String,
    pub media: String,
    pub senders: String,
    pub payloads: Vec<Payload>,
    pub extmaps: Vec<(u16, String)>,
    pub rtcp_mux: bool,
    pub sources: Vec<Source>,
    pub transport: Transport,
}

/// A Jingle session as offered: what [`Offer::sdp`] renders.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Offer {
    pub sid: String,
    pub audio: Content,
    /// Remote audio sources in their media sections' order; `None` once removed
    /// (a media section is never taken out, only made inactive).
    pub slots: Vec<Option<Source>>,
    /// The `o=` version, raised on each renegotiation.
    pub version: u32,
}

/// Parses an `<rtp:description>` + `<transport>` content.
pub fn parse_content(content: &Element) -> Option<Content> {
    let description = content.find("description", RTP)?;
    let mut out = Content {
        name: content.get("name").unwrap_or("audio").to_owned(),
        media: description.get("media").unwrap_or_default().to_owned(),
        senders: content.get("senders").unwrap_or("both").to_owned(),
        rtcp_mux: description.find("rtcp-mux", RTP).is_some(),
        ..Default::default()
    };
    for p in description.find_all("payload-type", RTP) {
        let Some(id) = p.get("id").and_then(|v| v.parse().ok()) else { continue };
        out.payloads.push(Payload {
            id,
            name: p.get("name").unwrap_or_default().to_owned(),
            clockrate: p.get("clockrate").and_then(|v| v.parse().ok()).unwrap_or(0),
            channels: p.get("channels").and_then(|v| v.parse().ok()).unwrap_or(1),
            params: p
                .find_all("parameter", RTP)
                .map(|e| (e.get("name").unwrap_or_default().to_owned(), e.get("value").unwrap_or_default().to_owned()))
                .collect(),
            feedback: p
                .find_all("rtcp-fb", RTCP_FB)
                .map(|e| {
                    (e.get("type").unwrap_or_default().to_owned(), e.get("subtype").unwrap_or_default().to_owned())
                })
                .collect(),
        });
    }
    for h in description.find_all("rtp-hdrext", HDREXT) {
        if let (Some(id), Some(uri)) = (h.get("id").and_then(|v| v.parse().ok()), h.get("uri")) {
            out.extmaps.push((id, uri.to_owned()));
        }
    }
    out.sources = parse_sources(description);
    if let Some(t) = content.find("transport", ICE_UDP) {
        out.transport = parse_transport(t);
        out.rtcp_mux |= t.find("rtcp-mux", ICE_UDP).is_some();
    }
    Some(out)
}

pub fn parse_sources(description: &Element) -> Vec<Source> {
    description
        .find_all("source", SSMA)
        .filter_map(|s| {
            Some(Source {
                ssrc: s.get("ssrc")?.parse().ok()?,
                name: s.get("name").unwrap_or_default().to_owned(),
                params: s
                    .find_all("parameter", SSMA)
                    .map(|e| {
                        (e.get("name").unwrap_or_default().to_owned(), e.get("value").unwrap_or_default().to_owned())
                    })
                    .collect(),
                owner: s.find("ssrc-info", JITMEET).and_then(|i| i.get("owner")).unwrap_or_default().to_owned(),
            })
        })
        .collect()
}

pub fn parse_transport(t: &Element) -> Transport {
    Transport {
        ufrag: t.get("ufrag").unwrap_or_default().to_owned(),
        pwd: t.get("pwd").unwrap_or_default().to_owned(),
        fingerprint: t.find("fingerprint", DTLS).map(|f| {
            (
                f.get("hash").unwrap_or("sha-256").to_owned(),
                f.content().trim().to_owned(),
                f.get("setup").unwrap_or("actpass").to_owned(),
            )
        }),
        candidates: t.find_all("candidate", ICE_UDP).map(candidate_line).collect(),
    }
}

/// A Jingle `<candidate>` as the SDP attribute value `candidate:...`.
pub fn candidate_line(c: &Element) -> String {
    let get = |n: &str| c.get(n).unwrap_or_default();
    let mut line = format!(
        "candidate:{} {} {} {} {} {} typ {}",
        get("foundation"),
        c.get("component").unwrap_or("1"),
        get("protocol").to_lowercase(),
        get("priority"),
        get("ip"),
        get("port"),
        get("type"),
    );
    if let (Some(addr), Some(port)) = (c.get("rel-addr"), c.get("rel-port")) {
        line.push_str(&format!(" raddr {addr} rport {port}"));
    }
    if let Some(tcptype) = c.get("tcptype") {
        line.push_str(&format!(" tcptype {tcptype}"));
    }
    line.push_str(&format!(" generation {}", c.get("generation").unwrap_or("0")));
    line
}

/// An SDP `candidate:...` value as a Jingle `<candidate>`; `id` must be unique in the session.
pub fn candidate_element(line: &str, id: &str) -> Option<Element> {
    let line = line.strip_prefix("a=").unwrap_or(line);
    let line = line.strip_prefix("candidate:")?;
    let parts: Vec<&str> = line.split_whitespace().collect();
    if parts.len() < 8 || parts[6] != "typ" {
        return None;
    }
    let mut e = Element::new("candidate", ICE_UDP)
        .attr("foundation", parts[0])
        .attr("component", parts[1])
        .attr("protocol", parts[2].to_lowercase())
        .attr("priority", parts[3])
        .attr("ip", parts[4])
        .attr("port", parts[5])
        .attr("type", parts[7])
        .attr("generation", "0")
        .attr("network", "0")
        .attr("id", id);
    let mut rest = parts[8..].iter();
    while let (Some(key), Some(value)) = (rest.next(), rest.next()) {
        match *key {
            "raddr" => e.set_attr("rel-addr", *value),
            "rport" => e.set_attr("rel-port", *value),
            "tcptype" => e.set_attr("tcptype", *value),
            "generation" => e.set_attr("generation", *value),
            _ => {}
        }
    }
    Some(e)
}

impl Offer {
    /// The offer's audio content from a `session-initiate`.
    pub fn from_initiate(jingle: &Element) -> Option<Offer> {
        let audio = jingle.find_all("content", JINGLE).filter_map(parse_content).find(|c| c.media == "audio")?;
        let mut offer = Offer { sid: jingle.get("sid").unwrap_or_default().to_owned(), audio, ..Default::default() };
        let sources = std::mem::take(&mut offer.audio.sources);
        offer.add(sources);
        offer.version = 1;
        Some(offer)
    }

    /// Adds remote sources (`source-add`); the bridge's own and duplicates skipped.
    pub fn add(&mut self, sources: Vec<Source>) {
        for source in sources {
            if source.owner == "jvb" || self.slots.iter().flatten().any(|s| s.ssrc == source.ssrc) {
                continue;
            }
            self.slots.push(Some(source));
        }
        self.version += 1;
    }

    /// Removes remote sources by ssrc (`source-remove`).
    pub fn remove(&mut self, ssrcs: &[u32]) {
        for slot in &mut self.slots {
            if slot.as_ref().is_some_and(|s| ssrcs.contains(&s.ssrc)) {
                *slot = None;
            }
        }
        self.version += 1;
    }

    /// The remote description: this client's `sendrecv` section, then one
    /// `recvonly` section per remote source, all bundled on one transport.
    pub fn sdp(&self) -> String {
        let mut s = String::new();
        s.push_str("v=0\r\n");
        s.push_str(&format!("o=- {} {} IN IP4 0.0.0.0\r\n", sid_number(&self.sid), self.version));
        s.push_str("s=-\r\nt=0 0\r\n");
        let mids: Vec<String> = std::iter::once(self.audio.name.clone())
            .chain(self.slots.iter().enumerate().filter(|(_, s)| s.is_some()).map(|(i, _)| slot_mid(i)))
            .collect();
        s.push_str(&format!("a=group:BUNDLE {}\r\n", mids.join(" ")));
        s.push_str("a=msid-semantic: WMS *\r\n");
        self.section(&mut s, &self.audio.name, None, "sendrecv");
        for (i, slot) in self.slots.iter().enumerate() {
            match slot {
                Some(source) => self.section(&mut s, &slot_mid(i), Some(source), "sendonly"),
                None => self.section(&mut s, &slot_mid(i), None, "inactive"),
            }
        }
        s
    }

    /// One media section; the remote side's direction (`sendonly` for a source
    /// only the remote sends, which libwebrtc answers `recvonly`).
    fn section(&self, s: &mut String, mid: &str, source: Option<&Source>, direction: &str) {
        let a = &self.audio;
        let pts: Vec<String> = a.payloads.iter().map(|p| p.id.to_string()).collect();
        let port = if direction == "inactive" && mid != a.name { 0 } else { 9 };
        s.push_str(&format!("m=audio {port} UDP/TLS/RTP/SAVPF {}\r\n", pts.join(" ")));
        s.push_str("c=IN IP4 0.0.0.0\r\na=rtcp:1 IN IP4 0.0.0.0\r\n");
        let t = &a.transport;
        s.push_str(&format!("a=ice-ufrag:{}\r\na=ice-pwd:{}\r\n", t.ufrag, t.pwd));
        if let Some((hash, value, setup)) = &t.fingerprint {
            s.push_str(&format!("a=fingerprint:{hash} {value}\r\na=setup:{setup}\r\n"));
        }
        if mid == a.name {
            for c in &t.candidates {
                s.push_str(&format!("a={c}\r\n"));
            }
        }
        s.push_str(&format!("a=mid:{mid}\r\na={direction}\r\n"));
        if a.rtcp_mux {
            s.push_str("a=rtcp-mux\r\n");
        }
        for p in &a.payloads {
            let channels = if p.channels > 1 { format!("/{}", p.channels) } else { String::new() };
            s.push_str(&format!("a=rtpmap:{} {}/{}{channels}\r\n", p.id, p.name, p.clockrate));
            if !p.params.is_empty() {
                let params: Vec<String> = p.params.iter().map(|(k, v)| format!("{k}={v}")).collect();
                s.push_str(&format!("a=fmtp:{} {}\r\n", p.id, params.join(";")));
            }
            for (kind, sub) in &p.feedback {
                let fb = if sub.is_empty() { kind.clone() } else { format!("{kind} {sub}") };
                s.push_str(&format!("a=rtcp-fb:{} {fb}\r\n", p.id));
            }
        }
        for (id, uri) in &a.extmaps {
            s.push_str(&format!("a=extmap:{id} {uri}\r\n"));
        }
        if let Some(source) = source {
            let endpoint = source.endpoint();
            let track =
                if source.name.is_empty() { format!("{endpoint}-a{}", source.ssrc) } else { source.name.clone() };
            s.push_str(&format!("a=msid:{endpoint} {track}\r\n"));
            let cname = source.params.iter().find(|(k, _)| k == "cname").map(|(_, v)| v.clone()).unwrap_or(endpoint);
            s.push_str(&format!("a=ssrc:{} cname:{cname}\r\n", source.ssrc));
            s.push_str(&format!("a=ssrc:{} msid:{} {track}\r\n", source.ssrc, source.endpoint()));
        }
    }
}

fn slot_mid(i: usize) -> String {
    format!("r{i}")
}

/// An `o=` session id: decimal digits, from the Jingle sid.
fn sid_number(sid: &str) -> String {
    let digits: String = sid.bytes().map(|b| (b % 10).to_string()).take(18).collect();
    if digits.is_empty() { "1".to_owned() } else { format!("1{digits}") }
}

/// This client's side, read from libwebrtc's answer (its first media section).
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Answer {
    pub payloads: Vec<Payload>,
    pub extmaps: Vec<(u16, String)>,
    pub rtcp_mux: bool,
    pub ssrc: Option<u32>,
    pub cname: String,
    pub transport: Transport,
}

impl Answer {
    pub fn parse(sdp: &str, mid: &str) -> Answer {
        let mut out = Answer::default();
        let mut session_level = Transport::default();
        // The session's lines, then each media section's: only the section for
        // `mid` is read, the session-level ICE and fingerprint lines apply too.
        let mut sections: Vec<Vec<&str>> = vec![Vec::new()];
        for line in sdp.lines().map(str::trim) {
            if line.starts_with("m=") {
                sections.push(Vec::new());
            }
            sections.last_mut().expect("one section at least").push(line);
        }
        let wanted = format!("a=mid:{mid}");
        let chosen =
            sections.iter().skip(1).find(|lines| lines.contains(&wanted.as_str())).cloned().unwrap_or_default();
        let lines = sections[0].iter().map(|l| (true, *l)).chain(chosen.iter().map(|l| (false, *l)));
        for (session, line) in lines {
            let in_section = !session;
            let target = if session { &mut session_level } else { &mut out.transport };
            if let Some(v) = line.strip_prefix("a=ice-ufrag:") {
                target.ufrag = v.to_owned();
            } else if let Some(v) = line.strip_prefix("a=ice-pwd:") {
                target.pwd = v.to_owned();
            } else if let Some(v) = line.strip_prefix("a=fingerprint:") {
                if let Some((hash, value)) = v.split_once(' ') {
                    let setup = target.fingerprint.as_ref().map(|f| f.2.clone()).unwrap_or_default();
                    target.fingerprint = Some((hash.to_owned(), value.to_owned(), setup));
                }
            } else if let Some(v) = line.strip_prefix("a=setup:") {
                let f = target.fingerprint.get_or_insert_with(Default::default);
                f.2 = v.to_owned();
            } else if let Some(v) = line.strip_prefix("a=candidate:") {
                target.candidates.push(format!("candidate:{v}"));
            } else if !in_section {
                continue;
            } else if line == "a=rtcp-mux" {
                out.rtcp_mux = true;
            } else if let Some(v) = line.strip_prefix("a=rtpmap:") {
                let Some((id, rest)) = v.split_once(' ') else { continue };
                let mut it = rest.split('/');
                out.payloads.push(Payload {
                    id: id.parse().unwrap_or(0),
                    name: it.next().unwrap_or_default().to_owned(),
                    clockrate: it.next().and_then(|c| c.parse().ok()).unwrap_or(0),
                    channels: it.next().and_then(|c| c.parse().ok()).unwrap_or(1),
                    ..Default::default()
                });
            } else if let Some(v) = line.strip_prefix("a=fmtp:") {
                let Some((id, params)) = v.split_once(' ') else { continue };
                if let Some(p) = out.payloads.iter_mut().find(|p| p.id.to_string() == id) {
                    p.params = params
                        .split(';')
                        .filter_map(|kv| kv.trim().split_once('='))
                        .map(|(k, v)| (k.to_owned(), v.to_owned()))
                        .collect();
                }
            } else if let Some(v) = line.strip_prefix("a=rtcp-fb:") {
                let Some((id, fb)) = v.split_once(' ') else { continue };
                let (kind, sub) = fb.split_once(' ').unwrap_or((fb, ""));
                if let Some(p) = out.payloads.iter_mut().find(|p| p.id.to_string() == id) {
                    p.feedback.push((kind.to_owned(), sub.to_owned()));
                }
            } else if let Some(v) = line.strip_prefix("a=extmap:") {
                if let Some((id, uri)) = v.split_once(' ') {
                    let id = id.split('/').next().unwrap_or(id);
                    if let Ok(id) = id.parse() {
                        out.extmaps.push((id, uri.split_whitespace().next().unwrap_or(uri).to_owned()));
                    }
                }
            } else if let Some(v) = line.strip_prefix("a=ssrc:") {
                let Some((ssrc, attr)) = v.split_once(' ') else { continue };
                out.ssrc.get_or_insert(ssrc.parse().unwrap_or(0));
                if let Some(c) = attr.strip_prefix("cname:") {
                    out.cname = c.to_owned();
                }
            }
        }
        if out.transport.ufrag.is_empty() {
            out.transport.ufrag = session_level.ufrag;
            out.transport.pwd = session_level.pwd;
        }
        if out.transport.fingerprint.is_none() {
            out.transport.fingerprint = session_level.fingerprint;
        }
        out
    }

    /// The `<content>` of a `session-accept` (initiator's content `name`); `endpoint`
    /// names this client's source as Jitsi expects (`<endpoint>-a0`).
    pub fn content(&self, name: &str, endpoint: &str) -> Element {
        let mut description = Element::new("description", RTP).attr("media", "audio");
        if let Some(ssrc) = self.ssrc {
            description.set_attr("ssrc", ssrc.to_string());
        }
        for p in &self.payloads {
            let mut pt = Element::new("payload-type", RTP)
                .attr("id", p.id.to_string())
                .attr("name", &p.name)
                .attr("clockrate", p.clockrate.to_string());
            if p.channels > 1 {
                pt.set_attr("channels", p.channels.to_string());
            }
            for (k, v) in &p.params {
                pt.push(Element::new("parameter", RTP).attr("name", k).attr("value", v));
            }
            for (kind, sub) in &p.feedback {
                let mut fb = Element::new("rtcp-fb", RTCP_FB).attr("type", kind);
                if !sub.is_empty() {
                    fb.set_attr("subtype", sub);
                }
                pt.push(fb);
            }
            description.push(pt);
        }
        for (id, uri) in &self.extmaps {
            description.push(Element::new("rtp-hdrext", HDREXT).attr("id", id.to_string()).attr("uri", uri));
        }
        if let Some(ssrc) = self.ssrc {
            let source_name = format!("{endpoint}-a0");
            description.push(
                Element::new("source", SSMA).attr("ssrc", ssrc.to_string()).attr("name", &source_name).child(
                    Element::new("parameter", SSMA)
                        .attr("name", "msid")
                        .attr("value", format!("{endpoint} {source_name}")),
                ),
            );
        }
        if self.rtcp_mux {
            description.push(Element::new("rtcp-mux", RTP));
        }
        Element::new("content", JINGLE)
            .attr("creator", "initiator")
            .attr("name", name)
            .attr("senders", "both")
            .child(description)
            .child(self.transport_element(true))
    }

    /// The transport, with or without the candidates gathered so far.
    pub fn transport_element(&self, with_candidates: bool) -> Element {
        let mut t =
            Element::new("transport", ICE_UDP).attr("ufrag", &self.transport.ufrag).attr("pwd", &self.transport.pwd);
        if let Some((hash, value, setup)) = &self.transport.fingerprint {
            let setup = if setup.is_empty() || setup == "actpass" { "active" } else { setup.as_str() };
            t.push(Element::new("fingerprint", DTLS).attr("hash", hash).attr("setup", setup).text(value));
        }
        if self.rtcp_mux {
            t.push(Element::new("rtcp-mux", ICE_UDP));
        }
        if with_candidates {
            for (i, c) in self.transport.candidates.iter().enumerate() {
                if let Some(e) = candidate_element(c, &format!("c{i}")) {
                    t.push(e);
                }
            }
        }
        t
    }
}

/// A remote candidate for the media engine: Jitsi's are for the audio content,
/// which is this client's first media section.
pub fn remote_candidate(offer: &Offer, line: String) -> Candidate {
    Candidate { mid: offer.audio.name.clone(), line }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// The shape of meet.barrut.me's bridge offer (2026-11-02), values neutral.
    pub(crate) const INITIATE: &str = r#"<iq xmlns="jabber:client" type="set" from="room@muc.meet.jitsi/focus" id="j1">
<jingle xmlns="urn:xmpp:jingle:1" action="session-initiate" initiator="focus@auth.meet.jitsi/focus" sid="7a1b2c3d4e">
<content creator="initiator" name="audio" senders="both">
<description xmlns="urn:xmpp:jingle:apps:rtp:1" media="audio" maxptime="60">
<payload-type id="111" name="opus" clockrate="48000" channels="2">
<parameter name="minptime" value="10"/><parameter name="useinbandfec" value="1"/>
<rtcp-fb xmlns="urn:xmpp:jingle:apps:rtp:rtcp-fb:0" type="transport-cc"/>
</payload-type>
<payload-type id="126" name="telephone-event" clockrate="8000"/>
<rtp-hdrext xmlns="urn:xmpp:jingle:apps:rtp:rtp-hdrext:0" id="1" uri="urn:ietf:params:rtp-hdrext:ssrc-audio-level"/>
<rtp-hdrext xmlns="urn:xmpp:jingle:apps:rtp:rtp-hdrext:0" id="5" uri="http://www.ietf.org/id/draft-holmer-rmcat-transport-wide-cc-extensions-01"/>
<rtcp-mux/>
<source xmlns="urn:xmpp:jingle:apps:rtp:ssma:0" ssrc="1111" name="jvb-a0"><ssrc-info xmlns="http://jitsi.org/jitmeet" owner="jvb"/></source>
<source xmlns="urn:xmpp:jingle:apps:rtp:ssma:0" ssrc="2222" name="abcd1234-a0"><parameter name="msid" value="x y"/><ssrc-info xmlns="http://jitsi.org/jitmeet" owner="room@muc.meet.jitsi/abcd1234"/></source>
</description>
<transport xmlns="urn:xmpp:jingle:transports:ice-udp:1" ufrag="uf1" pwd="pw1">
<web-socket xmlns="http://jitsi.org/protocol/colibri" url="wss://x/colibri-ws"/>
<rtcp-mux/>
<fingerprint xmlns="urn:xmpp:jingle:apps:dtls:0" hash="sha-256" setup="actpass" required="false">AA:BB</fingerprint>
<candidate component="1" foundation="1" generation="0" id="c1" network="0" port="10000" priority="2130706431" protocol="udp" type="host" ip="203.0.113.5"/>
</transport>
</content>
<content creator="initiator" name="video" senders="both"><description xmlns="urn:xmpp:jingle:apps:rtp:1" media="video"/></content>
<group xmlns="urn:xmpp:jingle:apps:grouping:0" semantics="BUNDLE"><content name="audio"/><content name="video"/></group>
</jingle></iq>"#;

    #[test]
    fn an_initiate_becomes_one_send_section_and_one_per_remote_source() {
        let iq = Element::parse(INITIATE).unwrap();
        let offer = Offer::from_initiate(iq.find("jingle", JINGLE).unwrap()).unwrap();
        assert_eq!(offer.sid, "7a1b2c3d4e");
        assert_eq!(offer.slots.len(), 1, "the bridge's own source is skipped");
        let sdp = offer.sdp();
        assert!(sdp.contains("a=group:BUNDLE audio r0\r\n"));
        assert_eq!(sdp.matches("m=audio 9 UDP/TLS/RTP/SAVPF 111 126").count(), 2);
        assert!(sdp.contains("a=candidate:1 1 udp 2130706431 203.0.113.5 10000 typ host generation 0\r\n"));
        assert!(sdp.contains("a=fingerprint:sha-256 AA:BB\r\na=setup:actpass\r\n"));
        assert!(sdp.contains("a=fmtp:111 minptime=10;useinbandfec=1\r\n"));
        assert!(sdp.contains("a=rtcp-fb:111 transport-cc\r\n"));
        assert!(sdp.contains("a=extmap:1 urn:ietf:params:rtp-hdrext:ssrc-audio-level\r\n"));
        assert!(sdp.contains("a=mid:r0\r\na=sendonly\r\n"));
        assert!(sdp.contains("a=ssrc:2222 msid:abcd1234 abcd1234-a0\r\n"));
        assert!(!sdp.contains("video"));
    }

    #[test]
    fn sources_come_and_go_without_media_sections_being_removed() {
        let iq = Element::parse(INITIATE).unwrap();
        let mut offer = Offer::from_initiate(iq.find("jingle", JINGLE).unwrap()).unwrap();
        offer.add(vec![Source {
            ssrc: 3333,
            name: "beef0001-a0".into(),
            owner: "r@m/beef0001".into(),
            ..Default::default()
        }]);
        offer.remove(&[2222]);
        let sdp = offer.sdp();
        assert!(sdp.contains("a=group:BUNDLE audio r1\r\n"));
        assert!(sdp.contains("m=audio 0 UDP/TLS/RTP/SAVPF 111 126\r\n"));
        assert!(sdp.contains("a=mid:r0\r\na=inactive\r\n"));
        assert!(sdp.contains("a=ssrc:3333 msid:beef0001 beef0001-a0\r\n"));
        assert_eq!(offer.version, 3);
    }

    const ANSWER: &str = "v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\na=group:BUNDLE audio r0\r\n\
a=msid-semantic: WMS ep\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111 126\r\nc=IN IP4 0.0.0.0\r\na=rtcp:9 IN IP4 0.0.0.0\r\n\
a=candidate:842163049 1 udp 1677729535 198.51.100.7 50000 typ srflx raddr 10.0.0.2 rport 50000 generation 0 network-cost 999\r\n\
a=ice-ufrag:lu\r\na=ice-pwd:lp\r\na=ice-options:trickle\r\na=fingerprint:sha-256 CC:DD\r\na=setup:active\r\n\
a=mid:audio\r\na=extmap:1 urn:ietf:params:rtp-hdrext:ssrc-audio-level\r\na=sendrecv\r\na=msid:ep ep-a0\r\na=rtcp-mux\r\n\
a=rtpmap:111 opus/48000/2\r\na=rtcp-fb:111 transport-cc\r\na=fmtp:111 minptime=10;useinbandfec=1\r\n\
a=rtpmap:126 telephone-event/8000\r\na=ssrc:4444 cname:qq\r\na=ssrc:4444 msid:ep ep-a0\r\n\
m=audio 9 UDP/TLS/RTP/SAVPF 111 126\r\nc=IN IP4 0.0.0.0\r\na=mid:r0\r\na=recvonly\r\na=ssrc:9999 cname:zz\r\n";

    #[test]
    fn the_answer_becomes_a_session_accept_content() {
        let answer = Answer::parse(ANSWER, "audio");
        assert_eq!(answer.ssrc, Some(4444));
        assert_eq!(answer.payloads.len(), 2);
        assert_eq!(answer.transport.ufrag, "lu");
        assert_eq!(answer.transport.fingerprint, Some(("sha-256".into(), "CC:DD".into(), "active".into())));
        let content = answer.content("audio", "ep");
        let xml = content.write();
        assert!(xml.contains(r#"<source xmlns="urn:xmpp:jingle:apps:rtp:ssma:0" ssrc="4444" name="ep-a0">"#));
        assert!(xml.contains(
            r#"<fingerprint xmlns="urn:xmpp:jingle:apps:dtls:0" hash="sha-256" setup="active">CC:DD</fingerprint>"#
        ));
        assert!(xml.contains(r#"rel-addr="10.0.0.2""#));
        assert!(!xml.contains("9999"), "the receive-only sections stay out");
    }

    #[test]
    fn candidates_round_trip() {
        let line = "candidate:1 1 tcp 1518280447 192.0.2.1 9 typ host tcptype active generation 0";
        let e = candidate_element(line, "c0").unwrap();
        assert_eq!(candidate_line(&e), line);
    }
}
