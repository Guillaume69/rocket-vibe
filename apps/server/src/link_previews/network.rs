//! Public-network-only, credential-free collector. Every redirect receives a
//! fresh DNS check and a new client pinned to the complete validated answer.
//! References: OWASP SSRF Prevention Cheat Sheet and IANA special registries.
use reqwest::{Client, Url, header, redirect::Policy};
use rv_protocol::link_previews::{MAX_PREVIEWS, MAX_URL_BYTES, PreviewKind};
use scraper::{Html, Selector};
use std::{
    io::Cursor,
    net::{IpAddr, SocketAddr},
    time::Duration,
};

const PAGE_BYTES: usize = 512 * 1024;
const IMAGE_BYTES: usize = 2 * 1024 * 1024;
const REQUEST_TIME: Duration = Duration::from_secs(8);
const TOTAL_TIME: Duration = Duration::from_secs(24);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Failure {
    Blocked,
    Unsupported,
    TooLarge,
    Network,
}
impl Failure {
    pub(super) fn retry(self) -> bool {
        self == Self::Network
    }
}
type Result<T> = std::result::Result<T, Failure>;

#[derive(Debug)]
pub(super) struct Collected {
    pub kind: PreviewKind,
    pub title: Option<String>,
    pub description: Option<String>,
    pub site: Option<String>,
    pub image: Option<NormalizedImage>,
}
#[derive(Debug)]
pub(super) struct NormalizedImage {
    pub bytes: Vec<u8>,
    pub width: u32,
    pub height: u32,
}
#[derive(Debug)]
struct Resource {
    final_url: Url,
    media_type: String,
    charset: Option<String>,
    bytes: Vec<u8>,
}

/// Conservative public-unicast policy: rejects special IPv4 assignments,
/// transition/mapped IPv6, documentation and unallocated IPv6 space too.
/// Some globally reachable special-purpose anycast assignments are excluded.
pub(super) fn public_address(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => {
            let [a, b, c, _] = ip.octets();
            !(a == 0
                || a == 10
                || a == 127
                || a >= 224
                || a == 100 && (64..=127).contains(&b)
                || a == 169 && b == 254
                || a == 172 && (16..=31).contains(&b)
                || a == 192 && (b == 168 || b == 0 && (c == 0 || c == 2) || b == 88 && c == 99)
                || a == 198 && (b == 18 || b == 19 || b == 51 && c == 100)
                || a == 203 && b == 0 && c == 113)
        }
        IpAddr::V6(ip) => {
            let s = ip.segments();
            s[0] & 0xe000 == 0x2000
                && !(s[0] == 0x2001 && (s[1] < 0x200 || s[1] == 0xdb8))
                && s[0] != 0x2002
                && !(s[0] == 0x3fff && s[1] & 0xf000 == 0)
        }
    }
}

pub(super) fn web_url(raw: &str) -> Result<Url> {
    if raw.len() > MAX_URL_BYTES || raw.chars().any(char::is_control) {
        return Err(Failure::Blocked);
    }
    let mut url = Url::parse(raw).map_err(|_| Failure::Blocked)?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || !matches!(url.port_or_known_default(), Some(80 | 443))
    {
        return Err(Failure::Blocked);
    }
    if let Some(host) = url.host_str() {
        let host = host.trim_end_matches('.').to_ascii_lowercase();
        if !host.contains('.')
            && url
                .host()
                .is_some_and(|h| matches!(h, url::Host::Domain(_)))
            || ["localhost", "local", "internal", "home.arpa", "onion"]
                .iter()
                .any(|suffix| host == *suffix || host.ends_with(&format!(".{suffix}")))
        {
            return Err(Failure::Blocked);
        }
    }
    if let Some(ip) = match url.host() {
        Some(url::Host::Ipv4(ip)) => Some(IpAddr::V4(ip)),
        Some(url::Host::Ipv6(ip)) => Some(IpAddr::V6(ip)),
        _ => None,
    } && !public_address(ip)
    {
        return Err(Failure::Blocked);
    }
    url.set_fragment(None);
    Ok(url)
}

fn checked_addresses(addresses: Vec<SocketAddr>) -> Result<Vec<SocketAddr>> {
    if addresses.is_empty()
        || addresses.len() > 64
        || addresses.iter().any(|a| !public_address(a.ip()))
    {
        return Err(Failure::Blocked);
    }
    Ok(addresses)
}
async fn resolve(url: &Url) -> Result<Vec<SocketAddr>> {
    let host = url.host_str().ok_or(Failure::Blocked)?;
    let port = url.port_or_known_default().ok_or(Failure::Blocked)?;
    let addresses = match url.host() {
        Some(url::Host::Ipv4(ip)) => vec![SocketAddr::new(IpAddr::V4(ip), port)],
        Some(url::Host::Ipv6(ip)) => vec![SocketAddr::new(IpAddr::V6(ip), port)],
        _ => tokio::time::timeout(
            Duration::from_secs(3),
            tokio::net::lookup_host((host, port)),
        )
        .await
        .map_err(|_| Failure::Network)?
        .map_err(|_| Failure::Network)?
        .take(65)
        .collect(),
    };
    checked_addresses(addresses)
}
fn client(host: &str, addresses: &[SocketAddr]) -> Result<Client> {
    Client::builder()
        .no_proxy()
        .redirect(Policy::none())
        .referer(false)
        .no_gzip()
        .no_brotli()
        .no_deflate()
        .no_zstd()
        .http1_only()
        .resolve_to_addrs(host, addresses)
        .connect_timeout(Duration::from_secs(3))
        .timeout(REQUEST_TIME)
        .user_agent("RocketVibe-LinkPreview/1")
        .build()
        .map_err(|_| Failure::Network)
}
fn redirect(current: &Url, location: &str) -> Result<Url> {
    if location.len() > MAX_URL_BYTES {
        return Err(Failure::Blocked);
    }
    let next = current.join(location).map_err(|_| Failure::Blocked)?;
    let next = web_url(next.as_str())?;
    if current.scheme() == "https" && next.scheme() == "http" {
        return Err(Failure::Blocked);
    }
    Ok(next)
}
async fn fetch(raw: &str, limit: usize, image_only: bool) -> Result<Resource> {
    let mut url = web_url(raw)?;
    for hop in 0..=4 {
        let addresses = resolve(&url).await?;
        let request = client(url.host_str().ok_or(Failure::Blocked)?, &addresses)?;
        let response = request
            .get(url.clone())
            .header(
                header::ACCEPT,
                if image_only {
                    "image/png,image/jpeg,image/gif,image/webp"
                } else {
                    "text/html,application/xhtml+xml,image/png,image/jpeg,image/gif,image/webp"
                },
            )
            .header(header::ACCEPT_ENCODING, "identity")
            .send()
            .await
            .map_err(|_| Failure::Network)?;
        let status = response.status();
        if matches!(status.as_u16(), 301 | 302 | 303 | 307 | 308) {
            if hop == 4 {
                return Err(Failure::Blocked);
            }
            let location = response
                .headers()
                .get(header::LOCATION)
                .and_then(|v| v.to_str().ok())
                .ok_or(Failure::Blocked)?;
            url = redirect(&url, location)?;
            continue;
        }
        if !status.is_success() {
            return Err(if status.is_server_error() || status.as_u16() == 429 {
                Failure::Network
            } else {
                Failure::Unsupported
            });
        }
        return read_resource(response, url, limit, image_only).await;
    }
    Err(Failure::Blocked)
}
async fn read_resource(
    mut response: reqwest::Response,
    url: Url,
    limit: usize,
    image_only: bool,
) -> Result<Resource> {
    if response
        .headers()
        .get(header::CONTENT_ENCODING)
        .is_some_and(|v| v != "identity")
    {
        return Err(Failure::Unsupported);
    }
    let content_type = response
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .ok_or(Failure::Unsupported)?;
    let mut parts = content_type.split(';');
    let media_type = parts.next().unwrap_or("").trim().to_ascii_lowercase();
    let is_image = matches!(
        media_type.as_str(),
        "image/png" | "image/jpeg" | "image/gif" | "image/webp"
    );
    if !is_image
        && (image_only || !matches!(media_type.as_str(), "text/html" | "application/xhtml+xml"))
    {
        return Err(Failure::Unsupported);
    }
    let charset = parts.find_map(|part| {
        let (key, value) = part.trim().split_once('=')?;
        key.eq_ignore_ascii_case("charset")
            .then(|| value.trim_matches(['\'', '"']).to_owned())
    });
    let limit = if is_image {
        limit.min(IMAGE_BYTES)
    } else {
        limit.min(PAGE_BYTES)
    };
    if response.content_length().is_some_and(|n| n > limit as u64) {
        return Err(Failure::TooLarge);
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| Failure::Network)? {
        if bytes.len() + chunk.len() > limit {
            return Err(Failure::TooLarge);
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(Resource {
        final_url: url,
        media_type,
        charset,
        bytes,
    })
}

pub(super) fn links(source: &str) -> Vec<String> {
    use rv_protocol::markdown::Node;
    fn collect(nodes: &[Node], out: &mut Vec<String>) {
        for node in nodes {
            if out.len() == MAX_PREVIEWS {
                break;
            }
            match node {
                Node::Link { href, .. } => {
                    if web_url(href).is_ok() && !out.contains(href) {
                        out.push(href.clone());
                    }
                }
                Node::Paragraph { children }
                | Node::Bold { children }
                | Node::Italic { children }
                | Node::Strike { children }
                | Node::Heading { children, .. }
                | Node::List { children, .. }
                | Node::ListItem { children, .. } => collect(children, out),
                _ => (), // Do not unfurl quoted text, code, or inline images.
            }
        }
    }
    let mut out = Vec::new();
    collect(&rv_protocol::markdown::parse(source).nodes, &mut out);
    out
}

fn bounded_text(raw: &str, max: usize) -> Option<String> {
    let value = raw.split_whitespace().collect::<Vec<_>>().join(" ");
    let value: String = value
        .chars()
        .filter(|c| !c.is_control())
        .scan(0usize, |bytes, c| {
            *bytes += c.len_utf8();
            (*bytes <= max).then_some(c)
        })
        .collect();
    (!value.is_empty()).then_some(value)
}
struct Metadata {
    title: Option<String>,
    description: Option<String>,
    site: Option<String>,
    image_url: Option<String>,
}
fn metadata(page: &Resource) -> Result<Metadata> {
    let encoding = match &page.charset {
        Some(label) => {
            encoding_rs::Encoding::for_label(label.as_bytes()).ok_or(Failure::Unsupported)?
        }
        None => encoding_rs::UTF_8,
    };
    let (source, _, _) = encoding.decode(&page.bytes);
    let document = Html::parse_document(&source);
    let selector = Selector::parse("head meta").expect("static selector");
    let mut values = std::collections::BTreeMap::new();
    for element in document.select(&selector).take(512) {
        if let (Some(key), Some(value)) = (
            element
                .value()
                .attr("property")
                .or_else(|| element.value().attr("name")),
            element.value().attr("content"),
        ) {
            values
                .entry(key.to_ascii_lowercase())
                .or_insert_with(|| value.to_owned());
        }
    }
    let first = |keys: &[&str], max| {
        keys.iter()
            .find_map(|k| values.get(*k).and_then(|v| bounded_text(v, max)))
    };
    let title = first(&["og:title", "twitter:title"], 512).or_else(|| {
        document
            .select(&Selector::parse("head title").expect("static selector"))
            .next()
            .and_then(|e| bounded_text(&e.text().collect::<String>(), 512))
    });
    let image_url = [
        "og:image:secure_url",
        "og:image",
        "twitter:image",
        "twitter:image:src",
    ]
    .iter()
    .find_map(|key| {
        let raw = values.get(*key)?;
        if raw.len() > MAX_URL_BYTES {
            return None;
        }
        let url = page.final_url.join(raw).ok()?;
        web_url(url.as_str()).ok().map(|u| u.to_string())
    });
    Ok(Metadata {
        title,
        description: first(
            &["og:description", "twitter:description", "description"],
            2048,
        ),
        site: first(&["og:site_name"], 256)
            .or_else(|| page.final_url.host_str().and_then(|h| bounded_text(h, 256))),
        image_url,
    })
}
fn normalize_image(resource: Resource) -> Result<NormalizedImage> {
    let format = match resource.media_type.as_str() {
        "image/png" => image::ImageFormat::Png,
        "image/jpeg" => image::ImageFormat::Jpeg,
        "image/gif" => image::ImageFormat::Gif,
        "image/webp" => image::ImageFormat::WebP,
        _ => return Err(Failure::Unsupported),
    };
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(8192);
    limits.max_image_height = Some(8192);
    limits.max_alloc = Some(32 * 1024 * 1024);
    let mut reader = image::ImageReader::with_format(Cursor::new(&resource.bytes), format);
    reader.limits(limits);
    let decoded = reader.decode().map_err(|_| Failure::Unsupported)?;
    if decoded.width() == 0 || decoded.height() == 0 {
        return Err(Failure::Unsupported);
    }
    let thumbnail = decoded.thumbnail(1200, 1200);
    let mut output = Cursor::new(Vec::new());
    thumbnail
        .write_to(&mut output, image::ImageFormat::Png)
        .map_err(|_| Failure::Unsupported)?;
    if output.get_ref().len() > 4 * 1024 * 1024 {
        return Err(Failure::TooLarge);
    }
    Ok(NormalizedImage {
        bytes: output.into_inner(),
        width: thumbnail.width(),
        height: thumbnail.height(),
    })
}
async fn collect_inner(url: &str) -> Result<Collected> {
    let resource = fetch(url, IMAGE_BYTES, false).await?;
    if resource.media_type.starts_with("image/") {
        let image = tokio::task::spawn_blocking(move || normalize_image(resource))
            .await
            .map_err(|_| Failure::Unsupported)??;
        return Ok(Collected {
            kind: PreviewKind::Image,
            title: None,
            description: None,
            site: None,
            image: Some(image),
        });
    }
    let meta = tokio::task::spawn_blocking(move || metadata(&resource))
        .await
        .map_err(|_| Failure::Unsupported)??;
    let image = if let Some(image_url) = meta.image_url {
        match fetch(&image_url, IMAGE_BYTES, true).await {
            Ok(resource) => tokio::task::spawn_blocking(move || normalize_image(resource))
                .await
                .ok()
                .and_then(Result::ok),
            Err(_) => None, // A bad thumbnail does not suppress a valid text card.
        }
    } else {
        None
    };
    if meta.title.is_none() && image.is_none() {
        return Err(Failure::Unsupported);
    }
    Ok(Collected {
        kind: PreviewKind::Page,
        title: meta.title,
        description: meta.description,
        site: meta.site,
        image,
    })
}
pub(super) async fn collect(url: &str) -> Result<Collected> {
    tokio::time::timeout(TOTAL_TIME, collect_inner(url))
        .await
        .map_err(|_| Failure::Network)?
}

#[cfg(test)]
mod tests;
