//! Operator-owned GIPHY integration. Keys never travel to a client.
use crate::error::{Error, Result};
use axum::http::StatusCode;
use rv_protocol::social::{GifItem, public_image};
use serde::Deserialize;
use std::{io::Read, path::Path, time::Duration};
use zeroize::Zeroizing;
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Config {
    api_key: String,
    #[serde(default = "rating")]
    rating: String,
}
fn rating() -> String {
    "pg".into()
}
pub struct Giphy {
    key: Zeroizing<String>,
    rating: String,
    http: reqwest::Client,
}
impl Giphy {
    pub fn from_file(
        path: &Path,
    ) -> std::result::Result<Self, Box<dyn std::error::Error + Send + Sync>> {
        let metadata = std::fs::symlink_metadata(path)?;
        if !metadata.is_file() || metadata.len() > 16 * 1024 {
            return Err("GIPHY config must be a regular file of at most 16 KiB".into());
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if metadata.permissions().mode() & 0o077 != 0 {
                return Err("GIPHY config must be private (0600)".into());
            }
        }
        let mut bytes = Zeroizing::new(Vec::new());
        std::fs::File::open(path)?
            .take(16 * 1024 + 1)
            .read_to_end(&mut bytes)?;
        if bytes.len() > 16 * 1024 {
            return Err("GIPHY config is oversized".into());
        }
        Self::parse(&bytes)
    }
    pub fn parse(
        bytes: &[u8],
    ) -> std::result::Result<Self, Box<dyn std::error::Error + Send + Sync>> {
        let c: Config = serde_json::from_slice(bytes)?;
        if c.api_key.trim().is_empty()
            || c.api_key.len() > 256
            || !matches!(c.rating.as_str(), "g" | "pg" | "pg-13" | "r")
        {
            return Err("Invalid GIPHY configuration".into());
        }
        Ok(Self {
            key: Zeroizing::new(c.api_key),
            rating: c.rating,
            http: reqwest::Client::builder()
                .timeout(Duration::from_secs(10))
                .redirect(reqwest::redirect::Policy::none())
                .build()?,
        })
    }
    pub async fn search(&self, query: &str, stickers: bool) -> Result<Vec<GifItem>> {
        if query.len() > 128 || query.chars().any(char::is_control) {
            return Err(Error::invalid());
        }
        let kind = if stickers { "stickers" } else { "gifs" };
        let endpoint = if query.trim().is_empty() {
            "trending"
        } else {
            "search"
        };
        let url = format!("https://api.giphy.com/v1/{kind}/{endpoint}");
        let mut response = self
            .http
            .get(url)
            .query(&[
                ("api_key", self.key.as_str()),
                ("q", query.trim()),
                ("limit", "10"),
                ("rating", self.rating.as_str()),
            ])
            .send()
            .await
            .map_err(|_| unavailable())?;
        if !response.status().is_success() {
            return Err(unavailable());
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|_| unavailable())? {
            if bytes.len() + chunk.len() > 1_048_576 {
                return Err(unavailable());
            }
            bytes.extend_from_slice(&chunk)
        }
        parse(&bytes)
    }
}
fn unavailable() -> Error {
    Error::new(StatusCode::SERVICE_UNAVAILABLE, "giphy_unavailable")
}
fn parse(bytes: &[u8]) -> Result<Vec<GifItem>> {
    let value: serde_json::Value = serde_json::from_slice(bytes).map_err(|_| unavailable())?;
    let data = value
        .get("data")
        .and_then(serde_json::Value::as_array)
        .ok_or_else(unavailable)?;
    Ok(data
        .iter()
        .take(10)
        .filter_map(|g| {
            let image = g
                .get("images")?
                .get("downsized")
                .or_else(|| g.get("images")?.get("original"))?;
            let url = image.get("url")?.as_str()?;
            let host = url::Url::parse(url).ok()?;
            if !public_image(url)
                || !host
                    .host_str()
                    .is_some_and(|h| h == "media.giphy.com" || h.ends_with(".giphy.com"))
            {
                return None;
            }
            let dimension = |k: &str| {
                image
                    .get(k)
                    .and_then(|v| v.as_str().and_then(|s| s.parse::<u32>().ok()))
                    .unwrap_or(0)
                    .min(4096)
            };
            Some(GifItem {
                id: g.get("id")?.as_str()?.into(),
                title: g
                    .get("title")
                    .and_then(|v| v.as_str())
                    .unwrap_or("GIF")
                    .chars()
                    .take(200)
                    .collect(),
                url: url.into(),
                width: dimension("width"),
                height: dimension("height"),
                source: g
                    .get("url")
                    .and_then(|v| v.as_str())
                    .filter(|s| public_image(s))
                    .map(str::to_owned),
            })
        })
        .collect())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_remote_urls_outside_giphy() {
        let bytes=br#"{"data":[{"id":"a","images":{"downsized":{"url":"https://evil.example/x.gif"}}},{"id":"b","title":"Dance","images":{"downsized":{"url":"https://media.giphy.com/media/b/giphy.gif","width":"120","height":"80"}}}]}"#;
        let items = parse(bytes).unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].id, "b");
        assert_eq!(items[0].width, 120);
    }
}
