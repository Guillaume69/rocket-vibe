//! The client's address behind a reverse proxy. The documented deployment puts
//! Caddy in front (`docs/DEPLOY-SERVER.md`), so the TCP peer is the proxy for
//! every request: the per-address login and mail limits then counted the whole
//! instance as one address, and about thirty failed logins a minute locked
//! everyone out. Only a peer listed in `RV_TRUSTED_PROXIES` may name the client
//! in `X-Forwarded-For`; anyone else's header is ignored, since it is forgeable.

use axum::{
    extract::{ConnectInfo, Request, State},
    middleware::Next,
    response::Response,
};
use std::net::{IpAddr, SocketAddr};

use crate::App;

/// Address ranges whose connections are a reverse proxy's.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct TrustedProxies(Vec<(IpAddr, u8)>);

impl TrustedProxies {
    /// A comma-separated list of addresses or CIDR ranges (`127.0.0.1`,
    /// `172.16.0.0/12`, `::1/128`); empty trusts nobody.
    pub fn parse(list: &str) -> Result<Self, String> {
        let mut ranges = Vec::new();
        for item in list.split(',').map(str::trim).filter(|i| !i.is_empty()) {
            let (address, prefix) = match item.split_once('/') {
                Some((address, prefix)) => (address, Some(prefix)),
                None => (item, None),
            };
            let address: IpAddr = address
                .parse()
                .map_err(|_| format!("invalid trusted proxy address: {item}"))?;
            let width = if address.is_ipv4() { 32 } else { 128 };
            let prefix = match prefix {
                Some(prefix) => prefix
                    .parse::<u8>()
                    .ok()
                    .filter(|p| *p <= width)
                    .ok_or_else(|| format!("invalid trusted proxy prefix: {item}"))?,
                None => width,
            };
            ranges.push((address, prefix));
        }
        Ok(Self(ranges))
    }

    pub fn contains(&self, ip: IpAddr) -> bool {
        let ip = canonical(ip);
        self.0
            .iter()
            .any(|(range, prefix)| match (canonical(*range), ip) {
                (IpAddr::V4(range), IpAddr::V4(ip)) => {
                    masked(u32::from(range).into(), u32::from(ip).into(), *prefix, 32)
                }
                (IpAddr::V6(range), IpAddr::V6(ip)) => {
                    masked(u128::from(range), u128::from(ip), *prefix, 128)
                }
                _ => false,
            })
    }

    /// The client of a request whose TCP peer is `peer`: the right-most
    /// `X-Forwarded-For` hop that is not a trusted proxy, each trusted proxy
    /// having appended the address it saw. Falls back to the peer when it is
    /// not trusted or the header is missing or unreadable.
    pub fn client(&self, peer: IpAddr, forwarded_for: &[&str]) -> IpAddr {
        if !self.contains(peer) {
            return peer;
        }
        let hops: Vec<&str> = forwarded_for
            .iter()
            .flat_map(|value| value.split(','))
            .map(str::trim)
            .collect();
        for hop in hops.into_iter().rev() {
            let Ok(hop) = hop.parse::<IpAddr>() else {
                return peer;
            };
            if !self.contains(hop) {
                return canonical(hop);
            }
        }
        peer
    }
}

fn canonical(ip: IpAddr) -> IpAddr {
    match ip {
        IpAddr::V6(v6) => v6.to_ipv4_mapped().map_or(ip, IpAddr::V4),
        v4 => v4,
    }
}

fn masked(range: u128, ip: u128, prefix: u8, width: u8) -> bool {
    if prefix == 0 {
        return true;
    }
    let shift = u32::from(width - prefix);
    (range >> shift) == (ip >> shift)
}

/// Replaces the connection's `ConnectInfo` with the client's address, so every
/// handler reading the peer (login, invitations, recovery, mail) keys its
/// limits on the real client.
pub(crate) async fn resolve(State(app): State<App>, mut request: Request, next: Next) -> Response {
    if let Some(ConnectInfo(peer)) = request
        .extensions()
        .get::<ConnectInfo<SocketAddr>>()
        .copied()
    {
        let forwarded: Vec<&str> = request
            .headers()
            .get_all("x-forwarded-for")
            .iter()
            .filter_map(|v| v.to_str().ok())
            .collect();
        let client = app.trusted_proxies.client(peer.ip(), &forwarded);
        if client != peer.ip() {
            request
                .extensions_mut()
                .insert(ConnectInfo(SocketAddr::new(client, peer.port())));
        }
    }
    next.run(request).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ip(s: &str) -> IpAddr {
        s.parse().unwrap()
    }

    #[test]
    fn untrusted_peer_cannot_name_a_client() {
        let proxies = TrustedProxies::parse("127.0.0.1").unwrap();
        assert_eq!(
            proxies.client(ip("203.0.113.9"), &["198.51.100.1"]),
            ip("203.0.113.9")
        );
        assert_eq!(
            TrustedProxies::default().client(ip("127.0.0.1"), &["198.51.100.1"]),
            ip("127.0.0.1")
        );
    }

    #[test]
    fn trusted_proxy_names_the_right_most_untrusted_hop() {
        let proxies = TrustedProxies::parse("127.0.0.0/8, 172.16.0.0/12").unwrap();
        // A client-supplied header first, then what each proxy appended.
        assert_eq!(
            proxies.client(ip("172.18.0.1"), &["6.6.6.6, 198.51.100.7", "127.0.0.1"]),
            ip("198.51.100.7")
        );
        assert_eq!(proxies.client(ip("127.0.0.1"), &[]), ip("127.0.0.1"));
        assert_eq!(
            proxies.client(ip("127.0.0.1"), &["not-an-ip"]),
            ip("127.0.0.1")
        );
        assert_eq!(
            proxies.client(ip("127.0.0.1"), &["127.0.0.2"]),
            ip("127.0.0.1")
        );
    }

    #[test]
    fn ranges_and_mapped_addresses() {
        let proxies = TrustedProxies::parse("10.0.0.0/8,::1,fd00::/8").unwrap();
        assert!(proxies.contains(ip("10.255.0.1")));
        assert!(!proxies.contains(ip("11.0.0.1")));
        assert!(proxies.contains(ip("::ffff:10.1.2.3")));
        assert!(proxies.contains(ip("::1")));
        assert!(proxies.contains(ip("fd12::1")));
        assert!(!proxies.contains(ip("fe80::1")));
        assert!(
            TrustedProxies::parse("0.0.0.0/0")
                .unwrap()
                .contains(ip("8.8.8.8"))
        );
        assert!(TrustedProxies::parse("10.0.0.0/33").is_err());
        assert!(TrustedProxies::parse("nope").is_err());
        assert_eq!(
            TrustedProxies::parse(" , ").unwrap(),
            TrustedProxies::default()
        );
    }
}
