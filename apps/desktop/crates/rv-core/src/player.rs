//! The inline video player: a page of ours holding the provider's embed in
//! an iframe. YouTube refuses an embed loaded without a Referer (error 153),
//! which a page loaded from a string or opened directly never sends, so the
//! page is served from `ORIGIN`, a name of ours that resolves nowhere: each
//! engine hands the page over itself, and the iframe's requests carry it.

use crate::call::{origin, same_origin};

pub const ORIGIN: &str = "https://player.rocket-vibe.invalid";

/// The provider's player for the video, started as soon as it loads.
pub fn embed_url(provider: &str, id: &str) -> Option<String> {
    let safe = !id.is_empty() && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-');
    if !safe {
        return None;
    }
    Some(match provider {
        "YouTube" => {
            format!("https://www.youtube.com/embed/{id}?autoplay=1&playsinline=1&rel=0&fs=0&origin={ORIGIN}")
        }
        "Dailymotion" => format!("https://www.dailymotion.com/embed/video/{id}?autoplay=1"),
        "Vimeo" => format!("https://player.vimeo.com/video/{id}?autoplay=1"),
        _ => return None,
    })
}

/// The page around the embed, filling the player's frame.
pub fn page(provider: &str, id: &str) -> Option<String> {
    let src = embed_url(provider, id)?;
    Some(format!(
        "<!doctype html><html><head><meta charset=\"utf-8\">\
         <meta name=\"referrer\" content=\"strict-origin-when-cross-origin\">\
         <style>html,body{{margin:0;height:100%;background:#000;overflow:hidden}}\
         iframe{{border:0;width:100%;height:100%;display:block}}</style></head>\
         <body><iframe src=\"{src}\" allow=\"autoplay; encrypted-media; picture-in-picture\" \
         referrerpolicy=\"strict-origin-when-cross-origin\"></iframe></body></html>"
    ))
}

/// The page's own address, for engines that load it by URL.
pub fn page_url(provider: &str, id: &str) -> String {
    format!("{ORIGIN}/{}-{id}.html", provider.to_lowercase())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Navigation {
    Allow,
    /// Cancelled here, opened in the browser.
    Browser,
    Block,
}

/// What the player does with a navigation to `target`: the window itself
/// stays on our page; inside the embed the provider goes where it likes,
/// but a link the user follows out of the player ("Watch on YouTube")
/// opens in the browser.
pub fn navigation(target: &str, main_frame: bool, user_click: bool) -> Navigation {
    let web = origin(target).is_some();
    if main_frame {
        return if target == "about:blank" || same_origin(target, ORIGIN) {
            Navigation::Allow
        } else if user_click && web {
            Navigation::Browser
        } else {
            Navigation::Block
        };
    }
    if user_click && web && !is_embed(target) { Navigation::Browser } else { Navigation::Allow }
}

fn is_embed(url: &str) -> bool {
    let Some((_, rest)) = url.split_once("://") else { return false };
    let (host, path) = rest.split_once('/').unwrap_or((rest, ""));
    let host = host.to_lowercase();
    let host = host.strip_prefix("www.").unwrap_or(&host);
    match host {
        "youtube.com" | "youtube-nocookie.com" => path.starts_with("embed/"),
        "dailymotion.com" | "geo.dailymotion.com" => path.starts_with("embed/") || path.starts_with("player"),
        "player.vimeo.com" => path.starts_with("video/"),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn embeds_each_provider() {
        let youtube = embed_url("YouTube", "dQw4w9WgXcQ").unwrap();
        assert!(youtube.starts_with("https://www.youtube.com/embed/dQw4w9WgXcQ?autoplay=1"));
        assert!(youtube.ends_with("&origin=https://player.rocket-vibe.invalid"));
        assert_eq!(
            embed_url("Dailymotion", "x7tgad0").unwrap(),
            "https://www.dailymotion.com/embed/video/x7tgad0?autoplay=1"
        );
        assert_eq!(embed_url("Vimeo", "76979871").unwrap(), "https://player.vimeo.com/video/76979871?autoplay=1");
        assert_eq!(embed_url("Other", "x"), None);
        assert_eq!(embed_url("YouTube", "a\"><script>"), None);
        assert_eq!(embed_url("YouTube", ""), None);
    }

    #[test]
    fn the_page_holds_the_embed() {
        let html = page("Vimeo", "76979871").unwrap();
        assert!(html.contains("<iframe src=\"https://player.vimeo.com/video/76979871?autoplay=1\""));
        assert!(html.contains("allow=\"autoplay"));
        assert!(!html.contains("allowfullscreen"));
        assert_eq!(page_url("YouTube", "dQw4w9WgXcQ"), "https://player.rocket-vibe.invalid/youtube-dQw4w9WgXcQ.html");
    }

    #[test]
    fn the_window_stays_on_the_page() {
        use Navigation::*;
        assert_eq!(navigation("https://player.rocket-vibe.invalid/youtube-x.html", true, false), Allow);
        assert_eq!(navigation("about:blank", true, false), Allow);
        assert_eq!(navigation("https://www.youtube.com/watch?v=x", true, true), Browser);
        assert_eq!(navigation("https://www.youtube.com/watch?v=x", true, false), Block);
        assert_eq!(navigation("file:///etc/passwd", true, true), Block);
    }

    #[test]
    fn the_embed_goes_where_it_likes_until_a_link_leaves_it() {
        use Navigation::*;
        assert_eq!(navigation("https://googleads.g.doubleclick.net/pagead/id", false, false), Allow);
        assert_eq!(navigation("https://www.youtube-nocookie.com/embed/other", false, true), Allow);
        assert_eq!(navigation("https://www.youtube.com/watch?v=x", false, true), Browser);
        assert_eq!(navigation("https://vimeo.com/76979871", false, true), Browser);
        assert_eq!(navigation("https://player.vimeo.com/video/1", false, true), Allow);
    }
}
