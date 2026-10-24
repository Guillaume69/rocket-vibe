//! Profile photos of the chats and of group authors, kept with the account
//! and asked for again once a week or when WhatsApp says one changed.

use std::sync::Arc;
use std::time::Duration;

use whatsapp_rust::{
    Jid, ProfilePictureLookup, ProfilePictureRequest, ProfilePictureTarget, ProfilePictureType,
};

use crate::engine::{Engine, now};
use crate::projection::Avatar;

const FRESH: i64 = 7 * 24 * 3600 * 1000;
const PAUSE: Duration = Duration::from_millis(400);
const CHATS: usize = 300;
const AUTHORS: usize = 3000;
const MAX_SIZE: usize = 512 << 10;

impl Engine {
    /// Runs while the engine lives: a pass over the stale photos after each
    /// connection or change notice.
    pub(crate) async fn run_avatars(self: Arc<Self>) {
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(20))
            .build()
            .unwrap_or_default();
        loop {
            tokio::select! {
                _ = self.cancelled() => return,
                _ = self.avatar_kick.notified() => {}
            }
            for jid in self.stale_avatars().await {
                if self.is_stopped() || self.ready().is_none() {
                    break;
                }
                self.fetch_avatar(&http, &jid).await;
                tokio::select! {
                    _ = self.cancelled() => return,
                    _ = tokio::time::sleep(PAUSE) => {}
                }
            }
        }
    }

    async fn stale_avatars(&self) -> Vec<String> {
        let fresh = now() - FRESH;
        let mut out = Vec::new();
        // My own photo first: my messages and the account show it.
        if let Some(pn) = self.client().and_then(|c| c.pn()) {
            let own = self.canonical(&pn).await.to_string();
            if self.read_state(|p| p.avatar(&own).is_none_or(|a| a.checked <= fresh)) {
                out.push(own);
            }
        }
        for jid in self.read_state(|p| p.stale_avatars(CHATS, AUTHORS, fresh)) {
            if !out.contains(&jid) {
                out.push(jid);
            }
        }
        out
    }

    async fn fetch_avatar(&self, http: &reqwest::Client, jid: &str) {
        let (Some(client), Ok(parsed)) = (self.ready(), jid.parse::<Jid>()) else {
            return;
        };
        let existing = self.read_state(|p| {
            p.avatar(jid)
                .filter(|a| !a.data.is_empty())
                .map(|a| a.picture.clone())
        });
        let target = if parsed.server.as_str() == "g.us" {
            ProfilePictureTarget::Group(&parsed)
        } else {
            ProfilePictureTarget::Contact(&parsed)
        };
        let request = ProfilePictureRequest::new(target, ProfilePictureType::Preview)
            .existing_id(existing.as_deref());
        let looked =
            tokio::time::timeout(Duration::from_secs(20), client.pictures().lookup(request)).await;
        let picture = match looked {
            Ok(Ok(ProfilePictureLookup::Found(picture))) => picture,
            Ok(Ok(ProfilePictureLookup::NotFound | ProfilePictureLookup::NotAuthorized)) => {
                let frame = self.with_state(|p| {
                    p.keep_avatar(
                        jid,
                        Avatar {
                            checked: now(),
                            ..Avatar::default()
                        },
                    )
                });
                self.emit(frame);
                return;
            }
            // Unchanged since the photo kept.
            Ok(Ok(ProfilePictureLookup::Unchanged)) => {
                return self.with_state(|p| p.avatar_checked(jid, now()));
            }
            // Network or server trouble: asked again at the next pass.
            _ => return,
        };
        let Some(data) = download(http, &picture.url).await else {
            return;
        };
        let frame = self.with_state(|p| {
            p.keep_avatar(
                jid,
                Avatar {
                    picture: picture.id,
                    data,
                    checked: now(),
                },
            )
        });
        self.emit(frame);
    }
}

/// Fetches a photo from WhatsApp's own CDN only, bounded in size.
async fn download(http: &reqwest::Client, address: &str) -> Option<Vec<u8>> {
    let url = reqwest::Url::parse(address).ok()?;
    if url.scheme() != "https" || !url.host_str().is_some_and(|h| h.ends_with(".whatsapp.net")) {
        return None;
    }
    let mut response = http.get(url).send().await.ok()?;
    if !response.status().is_success()
        || response
            .content_length()
            .is_some_and(|n| n > MAX_SIZE as u64)
    {
        return None;
    }
    let mut data = Vec::new();
    while let Some(chunk) = response.chunk().await.ok()? {
        if data.len() + chunk.len() > MAX_SIZE {
            return None;
        }
        data.extend_from_slice(&chunk);
    }
    Some(data)
}
