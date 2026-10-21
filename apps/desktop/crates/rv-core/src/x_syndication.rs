//! An X post read from X itself, for Rocket.Chat accounts only.
//!
//! Rocket.Chat 8.5 fetches X posts with a Googlebot user agent that X
//! refuses, so their `urls` never carry anything. On such an account the
//! card asks X's syndication endpoint, the one X's own embed widget reads,
//! for the post it shows: the computer then tells X which post was linked.
//! A Vibez or Mattermost server collects the post itself and nothing is
//! asked (user decision, 2026-10-14; brain/features/x-posts.md).

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant};

use serde_json::Value;

use crate::content::XPost;
use crate::session::SessionInfo;

const ENDPOINT: &str = "https://cdn.syndication.twimg.com/tweet-result";
/// Bounded so a long session does not keep every post it ever showed.
const MAX_CACHED: usize = 300;
const MAX_BYTES: usize = 512 * 1024;
/// After a failure, the post is not asked again for this long.
const RETRY: Duration = Duration::from_secs(60);

/// What X says of a post, for its card.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Details {
    pub name: Option<String>,
    pub handle: Option<String>,
    pub text: Option<String>,
    pub avatar: Option<String>,
    pub media: Option<String>,
    pub video: bool,
}

impl Details {
    /// X's answer replaces what the card had: on Rocket.Chat that is the handle only.
    pub fn apply(&self, post: &mut XPost) {
        post.name = self.name.clone().or(post.name.take());
        post.handle = self.handle.clone().or(post.handle.take());
        post.text = self.text.clone().or(post.text.take());
        post.avatar = self.avatar.clone().or(post.avatar.take());
        if self.media.is_some() {
            post.media = self.media.clone();
            post.video = self.video;
        }
    }
}

/// Only a Rocket.Chat account asks X: not Vibez, Mattermost, kChat, Teams or WhatsApp.
pub fn applies(info: &SessionInfo) -> bool {
    info.native.is_none() && info.mattermost.is_none() && info.teams.is_none() && !crate::whatsapp::is_whatsapp(info)
}

/// JavaScript's `Number.prototype.toString(36)` for a positive finite value,
/// V8's `DoubleToRadixCString`: the shortest digits that read back as `value`.
fn js_base36(value: f64) -> String {
    const DIGITS: &[u8; 36] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    let mut integer = value.floor();
    let mut fraction = value - integer;
    let mut delta = (0.5 * (value.next_up() - value)).max(0.0f64.next_up());
    let mut decimals: Vec<usize> = Vec::new();
    if fraction >= delta {
        loop {
            fraction *= 36.0;
            delta *= 36.0;
            let digit = fraction as usize;
            decimals.push(digit);
            fraction -= digit as f64;
            if (fraction > 0.5 || (fraction == 0.5 && digit & 1 == 1)) && fraction + delta > 1.0 {
                // Round up, carrying into the integer part past the last decimal.
                loop {
                    match decimals.pop() {
                        None => {
                            integer += 1.0;
                            break;
                        }
                        Some(d) if d + 1 < 36 => {
                            decimals.push(d + 1);
                            break;
                        }
                        Some(_) => {}
                    }
                }
                break;
            }
            if fraction < delta {
                break;
            }
        }
    }
    let mut whole = integer as u64;
    let mut out = Vec::new();
    loop {
        out.push(DIGITS[(whole % 36) as usize]);
        whole /= 36;
        if whole == 0 {
            break;
        }
    }
    out.reverse();
    if !decimals.is_empty() {
        out.push(b'.');
        out.extend(decimals.iter().map(|d| DIGITS[*d]));
    }
    String::from_utf8(out).unwrap_or_default()
}

/// The `token` X's widget sends with the id: `((id / 1e15) * π).toString(36)`
/// without its zeros and point. Its value is not checked today (any non-empty
/// token answers, none gets `{}`; probed 2026-10-14), but this keeps the
/// request the widget's own.
fn token(id: &str) -> String {
    let value = id.parse::<f64>().unwrap_or(0.0) / 1e15 * std::f64::consts::PI;
    js_base36(value).chars().filter(|c| *c != '0' && *c != '.').collect()
}

fn text(v: Option<&Value>) -> Option<String> {
    v.and_then(Value::as_str).filter(|s| !s.trim().is_empty()).map(str::to_owned)
}

fn https(v: Option<&Value>) -> Option<String> {
    text(v).filter(|s| s.starts_with("https://"))
}

/// `[start, end)` of a JSON pair of code-point indices.
fn span(v: Option<&Value>) -> Option<(usize, usize)> {
    let pair = v?.as_array()?;
    let (start, end) = (pair.first()?.as_u64()? as usize, pair.get(1)?.as_u64()? as usize);
    (start <= end).then_some((start, end))
}

/// The text as X shows it: the `display_text_range` slice (it drops leading
/// @replies), without the media's own `t.co` link (`mediaDetails[].indices`,
/// which older posts keep inside the range), other `t.co` links in their
/// display form, then decoded. X counts its indices in code points of the
/// ESCAPED text, `&amp;` being five (probed 2026-10-14).
fn display_text(post: &Value) -> Option<String> {
    let chars: Vec<char> = post.get("text")?.as_str()?.chars().collect();
    let (start, end) = span(post.get("display_text_range")).unwrap_or((0, chars.len()));
    let media: Vec<(usize, usize)> = post
        .get("mediaDetails")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|m| span(m.get("indices")))
        .collect();
    let mut out: String = chars
        .iter()
        .enumerate()
        .filter(|(i, _)| *i >= start && *i < end && !media.iter().any(|(a, b)| i >= a && i < b))
        .map(|(_, c)| c)
        .collect();
    for u in post.pointer("/entities/urls").and_then(Value::as_array).into_iter().flatten() {
        let (Some(short), Some(shown)) =
            (text(u.get("url")), text(u.get("display_url")).or_else(|| text(u.get("expanded_url"))))
        else {
            continue;
        };
        out = out.replace(&short, &shown);
    }
    let out = crate::content::decode_entities(&out);
    let out = out.trim();
    (!out.is_empty()).then(|| out.to_owned())
}

/// A `tweet-result` answer as the card's fields, None if it is not a post.
fn parse(post: &Value) -> Option<Details> {
    if post.get("__typename").and_then(Value::as_str) != Some("Tweet") {
        return None;
    }
    let user = post.get("user");
    let handle = text(user.and_then(|u| u.get("screen_name")));
    let details = post.get("mediaDetails").and_then(Value::as_array).and_then(|m| m.first());
    let kind = details.and_then(|d| d.get("type")).and_then(Value::as_str);
    let media = https(details.and_then(|d| d.get("media_url_https")))
        .or_else(|| https(post.pointer("/photos/0/url")))
        .or_else(|| https(post.pointer("/video/poster")));
    let video = media.is_some()
        && (matches!(kind, Some("video" | "animated_gif")) || details.is_none() && post.get("video").is_some());
    Some(Details {
        name: text(user.and_then(|u| u.get("name"))).or_else(|| handle.clone()),
        // `_normal` is 48 px: the 73 px `_bigger` stays sharp at 36 px on a 2x screen.
        avatar: https(user.and_then(|u| u.get("profile_image_url_https"))).map(|a| match a.rsplit_once("_normal.") {
            Some((stem, ext)) if !ext.contains('/') => format!("{stem}_bigger.{ext}"),
            _ => a,
        }),
        handle,
        text: display_text(post),
        media,
        video,
    })
}

#[derive(Default)]
struct Cache {
    found: HashMap<String, Option<Details>>,
    order: VecDeque<String>,
    failed: HashMap<String, Instant>,
    /// One request per post at a time: cards rebuilt on every list bind
    /// wait for the one in flight instead of asking again.
    asking: HashMap<String, Arc<tokio::sync::Mutex<()>>>,
}

static CACHE: LazyLock<Mutex<Cache>> = LazyLock::new(Mutex::default);

/// What an earlier fetch learned: `Some(None)` when X has no such post.
pub fn cached(id: &str) -> Option<Option<Details>> {
    CACHE.lock().ok()?.found.get(id).cloned()
}

fn remember(id: &str, details: Option<Details>) {
    let Ok(mut cache) = CACHE.lock() else { return };
    cache.failed.remove(id);
    if cache.found.insert(id.to_owned(), details).is_none() {
        cache.order.push_back(id.to_owned());
    }
    while cache.order.len() > MAX_CACHED {
        if let Some(old) = cache.order.pop_front() {
            cache.found.remove(&old);
        }
    }
}

fn failed(id: &str, now: Instant) {
    let Ok(mut cache) = CACHE.lock() else { return };
    cache.failed.retain(|_, at| now.duration_since(*at) < RETRY);
    if cache.failed.len() < MAX_CACHED {
        cache.failed.insert(id.to_owned(), now);
    }
}

fn failed_recently(id: &str, now: Instant) -> bool {
    CACHE.lock().is_ok_and(|c| c.failed.get(id).is_some_and(|at| now.duration_since(*at) < RETRY))
}

/// X refuses a request without a user agent (400); this one names no app.
static CLIENT: LazyLock<Option<reqwest::Client>> = LazyLock::new(|| {
    reqwest::Client::builder()
        .user_agent("Mozilla/5.0")
        .timeout(Duration::from_secs(15))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .ok()
});

/// What one request learned: an answer to remember, or a failure.
enum Answer {
    Known(Option<Details>),
    Failed,
}

async fn ask(id: &str) -> Answer {
    let Some(client) = CLIENT.as_ref() else { return Answer::Failed };
    let url = format!("{ENDPOINT}?id={id}&token={}&lang=en", token(id));
    let Ok(mut response) = client.get(url).send().await else { return Answer::Failed };
    if response.status() == reqwest::StatusCode::NOT_FOUND {
        return Answer::Known(None);
    }
    if !response.status().is_success() {
        return Answer::Failed;
    }
    let mut bytes = Vec::new();
    loop {
        match response.chunk().await {
            Ok(Some(chunk)) if bytes.len() + chunk.len() <= MAX_BYTES => bytes.extend_from_slice(&chunk),
            Ok(None) => break,
            // A cut connection, a timeout or an oversized body says nothing of the post.
            _ => return Answer::Failed,
        }
    }
    match serde_json::from_slice::<Value>(&bytes) {
        Ok(value) => Answer::Known(parse(&value)),
        Err(_) => Answer::Failed,
    }
}

/// Post `id` as X serves it: None when X has no such post (remembered), or
/// on a failure (not remembered as an answer, but not asked again for
/// `RETRY`, so a room scrolled while X refuses sends no request per row).
pub async fn fetch(id: &str) -> Option<Details> {
    if id.is_empty() || id.len() > 20 || !id.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    if let Some(known) = cached(id) {
        return known;
    }
    let lock = CACHE.lock().ok()?.asking.entry(id.to_owned()).or_default().clone();
    let _turn = lock.lock().await;
    if let Some(known) = cached(id) {
        return known;
    }
    let answer = if failed_recently(id, Instant::now()) { None } else { Some(ask(id).await) };
    if let Ok(mut cache) = CACHE.lock() {
        cache.asking.remove(id);
    }
    let answer = answer?;
    match answer {
        Answer::Known(details) => {
            remember(id, details.clone());
            details
        }
        Answer::Failed => {
            failed(id, Instant::now());
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn token_is_the_widget_formula() {
        // Computed with the widget's own JavaScript (mobile's tests share these).
        assert_eq!(token("20"), "6dq1a2xwd93");
        assert_eq!(token("266031293945503744"), "n7rfhxzwhkd");
        assert_eq!(token("1585341984679469056"), "3uchycv2wqc");
        assert_eq!(token("1846966287430918527"), "4h6eyrtzyeo");
        assert_eq!(token("1"), "bhi2ay3f28n");
        assert_eq!(js_base36(35.0), "z");
        assert_eq!(js_base36(36.5), "10.i");
    }

    #[test]
    fn parses_a_post_like_x_shows_it() {
        let photo = json!({
            "__typename": "Tweet",
            "text": "Four more years. http://t.co/bAJE6Vom",
            "display_text_range": [0, 37],
            "user": {"name": "Barack Obama", "screen_name": "BarackObama",
                "profile_image_url_https": "https://pbs.twimg.com/profile_images/1329647526807543809/2SGvnHYV_normal.jpg"},
            "mediaDetails": [{"type": "photo", "indices": [17, 37],
                "media_url_https": "https://pbs.twimg.com/media/A7EiDWcCYAAZT1D.jpg"}]
        });
        assert_eq!(
            parse(&photo),
            Some(Details {
                name: Some("Barack Obama".into()),
                handle: Some("BarackObama".into()),
                text: Some("Four more years.".into()),
                avatar: Some("https://pbs.twimg.com/profile_images/1329647526807543809/2SGvnHYV_bigger.jpg".into()),
                media: Some("https://pbs.twimg.com/media/A7EiDWcCYAAZT1D.jpg".into()),
                video: false,
            })
        );
        let video = json!({"__typename": "Tweet", "text": "x", "user": {"screen_name": "elonmusk"},
            "mediaDetails": [{"type": "video", "media_url_https": "https://pbs.twimg.com/ext_tw_video_thumb/1/pu/img/a.jpg"}]});
        let video = parse(&video).unwrap();
        assert!(video.video);
        assert_eq!(video.name.as_deref(), Some("elonmusk"));
        let escaped = json!({"__typename": "Tweet", "text": "@bob 🚀 see https://t.co/abc &amp; more",
            "display_text_range": [5, 38],
            "entities": {"urls": [{"url": "https://t.co/abc", "display_url": "example.com/page"}]},
            "user": {"profile_image_url_https": "file:///etc/x.jpg"},
            "mediaDetails": [{"type": "photo", "media_url_https": "javascript:alert(1)"}]});
        let escaped = parse(&escaped).unwrap();
        assert_eq!(escaped.text.as_deref(), Some("🚀 see example.com/page & more"));
        assert_eq!((escaped.avatar, escaped.media), (None, None));
        assert_eq!(parse(&json!({"__typename": "TweetTombstone"})), None);
        assert_eq!(parse(&json!({})), None);
    }

    #[test]
    fn indices_count_the_escaped_text_as_x_serves_it() {
        // X's real answer (probed 2026-10-14): the photo's link starts at 39 of
        // the ESCAPED text, so decoding first left "htt" behind.
        let post = json!({"__typename": "Tweet",
            "text": "To an exciting &amp; inspiring future! https://t.co/WUIqN7B2F6",
            "display_text_range": [0, 38], "user": {"screen_name": "a"},
            "mediaDetails": [{"type": "photo", "indices": [39, 62], "media_url_https": "https://pbs.twimg.com/media/b.jpg"}]});
        assert_eq!(parse(&post).unwrap().text.as_deref(), Some("To an exciting & inspiring future!"));
    }

    #[test]
    fn media_fallbacks() {
        let photo = parse(
            &json!({"__typename": "Tweet", "text": "p", "photos": [{"url": "https://pbs.twimg.com/media/p.jpg"}]}),
        )
        .unwrap();
        assert_eq!((photo.media.as_deref(), photo.video), (Some("https://pbs.twimg.com/media/p.jpg"), false));
        let poster =
            parse(&json!({"__typename": "Tweet", "text": "v", "video": {"poster": "https://pbs.twimg.com/v.jpg"}}))
                .unwrap();
        assert_eq!((poster.media.as_deref(), poster.video), (Some("https://pbs.twimg.com/v.jpg"), true));
        let gif = parse(&json!({"__typename": "Tweet", "text": "g",
            "mediaDetails": [{"type": "animated_gif", "media_url_https": "https://pbs.twimg.com/tweet_video_thumb/g.jpg"}]}))
        .unwrap();
        assert!(gif.video);
    }

    #[test]
    fn a_failure_is_paused_not_remembered_and_an_answer_clears_it() {
        let (id, start) = ("990000000000000001", Instant::now());
        failed(id, start);
        assert!(failed_recently(id, start + Duration::from_secs(30)));
        assert!(!failed_recently(id, start + RETRY + Duration::from_secs(1)));
        assert_eq!(cached(id), None, "a failure is not an answer");
        remember(id, None);
        assert_eq!(cached(id), Some(None));
        assert!(!failed_recently(id, start));
    }

    #[tokio::test]
    async fn a_malformed_id_never_reaches_x() {
        for id in ["", "12a", "123456789012345678901", "1/../2"] {
            assert_eq!(fetch(id).await, None, "{id}");
        }
    }

    #[tokio::test]
    #[ignore = "asks X over the network"]
    async fn live_post_and_unknown_post() {
        let post = fetch("266031293945503744").await.expect("X answers the post");
        assert_eq!(post.handle.as_deref(), Some("BarackObama"));
        assert_eq!(post.text.as_deref(), Some("Four more years."));
        assert!(post.media.is_some() && post.avatar.is_some());
        assert_eq!(fetch("1").await, None);
        assert_eq!(cached("1"), Some(None));
    }

    #[test]
    fn x_fills_a_bare_card_and_asks_only_for_rocket_chat() {
        let mut post =
            crate::content::x_posts("https://x.com/BarackObama/status/266031293945503744", None, 3).remove(0);
        Details {
            name: Some("Barack Obama".into()),
            handle: None,
            text: Some("Four more years.".into()),
            avatar: None,
            media: Some("https://pbs.twimg.com/media/a.jpg".into()),
            video: false,
        }
        .apply(&mut post);
        assert_eq!(post.handle.as_deref(), Some("BarackObama"));
        assert_eq!(post.name.as_deref(), Some("Barack Obama"));
        assert!(post.media.is_some());
        // X without media or photo keeps what the card had, the video flag with its picture.
        post.avatar = Some("https://pbs.twimg.com/profile_images/a.jpg".into());
        post.video = true;
        Details { name: None, handle: None, text: None, avatar: None, media: None, video: false }.apply(&mut post);
        assert_eq!(post.media.as_deref(), Some("https://pbs.twimg.com/media/a.jpg"));
        assert!(post.video && post.avatar.is_some() && post.text.is_some());
        let rocket_chat = SessionInfo {
            base_url: "https://chat.example.com".into(),
            user_id: "u".into(),
            username: "me".into(),
            auth_token: "t".into(),
            native: None,
            mattermost: None,
            slack: None,
            teams: None,
        };
        assert!(applies(&rocket_chat));
        let mattermost = SessionInfo { mattermost: Some(crate::mattermost::Flavor::Mattermost), ..rocket_chat.clone() };
        assert!(!applies(&mattermost));
        let kchat = SessionInfo { mattermost: Some(crate::mattermost::Flavor::Kchat), ..rocket_chat.clone() };
        assert!(!applies(&kchat));
        let teams = SessionInfo {
            teams: Some(crate::teams::auth::TeamsAccount { tenant_id: "t".into(), refresh: "r".to_owned().into() }),
            ..rocket_chat.clone()
        };
        assert!(!applies(&teams));
        let vibez = SessionInfo {
            native: Some(crate::native::Identity { instance_id: "i".into(), data_epoch: "e".into() }),
            ..rocket_chat
        };
        assert!(!applies(&vibez));
        assert!(!applies(&crate::whatsapp::account_info("abc123", "33600000000@s.whatsapp.net", "Me")));
    }
}
