use super::*;
use crate::delivery::{self, Target, Worker};
use rv_client::NativeClient;
use rv_protocol::e2ee as http;
use std::{
    io::{Read as _, Write as _},
    net::{TcpListener, TcpStream},
    sync::atomic::AtomicBool,
    thread,
    time::Duration,
};

fn now() -> std::result::Result<u64, delivery::Error> {
    Ok(NOW)
}
struct Request {
    method: String,
    path: String,
    headers: String,
    body: Vec<u8>,
}
struct Reply {
    status: u16,
    body: serde_json::Value,
    retry: Option<u64>,
}
fn json(value: &impl Serialize) -> Option<Reply> {
    Some(Reply {
        status: 200,
        body: serde_json::to_value(value).unwrap(),
        retry: None,
    })
}
fn error(status: u16, code: &str, retry: Option<u64>) -> Option<Reply> {
    Some(Reply {
        status,
        body: serde_json::json!({"code":code,"request_id":"delivery-fixture"}),
        retry,
    })
}
fn receive(stream: &mut TcpStream) -> Request {
    stream
        .set_read_timeout(Some(Duration::from_secs(5)))
        .unwrap();
    stream
        .set_write_timeout(Some(Duration::from_secs(5)))
        .unwrap();
    let mut bytes = Vec::new();
    let mut buffer = [0; 4096];
    loop {
        let n = stream.read(&mut buffer).unwrap();
        assert!(n > 0 && bytes.len() + n <= 4 * 1024 * 1024);
        bytes.extend_from_slice(&buffer[..n]);
        if let Some(end) = bytes.windows(4).position(|w| w == b"\r\n\r\n") {
            let headers = std::str::from_utf8(&bytes[..end]).unwrap();
            let length = headers
                .lines()
                .find_map(|h| {
                    let (name, value) = h.split_once(':')?;
                    name.eq_ignore_ascii_case("content-length")
                        .then(|| value.trim().parse::<usize>().unwrap())
                })
                .unwrap_or(0);
            if bytes.len() < end + 4 + length {
                continue;
            }
            let mut first = headers.lines().next().unwrap().split_whitespace();
            return Request {
                method: first.next().unwrap().into(),
                path: first.next().unwrap().into(),
                headers: headers.into(),
                body: bytes[end + 4..end + 4 + length].to_vec(),
            };
        }
    }
}
struct Server {
    url: String,
    stopped: Arc<AtomicBool>,
    join: Option<thread::JoinHandle<()>>,
}
impl Server {
    fn new(mut handler: impl FnMut(Request) -> Option<Reply> + Send + 'static) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        listener.set_nonblocking(true).unwrap();
        let stopped = Arc::new(AtomicBool::new(false));
        let closed = stopped.clone();
        let join = thread::spawn(move || {
            while !closed.load(Ordering::Acquire) {
                match listener.accept() {
                    Ok((mut stream, _)) => {
                        let request = receive(&mut stream);
                        if let Some(reply) = handler(request) {
                            let body = serde_json::to_vec(&reply.body).unwrap();
                            let retry = reply
                                .retry
                                .map(|n| format!("Retry-After: {n}\r\n"))
                                .unwrap_or_default();
                            write!(stream,"HTTP/1.1 {} fixture\r\nContent-Type: application/json\r\nContent-Length: {}\r\n{}Connection: close\r\n\r\n",reply.status,body.len(),retry).unwrap();
                            stream.write_all(&body).unwrap();
                        }
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(2))
                    }
                    Err(error) => panic!("fixture accept failed: {error}"),
                }
            }
        });
        Self {
            url,
            stopped,
            join: Some(join),
        }
    }
    fn worker(&self, account: &Account) -> Worker {
        let client = NativeClient::new(&self.url).unwrap();
        client.update_token(format!("{}-token", account.root.user));
        Worker::new(account.manager.clone(), account.root.clone(), client)
            .unwrap()
            .with_clock(now)
    }
}
impl Drop for Server {
    fn drop(&mut self) {
        self.stopped.store(true, Ordering::Release);
        self.join.take().unwrap().join().unwrap();
    }
}

struct Book {
    roster: http::GroupRoster,
    package: http::AvailableKeyPackage,
    submission: Option<http::GroupSubmission>,
    receipt: Option<http::GroupReceipt>,
    posts: usize,
    drop_once: bool,
    wrong_ack: bool,
    limited: bool,
}
fn server(alice: &Account, bob: &Account, drop_once: bool) -> (Server, Arc<Mutex<Book>>) {
    let roster = wire_tests::observation(&request(vec![], &["alice", "bob"]).roster, None);
    let book = Arc::new(Mutex::new(Book {
        roster,
        package: wire_tests::available(bob),
        submission: None,
        receipt: None,
        posts: 0,
        drop_once,
        wrong_ack: false,
        limited: false,
    }));
    let stored = book.clone();
    let own = alice.certificate.device.device.clone();
    let other = bob.certificate.device.device.clone();
    let server = Server::new(move |request| {
        let mut book = stored.lock().unwrap();
        let user = if request.headers.contains("bob-token") {
            "bob"
        } else {
            "alice"
        };
        let device = if user == "alice" {
            own.as_str()
        } else {
            other.as_str()
        };
        if request.path == "/.well-known/rocketvibe" {
            assert!(
                !request
                    .headers
                    .to_ascii_lowercase()
                    .contains("authorization:")
            );
            return json(&rv_protocol::Discovery {
                product: "rocketvibe".into(),
                instance_id: "instance".into(),
                data_epoch: "epoch".into(),
                server_version: "fixture".into(),
                protocol_versions: vec![1],
                api_path: "/api/v1".into(),
                capabilities: rv_protocol::Capabilities::default(),
            });
        }
        if request.path == "/api/v1/me" {
            return json(&rv_protocol::User {
                id: user.into(),
                username: user.into(),
                display_name: user.into(),
            });
        }
        if request.path == "/api/v1/me/sessions" {
            return json(&vec![rv_protocol::parity::DeviceSession {
                id: device.into(),
                label: "fixture".into(),
                created_at: "0".into(),
                last_seen_at: "0".into(),
                expires_at: "0".into(),
                current: true,
            }]);
        }
        if request.path.ends_with("/roster") {
            return json(&book.roster);
        }
        if request.path.contains("/key-packages/") {
            return json(&book.package);
        }
        if request.path.contains("/operations/") {
            return match &book.receipt {
                Some(receipt)
                    if request
                        .path
                        .ends_with(&format!("/{}", receipt.operation_id)) =>
                {
                    let mut receipt = receipt.clone();
                    if book.wrong_ack {
                        receipt.fingerprint = HEXLOWER.encode(&[7; 32]);
                    }
                    json(&receipt)
                }
                _ => error(404, "not_found", None),
            };
        }
        if request.path.ends_with("/transitions") && request.method == "POST" {
            book.posts += 1;
            if book.limited {
                return error(429, "rate_limited", Some(30));
            }
            let submission: http::GroupSubmission = serde_json::from_slice(&request.body).unwrap();
            let transition =
                Transition::from_bytes(&B64.decode(submission.transition.as_bytes()).unwrap())
                    .unwrap();
            transition.verify(NOW).unwrap();
            let receipt = Receipt {
                scope: transition.plan.scope.clone(),
                operation: submission.operation_id.clone(),
                revision: transition.plan.expected_revision + 1,
                epoch: transition.plan.epoch,
                fingerprint: transition.fingerprint().unwrap(),
            }
            .to_wire()
            .unwrap();
            book.roster.group = Some(receipt.clone());
            book.submission = Some(submission);
            book.receipt = Some(receipt.clone());
            if book.drop_once {
                book.drop_once = false;
                return None;
            }
            return json(&receipt);
        }
        if request.path.ends_with("/state") {
            let submission = book.submission.as_ref().unwrap();
            return json(&http::GroupState {
                receipt: book.receipt.clone().unwrap(),
                needs_rekey: false,
                transition: submission.transition.clone(),
                tree: submission.tree.clone(),
            });
        }
        if request.path.contains("/events?after=") {
            let after: u64 = request
                .path
                .split("after=")
                .nth(1)
                .unwrap()
                .parse()
                .unwrap();
            if after
                >= book
                    .receipt
                    .as_ref()
                    .unwrap()
                    .revision
                    .parse::<u64>()
                    .unwrap()
            {
                return json(&http::GroupEventPage {
                    events: vec![],
                    next: None,
                });
            }
            let submission = book.submission.as_ref().unwrap();
            let event = http::GroupEvent {
                receipt: book.receipt.clone().unwrap(),
                transition: submission.transition.clone(),
                commit: submission.commit.clone(),
                welcome: submission
                    .welcomes
                    .iter()
                    .find(|w| w.device_id == device)
                    .cloned(),
            };
            return json(&http::GroupEventPage {
                events: vec![event],
                next: None,
            });
        }
        panic!("unexpected fixture route {}", request.path);
    });
    (server, book)
}
fn accounts() -> (Account, Account) {
    let alice = Account::new("alice", "alice-desktop", [1; 16]);
    let bob = Account::new("bob", "bob-mobile", [2; 16]);
    alice.trust(&bob, true);
    bob.trust(&alice, true);
    (alice, bob)
}
async fn preview(worker: &Worker) -> delivery::GenesisPreview {
    worker
        .preview_genesis(
            "room",
            [3; 16],
            "worker-genesis".into(),
            vec![Target {
                user: "bob".into(),
                device: "bob-mobile".into(),
            }],
        )
        .await
        .unwrap()
}

#[tokio::test]
async fn lost_http_ack_is_reconciled_after_worker_recreation_without_new_post_or_new_commit() {
    let (alice, bob) = accounts();
    let (server, book) = server(&alice, &bob, true);
    let worker = server.worker(&alice);
    let prepared = preview(&worker).await;
    let fingerprint = prepared.preview.fingerprint;
    assert!(matches!(
        worker.prepare_genesis(prepared, fingerprint).await,
        Err(delivery::Error::Network(_))
    ));
    assert_eq!(
        alice.coordinator().ready_epoch("room"),
        Err(Error::NotReady)
    );
    let original = alice.reopened().retry("room", NOW).unwrap();
    assert_eq!(book.lock().unwrap().posts, 1);
    worker.stop();
    let accepted = server.worker(&alice).resume_group("room").await.unwrap();
    assert_eq!(accepted.fingerprint, receipt(&original).fingerprint);
    assert_eq!(book.lock().unwrap().posts, 1);
    assert_eq!(alice.reopened().ready_epoch("room"), Ok(1));
    let recipient = server.worker(&bob);
    let batch = recipient.events("room").await.unwrap();
    let prepared = recipient
        .preview_event(batch.page.events[0].clone())
        .await
        .unwrap();
    let fingerprint = prepared.preview.fingerprint;
    recipient.accept_event(prepared, fingerprint).await.unwrap();
    assert_eq!(
        incoming_commits::secret(&alice),
        incoming_commits::secret(&bob)
    );
}

#[tokio::test]
async fn lost_rotation_ack_preserves_parent_until_exact_receipt_and_peer_catchup() {
    let (alice, bob) = accounts();
    let (server, book) = server(&alice, &bob, false);
    let author = server.worker(&alice);
    let prepared = preview(&author).await;
    let fingerprint = prepared.preview.fingerprint;
    author.prepare_genesis(prepared, fingerprint).await.unwrap();
    let recipient = server.worker(&bob);
    let batch = recipient.events("room").await.unwrap();
    let prepared = recipient
        .preview_event(batch.page.events[0].clone())
        .await
        .unwrap();
    let fingerprint = prepared.preview.fingerprint;
    recipient.accept_event(prepared, fingerprint).await.unwrap();
    let original_secret = incoming_commits::secret(&alice);
    let prepared = author
        .preview_change("room", "worker-rotation".into(), vec![], vec![])
        .await
        .unwrap();
    let fingerprint = prepared.preview.fingerprint;
    book.lock().unwrap().drop_once = true;
    assert!(matches!(
        author.prepare_change(prepared, fingerprint).await,
        Err(delivery::Error::Network(_))
    ));
    assert_eq!(alice.reopened().ready_epoch("room"), Ok(1));
    assert_eq!(incoming_commits::secret(&alice), original_secret);
    author.stop();
    let head = server.worker(&alice).resume_group("room").await.unwrap();
    assert_eq!(head.epoch, 2);
    assert_eq!(book.lock().unwrap().posts, 2);
    let batch = recipient.events("room").await.unwrap();
    assert_eq!(batch.page.events[0].receipt.revision, "2");
    assert!(batch.page.events[0].welcome.is_none());
    let prepared = recipient
        .preview_event(batch.page.events[0].clone())
        .await
        .unwrap();
    let fingerprint = prepared.preview.fingerprint;
    recipient.accept_event(prepared, fingerprint).await.unwrap();
    assert_ne!(incoming_commits::secret(&alice), original_secret);
    assert_eq!(
        incoming_commits::secret(&alice),
        incoming_commits::secret(&bob)
    );
    assert!(
        recipient
            .events("room")
            .await
            .unwrap()
            .page
            .events
            .is_empty()
    );
}

#[tokio::test]
async fn wrong_operation_receipt_and_changed_roster_never_merge_or_consume_a_welcome() {
    let (alice, bob) = accounts();
    let (server, book) = server(&alice, &bob, true);
    let worker = server.worker(&alice);
    let prepared = preview(&worker).await;
    let fingerprint = prepared.preview.fingerprint;
    assert!(worker.prepare_genesis(prepared, fingerprint).await.is_err());
    book.lock().unwrap().wrong_ack = true;
    assert!(matches!(
        worker.resume_group("room").await,
        Err(delivery::Error::Group(Error::Receipt))
    ));
    assert_eq!(
        alice.coordinator().ready_epoch("room"),
        Err(Error::NotReady)
    );
    book.lock().unwrap().wrong_ack = false;
    worker.resume_group("room").await.unwrap();
    let recipient = server.worker(&bob);
    let batch = recipient.events("room").await.unwrap();
    let event = batch.page.events[0].clone();
    let prepared = recipient.preview_event(event.clone()).await.unwrap();
    let fingerprint = prepared.preview.fingerprint;
    book.lock().unwrap().roster.members[1].activation_version = "changed-activation".into();
    assert!(recipient.accept_event(prepared, fingerprint).await.is_err());
    assert_eq!(bob.reopened().ready_epoch("room"), Err(Error::NotReady));
    book.lock().unwrap().roster.members[1].activation_version = "activation-bob".into();
    let prepared = recipient.preview_event(event).await.unwrap();
    let fingerprint = prepared.preview.fingerprint;
    recipient.accept_event(prepared, fingerprint).await.unwrap();
}

#[tokio::test]
async fn retry_after_survives_new_worker_and_still_allows_receipt_reconciliation() {
    let (alice, bob) = accounts();
    let (server, book) = server(&alice, &bob, false);
    book.lock().unwrap().limited = true;
    let worker = server.worker(&alice);
    let prepared = preview(&worker).await;
    let fingerprint = prepared.preview.fingerprint;
    assert!(matches!(
        worker.prepare_genesis(prepared, fingerprint).await,
        Err(delivery::Error::Network(rv_client::Error::Server {
            status: 429,
            ..
        }))
    ));
    let original = alice.coordinator().retry("room", NOW).unwrap();
    assert!(matches!(
        server.worker(&alice).resume_group("room").await,
        Err(delivery::Error::Cooldown { retry_after: 30 })
    ));
    assert_eq!(book.lock().unwrap().posts, 1);
    // An accepted historical receipt remains queryable during POST cooldown.
    book.lock().unwrap().receipt = Some(receipt(&original).to_wire().unwrap());
    server.worker(&alice).resume_group("room").await.unwrap();
    assert_eq!(alice.reopened().ready_epoch("room"), Ok(1));
}

#[tokio::test]
async fn stop_is_shared_and_scope_changes_prevent_any_vault_or_crypto_request() {
    let (alice, bob) = accounts();
    let (server, book) = server(&alice, &bob, false);
    let worker = server.worker(&alice);
    let clone = worker.clone();
    worker.stop();
    assert!(matches!(
        clone.resume_group("room").await,
        Err(delivery::Error::Stopped)
    ));
    assert_eq!(book.lock().unwrap().posts, 0);
    for field in 0..3 {
        let calls = Arc::new(AtomicUsize::new(0));
        let recorded = calls.clone();
        let server = Server::new(move |request| {
            recorded.fetch_add(1, Ordering::SeqCst);
            match request.path.as_str() {
                "/.well-known/rocketvibe" => json(&rv_protocol::Discovery {
                    product: "rocketvibe".into(),
                    instance_id: "instance".into(),
                    data_epoch: if field == 0 {
                        "changed".into()
                    } else {
                        "epoch".into()
                    },
                    server_version: "fixture".into(),
                    protocol_versions: vec![1],
                    api_path: "/api/v1".into(),
                    capabilities: rv_protocol::Capabilities::default(),
                }),
                "/api/v1/me" => json(&rv_protocol::User {
                    id: if field == 1 {
                        "other".into()
                    } else {
                        "alice".into()
                    },
                    username: "alice".into(),
                    display_name: "alice".into(),
                }),
                "/api/v1/me/sessions" => json(&vec![rv_protocol::parity::DeviceSession {
                    id: "other-device".into(),
                    label: "fixture".into(),
                    created_at: "0".into(),
                    last_seen_at: "0".into(),
                    expires_at: "0".into(),
                    current: true,
                }]),
                _ => panic!("crypto should not be requested after scope mismatch"),
            }
        });
        assert!(matches!(
            server.worker(&alice).resume_group("room").await,
            Err(delivery::Error::Scope)
        ));
        assert_eq!(calls.load(Ordering::SeqCst), field + 1);
    }
    assert_eq!(
        alice.coordinator().pending_lookup("room").err(),
        Some(Error::NotReady)
    );
}
