//! The signalling half of native calls (brain/architecture/native-calls.md): one
//! adapter per provider's protocol speaks to its servers and hands the media
//! engine (the voice sidecar's libwebrtc) SDP and ICE candidates. No media here.

pub mod chime;
pub mod jitsi;
pub mod xml;

use std::fmt;
use std::future::Future;

/// A TURN or STUN server the provider offers for this call.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct IceServer {
    pub urls: Vec<String>,
    pub username: String,
    pub credential: String,
}

/// One ICE candidate as an SDP attribute value (`candidate:...`), for the media line `mid`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Candidate {
    pub mid: String,
    pub line: String,
}

/// Someone in the call other than this client.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Member {
    /// The id their media streams carry (the SDP `msid` stream id), so a remote
    /// track can be told apart; the provider's user id where it mixes the audio.
    pub id: String,
    /// Empty when the provider does not say (Chime): the app names them.
    pub name: String,
    pub muted: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Event {
    /// The servers to give the peer connection, before any offer.
    IceServers(Vec<IceServer>),
    /// The remote side's whole session description. Set it, create an answer, set
    /// that, and give it to [`CallSignaling::answer`]: whether it is sent is the
    /// adapter's business (a renegotiation of sources is local in Jitsi).
    Offer {
        sdp: String,
    },
    /// The engine offers (Chime): create the local offer with the microphone,
    /// set it, let ICE gathering complete, and give the local description,
    /// candidates included, to [`CallSignaling::offer`]. `relay_only` keeps the
    /// media on the provider's TURN servers.
    OfferWanted {
        relay_only: bool,
    },
    /// The remote answer to the offer given to [`CallSignaling::offer`].
    Answer {
        sdp: String,
    },
    RemoteCandidate(Candidate),
    /// How loud each member is, 0 to 1, by [`Member::id`], where the provider
    /// mixes everyone into one stream and says who speaks itself (Chime).
    Levels(Vec<(String, f32)>),
    /// Everyone else, whenever anyone joins, leaves or changes.
    Roster(Vec<Member>),
    /// The media session is over but this client is still in the call: close
    /// the peer connection and wait for the next [`Event::Offer`] (Jitsi's focus
    /// ends the session of a participant left alone, and offers a new one when
    /// someone comes back).
    MediaEnded,
    /// This session is gone, the reason in snake case; joining again may bring
    /// the call back.
    Ended(String),
    /// The call is over for good (the meeting ended, this attendee was removed
    /// or joined elsewhere): joining again would be refused or take it back.
    Over(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Error(pub String);

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for Error {}

impl Error {
    pub fn new(message: impl Into<String>) -> Self {
        Error(message.into())
    }
}

/// A provider's call signalling, as the media engine drives it.
pub trait CallSignaling {
    /// The next thing the engine must act on; `None` once the session is gone.
    fn next_event(&mut self) -> impl Future<Output = Option<Event>> + Send;
    /// The local description answering the last [`Event::Offer`].
    fn answer(&mut self, sdp: &str) -> impl Future<Output = Result<(), Error>> + Send;
    /// The local offer, after [`Event::OfferWanted`].
    fn offer(&mut self, _sdp: &str) -> impl Future<Output = Result<(), Error>> + Send {
        async { Err(Error::new("this provider offers itself")) }
    }
    /// A local ICE candidate, as the peer connection gathers it.
    fn local_candidate(&mut self, candidate: Candidate) -> impl Future<Output = Result<(), Error>> + Send;
    fn set_muted(&mut self, muted: bool) -> impl Future<Output = Result<(), Error>> + Send;
    fn leave(&mut self) -> impl Future<Output = ()> + Send;
    /// The stream id this client's own tracks must carry (`msid`).
    fn local_id(&self) -> &str;
}

/// An SDP with these gathered candidates in their media sections, for a
/// provider that takes no trickle: each goes at the end of the section whose
/// `a=mid` it names, the first section when it names none.
pub fn sdp_with_candidates(sdp: &str, candidates: &[Candidate]) -> String {
    let mut sections: Vec<Vec<&str>> = vec![Vec::new()];
    for line in sdp.lines() {
        if line.starts_with("m=") {
            sections.push(Vec::new());
        }
        sections.last_mut().expect("never empty").push(line);
    }
    let mut out = String::with_capacity(sdp.len());
    for (at, section) in sections.iter().enumerate() {
        for line in section {
            out.push_str(line);
            out.push_str("\r\n");
        }
        if at == 0 {
            continue;
        }
        let mid = section.iter().find_map(|l| l.strip_prefix("a=mid:"));
        for candidate in candidates {
            if mid == Some(candidate.mid.as_str()) || (candidate.mid.is_empty() && at == 1) {
                out.push_str("a=");
                out.push_str(&candidate.line);
                out.push_str("\r\n");
            }
        }
    }
    out
}

/// Random lowercase hex, for ids the protocols want unique.
pub fn random_hex(bytes: usize) -> String {
    let mut buf = vec![0u8; bytes];
    let _ = getrandom::fill(&mut buf);
    buf.iter().map(|b| format!("{b:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn candidates_land_in_the_section_they_name() {
        let sdp = "v=0\r\ns=-\r\nm=audio 9 X 111\r\na=mid:0\r\nm=video 9 X 96\r\na=mid:1\r\n";
        let candidates = [
            Candidate { mid: "0".into(), line: "candidate:1 1 udp 5 1.2.3.4 9 typ relay".into() },
            Candidate { mid: "1".into(), line: "candidate:2 1 udp 5 1.2.3.5 9 typ relay".into() },
        ];
        assert_eq!(
            sdp_with_candidates(sdp, &candidates),
            "v=0\r\ns=-\r\nm=audio 9 X 111\r\na=mid:0\r\na=candidate:1 1 udp 5 1.2.3.4 9 typ relay\r\n\
             m=video 9 X 96\r\na=mid:1\r\na=candidate:2 1 udp 5 1.2.3.5 9 typ relay\r\n"
        );
    }

    #[test]
    fn a_candidate_naming_no_section_goes_in_the_first() {
        let sdp = "v=0\r\nm=audio 9 X 111\r\na=mid:0\r\n";
        let got = sdp_with_candidates(sdp, &[Candidate { mid: String::new(), line: "candidate:1".into() }]);
        assert!(got.ends_with("a=mid:0\r\na=candidate:1\r\n"), "{got}");
    }
}
