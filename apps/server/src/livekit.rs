//! The operator's LiveKit SFU: join tokens for members, and the RoomService API
//! (Twirp over HTTP) the voice worker reads and corrects. Media never crosses
//! this process.
use crate::{
    auth,
    error::{Error, Result},
};
use chrono::{DateTime, Duration, Utc};
use data_encoding::BASE64URL_NOPAD;
use hmac::{Hmac, Mac};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::Sha256;
use std::{io::Read, path::Path};
use url::Url;
use zeroize::Zeroizing;

/// Long enough to connect; an established connection outlives its token.
pub(crate) const TOKEN_SECONDS: i64 = 300;
const ADMIN_SECONDS: i64 = 60;
/// The LiveKit attribute a participant sets on itself while deafened.
pub(crate) const DEAFENED: &str = "rv.deafened";

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Configuration {
    url: String,
    api_url: String,
    api_key: String,
    api_secret: String,
}

/// Operator-owned SFU origin and shared HS256 secret. Intentionally no Debug.
pub struct LiveKit {
    url: String,
    api: Url,
    key: String,
    secret: Zeroizing<Vec<u8>>,
    http: reqwest::Client,
}

/// One participant as the SFU reports it.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Participant {
    pub identity: String,
    pub muted: bool,
    pub deafened: bool,
    pub camera: bool,
    /// The sources it may publish, as protojson names, sorted; empty when it may not publish.
    pub sources: Vec<String>,
}

/// What a participant may publish: microphone and camera for a member allowed
/// to speak, and the screen for the one holding the room's share.
pub(crate) fn sources(speak: bool, screen: bool) -> Vec<String> {
    let mut sources = Vec::new();
    if speak {
        sources.extend(["CAMERA", "MICROPHONE"]);
        if screen {
            sources.extend(["SCREEN_SHARE", "SCREEN_SHARE_AUDIO"]);
        }
    }
    sources.into_iter().map(str::to_owned).collect()
}

impl LiveKit {
    pub fn from_file(path: &Path) -> std::result::Result<Self, &'static str> {
        let metadata =
            std::fs::symlink_metadata(path).map_err(|_| "Cannot read RV_LIVEKIT_CONFIG_FILE")?;
        if !metadata.is_file() || metadata.len() > 16 * 1024 {
            return Err("RV_LIVEKIT_CONFIG_FILE must be a regular file of at most 16 KiB");
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if metadata.permissions().mode() & 0o077 != 0 {
                return Err("RV_LIVEKIT_CONFIG_FILE must not be readable by group or others");
            }
        }
        let mut bytes = Zeroizing::new(Vec::new());
        std::fs::File::open(path)
            .map_err(|_| "Cannot read RV_LIVEKIT_CONFIG_FILE")?
            .take(16 * 1024 + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| "Cannot read RV_LIVEKIT_CONFIG_FILE")?;
        if bytes.len() > 16 * 1024 {
            return Err("RV_LIVEKIT_CONFIG_FILE is oversized");
        }
        Self::parse(&bytes)
    }

    pub fn parse(bytes: &[u8]) -> std::result::Result<Self, &'static str> {
        let config: Configuration =
            serde_json::from_slice(bytes).map_err(|_| "Invalid RV_LIVEKIT_CONFIG_FILE JSON")?;
        let secret = Zeroizing::new(config.api_secret.into_bytes());
        let origin = |value: &str, schemes: [&str; 2]| {
            Url::parse(value).ok().filter(|url| {
                schemes.contains(&url.scheme())
                    && url.host_str().is_some()
                    && url.username().is_empty()
                    && url.password().is_none()
                    && url.query().is_none()
                    && url.fragment().is_none()
                    && url.path() == "/"
            })
        };
        // ws:// only serves a local bench; production terminates TLS in front of LiveKit.
        let url = origin(&config.url, ["wss", "ws"])
            .ok_or("LiveKit url must be a ws(s) origin without credentials, path or query")?;
        let api = origin(&config.api_url, ["https", "http"]).ok_or(
            "LiveKit api_url must be an http(s) origin without credentials, path or query",
        )?;
        if !(32..=1024).contains(&secret.len()) || !auth::identifier(&config.api_key) {
            return Err("LiveKit requires an api_key and an api_secret of 32 to 1024 bytes");
        }
        let http = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(5))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|_| "LiveKit HTTP initialization failed")?;
        Ok(Self {
            url: url.as_str().trim_end_matches('/').into(),
            api,
            key: config.api_key,
            secret,
            http,
        })
    }

    pub(crate) fn url(&self) -> &str {
        &self.url
    }

    fn sign(&self, claims: &Value) -> Result<Zeroizing<String>> {
        let header = BASE64URL_NOPAD.encode(br#"{"alg":"HS256","typ":"JWT"}"#);
        let payload =
            BASE64URL_NOPAD.encode(&serde_json::to_vec(claims).map_err(|_| Error::internal())?);
        let input = format!("{header}.{payload}");
        let mut mac =
            Hmac::<Sha256>::new_from_slice(&self.secret).map_err(|_| Error::internal())?;
        mac.update(input.as_bytes());
        Ok(Zeroizing::new(format!(
            "{input}.{}",
            BASE64URL_NOPAD.encode(&mac.finalize().into_bytes())
        )))
    }

    /// A member's token for one room: microphone only, no data channel.
    pub(crate) fn join_token(
        &self,
        identity: &str,
        name: &str,
        room: &str,
        can_publish: bool,
    ) -> Result<(Zeroizing<String>, DateTime<Utc>)> {
        let now = Utc::now();
        let expires = now + Duration::seconds(TOKEN_SECONDS);
        let claims = json!({
            "iss": self.key, "sub": identity, "name": name, "jti": auth::random_token(),
            "nbf": now.timestamp() - 5, "exp": expires.timestamp(),
            "video": {
                "room": room, "roomJoin": true, "canSubscribe": true,
                "canPublish": can_publish, "canPublishSources": ["microphone", "camera"],
                "canPublishData": false, "canUpdateOwnMetadata": true,
            },
        });
        Ok((self.sign(&claims)?, expires))
    }

    fn admin_token(&self, room: Option<&str>) -> Result<Zeroizing<String>> {
        let now = Utc::now();
        let mut video = json!({"roomAdmin": true, "roomList": true});
        if let Some(room) = room {
            video["room"] = json!(room);
        }
        self.sign(&json!({
            "iss": self.key, "sub": "rocketvibe-server",
            "nbf": now.timestamp() - 5, "exp": (now + Duration::seconds(ADMIN_SECONDS)).timestamp(),
            "video": video,
        }))
    }

    async fn call(&self, method: &str, room: Option<&str>, body: Value) -> Result<Option<Value>> {
        let token = self.admin_token(room)?;
        let url = self
            .api
            .join(&format!("twirp/livekit.RoomService/{method}"))
            .map_err(|_| Error::internal())?;
        let response = self
            .http
            .post(url)
            .bearer_auth(token.as_str())
            .json(&body)
            .send()
            .await
            .map_err(|_| unreachable_sfu())?;
        if response.status() == reqwest::StatusCode::NOT_FOUND {
            return Ok(None);
        }
        if !response.status().is_success() {
            tracing::warn!(
                status = response.status().as_u16(),
                method,
                "LiveKit API refused"
            );
            return Err(unreachable_sfu());
        }
        let bytes = response.bytes().await.map_err(|_| unreachable_sfu())?;
        if bytes.len() > 4 * 1024 * 1024 {
            return Err(unreachable_sfu());
        }
        serde_json::from_slice(&bytes)
            .map(Some)
            .map_err(|_| unreachable_sfu())
    }

    pub(crate) async fn rooms(&self) -> Result<Vec<String>> {
        let value = self.call("ListRooms", None, json!({})).await?;
        Ok(value
            .as_ref()
            .and_then(|v| v["rooms"].as_array())
            .into_iter()
            .flatten()
            .filter_map(|room| room["name"].as_str().map(str::to_owned))
            .collect())
    }

    pub(crate) async fn participants(&self, room: &str) -> Result<Vec<Participant>> {
        let value = self
            .call("ListParticipants", Some(room), json!({"room": room}))
            .await?;
        Ok(value
            .as_ref()
            .and_then(|v| v["participants"].as_array())
            .into_iter()
            .flatten()
            .filter_map(participant)
            .collect())
    }

    pub(crate) async fn remove(&self, room: &str, identity: &str) -> Result<()> {
        self.call(
            "RemoveParticipant",
            Some(room),
            json!({"room": room, "identity": identity}),
        )
        .await
        .map(drop)
    }

    /// Sets what the participant may publish; the SFU unpublishes the rest.
    pub(crate) async fn permit(
        &self,
        room: &str,
        identity: &str,
        sources: &[String],
    ) -> Result<()> {
        self.call(
            "UpdateParticipant",
            Some(room),
            json!({"room": room, "identity": identity, "permission": {
                "can_subscribe": true, "can_publish": !sources.is_empty(), "can_publish_data": false,
                "can_publish_sources": sources, "can_update_metadata": true,
            }}),
        )
        .await
        .map(drop)
    }
}

/// Twirp's JSON follows protojson: default values are omitted, enums are names
/// (numbers are accepted too), field names may be camelCase or snake_case.
fn participant(value: &Value) -> Option<Participant> {
    let identity = value["identity"].as_str()?.to_owned();
    let field = |object: &Value, snake: &str, camel: &str| {
        let v = &object[snake];
        if v.is_null() {
            object[camel].clone()
        } else {
            v.clone()
        }
    };
    // TrackSource: CAMERA = 1, MICROPHONE = 2, SCREEN_SHARE = 3, SCREEN_SHARE_AUDIO = 4.
    const NAMES: [&str; 5] = [
        "UNKNOWN",
        "CAMERA",
        "MICROPHONE",
        "SCREEN_SHARE",
        "SCREEN_SHARE_AUDIO",
    ];
    let name = |v: &Value| {
        v.as_str().map(str::to_owned).or_else(|| {
            v.as_u64()
                .and_then(|n| NAMES.get(n as usize))
                .map(|n| (*n).to_owned())
        })
    };
    let unmuted = |source: &str| {
        value["tracks"]
            .as_array()
            .into_iter()
            .flatten()
            .any(|track| {
                name(&track["source"]).as_deref() == Some(source)
                    && !track["muted"].as_bool().unwrap_or(false)
            })
    };
    let permission = &value["permission"];
    let can_publish = field(permission, "can_publish", "canPublish")
        .as_bool()
        .unwrap_or(false);
    let mut sources: Vec<String> = if can_publish {
        field(permission, "can_publish_sources", "canPublishSources")
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(name)
            .collect()
    } else {
        Vec::new()
    };
    // An empty list grants every source: say so explicitly.
    if can_publish && sources.is_empty() {
        sources = NAMES[1..].iter().map(|n| (*n).to_owned()).collect();
    }
    sources.sort();
    Some(Participant {
        identity,
        muted: !unmuted("MICROPHONE"),
        deafened: value["attributes"][DEAFENED].as_str() == Some("1"),
        camera: unmuted("CAMERA"),
        sources,
    })
}

fn unreachable_sfu() -> Error {
    Error::new(
        axum::http::StatusCode::SERVICE_UNAVAILABLE,
        "voice_unavailable",
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config(url: &str, api: &str, secret: usize) -> Vec<u8> {
        serde_json::to_vec(
            &json!({"url":url,"api_url":api,"api_key":"rv","api_secret":"s".repeat(secret)}),
        )
        .unwrap()
    }

    #[test]
    fn configuration_requires_origins_and_a_long_secret() {
        assert!(
            LiveKit::parse(&config(
                "wss://voice.example.org",
                "http://livekit:7880",
                32
            ))
            .is_ok()
        );
        assert!(
            LiveKit::parse(&config("ws://127.0.0.1:7880", "http://127.0.0.1:7880", 32)).is_ok()
        );
        for (url, api) in [
            ("https://voice.example.org", "http://livekit:7880"),
            ("wss://voice.example.org/path", "http://livekit:7880"),
            ("wss://u:p@voice.example.org", "http://livekit:7880"),
            ("wss://voice.example.org", "ftp://livekit"),
            ("wss://voice.example.org", "http://livekit:7880/?x=1"),
        ] {
            assert!(
                LiveKit::parse(&config(url, api, 32)).is_err(),
                "{url} {api}"
            );
        }
        assert!(
            LiveKit::parse(&config(
                "wss://voice.example.org",
                "http://livekit:7880",
                31
            ))
            .is_err()
        );
    }

    #[test]
    fn join_token_grants_the_microphone_of_one_room() {
        let livekit = LiveKit::parse(&config(
            "wss://voice.example.org",
            "http://livekit:7880",
            32,
        ))
        .unwrap();
        let (token, expires) = livekit.join_token("u1", "Alice", "rv:e:r1", false).unwrap();
        let parts: Vec<_> = token.split('.').collect();
        assert_eq!(parts.len(), 3);
        let claims: Value =
            serde_json::from_slice(&BASE64URL_NOPAD.decode(parts[1].as_bytes()).unwrap()).unwrap();
        assert_eq!(claims["sub"], "u1");
        assert_eq!(claims["iss"], "rv");
        assert_eq!(claims["video"]["room"], "rv:e:r1");
        assert_eq!(claims["video"]["canPublish"], false);
        assert_eq!(
            claims["video"]["canPublishSources"],
            json!(["microphone", "camera"])
        );
        assert_eq!(claims["exp"], expires.timestamp());
        let mut mac = Hmac::<Sha256>::new_from_slice(&[b's'; 32]).unwrap();
        mac.update(format!("{}.{}", parts[0], parts[1]).as_bytes());
        assert_eq!(
            BASE64URL_NOPAD.encode(&mac.finalize().into_bytes()),
            parts[2]
        );
    }

    #[test]
    fn participants_read_protojson_in_either_spelling() {
        let p = participant(
            &json!({"identity":"u1","tracks":[{"source":"MICROPHONE","type":"AUDIO"}],
            "permission":{"canPublish":true},"attributes":{"rv.deafened":"1"}}),
        )
        .unwrap();
        assert_eq!(
            p,
            Participant {
                identity: "u1".into(),
                muted: false,
                deafened: true,
                camera: false,
                sources: sources(true, true),
            }
        );
        let p = participant(&json!({"identity":"u2","tracks":[{"source":2,"muted":true}],"permission":{"can_publish":false}})).unwrap();
        assert!(p.muted && !p.deafened && p.sources.is_empty());
        let p = participant(&json!({"identity":"u4","tracks":[{"source":"CAMERA"},{"source":"MICROPHONE","muted":true}],
            "permission":{"can_publish":true,"can_publish_sources":["MICROPHONE","CAMERA"]}})).unwrap();
        assert!(p.camera && p.muted);
        assert_eq!(p.sources, sources(true, false));
        // No microphone track yet: shown muted.
        assert!(participant(&json!({"identity":"u3"})).unwrap().muted);
        assert!(participant(&json!({"tracks":[]})).is_none());
    }
}
