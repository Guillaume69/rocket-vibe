//! What a call window may load. It holds the camera and the microphone, so
//! it only follows the origin the server named for the call: anything else
//! opens in the browser. Same rule as the Android call screen
//! (`apps/mobile/lib/origin.ts`): the authority is taken as written,
//! userinfo included, so `https://server@evil` never passes for `https://server`.

/// Scheme and authority of a web URL, lowercased; None for anything else.
pub fn origin(url: &str) -> Option<String> {
    let (scheme, rest) = url.split_once("://")?;
    if !scheme.eq_ignore_ascii_case("https") && !scheme.eq_ignore_ascii_case("http") {
        return None;
    }
    let authority = rest.split(['/', '?', '#']).next().unwrap_or_default();
    if authority.is_empty() {
        return None;
    }
    Some(format!("{scheme}://{authority}").to_lowercase())
}

/// Whether `url` is served by the origin of `call_url`.
pub fn same_origin(url: &str, call_url: &str) -> bool {
    matches!((origin(url), origin(call_url)), (Some(a), Some(b)) if a == b)
}

/// Where the call window may go: the call's origin, and the blank page and
/// in-page resources an engine loads by itself.
pub fn allowed(url: &str, call_url: &str) -> bool {
    url == "about:blank"
        || url == "about:srcdoc"
        || url.strip_prefix("blob:").is_some_and(|inner| same_origin(inner, call_url))
        || same_origin(url, call_url)
}

/// The Wayland app id a Chromium-family browser gives the app window it
/// opens on `url` (`--app`), which ignores `--class` there: `prefix` is the
/// browser's (`chrome`, `brave`, `msedge`, `vivaldi`), then the host without
/// its port, `_`, the path with every `/` as `_`, and the profile. Read from
/// Chromium's own `set_app_id`; the desktop names its icon by it.
pub fn app_window_id(prefix: &str, url: &str) -> Option<String> {
    let (_, rest) = url.split_once("://")?;
    let end = rest.find(['?', '#']).unwrap_or(rest.len());
    let rest = &rest[..end];
    let (authority, path) = rest.split_at(rest.find('/').unwrap_or(rest.len()));
    let host = authority.rsplit('@').next()?.split(':').next().filter(|h| !h.is_empty())?;
    let path = if path.is_empty() { "/" } else { path };
    Some(format!("{prefix}-{host}_{}-Default", path.replace('/', "_")))
}

/// The meeting's address as people share it: without the query, which holds
/// the signed token of whoever joined.
pub fn meeting_link(url: &str) -> String {
    url.split(['?', '#']).next().unwrap_or(url).to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn app_window_ids_follow_chromium() {
        assert_eq!(app_window_id("chrome", "https://example.org/").as_deref(), Some("chrome-example.org__-Default"));
        assert_eq!(
            app_window_id("chrome", "https://example.org/RocketChat6ac0214aed626761c8bf3f56?jwt=abc.def#config.x=1")
                .as_deref(),
            Some("chrome-example.org__RocketChat6ac0214aed626761c8bf3f56-Default")
        );
        assert_eq!(
            app_window_id("chrome", "https://example.org:8443/a/b-c_d.e").as_deref(),
            Some("chrome-example.org__a_b-c_d.e-Default")
        );
        assert_eq!(app_window_id("brave", "https://meet.example").as_deref(), Some("brave-meet.example__-Default"));
        assert_eq!(app_window_id("brave", "not a url"), None);
    }

    #[test]
    fn origins_are_scheme_and_authority() {
        assert_eq!(origin("https://Meet.Barrut.me/Room?jwt=x").as_deref(), Some("https://meet.barrut.me"));
        assert_eq!(origin("http://localhost:3000").as_deref(), Some("http://localhost:3000"));
        assert_eq!(origin("rocketvibe://room/x"), None);
        assert_eq!(origin("https://"), None);
        assert_eq!(origin("not a url"), None);
    }

    #[test]
    fn same_origin_is_not_a_prefix_match() {
        let call = "https://meet.barrut.me/RocketChat6abc?jwt=token";
        assert!(same_origin("https://meet.barrut.me/other", call));
        assert!(!same_origin("https://meet.barrut.me.evil.com/x", call));
        assert!(!same_origin("https://meet.barrut.me@evil.com/x", call));
        assert!(!same_origin("http://meet.barrut.me/x", call));
        assert!(!same_origin("https://meet.barrut.me:8443/x", call));
    }

    #[test]
    fn the_window_stays_on_the_call() {
        let call = "https://meet.barrut.me/Room";
        assert!(allowed("about:blank", call));
        assert!(allowed("blob:https://meet.barrut.me/1234", call));
        assert!(allowed("https://meet.barrut.me/static/close.html", call));
        assert!(!allowed("https://jitsi.org/", call));
        assert!(!allowed("data:text/html,hi", call));
        assert!(!allowed("blob:https://evil.com/1234", call));
    }

    #[test]
    fn the_shared_link_leaves_the_token_out() {
        assert_eq!(
            meeting_link("https://meet.barrut.me/RocketChat6abc?jwt=secret#config.x=1"),
            "https://meet.barrut.me/RocketChat6abc"
        );
        assert_eq!(meeting_link("https://meet.barrut.me/Room"), "https://meet.barrut.me/Room");
    }
}
