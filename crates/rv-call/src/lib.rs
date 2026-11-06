//! The signalling half of native calls (brain/architecture/native-calls.md): one
//! adapter per provider's protocol speaks to its servers and hands the media
//! engine (the voice sidecar's libwebrtc) SDP and ICE candidates. No media here.

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
    /// track can be told apart.
    pub id: String,
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
    RemoteCandidate(Candidate),
    /// Everyone else, whenever anyone joins, leaves or changes.
    Roster(Vec<Member>),
    /// The media session is over but this client is still in the call: close
    /// the peer connection and wait for the next [`Event::Offer`] (Jitsi's focus
    /// ends the session of a participant left alone, and offers a new one when
    /// someone comes back).
    MediaEnded,
    /// The call is over for this client; the reason in snake case.
    Ended(String),
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
    /// A local ICE candidate, as the peer connection gathers it.
    fn local_candidate(&mut self, candidate: Candidate) -> impl Future<Output = Result<(), Error>> + Send;
    fn set_muted(&mut self, muted: bool) -> impl Future<Output = Result<(), Error>> + Send;
    fn leave(&mut self) -> impl Future<Output = ()> + Send;
    /// The stream id this client's own tracks must carry (`msid`).
    fn local_id(&self) -> &str;
}

/// Random lowercase hex, for ids the protocols want unique.
pub fn random_hex(bytes: usize) -> String {
    let mut buf = vec![0u8; bytes];
    let _ = getrandom::fill(&mut buf);
    buf.iter().map(|b| format!("{b:02x}")).collect()
}
