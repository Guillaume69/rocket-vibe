//! What a message carries besides its text: quoted messages, files, link
//! previews the server fetched, and video links found in the text.

use serde_json::{Map, Value};

use crate::media::{ImageAttachment, image_attachments};

/// Nesting the server keeps with `Message_QuoteChainLimit` at its default.
pub const QUOTE_DEPTH: usize = 2;

#[derive(Debug, Clone, PartialEq)]
pub struct Quote {
    pub unavailable: bool,
    pub link: String,
    pub author: Option<String>,
    pub text: String,
    /// The quoted message's parsed markdown, serialized.
    pub md: Option<String>,
    pub images: Vec<ImageAttachment>,
    pub quotes: Vec<Quote>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FileKind {
    Audio,
    Video,
    Other,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileAttachment {
    pub kind: FileKind,
    /// Relative to the server for uploads.
    pub url: String,
    pub title: String,
    pub size: Option<i64>,
    pub mime: Option<String>,
    pub description: Option<String>,
}

/// What a bot or an integration posts: a card with an author, a linked
/// title, text, labelled fields and a colour.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CardAttachment {
    pub author: Option<String>,
    pub title: Option<String>,
    pub link: Option<String>,
    pub text: Option<String>,
    pub color: Option<String>,
    /// Label, value, and whether it sits beside the next one.
    pub fields: Vec<(String, String, bool)>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LinkPreview {
    Image {
        url: String,
    },
    Card {
        url: String,
        title: Option<String>,
        description: Option<String>,
        image: Option<String>,
        site: Option<String>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VideoLink {
    pub provider: &'static str,
    pub id: String,
    pub url: String,
    pub thumbnail: Option<String>,
    pub title: Option<String>,
    pub author: Option<String>,
}

fn list(json: Option<&str>) -> Vec<Value> {
    json.and_then(|j| serde_json::from_str::<Vec<Value>>(j).ok()).unwrap_or_default()
}

fn text(v: &Value, key: &str) -> Option<String> {
    v.get(key).and_then(Value::as_str).map(decode_entities).map(|s| s.trim().to_owned()).filter(|s| !s.is_empty())
}

pub fn decode_entities(s: &str) -> String {
    if !s.contains('&') {
        return s.to_owned();
    }
    s.replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#039;", "'")
        .replace("&#39;", "'")
        .replace("&#x27;", "'")
        .replace("&#X27;", "'")
        .replace("&nbsp;", " ")
        .replace("&amp;", "&")
}

pub fn is_web_link(url: &str) -> bool {
    url::Url::parse(url).is_ok_and(|u| matches!(u.scheme(), "http" | "https") && u.host().is_some())
}

fn is_quote(a: &Value) -> bool {
    a.get("message_link").and_then(Value::as_str).is_some()
}

fn quote_of(a: &Value, depth: usize) -> Quote {
    let unavailable = a.get("native_unavailable").and_then(Value::as_bool) == Some(true);
    let inner = a.get("attachments").map(|v| v.to_string());
    let source = a.get("text").and_then(Value::as_str).unwrap_or_default();
    Quote {
        unavailable,
        link: if unavailable { String::new() } else { text(a, "message_link").unwrap_or_default() },
        author: if unavailable { None } else { text(a, "author_name") },
        text: if unavailable {
            String::new()
        } else if a.get("native_reference").is_some_and(Value::is_object) {
            source.to_owned()
        } else {
            crate::actions::strip_quote_prefix(source).to_owned()
        },
        md: if unavailable { None } else { a.get("md").filter(|v| v.is_array()).map(Value::to_string) },
        images: if unavailable { Vec::new() } else { image_attachments(inner.as_deref()) },
        quotes: if !unavailable && depth < QUOTE_DEPTH { quotes_at(inner.as_deref(), depth + 1) } else { Vec::new() },
    }
}

fn quotes_at(json: Option<&str>, depth: usize) -> Vec<Quote> {
    list(json).iter().filter(|a| is_quote(a)).map(|a| quote_of(a, depth)).collect()
}

/// The quoted messages, nested up to `QUOTE_DEPTH`.
pub fn quotes(attachments: Option<&str>) -> Vec<Quote> {
    quotes_at(attachments, 1)
}

/// Uploads that are not images: audio, video, anything else.
pub fn files(attachments: Option<&str>) -> Vec<FileAttachment> {
    list(attachments)
        .iter()
        .filter(|a| !is_quote(a) && a.get("image_url").is_none())
        .filter_map(|a| {
            let (kind, url, mime, size) = if let Some(url) = text(a, "audio_url") {
                (FileKind::Audio, url, text(a, "audio_type"), a.get("audio_size"))
            } else if let Some(url) = text(a, "video_url") {
                (FileKind::Video, url, text(a, "video_type"), a.get("video_size"))
            } else {
                let link = text(a, "title_link").filter(|link| is_upload(a, link))?;
                (FileKind::Other, link, text(a, "format"), a.get("size"))
            };
            Some(FileAttachment {
                kind,
                title: text(a, "title").unwrap_or_else(|| url.rsplit('/').next().unwrap_or_default().to_owned()),
                size: size.and_then(Value::as_i64).or_else(|| a.get("size").and_then(Value::as_i64)),
                description: text(a, "description"),
                url,
                mime,
            })
        })
        .collect()
}

/// A file on the server, not a page elsewhere that a card links to.
fn is_upload(a: &Value, link: &str) -> bool {
    link.starts_with('/') || a.get("title_link_download").and_then(Value::as_bool) == Some(true)
}

/// Attachments that are neither quotes, images, audio, video nor uploads.
pub fn cards(attachments: Option<&str>) -> Vec<CardAttachment> {
    list(attachments)
        .iter()
        .filter(|a| !is_quote(a) && ["image_url", "audio_url", "video_url"].iter().all(|k| a.get(*k).is_none()))
        .filter(|a| !text(a, "title_link").is_some_and(|link| is_upload(a, &link)))
        .map(|a| CardAttachment {
            author: text(a, "author_name"),
            title: text(a, "title"),
            link: text(a, "title_link"),
            text: text(a, "text"),
            color: text(a, "color"),
            fields: a
                .get("fields")
                .and_then(Value::as_array)
                .map(|fields| {
                    fields
                        .iter()
                        .filter_map(|f| {
                            let short = f.get("short").and_then(Value::as_bool).unwrap_or(false);
                            Some((text(f, "title")?, text(f, "value").unwrap_or_default(), short))
                        })
                        .collect()
                })
                .unwrap_or_default(),
        })
        .filter(|c| c.title.is_some() || c.text.is_some() || !c.fields.is_empty())
        .collect()
}

/// "1.4 MB", "830 KB", "12 B".
pub fn human_size(bytes: i64) -> String {
    const UNITS: [&str; 4] = ["KB", "MB", "GB", "TB"];
    if bytes < 1024 {
        return format!("{bytes} B");
    }
    let mut value = bytes as f64 / 1024.0;
    let mut unit = 0;
    while value >= 1024.0 && unit < UNITS.len() - 1 {
        value /= 1024.0;
        unit += 1;
    }
    if value < 10.0 { format!("{value:.1} {}", UNITS[unit]) } else { format!("{value:.0} {}", UNITS[unit]) }
}

fn first(meta: &Map<String, Value>, keys: &[&str]) -> Option<String> {
    let meta = Value::Object(meta.clone());
    keys.iter().find_map(|k| text(&meta, k))
}

fn host(url: &str) -> Option<String> {
    let host = url::Url::parse(url).ok()?.host_str()?.to_owned();
    Some(host.strip_prefix("www.").map(str::to_owned).unwrap_or(host))
}

fn is_image(entry: &Value, url: &str) -> bool {
    let content_type = entry.pointer("/headers/contentType").and_then(Value::as_str).unwrap_or_default();
    if content_type.starts_with("image/") && !content_type.contains("svg") {
        return true;
    }
    let path = url.split(['?', '#']).next().unwrap_or_default().to_lowercase();
    [".jpg", ".jpeg", ".png", ".gif", ".webp", ".avif", ".bmp"].iter().any(|ext| path.ends_with(ext))
}

/// Previews of the message's links, video links left to `video_links`.
pub fn link_previews(urls: Option<&str>, max: usize) -> Vec<LinkPreview> {
    let mut out = Vec::new();
    let mut seen = Vec::new();
    for entry in list(urls) {
        if out.len() >= max {
            break;
        }
        let Some(url) = entry.get("url").and_then(Value::as_str).filter(|u| is_web_link(u)) else { continue };
        if seen.iter().any(|s| s == url) || video_id(url).is_some() {
            continue;
        }
        let preview = if is_image(&entry, url) {
            Some(LinkPreview::Image { url: url.to_owned() })
        } else if let Some(meta) = entry.get("meta").and_then(Value::as_object) {
            let title = first(meta, &["ogTitle", "oembedTitle", "twitterTitle", "pageTitle"]);
            let image = first(meta, &["ogImage", "twitterImage", "oembedThumbnailUrl"]).filter(|i| is_web_link(i));
            (title.is_some() || image.is_some()).then(|| LinkPreview::Card {
                url: url.to_owned(),
                description: first(meta, &["ogDescription", "twitterDescription", "description", "oembedAuthorName"]),
                site: first(meta, &["ogSiteName", "oembedProviderName"]).or_else(|| host(url)),
                title,
                image,
            })
        } else {
            None
        };
        if let Some(p) = preview {
            seen.push(url.to_owned());
            out.push(p);
        }
    }
    out
}

fn take_id(rest: &str, allowed: impl Fn(char) -> bool, exact: Option<usize>) -> Option<String> {
    let id: String = rest.chars().take_while(|c| allowed(*c)).collect();
    match exact {
        Some(n) if id.chars().count() >= n => Some(id.chars().take(n).collect()),
        Some(_) => None,
        None => (!id.is_empty()).then_some(id),
    }
}

fn youtube_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_' || c == '-'
}

/// (provider, id) of a YouTube, Dailymotion or Vimeo link.
fn video_id(link: &str) -> Option<(&'static str, String)> {
    let mut rest = link;
    for scheme in ["https://", "http://"] {
        rest = rest.strip_prefix(scheme).unwrap_or(rest);
    }
    for sub in ["www.", "m."] {
        rest = rest.strip_prefix(sub).unwrap_or(rest);
    }
    if let Some(r) = rest.strip_prefix("youtu.be/") {
        return take_id(r, youtube_char, Some(11)).map(|id| ("YouTube", id));
    }
    if let Some(r) = rest.strip_prefix("youtube.com/") {
        for prefix in ["shorts/", "embed/", "live/", "v/"] {
            if let Some(r) = r.strip_prefix(prefix) {
                return take_id(r, youtube_char, Some(11)).map(|id| ("YouTube", id));
            }
        }
        let query = r.strip_prefix("watch?")?;
        let v = query.split('&').find_map(|pair| pair.strip_prefix("v="))?;
        return take_id(v, youtube_char, Some(11)).map(|id| ("YouTube", id));
    }
    if let Some(r) = rest.strip_prefix("dailymotion.com/video/").or_else(|| rest.strip_prefix("dai.ly/")) {
        return take_id(r, |c| c.is_ascii_alphanumeric(), None).map(|id| ("Dailymotion", id));
    }
    if let Some(r) = rest.strip_prefix("vimeo.com/") {
        return take_id(r, |c| c.is_ascii_digit(), None).map(|id| ("Vimeo", id));
    }
    None
}

/// Video links in the text, in order, titled from the server's `urls` when it has them.
pub fn video_links(text: &str, urls: Option<&str>, max: usize) -> Vec<VideoLink> {
    let titles: Vec<(String, Option<String>, Option<String>)> = list(urls)
        .iter()
        .filter_map(|e| {
            let (_, id) = video_id(e.get("url")?.as_str()?)?;
            let meta = e.get("meta")?.as_object()?;
            Some((
                id,
                first(meta, &["oembedTitle", "ogTitle", "twitterTitle", "pageTitle"]),
                first(meta, &["oembedAuthorName", "ogSiteName"]),
            ))
        })
        .collect();
    let mut out: Vec<VideoLink> = Vec::new();
    for token in text.split(|c: char| c.is_whitespace() || "<>\"'()[]".contains(c)) {
        if out.len() >= max {
            break;
        }
        let Some((provider, id)) = video_id(token) else { continue };
        if out.iter().any(|v| v.provider == provider && v.id == id) {
            continue;
        }
        let (url, thumbnail) = match provider {
            "YouTube" => (
                format!("https://www.youtube.com/watch?v={id}"),
                Some(format!("https://i.ytimg.com/vi/{id}/hqdefault.jpg")),
            ),
            "Dailymotion" => (
                format!("https://www.dailymotion.com/video/{id}"),
                Some(format!("https://www.dailymotion.com/thumbnail/video/{id}")),
            ),
            _ => (format!("https://vimeo.com/{id}"), None),
        };
        let (title, author) =
            titles.iter().find(|(i, _, _)| *i == id).map(|(_, t, a)| (t.clone(), a.clone())).unwrap_or_default();
        out.push(VideoLink { provider, id, url, thumbnail, title, author });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn native_quotes_preserve_literal_legacy_like_prefixes_without_changing_official_quotes() {
        let source = "[ ](https://example.test/channel/general?msg=source) mots";
        let local = json!([{"message_link":"","text":source,"native_reference":{"message_id":"source","room_id":"origin","revision":"1"}}]).to_string();
        assert_eq!(quotes(Some(&local))[0].text, source);
        let official =
            json!([{"message_link":"https://example.test/channel/general?msg=source","text":source}]).to_string();
        assert_eq!(quotes(Some(&official))[0].text, "mots");
        assert!(!quotes(Some(&official))[0].unavailable);
        let unavailable=json!([{"message_link":"https://private.invalid","native_unavailable":true,"text":"private words","author_name":"private author","attachments":[{"image_url":"/private.png"}],"native_reference":{"message_id":"source","room_id":"origin","revision":"1"}}]).to_string();
        let censored = quotes(Some(&unavailable)).remove(0);
        assert!(censored.unavailable);
        assert!(
            censored.author.is_none()
                && censored.text.is_empty()
                && censored.link.is_empty()
                && censored.images.is_empty()
                && censored.quotes.is_empty()
        );
    }

    #[test]
    fn quotes_nest_up_to_the_limit() {
        let level3 = json!({"message_link":"http://x/c?msg=3","text":"three"});
        let level2 = json!({"message_link":"http://x/c?msg=2","text":"two","attachments":[level3]});
        let attachments = json!([
            {"message_link":"http://x/c?msg=1","author_name":"bob","text":"[ ](http://x/c?msg=0) one",
             "attachments":[level2, {"image_url":"/i.png","title_link":"/full.png"}]},
            {"title":"file.pdf","title_link":"/f.pdf"}
        ])
        .to_string();
        let q = quotes(Some(&attachments));
        assert_eq!(q.len(), 1);
        assert_eq!((q[0].author.as_deref(), q[0].text.as_str()), (Some("bob"), "one"));
        assert_eq!(q[0].images[0].source, "/full.png");
        assert_eq!(q[0].quotes[0].text, "two");
        assert!(q[0].quotes[0].quotes.is_empty());
    }

    #[test]
    fn files_by_kind() {
        let attachments = json!([
            {"title":"a.png","image_url":"/a.png"},
            {"title":"voice.m4a","audio_url":"/v.m4a","audio_type":"audio/mp4","audio_size":2048},
            {"title":"clip.mp4","video_url":"/c.mp4","video_size":5_000_000},
            {"title":"doc.pdf","title_link":"/d.pdf","size":900,"format":"PDF"},
            {"message_link":"http://x/c?msg=1","text":"q"}
        ])
        .to_string();
        let f = files(Some(&attachments));
        assert_eq!(f.iter().map(|f| f.kind).collect::<Vec<_>>(), [FileKind::Audio, FileKind::Video, FileKind::Other]);
        assert_eq!(f[0].size, Some(2048));
        assert_eq!(f[2].title, "doc.pdf");
        assert_eq!(human_size(900), "900 B");
        assert_eq!(human_size(2048), "2.0 KB");
        assert_eq!(human_size(5_000_000), "4.8 MB");
    }

    #[test]
    fn integration_cards_are_not_files() {
        let attachments = json!([
            {"author_name":"CI","title":"Build #42","title_link":"https://ci.example/42","text":"passed","color":"#2de0a5",
             "fields":[{"short":true,"title":"Branch","value":"master"},{"title":"Log"}]},
            {"title":"doc.pdf","title_link":"/d.pdf"},
            {"title":"ext.pdf","title_link":"https://x/ext.pdf","title_link_download":true},
            {"image_url":"https://media.giphy.com/x.gif","title_link":"https://giphy.com/x"},
            {"message_link":"http://x/c?msg=1","text":"q"}
        ])
        .to_string();
        let c = cards(Some(&attachments));
        assert_eq!(c.len(), 1);
        assert_eq!(c[0].author.as_deref(), Some("CI"));
        assert_eq!(c[0].link.as_deref(), Some("https://ci.example/42"));
        assert_eq!(c[0].color.as_deref(), Some("#2de0a5"));
        assert_eq!(
            c[0].fields,
            [("Branch".to_owned(), "master".to_owned(), true), ("Log".to_owned(), String::new(), false)]
        );
        let f = files(Some(&attachments));
        assert_eq!(f.iter().map(|f| f.title.as_str()).collect::<Vec<_>>(), ["doc.pdf", "ext.pdf"]);
    }

    #[test]
    fn previews_skip_videos_and_empty_meta() {
        let urls = json!([
            {"url":"https://example.com/a","meta":{"ogTitle":"A &amp; B","ogDescription":"desc","ogImage":"https://example.com/a.png"}},
            {"url":"https://example.com/a","meta":{"ogTitle":"dup"}},
            {"url":"https://youtu.be/dQw4w9WgXcQ","meta":{"oembedTitle":"Never"}},
            {"url":"https://cdn.example.com/cat.JPG"},
            {"url":"https://example.com/empty","meta":{}},
            {"url":"javascript:alert(1)","meta":{"ogTitle":"x"}}
        ])
        .to_string();
        let p = link_previews(Some(&urls), 3);
        assert_eq!(p.len(), 2);
        assert_eq!(
            p[0],
            LinkPreview::Card {
                url: "https://example.com/a".into(),
                title: Some("A & B".into()),
                description: Some("desc".into()),
                image: Some("https://example.com/a.png".into()),
                site: Some("example.com".into()),
            }
        );
        assert_eq!(p[1], LinkPreview::Image { url: "https://cdn.example.com/cat.JPG".into() });
    }

    #[test]
    fn video_links_in_text() {
        let urls =
            json!([{"url":"https://youtu.be/dQw4w9WgXcQ","meta":{"oembedTitle":"Never","oembedAuthorName":"Rick"}}])
                .to_string();
        let v = video_links(
            "see https://youtu.be/dQw4w9WgXcQ and [x](https://www.youtube.com/watch?t=3&v=dQw4w9WgXcQ) \
             https://vimeo.com/76979871 dai.ly/x7tgad0 youtube.com/shorts/short",
            Some(&urls),
            5,
        );
        assert_eq!(
            v.iter().map(|v| (v.provider, v.id.as_str())).collect::<Vec<_>>(),
            [("YouTube", "dQw4w9WgXcQ"), ("Vimeo", "76979871"), ("Dailymotion", "x7tgad0")]
        );
        assert_eq!(v[0].title.as_deref(), Some("Never"));
        assert_eq!(v[0].author.as_deref(), Some("Rick"));
        assert_eq!(v[1].thumbnail, None);
        assert!(video_links("mail me at bob@vimeo.com/1", None, 3).is_empty());
    }
}
