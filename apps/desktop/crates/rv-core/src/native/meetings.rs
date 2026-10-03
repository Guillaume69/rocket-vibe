//! Native meetings reuse the existing call windows. Private URLs remain transient.
use super::{Error, NativeSession, permanent_command_error, room_operation_id};
use chrono::{DateTime, Utc};
use rv_protocol::meetings::{JoinMeeting, Meeting, MeetingJoin, StartMeeting};
use std::sync::atomic::Ordering;
use url::Url;

struct Scope {
    generation: u64,
    projection: u64,
}
impl NativeSession {
    pub async fn start_direct_call(&self, user: &str) -> Result<String, Error> {
        self.ready()?;
        if !self.capabilities.lock().unwrap().as_ref().is_some_and(|c| c.calls) {
            return Err(Error::Protocol("unsupported_feature"));
        }
        let mut changes = self.store.changes();
        let mut events = self.events();
        let room = self.direct_user(user).await?;
        // Creating a DM requests journal catch-up. The RPC's room is not an
        // authoritative local grant: wait for that projection and verified session.
        let membership = tokio::time::timeout(std::time::Duration::from_secs(15), async {
            loop {
                if self.is_closed() {
                    return Err(Error::Protocol("session_closed"));
                }
                if self.ready().is_ok()
                    && let Some(membership) = self.store.read_state(&room)?.and_then(|s| s.membership_version)
                {
                    return Ok(membership);
                }
                tokio::select! { _ = changes.recv() => {}, _ = events.recv() => {} }
            }
        })
        .await
        .map_err(|_| Error::Protocol("delivery_revalidate"))??;
        self.start_call(&room, &membership).await
    }
    pub fn can_start_call(&self, room: &str) -> bool {
        self.ready().is_ok()
            && self.capabilities.lock().unwrap().as_ref().is_some_and(|c| c.calls)
            && self
                .store
                .room_access(room)
                .ok()
                .flatten()
                .is_some_and(|a| !a.read_only || matches!(a.role.as_str(), "owner" | "moderator"))
    }
    pub async fn call_available(&self, room: &str, membership: &str) -> bool {
        let Ok(scope) = self.call_scope(room, membership) else { return false };
        if self.refresh_room_access(room).await.is_err() {
            return false;
        }
        self.check_call_scope(&scope, room, membership).is_ok() && self.can_start_call(room)
    }
    fn call_scope(&self, room: &str, membership: &str) -> Result<Scope, Error> {
        self.ready()?;
        if !self.capabilities.lock().unwrap().as_ref().is_some_and(|c| c.calls) {
            return Err(Error::Protocol("unsupported_feature"));
        }
        if !self.store.meeting_membership(room, membership)? {
            return Err(Error::Protocol("membership_changed"));
        }
        Ok(Scope {
            generation: self.security_generation.load(Ordering::SeqCst),
            projection: self.store.projection_token(),
        })
    }
    fn check_call_scope(&self, scope: &Scope, room: &str, membership: &str) -> Result<(), Error> {
        self.ready()?;
        if scope.generation != self.security_generation.load(Ordering::SeqCst)
            || scope.projection != self.store.projection_token()
            || !self.store.meeting_membership(room, membership)?
        {
            return Err(Error::Protocol("delivery_revalidate"));
        }
        if !self.capabilities.lock().unwrap().as_ref().is_some_and(|c| c.calls) {
            return Err(Error::Protocol("unsupported_feature"));
        }
        Ok(())
    }
    fn call_result<T>(&self, result: Result<T, Error>) -> Result<T, Error> {
        if let Err(error) = &result
            && error.terminal()
        {
            self.shutdown();
            self.set_failure(error);
        }
        result
    }
    pub async fn start_call(&self, room: &str, membership: &str) -> Result<String, Error> {
        let result = async {
            let scope = self.call_scope(room, membership)?;
            let _guard = self.command_lock.lock().await;
            self.check_call_scope(&scope, room, membership)?;
            self.identity().await?;
            self.check_call_scope(&scope, room, membership)?;
            // Nothing resumes an unanswered start automatically: the user retries the button.
            let input = self.store.stage_meeting(
                room,
                StartMeeting {
                    operation_id: room_operation_id(),
                    membership_version: membership.into(),
                    data_epoch: self.info.native.as_ref().unwrap().data_epoch.clone(),
                },
            )?;
            let meeting = match self.client.start_meeting(room, &input).await {
                Ok(meeting) => meeting,
                Err(error) => {
                    let error: Error = error.into();
                    if permanent_command_error(&error) {
                        self.store.acknowledge_meeting(room, &input)?;
                    }
                    return Err(error);
                }
            };
            self.identity().await?;
            self.check_call_scope(&scope, room, membership)?;
            public_url(&meeting, room, &meeting.id)?;
            if !self.store.acknowledge_meeting(room, &input)? {
                return Err(Error::Protocol("delivery_revalidate"));
            }
            self.join_scoped(&scope, room, &meeting.id, membership).await
        }
        .await;
        self.call_result(result)
    }
    pub async fn join_call(&self, room: &str, meeting: &str, membership: &str) -> Result<String, Error> {
        let result = async {
            let scope = self.call_scope(room, membership)?;
            self.join_scoped(&scope, room, meeting, membership).await
        }
        .await;
        self.call_result(result)
    }
    async fn join_scoped(&self, scope: &Scope, room: &str, meeting: &str, membership: &str) -> Result<String, Error> {
        self.identity().await?;
        self.check_call_scope(scope, room, membership)?;
        let joined = self
            .client
            .join_meeting(
                meeting,
                &JoinMeeting {
                    membership_version: membership.into(),
                    data_epoch: self.info.native.as_ref().unwrap().data_epoch.clone(),
                },
            )
            .await?;
        self.identity().await?;
        self.check_call_scope(scope, room, membership)?;
        private_url(joined, room, meeting)
    }
    pub async fn call_link(&self, room: &str, meeting: &str, membership: &str) -> Result<String, Error> {
        let result = async {
            let scope = self.call_scope(room, membership)?;
            self.identity().await?;
            self.check_call_scope(&scope, room, membership)?;
            let found = self.client.meeting(meeting).await?;
            self.identity().await?;
            self.check_call_scope(&scope, room, membership)?;
            public_url(&found, room, meeting)?;
            Ok(found.public_url)
        }
        .await;
        self.call_result(result)
    }
}
fn public_url(meeting: &Meeting, room: &str, expected: &str) -> Result<Url, Error> {
    let invalid = || Error::Protocol("invalid_meeting");
    if meeting.id != expected
        || meeting.room_id != room
        || meeting.id.is_empty()
        || meeting.id.len() > 128
        || meeting.public_url.len() > 1024
        || !meeting.id.bytes().all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
        || DateTime::parse_from_rfc3339(&meeting.expires_at).is_err()
    {
        return Err(invalid());
    }
    let url = Url::parse(&meeting.public_url).map_err(|_| invalid())?;
    let path = url.path().strip_prefix('/').unwrap_or_default();
    if url.scheme() != "https"
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || path.is_empty()
        || path.len() > 256
        || !path.bytes().all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
    {
        return Err(invalid());
    }
    Ok(url)
}
fn private_url(joined: MeetingJoin, room: &str, expected: &str) -> Result<String, Error> {
    let public = public_url(&joined.meeting, room, expected)?;
    let invalid = || Error::Protocol("invalid_meeting");
    let url = Url::parse(&joined.url).map_err(|_| invalid())?;
    let expiry = DateTime::parse_from_rfc3339(&joined.expires_at).map_err(|_| invalid())?;
    let meeting_expiry = DateTime::parse_from_rfc3339(&joined.meeting.expires_at).map_err(|_| invalid())?;
    let now = Utc::now();
    let query: Vec<_> = url.query_pairs().collect();
    if joined.meeting.ended
        || joined.url.len() > 16_384
        || expiry <= now
        || expiry > now + chrono::Duration::seconds(125)
        || expiry > meeting_expiry
        || url.origin() != public.origin()
        || url.path() != public.path()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
        || query.len() != 1
        || query[0].0 != "jwt"
        || query[0].1.is_empty()
    {
        return Err(invalid());
    }
    Ok(joined.url)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn joined() -> MeetingJoin {
        MeetingJoin {
            meeting: Meeting {
                id: "meeting".into(),
                room_id: "room".into(),
                public_url: "https://meet.example/rvroom".into(),
                created_by: "owner".into(),
                expires_at: (Utc::now() + chrono::Duration::hours(1)).to_rfc3339(),
                ended: false,
            },
            url: "https://meet.example/rvroom?jwt=private-token".into(),
            expires_at: (Utc::now() + chrono::Duration::seconds(120)).to_rfc3339(),
        }
    }
    #[test]
    fn private_links_require_room_binding_short_expiry_and_the_same_conference() {
        assert!(private_url(joined(), "room", "meeting").is_ok());
        assert!(private_url(joined(), "other-room", "meeting").is_err());
        assert!(private_url(joined(), "room", "other-meeting").is_err());
        for bad in [
            "http://meet.example/rvroom?jwt=x",
            "https://elsewhere.example/rvroom?jwt=x",
            "https://meet.example/other?jwt=x",
            "https://user@meet.example/rvroom?jwt=x",
            "https://meet.example/rvroom?jwt=x&redirect=y",
            "https://meet.example/rvroom?jwt=x&jwt=y",
            "https://meet.example/rvroom?jwt=",
            "https://meet.example/rvroom?jwt=x#secret",
        ] {
            let mut value = joined();
            value.url = bad.into();
            assert!(private_url(value, "room", "meeting").is_err());
        }
        let mut expired = joined();
        expired.expires_at = (Utc::now() - chrono::Duration::seconds(1)).to_rfc3339();
        assert!(private_url(expired, "room", "meeting").is_err());
        let mut long = joined();
        long.expires_at = (Utc::now() + chrono::Duration::minutes(3)).to_rfc3339();
        assert!(private_url(long, "room", "meeting").is_err());
        let mut ended = joined();
        ended.meeting.ended = true;
        assert!(private_url(ended, "room", "meeting").is_err());
    }
    #[test]
    fn shared_links_cannot_contain_a_participant_token_or_credentials() {
        for url in [
            "https://meet.example/rvroom?jwt=secret",
            "https://user:secret@meet.example/rvroom",
            "https://meet.example/a/b",
            "https://meet.example/rvroom#secret",
        ] {
            let mut value = joined();
            value.meeting.public_url = url.into();
            assert!(public_url(&value.meeting, "room", "meeting").is_err());
        }
    }
}
