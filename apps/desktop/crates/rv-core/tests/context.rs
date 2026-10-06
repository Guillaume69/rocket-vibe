mod common;

use std::collections::HashMap;
use std::sync::Arc;

use chrono::{DateTime, SecondsFormat, TimeZone, Utc};
use common::{FakeHttp, Request, Response, respond};
use rv_core::context::Window;
use rv_core::rest::{Credentials, RestClient};
use rv_core::store::Store;
use rv_core::sync::SyncEngine;
use serde_json::json;

const NOW: i64 = 2_000_000_000_000;

fn iso(ts: i64) -> String {
    Utc.timestamp_millis_opt(ts).unwrap().to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn epoch(value: &str) -> i64 {
    DateTime::parse_from_rfc3339(value).unwrap().timestamp_millis()
}

/// A room as 8.5 serves it: `history` answers the NEWEST `count` messages of
/// `[oldest, latest]`, whatever `oldest` is.
fn room(timestamps: Vec<i64>) -> impl Fn(&Request) -> Response + Send + Sync + 'static {
    let doc = |i: usize, ts: i64| json!({"_id": format!("m{i:04}"), "rid": "r", "msg": "hi", "ts": iso(ts), "u": {"_id": "u"}});
    move |r: &Request| {
        let query: HashMap<String, String> = r
            .target
            .split_once('?')
            .map(|(_, q)| url::form_urlencoded::parse(q.as_bytes()).into_owned().collect())
            .unwrap_or_default();
        if r.path().ends_with("chat.getMessage") {
            let i: usize = query["msgId"][1..].parse().unwrap();
            return match timestamps.get(i) {
                Some(ts) => respond(200, &json!({"success": true, "message": doc(i, *ts)}).to_string()),
                None => respond(400, r#"{"success":false,"error":"error-not-allowed"}"#),
            };
        }
        let latest = query.get("latest").map_or(i64::MAX, |v| epoch(v));
        let oldest = query.get("oldest").map_or(i64::MIN, |v| epoch(v));
        let count: usize = query["count"].parse().unwrap();
        let messages: Vec<_> = timestamps
            .iter()
            .enumerate()
            .rev()
            .filter(|(_, ts)| (oldest..=latest).contains(*ts))
            .take(count)
            .map(|(i, ts)| doc(i, *ts))
            .collect();
        respond(200, &json!({"success": true, "messages": messages}).to_string())
    }
}

async fn sync_for(timestamps: Vec<i64>) -> (FakeHttp, SyncEngine) {
    let server = FakeHttp::start(room(timestamps)).await;
    let rest = RestClient::new(server.url.clone());
    rest.set_credentials(Some(Credentials { auth_token: "tok".into(), user_id: "me".into() }));
    (server, SyncEngine::new(Arc::new(Store::in_memory().unwrap()), rest, "me", "me"))
}

fn indexes(window: &Window) -> Vec<usize> {
    window.messages().iter().map(|m| m.id[1..].parse().unwrap()).collect()
}

fn assert_contiguous(window: &Window, from: usize, to: usize) {
    assert_eq!(indexes(window), (from..=to).collect::<Vec<_>>());
}

#[tokio::test]
async fn reads_forward_without_a_hole_up_to_the_local_history() {
    let timestamps: Vec<i64> = (0..400).map(|i| 1_000_000 + i * 60_000).collect();
    let local_oldest = timestamps[350];
    let (_server, sync) = sync_for(timestamps).await;
    let mut window = Window::around(&sync, "r", "c", "m0100", Some(local_oldest), NOW).await.unwrap().unwrap();
    assert!(window.has_older);
    assert!(window.has_newer);
    let last = *indexes(&window).last().unwrap();
    assert!(last > 100, "the messages after the target come with it");
    assert_contiguous(&window, 51, last);
    for _ in 0..20 {
        if !window.has_newer {
            break;
        }
        window.newer(&sync, Some(local_oldest), NOW).await.unwrap();
    }
    assert!(!window.has_newer);
    assert_contiguous(&window, 51, 350);
}

#[tokio::test]
async fn a_burst_after_a_quiet_stretch_is_not_skipped() {
    let mut timestamps: Vec<i64> = (0..100).map(|i| 1_000_000 + i * 3_600_000).collect();
    let burst_start = timestamps[99] + 3_600_000;
    timestamps.extend((0..300).map(|i| burst_start + i * 20));
    timestamps.extend((0..20).map(|i| burst_start + 3_600_000 + i * 3_600_000));
    let total = timestamps.len();
    let (server, sync) = sync_for(timestamps).await;
    let mut window = Window::around(&sync, "r", "c", "m0090", None, NOW).await.unwrap().unwrap();
    for _ in 0..40 {
        if !window.has_newer {
            break;
        }
        window.newer(&sync, None, NOW).await.unwrap();
    }
    assert!(!window.has_newer);
    assert_contiguous(&window, 41, total - 1);
    assert!(server.requests().len() < 60, "{} requests", server.requests().len());
}

#[tokio::test]
async fn more_than_a_page_within_a_second_is_read_whole() {
    let mut timestamps: Vec<i64> = (0..60).map(|i| 1_000_000 + i * 60_000).collect();
    let instant = timestamps[59] + 60_000;
    timestamps.extend((0..120).map(|i| instant + i * 5));
    timestamps.extend((1..10).map(|i| instant + i * 60_000));
    let total = timestamps.len();
    let (_server, sync) = sync_for(timestamps).await;
    let mut window = Window::around(&sync, "r", "c", "m0055", None, NOW).await.unwrap().unwrap();
    for _ in 0..40 {
        if !window.has_newer {
            break;
        }
        window.newer(&sync, None, NOW).await.unwrap();
    }
    assert_contiguous(&window, 6, total - 1);
}

#[tokio::test]
async fn reads_back_to_the_first_message() {
    let timestamps: Vec<i64> = (0..130).map(|i| 1_000_000 + i * 1_000).collect();
    let (_server, sync) = sync_for(timestamps).await;
    let mut window = Window::around(&sync, "r", "c", "m0120", None, NOW).await.unwrap().unwrap();
    while window.has_older {
        window.older(&sync).await.unwrap();
    }
    assert!(!window.has_newer, "the room ends right after: the present is reached");
    assert_contiguous(&window, 0, 129);
}

#[tokio::test]
async fn an_unknown_message_has_no_window() {
    let (_server, sync) = sync_for(vec![1_000]).await;
    assert!(Window::around(&sync, "r", "c", "m0007", None, NOW).await.is_err());
}
