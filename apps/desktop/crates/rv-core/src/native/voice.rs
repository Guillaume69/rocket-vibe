//! Native voice (docs/protocol/VOICE.md): the server grants a LiveKit token to a
//! current member, the `rv-voice` sidecar carries the media (`crate::voice`).
//! The grant's token stays in memory, on its way to the sidecar.
use super::{Error, NativeSession};
use crate::voice::{VoiceError, VoiceKey, VoiceKeys};
use rv_protocol::voice::{AnswerRing, JoinVoice, VoiceGrant, VoiceParticipant, VoiceRing};
use std::sync::atomic::Ordering;

struct Scope {
    generation: u64,
    membership: String,
}

impl NativeSession {
    /// The server announces voice (an SFU is configured), sidecar or not:
    /// enough to edit a room's voice channel flag.
    pub fn voice_announced(&self) -> bool {
        self.capabilities.lock().unwrap().as_ref().is_some_and(|c| c.voice)
    }
    /// The server offers voice and this installation ships its sidecar.
    pub fn voice_supported(&self) -> bool {
        self.voice_announced() && crate::voice::available()
    }
    /// The media side: its snapshot and change notifications.
    pub fn voice(&self) -> &crate::voice::VoiceController {
        &self.voice
    }
    fn voice_scope(&self, room: &str) -> Result<Scope, Error> {
        self.ready()?;
        if !self.voice_supported() {
            return Err(Error::Protocol("unsupported_feature"));
        }
        let membership = self
            .store
            .read_state(room)?
            .and_then(|s| s.membership_version)
            .ok_or(Error::Protocol("delivery_revalidate"))?;
        Ok(Scope { generation: self.security_generation.load(Ordering::SeqCst), membership })
    }
    fn check_voice_scope(&self, scope: &Scope, room: &str) -> Result<(), Error> {
        self.ready()?;
        if scope.generation != self.security_generation.load(Ordering::SeqCst)
            || self.store.read_state(room)?.and_then(|s| s.membership_version).as_deref() != Some(&scope.membership)
        {
            return Err(Error::Protocol("delivery_revalidate"));
        }
        Ok(())
    }
    fn voice_result<T>(&self, result: Result<T, Error>) -> Result<T, Error> {
        if let Err(error) = &result
            && error.terminal()
        {
            self.shutdown();
            self.set_failure(error);
        }
        result
    }
    fn data_epoch(&self) -> String {
        self.info.native.as_ref().map(|i| i.data_epoch.clone()).unwrap_or_default()
    }
    /// A LiveKit grant for the room's session; `ring` rings the other member of a direct room.
    pub async fn join_voice(&self, room: &str, ring: bool, e2ee: bool) -> Result<VoiceGrant, Error> {
        let result = async {
            let scope = self.voice_scope(room)?;
            self.identity().await?;
            self.check_voice_scope(&scope, room)?;
            let input =
                JoinVoice { membership_version: scope.membership.clone(), data_epoch: self.data_epoch(), ring, e2ee };
            let grant = self.client.join_voice(room, &input).await?;
            self.check_voice_scope(&scope, room)?;
            valid_grant(grant, room)
        }
        .await;
        self.voice_result(result)
    }
    /// Leaves this account's session wherever it is, and cancels a ring it started.
    pub async fn leave_voice(&self) -> Result<(), Error> {
        if self.is_closed() {
            return Err(Error::Protocol("session_closed"));
        }
        self.client.leave_voice().await?;
        Ok(())
    }
    pub async fn voice_ring(&self, id: &str) -> Result<VoiceRing, Error> {
        self.ready()?;
        if !self.voice_announced() {
            return Err(Error::Protocol("unsupported_feature"));
        }
        let ring = self.client.voice_ring(id).await?;
        self.ready()?;
        if ring.id != id {
            return Err(Error::Protocol("invalid_voice_ring"));
        }
        Ok(ring)
    }
    /// Answers a ring: a grant for its room.
    pub async fn accept_ring(&self, id: &str, e2ee: bool) -> Result<VoiceGrant, Error> {
        let result = async {
            let known = self.rings().into_iter().find(|r| r.id == id);
            let ring = match known {
                Some(ring) => ring,
                None => self.voice_ring(id).await?,
            };
            let scope = self.voice_scope(&ring.room_id)?;
            self.identity().await?;
            self.check_voice_scope(&scope, &ring.room_id)?;
            let input =
                AnswerRing { membership_version: scope.membership.clone(), data_epoch: self.data_epoch(), e2ee };
            let grant = self.client.accept_ring(id, &input).await?;
            self.check_voice_scope(&scope, &ring.room_id)?;
            valid_grant(grant, &ring.room_id)
        }
        .await;
        self.voice_result(result)
    }
    pub async fn decline_ring(&self, id: &str) -> Result<(), Error> {
        self.ready()?;
        if !self.voice_announced() {
            return Err(Error::Protocol("unsupported_feature"));
        }
        self.client.decline_ring(id).await?;
        Ok(())
    }
    /// Who is in the room's voice session, from the live snapshot of a current membership.
    pub fn voice_participants(&self, room: &str) -> Vec<VoiceParticipant> {
        let cache = self.live.lock().unwrap();
        let current = cache.state.as_ref().and_then(|s| s.rooms.iter().find(|r| r.room_id == room)).is_some_and(|r| {
            self.store.read_state(room).ok().flatten().and_then(|s| s.membership_version).as_deref()
                == Some(&r.membership_version)
        });
        if !current {
            return vec![];
        }
        cache.voice(room, std::time::Instant::now())
    }
    /// Direct calls ringing, or resolved in the last seconds, where this account takes part.
    pub fn rings(&self) -> Vec<VoiceRing> {
        self.live.lock().unwrap().rings(std::time::Instant::now())
    }
    /// Joins the room's session and hands the grant to the sidecar; the media
    /// state then follows `voice().changes()`.
    /// `keys` gives an encrypted room's voice key (the app opens its crypto
    /// access); without it, voice in an encrypted room is refused.
    pub async fn connect_voice(&self, room: &str, ring: bool, keys: Option<VoiceKeys>) -> Result<(), Error> {
        let key = self.voice_key(room, keys.as_ref()).await?;
        let grant = self.join_voice(room, ring, key.is_some()).await?;
        self.connect_grant(grant, key, keys).await
    }
    /// Accepts a ring and connects to its room.
    pub async fn answer_ring(&self, id: &str, room: &str, keys: Option<VoiceKeys>) -> Result<(), Error> {
        let key = self.voice_key(room, keys.as_ref()).await?;
        let grant = self.accept_ring(id, key.is_some()).await?;
        if grant.room_id != room {
            return Err(Error::Protocol("invalid_voice_grant"));
        }
        self.connect_grant(grant, key, keys).await
    }
    /// The key of an encrypted room, None in a plaintext one.
    async fn voice_key(&self, room: &str, keys: Option<&VoiceKeys>) -> Result<Option<VoiceKey>, Error> {
        if !self.store.rooms()?.iter().any(|r| r.id == room && r.encrypted) {
            return Ok(None);
        }
        let keys = keys.ok_or(Error::Protocol("voice_key_unavailable"))?;
        keys().await.map(Some).ok_or(Error::Protocol("voice_key_unavailable"))
    }
    async fn connect_grant(
        &self,
        grant: VoiceGrant,
        key: Option<VoiceKey>,
        keys: Option<VoiceKeys>,
    ) -> Result<(), Error> {
        let result = self.voice.connect(&grant, key, keys).await;
        // The room became encrypted after its key was asked for: never in clear.
        if result == Err(VoiceError::Unencrypted) {
            let _ = self.leave_voice().await;
        }
        result.map_err(|e| Error::Protocol(e.code()))
    }
    /// Leaves the media at once, then tells the server (best effort: the SFU
    /// drops a client that vanished anyway).
    pub async fn disconnect_voice(&self) {
        self.voice.disconnect().await;
        let _ = self.leave_voice().await;
    }
}

fn valid_grant(grant: VoiceGrant, room: &str) -> Result<VoiceGrant, Error> {
    let invalid = || Error::Protocol("invalid_voice_grant");
    let url = url::Url::parse(&grant.url).map_err(|_| invalid())?;
    if grant.room_id != room
        || !matches!(url.scheme(), "wss" | "ws")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || grant.token.is_empty()
        || grant.token.len() > 16_384
        || chrono::DateTime::parse_from_rfc3339(&grant.expires_at).is_err()
        || grant.ring.as_ref().is_some_and(|r| r.room_id != room)
    {
        return Err(invalid());
    }
    Ok(grant)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn grant() -> VoiceGrant {
        VoiceGrant {
            room_id: "room".into(),
            url: "wss://voice.example.org".into(),
            token: "eyJ".into(),
            expires_at: "2026-10-06T12:05:00Z".into(),
            can_publish: true,
            ring: None,
            e2ee: false,
        }
    }
    #[test]
    fn grants_must_name_the_room_and_a_websocket_origin() {
        assert!(valid_grant(grant(), "room").is_ok());
        assert!(valid_grant(grant(), "other").is_err());
        for url in ["https://voice.example.org", "wss://user:pw@voice.example.org", "not a url"] {
            assert!(valid_grant(VoiceGrant { url: url.into(), ..grant() }, "room").is_err());
        }
        assert!(valid_grant(VoiceGrant { token: String::new(), ..grant() }, "room").is_err());
        assert!(valid_grant(VoiceGrant { expires_at: "soon".into(), ..grant() }, "room").is_err());
    }
}
