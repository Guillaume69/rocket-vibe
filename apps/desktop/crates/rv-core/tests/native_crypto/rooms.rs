//! Real registered installation, MLS transitions, HTTP and SQLite. The server
//! fixture checks the signed plan; UI metadata never substitutes for consent.
use super::*;
use crypto::enrollment::rooms::{Phase, ReviewKind, Target};
use rv_crypto_public::groups::Transition;

struct Book {
    scope: rv_protocol::e2ee::Scope,
    user: String,
    owner: bool,
    include_peer: bool,
    head: Option<rv_protocol::e2ee::GroupReceipt>,
    submission: Option<rv_protocol::e2ee::GroupSubmission>,
    receipts: BTreeMap<String, rv_protocol::e2ee::GroupReceipt>,
    posts: usize,
    lose_reply: bool,
    message_submissions: BTreeMap<String, rv_protocol::e2ee::ApplicationSubmission>,
    message_receipts: BTreeMap<String, rv_protocol::e2ee::ApplicationReceipt>,
    message_posts: usize,
    lose_message_reply: bool,
}
impl Book {
    fn reply(&mut self, request: &common::Request) -> Option<common::Response> {
        let json_response = |value: Value| respond(200, &value.to_string());
        let missing = || respond(404, r#"{"code":"not_found","request_id":"group-controls"}"#);
        Some(match request.path() {
            "/api/v1/rooms/room" => json_response(json!({
                "room": room(), "revision":"1", "topic":"", "description":"", "announcement":"",
                "read_only":false, "member_count": if self.include_peer {2} else {1},
                "permissions":{"room_id":"room", "revision":"1", "role":if self.owner {"owner"} else {"member"},
                    "read":true, "send":true, "invite":self.owner, "remove_member":self.owner,
                    "change_settings":self.owner, "pin":true, "upload":true, "start_call":true}
            })),
            "/api/v1/rooms/room/members" => {
                let mut members = vec![json!({"user":{"id":self.user,"username":"alice","display_name":"Alice"},
                    "role":if self.owner {"owner"} else {"member"},"disabled":false})];
                if self.include_peer {
                    members.push(json!({"user":{"id":"bob-id","username":"bob","display_name":"Bob"},
                        "role":"member","disabled":false}));
                }
                json_response(json!({"room_id":"room","revision":"1","members":members,"next":null}))
            }
            "/api/v1/e2ee/rooms/room/roster" => {
                let mut members = vec![json!({"user_id":self.user,"access_version":"1","activation_version":"1"})];
                if self.include_peer {
                    members.push(json!({"user_id":"bob-id","access_version":"1","activation_version":"1"}));
                }
                json_response(
                    json!({"scope":self.scope,"room_id":"room","authority_version":"1", "members":members,"group":self.head}),
                )
            }
            "/api/v1/e2ee/rooms/room/transitions" => {
                assert_eq!(request.method, "POST");
                let input: rv_protocol::e2ee::GroupSubmission = serde_json::from_str(&request.body).unwrap();
                let signed = Transition::from_bytes(&B64.decode(&input.transition).unwrap()).unwrap();
                signed.verify(SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs()).unwrap();
                assert_eq!(signed.plan.operation, input.operation_id);
                assert_eq!(signed.plan.scope.room, "room");
                assert_eq!(signed.plan.scope.instance, self.scope.instance_id);
                assert_eq!(signed.plan.scope.data_epoch, self.scope.data_epoch);
                assert_eq!(signed.plan.authority_version, "1");
                assert_eq!(
                    signed.plan.expected_revision,
                    self.head.as_ref().map_or(0, |r| r.revision.parse().unwrap())
                );
                assert_eq!(signed.plan.members[0].access_version, "1");
                assert_eq!(signed.plan.members[0].activation_version, "1");
                if let Some(parent) = &self.head {
                    assert_eq!(signed.plan.expected_epoch, Some(parent.epoch.parse().unwrap()));
                    let fingerprint = signed.plan.previous.iter().map(|b| format!("{b:02x}")).collect::<String>();
                    assert_eq!(fingerprint, parent.fingerprint);
                }
                let receipt = rv_crypto::groups::Receipt {
                    scope: signed.plan.scope.clone(),
                    operation: input.operation_id.clone(),
                    revision: signed.plan.expected_revision + 1,
                    epoch: signed.plan.epoch,
                    fingerprint: signed.fingerprint().unwrap(),
                }
                .to_wire()
                .unwrap();
                self.posts += 1;
                self.receipts.insert(input.operation_id.clone(), receipt.clone());
                self.head = Some(receipt.clone());
                self.submission = Some(input);
                if self.lose_reply {
                    respond(503, r#"{"code":"response_lost","request_id":"group-controls"}"#)
                } else {
                    json_response(serde_json::to_value(receipt).unwrap())
                }
            }
            "/api/v1/e2ee/rooms/room/state" => match (&self.head, &self.submission) {
                (Some(receipt), Some(input)) => json_response(json!({"receipt":receipt,"needs_rekey":false,
                    "transition":input.transition,"tree":input.tree})),
                _ => missing(),
            },
            "/api/v1/e2ee/rooms/room/events" => json_response(json!({"events":[],"next":null})),
            "/api/v1/e2ee/rooms/room/messages" => {
                assert_eq!(request.method, "POST");
                let input: rv_protocol::e2ee::ApplicationSubmission = serde_json::from_str(&request.body).unwrap();
                let submission = rv_crypto::groups::MessageSubmission::from_wire(&input).unwrap();
                let proof =
                    submission.verified(SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs()).unwrap();
                assert_eq!(proof.header.author, self.user);
                assert_eq!(proof.header.scope.room, "room");
                assert_eq!(proof.header.operation, input.operation_id);
                assert!(!request.body.contains("private-message-cleartext"));
                let receipt = rv_crypto::groups::wire::message_receipt_to_wire(&rv_crypto_public::messages::Receipt {
                    header: proof.header.clone(),
                    fingerprint: proof.fingerprint().unwrap(),
                    message: format!("private-message-{}", self.message_receipts.len() + 1),
                    position: 9007199254740993 + self.message_receipts.len() as u64,
                })
                .unwrap();
                assert!(!self.message_receipts.contains_key(&input.operation_id));
                self.message_posts += 1;
                self.message_receipts.insert(input.operation_id.clone(), receipt.clone());
                self.message_submissions.insert(input.operation_id.clone(), input);
                if self.lose_message_reply {
                    self.lose_message_reply = false;
                    respond(503, r#"{"code":"response_lost","request_id":"private-compose"}"#)
                } else {
                    json_response(serde_json::to_value(receipt).unwrap())
                }
            }
            "/api/v1/e2ee/rooms/room/delivery" => {
                let query = url::form_urlencoded::parse(request.target.split('?').nth(1).unwrap().as_bytes())
                    .into_owned()
                    .collect::<BTreeMap<_, _>>();
                let after = query.get("after").unwrap().parse::<u64>().unwrap();
                let through = query.get("through").map(|s| s.parse::<u64>().unwrap()).unwrap_or_else(|| {
                    self.message_receipts.values().map(|r| r.position.parse::<u64>().unwrap()).max().unwrap_or(1)
                });
                let head = self.head.as_ref().unwrap();
                let original = self.submission.as_ref().unwrap();
                let mut events = vec![];
                if after == 0 {
                    events.push(rv_protocol::e2ee::DeliveryEvent {
                        position: "1".into(),
                        content: rv_protocol::e2ee::DeliveryContent::Group(rv_protocol::e2ee::GroupEvent {
                            receipt: head.clone(),
                            transition: original.transition.clone(),
                            commit: original.commit.clone(),
                            welcome: None,
                        }),
                    });
                }
                for (operation, receipt) in &self.message_receipts {
                    let position = receipt.position.parse::<u64>().unwrap();
                    if after < position && position <= through {
                        let input = &self.message_submissions[operation];
                        events.push(rv_protocol::e2ee::DeliveryEvent {
                            position: receipt.position.clone(),
                            content: rv_protocol::e2ee::DeliveryContent::Message(
                                rv_protocol::e2ee::ApplicationMessage {
                                    receipt: receipt.clone(),
                                    proof: input.proof.clone(),
                                    ciphertext: input.ciphertext.clone(),
                                },
                            ),
                        });
                    }
                }
                events.sort_by_key(|e| e.position.parse::<u64>().unwrap());
                json_response(
                    serde_json::to_value(rv_protocol::e2ee::DeliveryPage {
                        scope: self.scope.clone(),
                        room_id: "room".into(),
                        incarnation: head.incarnation.clone(),
                        after: after.to_string(),
                        through: through.to_string(),
                        events,
                        next: None,
                    })
                    .unwrap(),
                )
            }
            path if path.starts_with("/api/v1/e2ee/rooms/room/message-operations/") => {
                assert_eq!(request.method, "GET");
                match self.message_receipts.get(path.rsplit('/').next().unwrap()) {
                    Some(receipt) => json_response(serde_json::to_value(receipt).unwrap()),
                    None => missing(),
                }
            }
            path if path.starts_with("/api/v1/e2ee/rooms/room/operations/") => {
                let operation = path.rsplit('/').next().unwrap();
                match self.receipts.get(operation) {
                    Some(receipt) => json_response(serde_json::to_value(receipt).unwrap()),
                    None => missing(),
                }
            }
            _ => return None,
        })
    }
}
fn room() -> rv_protocol::Room {
    rv_protocol::Room {
        id: "room".into(),
        name: "Existing room".into(),
        kind: rv_protocol::RoomKind::Public,
        revision: "1".into(),
        read_state: None,
        encrypted: false,
    }
}
fn snapshot(pilot: &Pilot, present: bool) {
    pilot
        .session
        .store
        .snapshot(&rv_protocol::Snapshot {
            protocol_version: 1,
            rooms: if present { vec![room()] } else { vec![] },
            messages: vec![],
            cursor: "initial".into(),
        })
        .unwrap();
}
async fn setup(include_peer: bool) -> (Pilot, crypto::enrollment::Access, Arc<Mutex<Book>>) {
    let pilot = Pilot::new(true).await;
    snapshot(&pilot, true);
    let identity = pilot.session.info.native.as_ref().unwrap();
    let book = Arc::new(Mutex::new(Book {
        scope: rv_protocol::e2ee::Scope {
            instance_id: identity.instance_id.clone(),
            data_epoch: identity.data_epoch.clone(),
        },
        user: pilot.session.info.user_id.clone(),
        owner: true,
        include_peer,
        head: None,
        submission: None,
        receipts: BTreeMap::new(),
        posts: 0,
        lose_reply: false,
        message_submissions: BTreeMap::new(),
        message_receipts: BTreeMap::new(),
        message_posts: 0,
        lose_message_reply: false,
    }));
    let remote = book.clone();
    *pilot.room_handler.lock().unwrap() = Some(Arc::new(move |request| remote.lock().unwrap().reply(request)));
    if include_peer {
        pilot.peer_directories.lock().unwrap().insert("bob-id".into(), Peer::new("bob-id").directory);
    }
    let settings = ready(&pilot).await;
    (pilot, settings, book)
}
async fn reopen(pilot: &Pilot) -> crypto::enrollment::rooms::Access {
    pilot
        .session
        .crypto_settings(Guard::new(), pilot.directory.path().join("ceremony"), pilot.memory.clone())
        .await
        .unwrap()
        .room("room".into())
        .await
        .unwrap()
}

#[tokio::test]
async fn room_review_requires_explicit_current_consent_and_never_approves_a_peer() {
    let (pilot, settings, book) = setup(true).await;
    let writes = pilot.memory.writes.load(Ordering::SeqCst);
    let access = settings.room("room".into()).await.unwrap();
    let view = access.refresh().await.unwrap();
    assert!(view.phase == Phase::Empty && view.can_create && view.review.is_none());
    assert!(view.participants.is_empty());
    assert!(view.devices.iter().any(|d| d.own && !d.eligible));
    assert!(view.devices.iter().any(|d| d.user == "bob-id" && !d.eligible));
    assert_eq!(pilot.memory.writes.load(Ordering::SeqCst), writes);
    assert!(pilot.publications.lock().unwrap().is_empty());
    assert!(
        access
            .preview_create(view.revision, vec![Target { user: "bob-id".into(), device: "peer-device".into() }])
            .await
            .is_err()
    );
    let view = access.refresh().await.unwrap();
    // The signed plan must represent every room member. An unapproved member
    // cannot silently be omitted to make creation appear successful.
    assert!(access.preview_create(view.revision, vec![]).await.is_err());
    assert_eq!(pilot.memory.writes.load(Ordering::SeqCst), writes);
    book.lock().unwrap().include_peer = false;
    let view = access.refresh().await.unwrap();
    let preview = access.preview_create(view.revision, vec![]).await.unwrap();
    let review = preview.review.as_ref().unwrap();
    assert!(review.kind == ReviewKind::Create);
    assert_eq!(review.recipients.len(), 1);
    assert_eq!(review.recipients[0].name, "Alice");
    assert_eq!(review.recipients[0].device, "current");
    assert_eq!(pilot.memory.writes.load(Ordering::SeqCst), writes);
    assert_eq!(book.lock().unwrap().posts, 0);
    assert!(access.confirm(view.revision, review.fingerprint.clone()).await.is_err());
    assert!(access.confirm(preview.revision, "aa".repeat(32)).await.is_err());
    assert_eq!(book.lock().unwrap().posts, 0);
    let view = access.refresh().await.unwrap();
    let preview = access.preview_create(view.revision, vec![]).await.unwrap();
    let accepted = access.confirm(preview.revision, preview.review.unwrap().fingerprint).await.unwrap();
    assert!(accepted.phase == Phase::Acknowledged && accepted.review.is_none());
    assert_eq!(accepted.epoch, "0");
    assert_eq!(accepted.participants.len(), 1);
    assert_eq!(accepted.fingerprint, book.lock().unwrap().head.as_ref().unwrap().fingerprint);
    assert_eq!(book.lock().unwrap().posts, 1);
    let peer = settings.peer("bob-id".into()).await.unwrap();
    assert!(peer.trust == crypto::enrollment::peers::Trust::Unknown && !peer.devices[0].approved);
    let preview = access.preview_change(accepted.revision, vec![], vec![]).await.unwrap();
    assert!(preview.review.as_ref().unwrap().kind == ReviewKind::Change);
    assert_eq!(book.lock().unwrap().posts, 1);
    let rotated = access.confirm(preview.revision, preview.review.unwrap().fingerprint).await.unwrap();
    assert_eq!(rotated.epoch, "1");
    assert_eq!(rotated.participants.len(), 1);
    assert_eq!(book.lock().unwrap().posts, 2);
    assert!(pilot.publications.lock().unwrap().is_empty());
}

#[tokio::test]
async fn room_reopen_recovers_a_lost_reply_from_the_original_receipt_without_another_post() {
    let (pilot, settings, book) = setup(false).await;
    book.lock().unwrap().lose_reply = true;
    let access = settings.room("room".into()).await.unwrap();
    let view = access.refresh().await.unwrap();
    let preview = access.preview_create(view.revision, vec![]).await.unwrap();
    assert!(access.confirm(preview.revision, preview.review.unwrap().fingerprint).await.is_err());
    assert_eq!(book.lock().unwrap().posts, 1);
    let pending = access.refresh().await.unwrap();
    assert!(pending.phase == Phase::Pending && pending.fingerprint.is_empty());
    assert!(!pending.pending_operation.is_empty() && pending.participants.is_empty());
    let original = book.lock().unwrap().head.clone().unwrap();
    assert_eq!(pending.pending_operation, original.operation_id);
    access.close();
    let reopened = reopen(&pilot).await;
    let pending = reopened.refresh().await.unwrap();
    assert!(pending.phase == Phase::Pending);
    let accepted = reopened.resume(pending.revision).await.unwrap();
    assert!(accepted.phase == Phase::Acknowledged && accepted.pending_operation.is_empty());
    assert_eq!(accepted.fingerprint, original.fingerprint);
    assert_eq!(accepted.epoch, original.epoch);
    assert_eq!(accepted.participants.len(), 1);
    assert_eq!(book.lock().unwrap().posts, 1);
    assert!(access.refresh().await.is_err());
}

#[tokio::test]
async fn room_removal_fences_an_existing_preview_even_after_rejoining() {
    let (pilot, settings, book) = setup(false).await;
    book.lock().unwrap().owner = false;
    let access = settings.room("room".into()).await.unwrap();
    let view = access.refresh().await.unwrap();
    assert!(!view.can_create);
    assert!(access.preview_create(view.revision, vec![]).await.is_err());
    book.lock().unwrap().owner = true;
    let view = access.refresh().await.unwrap();
    let preview = access.preview_create(view.revision, vec![]).await.unwrap();
    let writes = pilot.memory.writes.load(Ordering::SeqCst);
    snapshot(&pilot, false);
    assert!(access.confirm(preview.revision, preview.review.unwrap().fingerprint).await.is_err());
    snapshot(&pilot, true);
    assert!(access.refresh().await.is_err());
    assert_eq!(book.lock().unwrap().posts, 0);
    assert_eq!(pilot.memory.writes.load(Ordering::SeqCst), writes);
    let fresh = reopen(&pilot).await;
    assert!(fresh.refresh().await.unwrap().phase == Phase::Empty);
}

async fn message_settings(pilot: &Pilot) -> crypto::enrollment::Access {
    pilot
        .session
        .crypto_settings(Guard::new(), pilot.directory.path().join("ceremony"), pilot.memory.clone())
        .await
        .unwrap()
}

#[tokio::test]
async fn private_conversation_recovers_lost_send_reopens_drafts_and_never_projects_into_sql() {
    use crypto::enrollment::rooms::messages::Delivery;
    let (pilot, settings, book) = setup(false).await;
    assert!(settings.messages("room".into(), None).await.is_err());
    let group = settings.room("room".into()).await.unwrap();
    let view = group.refresh().await.unwrap();
    let preview = group.preview_create(view.revision, vec![]).await.unwrap();
    group.confirm(preview.revision, preview.review.unwrap().fingerprint).await.unwrap();
    group.close();
    let mut encrypted = room();
    encrypted.encrypted = true;
    pilot
        .session
        .store
        .snapshot(&rv_protocol::Snapshot {
            protocol_version: 1,
            rooms: vec![encrypted],
            messages: vec![],
            cursor: "encrypted".into(),
        })
        .unwrap();
    let chat = message_settings(&pilot).await.messages("room".into(), None).await.unwrap();
    let view = chat.refresh(None, 50).await.unwrap();
    assert!(view.can_send && !view.catching_up && view.messages.is_empty());
    chat.set_draft("private-message-cleartext **rich** 🐾".into()).await.unwrap();
    assert_eq!(chat.draft().await.unwrap(), "private-message-cleartext **rich** 🐾");
    let before = pilot.server.requests().len();
    chat.set_draft("private-message-cleartext **changed** 🐾".into()).await.unwrap();
    assert_eq!(pilot.server.requests().len(), before, "local draft saves must work without HTTP");
    let document = rv_protocol::SendMessage {
        operation_id: "private-send-one".into(),
        text: "private-message-cleartext **changed** 🐾".into(),
        reply_to: None,
        quotes: vec![],
        cards: vec![],
    };
    book.lock().unwrap().lose_message_reply = true;
    assert!(chat.send(document.clone()).await.is_err());
    assert_eq!(book.lock().unwrap().message_posts, 1);
    assert!(
        chat.send(rv_protocol::SendMessage { operation_id: "private-would-duplicate".into(), ..document })
            .await
            .is_err()
    );
    assert_eq!(book.lock().unwrap().message_posts, 1);
    assert_eq!(chat.draft().await.unwrap(), "private-message-cleartext **changed** 🐾");
    chat.close();
    let reopened = message_settings(&pilot).await.messages("room".into(), None).await.unwrap();
    // Querying older retained rows establishes the actor without consuming the
    // lost-ACK message; it must still expose the original protected intent.
    let pending = reopened.refresh(Some("9007199254740993".into()), 50).await.unwrap();
    assert!(pending.messages.is_empty());
    assert_eq!(pending.draft, "private-message-cleartext **changed** 🐾");
    reopened.resume("private-send-one".into()).await.unwrap();
    assert_eq!(book.lock().unwrap().message_posts, 1);
    assert!(reopened.draft().await.unwrap().is_empty());
    let view = reopened.refresh(None, 50).await.unwrap();
    assert_eq!(view.messages.len(), 1);
    assert!(view.messages[0].delivery == Delivery::Journaled);
    assert_eq!(view.messages[0].position.as_deref(), Some("9007199254740993"));
    assert_eq!(view.messages[0].row.id, "private-message-1");
    assert_eq!(view.messages[0].row.text.as_deref(), Some("private-message-cleartext **changed** 🐾"));
    assert!(view.messages[0].row.md.as_ref().unwrap().contains("BOLD"));
    assert!(view.messages[0].row.outbox_status.is_none());
    assert_eq!(view.after, "9007199254740993");
    let older = reopened.refresh(Some("9007199254740993".into()), 50).await.unwrap();
    assert!(older.messages.is_empty());
    assert!(reopened.refresh(Some("09007199254740993".into()), 50).await.is_err());
    assert!(reopened.refresh(None, 201).await.is_err());
    let dialog = message_settings(&pilot).await.room("room".into()).await.unwrap();
    dialog.refresh().await.unwrap();
    dialog.close();
    assert_eq!(reopened.refresh(None, 50).await.unwrap().messages.len(), 1);
    let unavailable = message_settings(&pilot).await.messages("room".into(), Some("unseen-root".into())).await.unwrap();
    assert!(!unavailable.refresh(None, 50).await.unwrap().can_send);
    assert!(
        unavailable
            .send(rv_protocol::SendMessage {
                operation_id: "invalid-private-thread".into(),
                text: "private-message-cleartext wrong thread".into(),
                reply_to: Some("unseen-root".into()),
                quotes: vec![],
                cards: vec![]
            })
            .await
            .is_err()
    );
    assert_eq!(book.lock().unwrap().message_posts, 1);
    unavailable.close();
    let thread =
        message_settings(&pilot).await.messages("room".into(), Some("private-message-1".into())).await.unwrap();
    let view = thread.refresh(None, 50).await.unwrap();
    assert!(view.can_send && view.messages.len() == 1 && view.messages[0].row.thread_id.is_none());
    reopened.set_draft("private-message-cleartext room draft".into()).await.unwrap();
    thread.set_draft("private-message-cleartext thread draft".into()).await.unwrap();
    assert_eq!(reopened.draft().await.unwrap(), "private-message-cleartext room draft");
    book.lock().unwrap().lose_message_reply = true;
    assert!(
        thread
            .send(rv_protocol::SendMessage {
                operation_id: "private-thread-one".into(),
                text: "private-message-cleartext thread draft".into(),
                reply_to: Some("private-message-1".into()),
                quotes: vec![],
                cards: vec![]
            })
            .await
            .is_err()
    );
    assert_eq!(book.lock().unwrap().message_posts, 2);
    thread.close();
    let thread =
        message_settings(&pilot).await.messages("room".into(), Some("private-message-1".into())).await.unwrap();
    thread.refresh(Some("9007199254740995".into()), 50).await.unwrap();
    assert_eq!(thread.draft().await.unwrap(), "private-message-cleartext thread draft");
    thread.resume("private-thread-one".into()).await.unwrap();
    assert_eq!(book.lock().unwrap().message_posts, 2);
    assert!(thread.draft().await.unwrap().is_empty());
    let view = thread.refresh(None, 50).await.unwrap();
    assert!(view.can_send && view.messages.len() == 2);
    assert_eq!(view.messages[0].row.id, "private-message-1");
    assert_eq!(view.messages[0].row.thread_count, 1);
    assert_eq!(view.messages[1].row.thread_id.as_deref(), Some("private-message-1"));
    assert_eq!(reopened.refresh(None, 50).await.unwrap().messages[0].row.thread_count, 1);
    let nested =
        message_settings(&pilot).await.messages("room".into(), Some("private-message-2".into())).await.unwrap();
    let view = nested.refresh(None, 50).await.unwrap();
    assert!(!view.can_send && view.messages.is_empty());
    nested.close();
    // Ordinary native tables and every SQL sidecar remain free of the body.
    for file in std::fs::read_dir(pilot.directory.path()).unwrap().flatten() {
        if file.file_type().unwrap().is_file() {
            let bytes = std::fs::read(file.path()).unwrap();
            assert!(!bytes.windows(b"private-message-cleartext".len()).any(|w| w == b"private-message-cleartext"));
        }
    }
    snapshot(&pilot, false);
    assert!(thread.refresh(None, 50).await.is_err());
    assert!(reopened.draft().await.is_err());
    assert!(reopened.set_draft("Late private draft".into()).await.is_err());
    snapshot(&pilot, true);
    assert!(reopened.refresh(None, 50).await.is_err());
    assert_eq!(book.lock().unwrap().message_posts, 2);
}
