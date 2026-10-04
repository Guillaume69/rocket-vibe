//! `rocketvibe://room/<rid>?host=<server>`: the links the Android app's
//! notifications open, handled here too.

use url::Url;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RoomLink {
    pub rid: String,
    /// The server's host name, when the link names one.
    pub host: Option<String>,
}

fn host_of(server: &str) -> Option<String> {
    let url = if server.contains("://") {
        Url::parse(server).ok()?
    } else {
        Url::parse(&format!("https://{server}")).ok()?
    };
    url.host_str().map(str::to_lowercase)
}

pub fn parse(link: &str) -> Option<RoomLink> {
    let url = Url::parse(link.trim()).ok()?;
    if url.scheme() != "rocketvibe" || !matches!(url.host_str(), Some("salon" | "room")) {
        return None;
    }
    let rid = url.path_segments()?.find(|s| !s.is_empty())?;
    let rid = url::form_urlencoded::parse(rid.as_bytes()).map(|(k, _)| k.into_owned()).next()?;
    let host = url.query_pairs().find(|(k, _)| k == "host").and_then(|(_, v)| host_of(&v));
    Some(RoomLink { rid, host })
}

/// Whether the link's server is this one (a link without a server fits any).
pub fn fits(link: &RoomLink, base_url: &str) -> bool {
    link.host.as_ref().is_none_or(|h| host_of(base_url).as_ref() == Some(h))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_room_links() {
        assert_eq!(
            parse("rocketvibe://room/abc123?host=https%3A%2F%2Fchat.example.org%2F"),
            Some(RoomLink { rid: "abc123".into(), host: Some("chat.example.org".into()) })
        );
        assert_eq!(
            parse("rocketvibe://room/r1?host=Chat.Example.org").unwrap().host.as_deref(),
            Some("chat.example.org")
        );
        assert_eq!(parse("rocketvibe://room/r1"), Some(RoomLink { rid: "r1".into(), host: None }));
        assert_eq!(parse("rocketvibe://room/"), None);
        assert_eq!(parse("https://room/r1"), None);
        assert_eq!(parse("rocketvibe://other/r1"), None);
    }

    #[test]
    fn still_parses_the_old_salon_links() {
        assert_eq!(
            parse("rocketvibe://salon/r1?host=x.org"),
            Some(RoomLink { rid: "r1".into(), host: Some("x.org".into()) })
        );
    }

    #[test]
    fn matches_the_server() {
        let link = parse("rocketvibe://room/r1?host=chat.example.org").unwrap();
        assert!(fits(&link, "https://chat.example.org"));
        assert!(!fits(&link, "https://other.example.org"));
        assert!(fits(&parse("rocketvibe://room/r1").unwrap(), "https://anything.org"));
    }
}
