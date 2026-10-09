//! `rocketvibe://room/<rid>?host=<server>`: the links the Android app's
//! notifications open, handled here too (older `salon/` links still parse).
//! Links name a service and provider, never credentials or an arbitrary account.
use crate::{native::Identity, session::SessionInfo};
use serde::Deserialize;
use std::collections::HashMap;
use url::Url;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RoomLink {
    pub rid: String,
    /// Canonical HTTP(S) service URL, including port and reverse-proxy path.
    pub host: Option<String>,
    pub native: Option<Identity>,
    /// Notifications pin an account; public permalinks deliberately omit it.
    pub user_id: Option<String>,
    pub message: Option<String>,
    pub root: Option<String>,
}

pub fn service_url(server: &str) -> Option<String> {
    let server = if server.contains("://") { server.to_owned() } else { format!("https://{server}") };
    let url = Url::parse(&server).ok()?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return None;
    }
    Some(url.to_string().trim_end_matches('/').to_owned())
}

fn id(s: &str) -> bool {
    !s.is_empty() && s.len() <= 128 && s.bytes().all(|c| c.is_ascii_alphanumeric() || b"_-".contains(&c))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PushScope {
    instance_id: String,
    data_epoch: String,
    user_id: String,
}

pub fn parse(link: &str) -> Option<RoomLink> {
    if link.len() > 8192 {
        return None;
    }
    let url = Url::parse(link.trim()).ok()?;
    if url.scheme() != "rocketvibe"
        || !matches!(url.host_str(), Some("salon" | "room"))
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
        || url.fragment().is_some()
    {
        return None;
    }
    let path = url.path().trim_matches('/');
    if path.contains('/') {
        return None;
    }
    let encoded = format!("id={}", path.replace('&', "%26").replace('+', "%2B"));
    let rid = url::form_urlencoded::parse(encoded.as_bytes()).next()?.1.into_owned();
    if !id(&rid) {
        return None;
    }
    let mut params = HashMap::new();
    for (key, value) in url.query_pairs() {
        if params.insert(key.into_owned(), value.into_owned()).is_some() {
            return None;
        }
    }
    // An invalid explicit service must not become a link without a service.
    let host = match params.get("host") {
        Some(v) => Some(service_url(v)?),
        None => None,
    };
    let mut instance = params.get("instanceId").cloned();
    let mut epoch = params.get("dataEpoch").cloned();
    let mut user_id = params.get("userId").cloned();
    if let Some(scope) = params.get("nativeScope") {
        if scope.len() > 1024 {
            return None;
        }
        let scope: PushScope = serde_json::from_str(scope).ok()?;
        for (current, pinned) in
            [(&mut instance, scope.instance_id), (&mut epoch, scope.data_epoch), (&mut user_id, scope.user_id)]
        {
            if current.as_ref().is_some_and(|v| *v != pinned) {
                return None;
            }
            *current = Some(pinned);
        }
    }
    let native = match (instance, epoch) {
        (None, None) if user_id.is_none() => None,
        (Some(instance_id), Some(data_epoch)) if host.is_some() && id(&instance_id) && id(&data_epoch) => {
            Some(Identity { instance_id, data_epoch })
        }
        _ => return None,
    };
    let message = params.get("msg").cloned();
    let root = params.get("tmid").cloned();
    if [&user_id, &message, &root].into_iter().flatten().any(|s| !id(s)) {
        return None;
    }
    Some(RoomLink { rid, host, native, user_id, message, root })
}

pub fn fits(link: &RoomLink, info: &SessionInfo) -> bool {
    link.native == info.native
        && link.host.as_ref().is_none_or(|h| service_url(&info.base_url).as_ref() == Some(h))
        && link.user_id.as_ref().is_none_or(|u| u == &info.user_id)
}

/// Prefer the account explicitly in use. With no active match, ambiguity needs
/// the existing account selector; never pick the first saved session.
pub fn select(link: &RoomLink, accounts: &[SessionInfo], current: Option<&SessionInfo>) -> Option<usize> {
    if let Some(current) = current.filter(|a| fits(link, a)) {
        return accounts.iter().position(|a| {
            a.base_url == current.base_url && a.user_id == current.user_id && a.native == current.native
        });
    }
    let mut matching = accounts.iter().enumerate().filter(|(_, a)| fits(link, a));
    let index = matching.next()?.0;
    matching.next().is_none().then_some(index)
}

/// Shareable by another authorized member: no account ID or bearer in the URL.
pub fn native_permalink(info: &SessionInfo, rid: &str, message: Option<&str>, root: Option<&str>) -> Option<String> {
    let native = info.native.as_ref()?;
    if !id(rid) || [message, root].into_iter().flatten().any(|s| !id(s)) {
        return None;
    }
    let mut url = Url::parse(&format!("rocketvibe://room/{rid}")).ok()?;
    {
        let mut query = url.query_pairs_mut();
        query.append_pair("host", &service_url(&info.base_url)?);
        query.append_pair("instanceId", &native.instance_id).append_pair("dataEpoch", &native.data_epoch);
        if let Some(message) = message {
            query.append_pair("msg", message);
        }
        if let Some(root) = root {
            query.append_pair("tmid", root);
        }
    }
    parse(url.as_str())?;
    Some(url.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn account(user: &str, native: bool) -> SessionInfo {
        SessionInfo {
            mattermost: None,
            base_url: "https://chat.example.org/native".into(),
            user_id: user.into(),
            username: user.into(),
            auth_token: "private-bearer".into(),
            native: native.then(|| Identity { instance_id: "instance".into(), data_epoch: "epoch".into() }),
        }
    }
    #[test]
    fn native_links_preserve_service_identity_and_are_shareable() {
        let alice = account("alice", true);
        let url = native_permalink(&alice, "room", Some("reply"), Some("root")).unwrap();
        assert!(!url.contains("alice") && !url.contains("private-bearer"));
        let link = parse(&url).unwrap();
        assert!(fits(&link, &alice));
        assert!(fits(&link, &account("bob", true)));
        assert_eq!(link.message.as_deref(), Some("reply"));
        assert_eq!(link.root.as_deref(), Some("root"));
        for other in [
            SessionInfo { base_url: "https://chat.example.org/other".into(), ..alice.clone() },
            SessionInfo { base_url: "http://chat.example.org/native".into(), ..alice.clone() },
            SessionInfo { base_url: "https://chat.example.org:8443/native".into(), ..alice.clone() },
            account("alice", false),
            SessionInfo {
                native: Some(Identity { instance_id: "instance".into(), data_epoch: "restored".into() }),
                ..alice
            },
        ] {
            assert!(!fits(&link, &other));
        }
    }
    #[test]
    fn legacy_and_notification_links_never_choose_an_arbitrary_account() {
        let old = parse("rocketvibe://salon/%72oom?host=https%3A%2F%2Fchat.example.org%2Fnative").unwrap();
        assert!(fits(&old, &account("alice", false)));
        assert!(!fits(&old, &account("alice", true)));
        assert!(fits(&parse("rocketvibe://salon/room").unwrap(), &account("alice", false)));
        let accounts = [account("alice", true), account("bob", true)];
        let public = parse(&native_permalink(&accounts[0], "room", None, None).unwrap()).unwrap();
        assert_eq!(select(&public, &accounts, None), None);
        assert_eq!(select(&public, &accounts, Some(&accounts[1])), Some(1));
        let scope = serde_json::json!({"instanceId":"instance","dataEpoch":"epoch","userId":"alice"});
        let mut url = Url::parse("rocketvibe://room/room").unwrap();
        url.query_pairs_mut().append_pair("host", &accounts[0].base_url).append_pair("nativeScope", &scope.to_string());
        let push = parse(url.as_str()).unwrap();
        assert_eq!(select(&push, &accounts, Some(&accounts[1])), Some(0));
        assert!(!fits(&push, &accounts[1]));
    }
    #[test]
    fn malformed_scope_cannot_fall_back_to_the_active_session() {
        for url in [
            "https://room/room",
            "rocketvibe://room/room/extra",
            "rocketvibe://room/room?host=file%3A%2F%2F%2Ftmp",
            "rocketvibe://room/room?host=https%3A%2F%2Fbearer%40chat.example.org",
            "rocketvibe://room/room?host=chat.example.org&host=other.example.org",
            "rocketvibe://room/room?instanceId=instance",
            "rocketvibe://room/room?userId=alice",
            "rocketvibe://room/room?nativeScope=null",
            "rocketvibe://room/room?msg=..%2Fsecret",
            "rocketvibe://room/room#token",
        ] {
            assert!(parse(url).is_none(), "{url}");
        }
        assert_eq!(service_url("https://CHAT.example.org:443/native/"), Some("https://chat.example.org/native".into()));
    }
}
