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
    // Accept flags vary by platform. The listener polls, but request reads
    // must block; allow the same deadline as the SDK under a busy CI runner.
    stream.set_nonblocking(false).unwrap();
    stream
        .set_read_timeout(Some(Duration::from_secs(15)))
        .unwrap();
    stream
        .set_write_timeout(Some(Duration::from_secs(15)))
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
        if let Err(error) = self.join.take().unwrap().join()
            && !thread::panicking()
        {
            // Keep the fixture failure visible without aborting the entire
            // test process with a second panic during unwinding.
            std::panic::resume_unwind(error);
        }
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
    group_drop_before: bool,
    group_cancellations: BTreeMap<String, (Vec<u8>, http::GroupCancellation)>,
    group_cancel_attempts: Vec<Vec<u8>>,
    group_cancel_drop_once: bool,
    group_cancel_wrong_ack: bool,
    message_submissions: BTreeMap<String, http::ApplicationSubmission>,
    message_receipts: BTreeMap<String, http::ApplicationReceipt>,
    message_cancellations: BTreeMap<String, (Vec<u8>, http::ApplicationCancellation)>,
    cancellation_drop_once: bool,
    cancellation_drop_before: bool,
    cancellation_wrong_ack: bool,
    message_attempts: Vec<Vec<u8>>,
    message_drop_before: bool,
    message_drop_after: bool,
    message_wrong_ack: bool,
    message_limited: bool,
    message_roster_reads: usize,
    journal_drop_once: bool,
    journal_wrong_room: bool,
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
        group_drop_before: false,
        group_cancellations: BTreeMap::new(),
        group_cancel_attempts: vec![],
        group_cancel_drop_once: false,
        group_cancel_wrong_ack: false,
        message_submissions: BTreeMap::new(),
        message_receipts: BTreeMap::new(),
        message_cancellations: BTreeMap::new(),
        cancellation_drop_once: false,
        cancellation_drop_before: false,
        cancellation_wrong_ack: false,
        message_attempts: vec![],
        message_drop_before: false,
        message_drop_after: false,
        message_wrong_ack: false,
        message_limited: false,
        message_roster_reads: 0,
        journal_drop_once: false,
        journal_wrong_room: false,
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
                icon_revision: None,
            });
        }
        if request.path == "/api/v1/me" {
            return json(&rv_protocol::User {
                id: user.into(),
                username: user.into(),
                display_name: user.into(),
                ..Default::default()
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
            book.message_roster_reads += 1;
            return json(&book.roster);
        }
        if request.path.contains("/key-packages/") {
            return json(&book.package);
        }
        if request.path.ends_with("/cancel")
            && request.method == "POST"
            && request.path.contains("/message-operations/")
        {
            if book.cancellation_drop_before {
                book.cancellation_drop_before = false;
                return None;
            }
            let input: http::ApplicationSubmission = serde_json::from_slice(&request.body).unwrap();
            let submission = MessageSubmission::from_wire(&input).unwrap();
            let proof = rv_crypto_public::messages::Proof::from_bytes(&submission.proof).unwrap();
            proof.authenticate(&submission.ciphertext).unwrap();
            assert_eq!(proof.header.author, user);
            if let Some(stored) = book.message_receipts.get(&input.operation_id) {
                assert!(
                    serde_json::to_vec(book.message_submissions.get(&input.operation_id).unwrap())
                        .unwrap()
                        == request.body
                );
                return json(&http::ApplicationSettlement::Accepted(stored.clone()));
            }
            if let Some((body, _)) = book.message_cancellations.get(&input.operation_id) {
                assert!(*body == request.body);
            }
            let receipt = http::ApplicationCancellation {
                scope: input.scope,
                room_id: proof.header.scope.room.clone(),
                operation_id: input.operation_id.clone(),
                header: B64.encode(&serde_json::to_vec(&proof.header).unwrap()),
                fingerprint: HEXLOWER.encode(&proof.fingerprint().unwrap()),
            };
            book.message_cancellations
                .insert(input.operation_id, (request.body, receipt.clone()));
            if book.cancellation_drop_once {
                book.cancellation_drop_once = false;
                return None;
            }
            let mut receipt = receipt;
            if book.cancellation_wrong_ack {
                receipt.fingerprint = HEXLOWER.encode(&[7; 32]);
            }
            return json(&http::ApplicationSettlement::Cancelled(receipt));
        }
        if request.path.contains("/message-operations/") {
            let operation = request.path.rsplit('/').next().unwrap();
            let Some(stored) = book.message_receipts.get(operation) else {
                if book.message_cancellations.contains_key(operation) {
                    return error(409, "crypto_message_cancelled", None);
                }
                return error(404, "not_found", None);
            };
            let mut stored = stored.clone();
            let receipt = wire::message_receipt(&stored).unwrap();
            if receipt.header.author != user {
                return error(404, "not_found", None);
            };
            if book.message_wrong_ack {
                stored.fingerprint = HEXLOWER.encode(&[7; 32]);
                stored.message_id = rv_crypto_public::messages::message_id(&[7; 32]);
            }
            return json(&stored);
        }
        if request.path.ends_with("/messages") && request.method == "POST" {
            book.message_attempts.push(request.body.clone());
            if book.message_limited {
                return error(429, "crypto_message_limit", Some(30));
            }
            if book.message_drop_before {
                book.message_drop_before = false;
                return None;
            }
            let input: http::ApplicationSubmission = serde_json::from_slice(&request.body).unwrap();
            let submission = MessageSubmission::from_wire(&input).unwrap();
            let proof = submission.verified(NOW).unwrap();
            if book.message_cancellations.contains_key(&input.operation_id) {
                return error(409, "crypto_message_cancelled", None);
            }
            assert_eq!(proof.header.author, user);
            assert_eq!(proof.header.device, device);
            let fingerprint = proof.fingerprint().unwrap();
            let receipt = rv_crypto_public::messages::Receipt {
                header: proof.header,
                fingerprint,
                message: rv_crypto_public::messages::message_id(&fingerprint),
                position: 9007199254740993 + book.message_receipts.len() as u64,
            };
            let receipt = wire::message_receipt_to_wire(&receipt).unwrap();
            book.message_submissions
                .insert(input.operation_id.clone(), input);
            book.message_receipts
                .insert(receipt.operation_id.clone(), receipt.clone());
            if book.message_drop_after {
                book.message_drop_after = false;
                return None;
            }
            return json(&receipt);
        }
        if request.path.contains("/operations/") && request.path.ends_with("/cancel") {
            assert_eq!(request.method, "POST");
            book.group_cancel_attempts.push(request.body.clone());
            let input: http::GroupSubmission = serde_json::from_slice(&request.body).unwrap();
            let transition =
                Transition::from_bytes(&B64.decode(input.transition.as_bytes()).unwrap()).unwrap();
            transition.authenticate().unwrap();
            assert_eq!(transition.certificate.device.root.user, user);
            assert_eq!(transition.certificate.device.device, device);
            if let Some(accepted) = &book.receipt
                && accepted.operation_id == input.operation_id
            {
                assert_eq!(
                    serde_json::to_value(book.submission.as_ref().unwrap()).unwrap(),
                    serde_json::to_value(&input).unwrap()
                );
                return json(&http::GroupSettlement::Accepted(accepted.clone()));
            }
            let cancellation = http::GroupCancellation {
                scope: input.scope,
                room_id: transition.plan.scope.room.clone(),
                incarnation: HEXLOWER.encode(&transition.plan.scope.incarnation),
                operation_id: input.operation_id,
                device_id: device.into(),
                fingerprint: HEXLOWER.encode(&transition.fingerprint().unwrap()),
            };
            if let Some((original, saved)) =
                book.group_cancellations.get(&cancellation.operation_id)
            {
                assert_eq!(original, &request.body);
                assert_eq!(
                    serde_json::to_value(saved).unwrap(),
                    serde_json::to_value(&cancellation).unwrap()
                );
            } else {
                book.group_cancellations.insert(
                    cancellation.operation_id.clone(),
                    (request.body, cancellation.clone()),
                );
            }
            if book.group_cancel_drop_once {
                book.group_cancel_drop_once = false;
                return None;
            }
            let mut cancellation = cancellation;
            if book.group_cancel_wrong_ack {
                cancellation.fingerprint = HEXLOWER.encode(&[7; 32]);
            }
            return json(&http::GroupSettlement::Cancelled(cancellation));
        }
        if request.path.contains("/operations/") {
            if book
                .group_cancellations
                .contains_key(request.path.rsplit('/').next().unwrap())
            {
                return error(409, "crypto_group_cancelled", None);
            }
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
            if book.group_drop_before {
                book.group_drop_before = false;
                return None;
            }
            if book.limited {
                return error(429, "rate_limited", Some(30));
            }
            let submission: http::GroupSubmission = serde_json::from_slice(&request.body).unwrap();
            if book
                .group_cancellations
                .contains_key(&submission.operation_id)
            {
                return error(409, "crypto_group_cancelled", None);
            }
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
        if request.path.contains("/delivery?after=") {
            if book.journal_drop_once {
                book.journal_drop_once = false;
                return None;
            }
            let query = request.path.split("after=").nth(1).unwrap();
            let (after, through) = query
                .split_once("&through=")
                .map_or((query, None), |(a, t)| (a, Some(t)));
            let after: u64 = after.parse().unwrap();
            let through = through.map(|t| t.parse().unwrap()).unwrap_or_else(|| {
                book.message_receipts
                    .values()
                    .map(|r| r.position.parse::<u64>().unwrap())
                    .max()
                    .unwrap_or(1)
            });
            let submission = book.submission.as_ref().unwrap();
            let receipt = book.receipt.as_ref().unwrap();
            let mut events = Vec::new();
            if after == 0 {
                events.push(http::DeliveryEvent {
                    position: "1".into(),
                    content: http::DeliveryContent::Group(http::GroupEvent {
                        receipt: receipt.clone(),
                        transition: submission.transition.clone(),
                        commit: submission.commit.clone(),
                        welcome: submission
                            .welcomes
                            .iter()
                            .find(|w| w.device_id == device)
                            .cloned(),
                    }),
                });
            }
            for (operation, receipt) in &book.message_receipts {
                let position: u64 = receipt.position.parse().unwrap();
                if after < position && position <= through {
                    let input = &book.message_submissions[operation];
                    events.push(http::DeliveryEvent {
                        position: receipt.position.clone(),
                        content: http::DeliveryContent::Message(http::ApplicationMessage {
                            receipt: receipt.clone(),
                            proof: input.proof.clone(),
                            ciphertext: input.ciphertext.clone(),
                        }),
                    });
                }
            }
            events.sort_by_key(|e| e.position.parse::<u64>().unwrap());
            return json(&http::DeliveryPage {
                scope: receipt.scope.clone(),
                room_id: if book.journal_wrong_room {
                    "other-room".into()
                } else {
                    receipt.room_id.clone()
                },
                incarnation: receipt.incarnation.clone(),
                after: after.to_string(),
                through: through.to_string(),
                events,
                next: None,
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
fn private_message(operation: &str) -> rv_protocol::SendMessage {
    rv_protocol::SendMessage {
        operation_id: operation.into(),
        text: "Message HTTP **privé** 🐾".into(),
        quotes: vec![rv_protocol::parity::QuoteReference {
            room_id: "quoted-room".into(),
            message_id: "quoted-message".into(),
            revision: "9007199254740993".into(),
        }],
        cards: vec![],
        reply_to: None,
        files: vec![],
    }
}
async fn joined_workers(server: &Server, alice: &Account, bob: &Account) -> (Worker, Worker) {
    let author = server.worker(alice);
    let preview = preview(&author).await;
    let fingerprint = preview.preview.fingerprint;
    author.prepare_genesis(preview, fingerprint).await.unwrap();
    let peer = server.worker(bob);
    let batch = peer.events("room").await.unwrap();
    let preview = peer
        .preview_event(batch.page.events[0].clone())
        .await
        .unwrap();
    let fingerprint = preview.preview.fingerprint;
    peer.accept_event(preview, fingerprint).await.unwrap();
    (author, peer)
}

#[tokio::test]
async fn journal_worker_reopens_after_lost_read_replays_clear_and_refuses_wrong_route_labels() {
    let (alice, bob) = accounts();
    let (server, book) = server(&alice, &bob, false);
    let (author, peer) = joined_workers(&server, &alice, &bob).await;
    let receipt = author
        .send_message("room", private_message("journal-http"))
        .await
        .unwrap();
    book.lock().unwrap().journal_drop_once = true;
    assert!(matches!(
        peer.journal_page("room").await,
        Err(delivery::Error::Network(_))
    ));
    assert_eq!(bob.reopened().journal_request("room").unwrap().after, 0);
    peer.stop();
    let batch = server.worker(&bob).journal_page("room").await.unwrap();
    assert!(batch.complete && batch.after == receipt.position && batch.messages.len() == 1);
    assert_eq!(
        batch.messages[0].message().unwrap().operation_id,
        "journal-http"
    );
    bob.coordinator()
        .forget_message(&batch.messages[0].receipt)
        .unwrap();
    let replay = server
        .worker(&bob)
        .journal_last_batch("room")
        .await
        .unwrap();
    assert_eq!(
        replay.messages[0].message().unwrap().text,
        "Message HTTP **privé** 🐾"
    );
    let projection = server
        .worker(&bob)
        .journal_projection(
            "room",
            ProjectionQuery {
                before: None,
                limit: 50,
                thread: None,
            },
        )
        .await
        .unwrap();
    assert_eq!(projection.messages.len(), 1);
    assert_eq!(
        projection.messages[0]
            .message
            .message()
            .unwrap()
            .operation_id,
        "journal-http"
    );
    // This deliberately blind fixture serves the valid room envelope for any
    // roster/state URL. The requested route must still bind the worker result.
    assert!(matches!(
        server.worker(&bob).journal_last_batch("other-room").await,
        Err(delivery::Error::Scope)
    ));
    book.lock().unwrap().journal_wrong_room = true;
    assert!(matches!(
        server.worker(&bob).journal_page("room").await,
        Err(delivery::Error::Scope)
    ));
    assert_eq!(
        bob.reopened().journal_request("room").unwrap().after,
        receipt.position
    );
    assert_eq!(book.lock().unwrap().message_attempts.len(), 1);
}
fn delivered(book: &Mutex<Book>, operation: &str) -> http::ApplicationMessage {
    let book = book.lock().unwrap();
    let input = book.message_submissions.get(operation).unwrap();
    http::ApplicationMessage {
        receipt: book.message_receipts.get(operation).unwrap().clone(),
        proof: input.proof.clone(),
        ciphertext: input.ciphertext.clone(),
    }
}
fn late() -> std::result::Result<u64, delivery::Error> {
    Ok(NOW + 3601)
}

#[tokio::test]
async fn cancellation_lost_ack_reopens_after_expiry_without_resending_or_observing_the_roster() {
    let (alice, bob) = accounts();
    let (server, book) = server(&alice, &bob, false);
    let (author, _) = joined_workers(&server, &alice, &bob).await;
    book.lock().unwrap().message_drop_before = true;
    let doc = private_message("worker-cancel-private");
    assert!(author.send_message("room", doc.clone()).await.is_err());
    let reads = book.lock().unwrap().message_roster_reads;
    book.lock().unwrap().cancellation_wrong_ack = true;
    assert!(matches!(
        author.cancel_message(&doc.operation_id).await,
        Err(delivery::Error::Group(Error::Receipt))
    ));
    assert!(alice.reopened().pending_message(&doc.operation_id).is_ok());
    book.lock().unwrap().cancellation_wrong_ack = false;
    book.lock().unwrap().cancellation_drop_once = true;
    assert!(author.cancel_message(&doc.operation_id).await.is_err());
    author.stop();
    let worker = server.worker(&alice).with_clock(late);
    let MessageSettlement::Cancelled(cancellation) =
        worker.cancel_message(&doc.operation_id).await.unwrap()
    else {
        panic!("unexpected send")
    };
    assert_eq!(book.lock().unwrap().message_roster_reads, reads);
    assert_eq!(book.lock().unwrap().message_attempts.len(), 1);
    assert!(book.lock().unwrap().message_receipts.is_empty());
    assert!(alice.reopened().pending_message(&doc.operation_id).is_err());
    assert!(matches!(
        worker.resume_message(&doc.operation_id).await,
        Err(delivery::Error::Group(Error::MessageCancelled))
    ));
    let body = alice
        .reopened()
        .cancelled_message(&doc.operation_id)
        .unwrap();
    assert!(body.cancellation == cancellation);
    assert!(
        serde_json::to_value(body.message().unwrap()).unwrap()
            == serde_json::to_value(doc).unwrap()
    );
}

#[tokio::test]
async fn cancellation_recovers_an_already_accepted_original_and_unblocks_rotation() {
    let (alice, bob) = accounts();
    let (server, book) = server(&alice, &bob, false);
    let (author, peer) = joined_workers(&server, &alice, &bob).await;
    book.lock().unwrap().message_drop_after = true;
    let doc = private_message("worker-cancel-accepted");
    assert!(author.send_message("room", doc.clone()).await.is_err());
    let MessageSettlement::Accepted(receipt) =
        author.cancel_message(&doc.operation_id).await.unwrap()
    else {
        panic!("accepted send abandoned")
    };
    assert_eq!(receipt.position, 9007199254740993);
    assert!(alice.reopened().pending_message(&doc.operation_id).is_err());
    assert!(
        alice
            .reopened()
            .cancelled_message(&doc.operation_id)
            .is_err()
    );
    assert_eq!(
        peer.receive_message(delivered(&book, &doc.operation_id))
            .await
            .unwrap()
            .message()
            .unwrap()
            .text,
        doc.text
    );
    assert!(
        author
            .preview_change("room", "rotation-after-settlement".into(), vec![], vec![])
            .await
            .is_ok()
    );
    assert_eq!(book.lock().unwrap().message_attempts.len(), 1);
}

#[tokio::test]
async fn cancellation_intent_survives_a_pre_server_cut_and_resume_never_republishes() {
    let (alice, bob) = accounts();
    let (server, book) = server(&alice, &bob, false);
    let (author, _) = joined_workers(&server, &alice, &bob).await;
    book.lock().unwrap().message_drop_before = true;
    let doc = private_message("worker-cancel-before-server");
    assert!(author.send_message("room", doc.clone()).await.is_err());
    book.lock().unwrap().cancellation_drop_before = true;
    assert!(author.cancel_message(&doc.operation_id).await.is_err());
    assert!(book.lock().unwrap().message_cancellations.is_empty());
    assert!(
        alice
            .reopened()
            .pending_message(&doc.operation_id)
            .unwrap()
            .cancelling
    );
    let reads = book.lock().unwrap().message_roster_reads;
    author.stop();
    assert!(matches!(
        server
            .worker(&alice)
            .resume_message(&doc.operation_id)
            .await,
        Err(delivery::Error::Group(Error::MessageCancelled))
    ));
    assert!(
        alice
            .reopened()
            .cancelled_message(&doc.operation_id)
            .unwrap()
            .message()
            .unwrap()
            .text
            == doc.text
    );
    assert_eq!(book.lock().unwrap().message_roster_reads, reads);
    assert_eq!(book.lock().unwrap().message_attempts.len(), 1);
    assert!(
        server
            .worker(&alice)
            .preview_change("room", "rotation-after-abandonment".into(), vec![], vec![])
            .await
            .is_ok()
    );
    // A different active session of the owner can settle the original. A 409
    // status only prompts retrieval and validation of the exact decision.
    let worker = server.worker(&alice);
    book.lock().unwrap().message_drop_before = true;
    let doc = private_message("worker-cancel-other-session");
    assert!(worker.send_message("room", doc.clone()).await.is_err());
    let input = alice
        .coordinator()
        .settlement_submission(&doc.operation_id, NOW)
        .unwrap()
        .to_wire()
        .unwrap();
    let client = NativeClient::new(&server.url).unwrap();
    client.update_token("alice-token".into());
    client.cancel_crypto_message("room", &input).await.unwrap();
    assert!(
        !alice
            .reopened()
            .pending_message(&doc.operation_id)
            .unwrap()
            .cancelling
    );
    assert!(matches!(
        worker.resume_message(&doc.operation_id).await,
        Err(delivery::Error::Group(Error::MessageCancelled))
    ));
    assert_eq!(book.lock().unwrap().message_attempts.len(), 2);
}

#[tokio::test]
async fn protected_message_lost_ack_reopens_exactly_and_real_peer_receive_is_durable() {
    let (alice, bob) = accounts();
    let (server, book) = server(&alice, &bob, false);
    let (author, peer) = joined_workers(&server, &alice, &bob).await;
    book.lock().unwrap().message_drop_after = true;
    let message = private_message("worker-private-one");
    assert!(matches!(
        author.send_message("room", message.clone()).await,
        Err(delivery::Error::Network(_))
    ));
    let original = alice
        .reopened()
        .pending_message(&message.operation_id)
        .unwrap();
    assert_eq!(book.lock().unwrap().message_attempts.len(), 1);
    author.stop();
    let acknowledged = server
        .worker(&alice)
        .resume_message(&message.operation_id)
        .await
        .unwrap();
    assert!(
        acknowledged.header == original.header && acknowledged.fingerprint == original.fingerprint
    );
    assert_eq!(acknowledged.position, 9007199254740993);
    assert_eq!(book.lock().unwrap().message_attempts.len(), 1);
    let frame = delivered(&book, &message.operation_id);
    let clear = peer.receive_message(frame.clone()).await.unwrap();
    assert_eq!(
        serde_json::to_value(clear.message().unwrap()).unwrap(),
        serde_json::to_value(&message).unwrap()
    );
    peer.stop();
    let clear = server
        .worker(&bob)
        .receive_message(frame.clone())
        .await
        .unwrap();
    assert_eq!(clear.receipt.position, acknowledged.position);
    assert_eq!(clear.message().unwrap().text, message.text);
    let clear = server.worker(&alice).receive_message(frame).await.unwrap();
    assert_eq!(
        clear.message().unwrap().quotes[0].revision,
        "9007199254740993"
    );
    assert!(
        alice
            .reopened()
            .pending_message(&message.operation_id)
            .is_err()
    );
}

#[tokio::test]
async fn unaccepted_message_retries_byte_identically_and_blocks_own_rotation() {
    let (alice, bob) = accounts();
    let (server, book) = server(&alice, &bob, false);
    let (author, peer) = joined_workers(&server, &alice, &bob).await;
    book.lock().unwrap().message_drop_before = true;
    let message = private_message("worker-private-retry");
    assert!(matches!(
        author.send_message("room", message.clone()).await,
        Err(delivery::Error::Network(_))
    ));
    assert!(matches!(
        author
            .preview_change("room", "rotation-must-wait".into(), vec![], vec![])
            .await,
        Err(delivery::Error::Group(Error::Pending))
    ));
    author.stop();
    server
        .worker(&alice)
        .resume_message(&message.operation_id)
        .await
        .unwrap();
    {
        let book_guard = book.lock().unwrap();
        assert_eq!(book_guard.message_attempts.len(), 2);
        assert!(book_guard.message_attempts[0] == book_guard.message_attempts[1]);
    }
    assert_eq!(
        peer.receive_message(delivered(&book, &message.operation_id))
            .await
            .unwrap()
            .message()
            .unwrap()
            .text,
        message.text
    );
}

#[tokio::test]
async fn divergent_message_receipt_never_clears_the_original_protected_outbox() {
    let (alice, bob) = accounts();
    let (server, book) = server(&alice, &bob, false);
    let (author, _) = joined_workers(&server, &alice, &bob).await;
    book.lock().unwrap().message_drop_after = true;
    let message = private_message("worker-private-wrong-ack");
    assert!(author.send_message("room", message.clone()).await.is_err());
    let original = alice
        .reopened()
        .pending_message(&message.operation_id)
        .unwrap();
    book.lock().unwrap().message_wrong_ack = true;
    assert!(matches!(
        server
            .worker(&alice)
            .resume_message(&message.operation_id)
            .await,
        Err(delivery::Error::Group(Error::Receipt))
    ));
    assert!(
        alice
            .reopened()
            .pending_message(&message.operation_id)
            .unwrap()
            .fingerprint
            == original.fingerprint
    );
    book.lock().unwrap().message_wrong_ack = false;
    server
        .worker(&alice)
        .resume_message(&message.operation_id)
        .await
        .unwrap();
    assert_eq!(book.lock().unwrap().message_attempts.len(), 1);
}

#[tokio::test]
async fn accepted_message_receipt_is_reconciled_after_certificate_expiry_without_roster_or_post() {
    let (alice, bob) = accounts();
    let (server, book) = server(&alice, &bob, false);
    let (author, _) = joined_workers(&server, &alice, &bob).await;
    book.lock().unwrap().message_drop_after = true;
    let message = private_message("worker-private-historical");
    assert!(author.send_message("room", message.clone()).await.is_err());
    let reads = book.lock().unwrap().message_roster_reads;
    book.lock().unwrap().roster.members.clear();
    assert!(alice.certificate.verify(late().unwrap()).is_err());
    author.stop();
    server
        .worker(&alice)
        .with_clock(late)
        .resume_message(&message.operation_id)
        .await
        .unwrap();
    let book = book.lock().unwrap();
    assert_eq!(book.message_attempts.len(), 1);
    assert_eq!(book.message_roster_reads, reads);
}

#[tokio::test]
async fn message_cooldown_is_durable_while_a_late_historical_receipt_remains_readable() {
    let (alice, bob) = accounts();
    let (server, book) = server(&alice, &bob, false);
    let (author, _) = joined_workers(&server, &alice, &bob).await;
    book.lock().unwrap().message_limited = true;
    let message = private_message("worker-private-budget");
    assert!(matches!(
        author.send_message("room", message.clone()).await,
        Err(delivery::Error::Network(rv_client::Error::Server {
            status: 429,
            ..
        }))
    ));
    assert!(matches!(
        server
            .worker(&alice)
            .resume_message(&message.operation_id)
            .await,
        Err(delivery::Error::Cooldown { retry_after: 30 })
    ));
    let original = alice
        .coordinator()
        .retry_message(
            &super::application_messages::observation(&alice),
            &message.operation_id,
            NOW,
        )
        .unwrap();
    let proof = original.verified(NOW).unwrap();
    let fingerprint = proof.fingerprint().unwrap();
    // Simulate a prior request committed after an uncertain/gateway response.
    // Its canonical original packet already exists in the protected outbox.
    let ack = wire::message_receipt_to_wire(&rv_crypto_public::messages::Receipt {
        header: proof.header,
        fingerprint,
        message: rv_crypto_public::messages::message_id(&fingerprint),
        position: 9007199254740993,
    })
    .unwrap();
    book.lock()
        .unwrap()
        .message_receipts
        .insert(message.operation_id.clone(), ack);
    server
        .worker(&alice)
        .resume_message(&message.operation_id)
        .await
        .unwrap();
    assert_eq!(book.lock().unwrap().message_attempts.len(), 1);
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
async fn lost_group_cancellation_reopens_without_resubmitting_then_a_fresh_genesis_can_publish() {
    let (alice, bob) = accounts();
    let (server, book) = server(&alice, &bob, false);
    book.lock().unwrap().group_drop_before = true;
    let worker = server.worker(&alice);
    let prepared = preview(&worker).await;
    let fingerprint = prepared.preview.fingerprint;
    assert!(matches!(
        worker.prepare_genesis(prepared, fingerprint).await,
        Err(delivery::Error::Network(_))
    ));
    book.lock().unwrap().group_cancel_drop_once = true;
    assert!(matches!(
        worker.cancel_group("room", "worker-genesis").await,
        Err(delivery::Error::Network(_))
    ));
    assert!(alice.reopened().pending_lookup("room").unwrap().cancelling);
    assert!(matches!(
        server.worker(&alice).resume_group("room").await,
        Err(delivery::Error::Group(Error::GroupCancelled))
    ));
    assert!(matches!(
        server
            .worker(&alice)
            .cancel_group("room", "worker-genesis")
            .await
            .unwrap(),
        GroupSettlement::Cancelled(_)
    ));
    {
        let book = book.lock().unwrap();
        assert_eq!(book.posts, 1);
        assert_eq!(book.group_cancel_attempts.len(), 2);
        assert_eq!(book.group_cancel_attempts[0], book.group_cancel_attempts[1]);
    }
    let fresh = server
        .worker(&alice)
        .preview_genesis(
            "room",
            [3; 16],
            "fresh-after-abandonment".into(),
            vec![Target {
                user: "bob".into(),
                device: "bob-mobile".into(),
            }],
        )
        .await
        .unwrap();
    let fingerprint = fresh.preview.fingerprint;
    server
        .worker(&alice)
        .prepare_genesis(fresh, fingerprint)
        .await
        .unwrap();
    assert_eq!(alice.reopened().ready_epoch("room"), Ok(1));
    assert_eq!(book.lock().unwrap().posts, 2);
}

#[tokio::test]
async fn group_cancellation_returns_an_already_accepted_original_and_repeats_without_network_mutation()
 {
    let (alice, bob) = accounts();
    let (server, book) = server(&alice, &bob, true);
    let worker = server.worker(&alice);
    let prepared = preview(&worker).await;
    let fingerprint = prepared.preview.fingerprint;
    assert!(matches!(
        worker.prepare_genesis(prepared, fingerprint).await,
        Err(delivery::Error::Network(_))
    ));
    let accepted = worker.cancel_group("room", "worker-genesis").await.unwrap();
    assert!(matches!(accepted, GroupSettlement::Accepted(_)));
    let repeated = server
        .worker(&alice)
        .cancel_group("room", "worker-genesis")
        .await
        .unwrap();
    assert!(accepted == repeated);
    assert_eq!(alice.reopened().ready_epoch("room"), Ok(1));
    let book = book.lock().unwrap();
    assert_eq!(book.posts, 1);
    assert_eq!(book.group_cancel_attempts.len(), 1);
    assert!(book.group_cancellations.is_empty());
}

#[tokio::test]
async fn substituted_group_abandonment_never_releases_the_pending_commit_or_replays_its_post() {
    let (alice, bob) = accounts();
    let (server, book) = server(&alice, &bob, false);
    book.lock().unwrap().group_drop_before = true;
    let worker = server.worker(&alice);
    let prepared = preview(&worker).await;
    let fingerprint = prepared.preview.fingerprint;
    assert!(worker.prepare_genesis(prepared, fingerprint).await.is_err());
    book.lock().unwrap().group_cancel_wrong_ack = true;
    assert!(matches!(
        worker.cancel_group("room", "worker-genesis").await,
        Err(delivery::Error::Group(Error::Receipt))
    ));
    assert!(alice.reopened().pending_lookup("room").unwrap().cancelling);
    assert!(
        alice
            .reopened()
            .group_settlement("worker-genesis")
            .unwrap()
            .is_none()
    );
    book.lock().unwrap().group_cancel_wrong_ack = false;
    assert!(matches!(
        server.worker(&alice).resume_group("room").await,
        Err(delivery::Error::Group(Error::GroupCancelled))
    ));
    let book = book.lock().unwrap();
    assert_eq!(book.posts, 1);
    assert_eq!(book.group_cancel_attempts.len(), 2);
    assert_eq!(book.group_cancel_attempts[0], book.group_cancel_attempts[1]);
}

#[tokio::test]
async fn lost_http_ack_is_reconciled_after_worker_recreation_without_new_post_or_new_commit() {
    let (alice, bob) = accounts();
    let (server, book) = server(&alice, &bob, true);
    let worker = server.worker(&alice);
    let empty = worker.local_group_status("room").await.unwrap();
    assert!(empty.accepted.is_none() && empty.pending.is_none() && empty.participants.is_empty());
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
    let pending = worker.local_group_status("room").await.unwrap();
    assert!(pending.accepted.is_none() && pending.participants.is_empty());
    let pending = pending.pending.unwrap();
    assert_eq!(pending.operation, original.operation);
    assert_eq!(pending.fingerprint, receipt(&original).fingerprint);
    assert_eq!(book.lock().unwrap().posts, 1);
    worker.stop();
    let reopened = server.worker(&alice);
    let accepted = reopened.resume_group("room").await.unwrap();
    assert_eq!(accepted.fingerprint, receipt(&original).fingerprint);
    assert_eq!(book.lock().unwrap().posts, 1);
    assert_eq!(alice.reopened().ready_epoch("room"), Ok(1));
    let current = reopened.local_group_status("room").await.unwrap();
    assert!(current.pending.is_none());
    assert!(current.accepted.as_ref() == Some(&accepted));
    assert_eq!(current.participants.len(), 2);
    assert!(
        current
            .participants
            .iter()
            .any(|p| p.device == alice.manager.scope().device)
    );
    assert!(
        current
            .participants
            .iter()
            .any(|p| p.device == bob.manager.scope().device)
    );
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
async fn voice_keys_match_at_the_head_and_a_device_behind_it_has_none() {
    let (alice, bob) = accounts();
    let (server, _book) = server(&alice, &bob, false);
    let (author, peer) = joined_workers(&server, &alice, &bob).await;
    let (epoch, key) = author.voice_key("room").await.unwrap().unwrap();
    assert_eq!(
        peer.voice_key("room").await.unwrap().unwrap(),
        (epoch, key.clone())
    );
    // The author rotates: the peer is behind the head until it accepts the commit.
    let prepared = author
        .preview_change("room", "voice-rotation".into(), vec![], vec![])
        .await
        .unwrap();
    let fingerprint = prepared.preview.fingerprint;
    author.prepare_change(prepared, fingerprint).await.unwrap();
    let (next, rotated) = author.voice_key("room").await.unwrap().unwrap();
    assert!(next > epoch && rotated != key);
    assert!(peer.voice_key("room").await.unwrap().is_none());
    let batch = peer.events("room").await.unwrap();
    let prepared = peer
        .preview_event(batch.page.events[0].clone())
        .await
        .unwrap();
    let fingerprint = prepared.preview.fingerprint;
    peer.accept_event(prepared, fingerprint).await.unwrap();
    assert_eq!(
        peer.voice_key("room").await.unwrap().unwrap(),
        (next, rotated)
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
                    icon_revision: None,
                }),
                "/api/v1/me" => json(&rv_protocol::User {
                    id: if field == 1 {
                        "other".into()
                    } else {
                        "alice".into()
                    },
                    username: "alice".into(),
                    display_name: "alice".into(),
                    ..Default::default()
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
