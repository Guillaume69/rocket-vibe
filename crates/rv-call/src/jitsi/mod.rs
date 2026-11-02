//! Jitsi Meet signalling (Rocket.Chat's Jitsi provider, Infomaniak's kMeet):
//! XMPP over WebSocket (RFC 7395), anonymous login (a kMeet JWT rides on the
//! socket's URL), the focus (Jicofo) asked for the conference, the MUC joined,
//! then Jingle: the focus offers the bridge's audio, this client answers, and
//! sources come and go. Audio only: the features this client announces keep
//! video and the bridge's data channel out of the offer. A peer-to-peer offer
//! from another participant is declined, which sends them through the bridge.

pub mod sdp;

#[cfg(feature = "client")]
mod client;
#[cfg(feature = "client")]
pub use client::{Session, join};

/// Where and as whom to join.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Config {
    /// `wss://host/xmpp-websocket`, without its query.
    pub websocket: String,
    /// The XMPP domain (`hosts.domain`).
    pub domain: String,
    /// The conference domain (`hosts.muc`).
    pub muc: String,
    /// The focus component (`hosts.focus`, by default `focus.<domain>`).
    pub focus: String,
    /// The room's name (the meeting URL's last path segment, lowercased).
    pub room: String,
    pub display_name: String,
    /// kMeet's JWT; none for an anonymous deployment.
    pub token: Option<String>,
}

impl Config {
    /// The join parameters from a meeting URL (`https://host/<room>`) and that
    /// host's `config.js`, as Jitsi Meet's own page reads them.
    pub fn from_meeting(
        meeting_url: &str,
        config_js: &str,
        display_name: &str,
        token: Option<String>,
    ) -> Option<Config> {
        let rest = meeting_url.split_once("://")?.1;
        let rest = rest.split(['?', '#']).next()?;
        let (host, path) = rest.split_once('/')?;
        let room = path.trim_end_matches('/').rsplit('/').next()?.to_lowercase();
        if room.is_empty() {
            return None;
        }
        let domain = js_string(config_js, "domain").unwrap_or_else(|| host.to_owned());
        let muc = js_string(config_js, "muc").unwrap_or_else(|| format!("conference.{domain}"));
        let focus = js_string(config_js, "focus").unwrap_or_else(|| format!("focus.{domain}"));
        let websocket = js_string(config_js, "websocket")
            .map(|w| absolute(&w, host))
            .unwrap_or_else(|| format!("wss://{host}/xmpp-websocket"));
        Some(Config { websocket, domain, muc, focus, room, display_name: display_name.to_owned(), token })
    }

    /// Whether a host's `config.js` is Jitsi Meet's: it names an XMPP domain.
    pub fn is_jitsi(config_js: &str) -> bool {
        js_string(config_js, "domain").is_some()
            && (js_string(config_js, "muc").is_some() || js_string(config_js, "websocket").is_some())
    }

    #[cfg(any(feature = "client", test))]
    fn socket_url(&self) -> String {
        let mut url = format!("{}?room={}", self.websocket, self.room);
        if let Some(token) = &self.token {
            url.push_str("&token=");
            url.push_str(token);
        }
        url
    }

    #[cfg(feature = "client")]
    fn room_jid(&self) -> String {
        format!("{}@{}", self.room, self.muc)
    }
}

/// The string `config.js` gives `key`, in either style Jitsi ships: an object
/// literal (`domain: 'meet.jitsi'`) or docker-jitsi-meet's assignments
/// (`config.hosts.muc = 'muc.' + subdomain + 'meet.jitsi';`), where the quoted
/// pieces are joined and the variables, empty by default there, are dropped.
fn js_string(js: &str, key: &str) -> Option<String> {
    for line in js.lines() {
        let line = line.trim();
        if line.starts_with("//") {
            continue;
        }
        let rest = if let Some(rest) = line.strip_prefix(key).and_then(|r| r.trim_start().strip_prefix(':')) {
            rest
        } else if let Some(at) = line.find(&format!(".{key} =")).or_else(|| line.find(&format!(".{key}="))) {
            line[at + key.len() + 1..].trim_start().strip_prefix('=')?
        } else {
            continue;
        };
        let mut value = String::new();
        let mut chars = rest.chars();
        let mut found = false;
        while let Some(c) = chars.next() {
            match c {
                '\'' | '"' => {
                    found = true;
                    for d in chars.by_ref() {
                        if d == c {
                            break;
                        }
                        value.push(d);
                    }
                }
                ';' | ',' => break,
                _ => {}
            }
        }
        if found {
            return Some(value);
        }
    }
    None
}

/// A `config.js` websocket may be relative (`//host/xmpp-websocket`) or a full URL.
fn absolute(url: &str, host: &str) -> String {
    if let Some(rest) = url.strip_prefix("//") {
        format!("wss://{rest}")
    } else if url.starts_with('/') {
        format!("wss://{host}{url}")
    } else {
        url.to_owned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const CONFIG_JS: &str = "var config = {\n    hosts: {\n        domain: 'meet.jitsi',\n        // focus: 'focus.meet.jitsi',\n        muc: 'muc.meet.jitsi'\n    },\n    bosh: 'https://meet.barrut.me/http-bind',\n    websocket: 'wss://meet.barrut.me/xmpp-websocket',\n};";

    #[test]
    fn a_meeting_url_and_its_config_give_the_join_parameters() {
        let c =
            Config::from_meeting("https://meet.barrut.me/RocketChatAbC12#config.x=1", CONFIG_JS, "Ana", None).unwrap();
        assert_eq!(c.room, "rocketchatabc12");
        assert_eq!(c.domain, "meet.jitsi");
        assert_eq!(c.muc, "muc.meet.jitsi");
        assert_eq!(c.focus, "focus.meet.jitsi");
        assert_eq!(c.websocket, "wss://meet.barrut.me/xmpp-websocket");
        assert_eq!(c.socket_url(), "wss://meet.barrut.me/xmpp-websocket?room=rocketchatabc12");
        let k = Config::from_meeting(
            "https://kmeet.infomaniak.com/Room",
            "websocket: '//kmeet.infomaniak.com/xmpp-websocket'",
            "B",
            Some("t.k.n".into()),
        )
        .unwrap();
        assert_eq!(k.socket_url(), "wss://kmeet.infomaniak.com/xmpp-websocket?room=room&token=t.k.n");
        assert_eq!(k.domain, "kmeet.infomaniak.com");
    }

    #[test]
    fn only_a_jitsi_config_is_taken_for_one() {
        assert!(Config::is_jitsi(CONFIG_JS));
        assert!(!Config::is_jitsi("window.config = { title: 'x' };"));
    }

    #[test]
    fn docker_jitsi_meet_assignments_are_read() {
        let js = "config.hosts = {};\nconfig.hosts.domain = 'meet.jitsi';\nvar subdomain = '';\n\
            config.hosts.muc = 'muc.' + subdomain + 'meet.jitsi';\nconfig.websocket = 'wss://meet.barrut.me/' + subdir + 'xmpp-websocket';";
        let c = Config::from_meeting("https://meet.barrut.me/RocketChatX", js, "Ana", None).unwrap();
        assert_eq!((c.domain.as_str(), c.muc.as_str()), ("meet.jitsi", "muc.meet.jitsi"));
        assert_eq!(c.websocket, "wss://meet.barrut.me/xmpp-websocket");
    }
}
