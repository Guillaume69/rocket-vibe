//! Characterization of `Session` per backend: each action reaches its own
//! server's route, and never the other server's API. A forgotten Mattermost
//! branch falls through to Rocket.Chat's REST in silence; these tests make it
//! loud, ahead of the provider refactor that turns it into a compile error.
mod common;

use std::future::Future;
use std::sync::Arc;

use common::{FakeHttp, Request, Response, dropped, respond};
use rv_core::mattermost::Flavor;
use rv_core::session::{Session, SessionInfo};
use serde_json::json;

/// The socket is refused (no live events); REST answers an empty success.
fn server(request: &Request) -> Response {
    if request.path().ends_with("/websocket") {
        dropped()
    } else if request.path().starts_with("/api/v4/") {
        respond(200, "{}")
    } else {
        respond(200, r#"{"success":true}"#)
    }
}

struct Bench {
    server: FakeHttp,
    session: Arc<Session>,
    /// Where this backend's routes live; the other one's must never be called.
    own: &'static str,
    other: &'static str,
    _dir: tempfile::TempDir,
}

async fn bench(flavor: Option<Flavor>) -> Bench {
    let server = FakeHttp::start(server).await;
    let dir = tempfile::tempdir().unwrap();
    let info = SessionInfo {
        base_url: server.url.to_string(),
        user_id: "u-me".into(),
        username: "me".into(),
        auth_token: "tok".into(),
        native: None,
        mattermost: flavor,
    };
    let session = Session::start(info, &dir.path().join("account.sqlite")).unwrap();
    let (own, other) = if flavor.is_some() { ("/api/v4/", "/api/v1/") } else { ("/api/v1/", "/api/v4/") };
    Bench { server, session, own, other, _dir: dir }
}

impl Bench {
    /// The requests made while `action` ran (background catch-up included).
    async fn during<T>(&self, action: impl Future<Output = T>) -> Vec<(String, String)> {
        let before = self.server.requests().len();
        action.await;
        self.server.requests()[before..].iter().map(|r| (r.method.clone(), r.path().to_owned())).collect()
    }

    /// `action` called `method path`, and nothing on the other backend's API.
    async fn expect<T>(&self, what: &str, method: &str, path: &str, action: impl Future<Output = T>) {
        let calls = self.during(action).await;
        assert!(calls.iter().any(|(m, p)| m == method && p == path), "{what}: expected {method} {path}, got {calls:?}");
        assert!(
            calls.iter().all(|(_, p)| !p.starts_with(self.other)),
            "{what}: reached the other backend ({}): {calls:?}",
            self.other
        );
        assert!(calls.iter().filter(|(_, p)| !p.ends_with("/websocket")).all(|(_, p)| p.starts_with(self.own)));
    }

    fn close(self) {
        self.session.shutdown();
        self.session.store.close();
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn rocket_chat_message_actions() {
    let b = bench(None).await;
    let s = b.session.clone();
    b.expect("react", "POST", "/api/v1/chat.react", s.react("m1", ":+1:", true)).await;
    b.expect("edit", "POST", "/api/v1/chat.update", s.edit("r1", "m1", "hello")).await;
    b.expect("delete", "POST", "/api/v1/chat.delete", s.delete("r1", "m1")).await;
    b.expect("favorite", "POST", "/api/v1/rooms.favorite", s.set_favorite("r1", true)).await;
    b.expect("pin", "POST", "/api/v1/chat.pinMessage", s.pin("m1")).await;
    b.expect("unpin", "POST", "/api/v1/chat.unPinMessage", s.unpin("m1")).await;
    b.expect("star", "POST", "/api/v1/chat.starMessage", s.star("m1", true)).await;
    b.expect("unstar", "POST", "/api/v1/chat.unStarMessage", s.star("m1", false)).await;
    b.close();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn mattermost_message_actions() {
    for flavor in [Flavor::Mattermost, Flavor::Kchat] {
        let b = bench(Some(flavor)).await;
        let s = b.session.clone();
        b.expect("react", "POST", "/api/v4/reactions", s.react("m1", ":+1:", true)).await;
        b.expect("unreact", "DELETE", "/api/v4/users/u-me/posts/m1/reactions/+1", s.react("m1", ":+1:", false)).await;
        b.expect("edit", "PUT", "/api/v4/posts/m1/patch", s.edit("r1", "m1", "hello")).await;
        b.expect("delete", "DELETE", "/api/v4/posts/m1", s.delete("r1", "m1")).await;
        b.expect("favorite", "PUT", "/api/v4/users/me/preferences", s.set_favorite("r1", true)).await;
        b.expect("pin", "POST", "/api/v4/posts/m1/pin", s.pin("m1")).await;
        b.expect("unpin", "POST", "/api/v4/posts/m1/unpin", s.unpin("m1")).await;
        b.expect("star", "PUT", "/api/v4/users/me/preferences", s.star("m1", true)).await;
        b.expect("unstar", "POST", "/api/v4/users/me/preferences/delete", s.star("m1", false)).await;
        b.close();
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn rocket_chat_rooms_and_account() {
    let b = bench(None).await;
    let s = b.session.clone();
    b.expect("room info", "GET", "/api/v1/rooms.info", s.room_info("r1")).await;
    b.expect("room by name", "GET", "/api/v1/rooms.info", s.room_by_name("dev")).await;
    b.expect("profile", "GET", "/api/v1/users.info", s.profile("bob", false)).await;
    b.expect("search", "GET", "/api/v1/chat.search", s.search("r1", "word")).await;
    b.expect("me", "GET", "/api/v1/me", s.me()).await;
    b.expect("status", "POST", "/api/v1/users.setStatus", s.set_status("away", "lunch")).await;
    b.expect("reset avatar", "POST", "/api/v1/users.resetAvatar", s.reset_avatar()).await;
    b.expect(
        "preference",
        "POST",
        "/api/v1/users.setPreferences",
        s.set_preference("desktopNotifications", json!("all")),
    )
    .await;
    b.expect("spotlight", "GET", "/api/v1/spotlight", s.spotlight("bo")).await;
    b.expect("open dm", "POST", "/api/v1/im.create", s.open_dm("bob")).await;
    b.expect("join", "POST", "/api/v1/channels.join", s.join_channel("r1")).await;
    b.expect("mark read", "POST", "/api/v1/subscriptions.read", s.mark_read("r1")).await;
    b.expect("calls", "GET", "/api/v1/video-conference.capabilities", s.call_available()).await;
    b.close();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn mattermost_rooms_and_account() {
    for flavor in [Flavor::Mattermost, Flavor::Kchat] {
        let b = bench(Some(flavor)).await;
        let s = b.session.clone();
        b.expect("room info", "GET", "/api/v4/channels/r1", s.room_info("r1")).await;
        b.expect("me", "GET", "/api/v4/users/me", s.me()).await;
        b.expect("status", "PUT", "/api/v4/users/me/status", s.set_status("away", "lunch")).await;
        b.expect("reset avatar", "DELETE", "/api/v4/users/u-me/image", s.reset_avatar()).await;
        b.expect("preference", "PUT", "/api/v4/users/me/patch", s.set_preference("desktopNotifications", json!("all")))
            .await;
        b.expect("spotlight", "POST", "/api/v4/users/search", s.spotlight("bo")).await;
        b.expect("join", "POST", "/api/v4/channels/r1/members", s.join_channel("r1")).await;
        b.expect("mark read", "POST", "/api/v4/channels/members/me/view", s.mark_read("r1")).await;
        // kChat has calls of its own; Mattermost none, and neither asks.
        let calls = b.during(s.call_available()).await;
        assert!(calls.iter().all(|(_, p)| !p.starts_with("/api/v1/")), "{calls:?}");
        assert_eq!(s.call_available().await, flavor == Flavor::Kchat);
        b.close();
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn permalinks_follow_the_backend() {
    let b = bench(Some(Flavor::Mattermost)).await;
    let link = b.session.permalink("c", Some("dev"), "r1", "m1").await;
    assert!(link.ends_with("/_redirect/pl/m1"), "{link}");
    b.close();
    let b = bench(None).await;
    let link = b.session.permalink("c", Some("dev"), "r1", "m1").await;
    assert!(link.contains("m1") && !link.contains("_redirect"), "{link}");
    b.close();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn rocket_chat_invites_and_discussions() {
    let b = bench(None).await;
    let s = b.session.clone();
    b.expect("invite", "POST", "/api/v1/findOrCreateInvite", s.invite_link("r1")).await;
    b.expect("discussion", "POST", "/api/v1/rooms.createDiscussion", s.create_discussion("r1", "plans", None, None))
        .await;
    b.expect("open discussion", "GET", "/api/v1/rooms.info", s.open_discussion("d1")).await;
    b.close();
}

/// Mattermost and kChat have neither invite links, discussions nor replies
/// also sent to the room: each is refused without a request.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn mattermost_has_no_invites_or_discussions() {
    for flavor in [Flavor::Mattermost, Flavor::Kchat] {
        let b = bench(Some(flavor)).await;
        let s = b.session.clone();
        assert!(!s.discussions_available() && !s.also_in_room_available());
        let calls = b
            .during(async {
                assert!(s.invite_link("r1").await.is_err());
                assert!(s.create_discussion("r1", "plans", None, None).await.is_err());
                assert!(s.open_discussion("d1").await.is_err());
                assert!(!s.can_invite("r1").await);
            })
            .await;
        assert!(calls.iter().all(|(_, p)| p.ends_with("/websocket") || !p.contains("invite")), "{calls:?}");
        assert!(calls.iter().all(|(_, p)| !p.starts_with("/api/v1/")), "{calls:?}");
        b.close();
    }
}

/// Mattermost reads its custom emoji through `MmSync`: a refresh asks nothing of
/// the server, rather than a Rocket.Chat route it does not have.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn mattermost_has_no_rocket_chat_emoji_refresh() {
    let b = bench(Some(Flavor::Mattermost)).await;
    let calls = b.during(b.session.refresh_custom_emojis()).await;
    assert!(calls.iter().all(|(_, p)| !p.contains("emoji-custom")), "{calls:?}");
    assert!(b.session.refresh_custom_emojis().await.is_err());
    b.close();
}
