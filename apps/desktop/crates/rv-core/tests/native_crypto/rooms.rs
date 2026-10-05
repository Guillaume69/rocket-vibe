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
    delivery: Vec<rv_protocol::e2ee::DeliveryEvent>,
    receipts: BTreeMap<String, rv_protocol::e2ee::GroupReceipt>,
    posts: usize,
    lose_reply: bool,
    message_submissions: BTreeMap<String, rv_protocol::e2ee::ApplicationSubmission>,
    message_receipts: BTreeMap<String, rv_protocol::e2ee::ApplicationReceipt>,
    message_posts: usize,
    lose_message_reply: bool,
    /// Fail the next message POST before the server records it.
    drop_message: bool,
    available: Option<rv_protocol::e2ee::AvailableKeyPackage>,
    package_gets: usize,
    /// Encrypted objects by upload id: the reservation, then the opaque bytes.
    uploads: BTreeMap<String, (rv_protocol::parity::PrepareUpload, Option<Vec<u8>>)>,
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
                self.delivery.push(rv_protocol::e2ee::DeliveryEvent {
                    position: (self.delivery.last().map_or(0, |e| e.position.parse::<u64>().unwrap()) + 1).to_string(),
                    content: rv_protocol::e2ee::DeliveryContent::Group(rv_protocol::e2ee::GroupEvent {
                        receipt: receipt.clone(),
                        transition: input.transition.clone(),
                        commit: input.commit.clone(),
                        welcome: None,
                    }),
                });
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
            "/api/v1/e2ee/rooms/room/key-packages/bob-id/peer-device" => {
                self.package_gets += 1;
                match &self.available {
                    Some(package) => json_response(serde_json::to_value(package).unwrap()),
                    None => missing(),
                }
            }
            "/api/v1/e2ee/rooms/room/messages" if self.drop_message => {
                self.drop_message = false;
                respond(503, r#"{"code":"unavailable","request_id":"private-compose"}"#)
            }
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
                // Encrypted files are the sender's ready objects (E2EE_FILES.md).
                for file in &proof.header.files {
                    assert!(self.uploads.get(file).is_some_and(|(_, bytes)| bytes.is_some()));
                }
                let receipt = rv_crypto::groups::wire::message_receipt_to_wire(&rv_crypto_public::messages::Receipt {
                    header: proof.header.clone(),
                    fingerprint: proof.fingerprint().unwrap(),
                    message: format!("private-message-{}", self.message_receipts.len() + 1),
                    position: (self.delivery.last().map_or(0, |e| e.position.parse::<u64>().unwrap()) + 1)
                        .max(9007199254740993),
                })
                .unwrap();
                assert!(!self.message_receipts.contains_key(&input.operation_id));
                self.message_posts += 1;
                self.message_receipts.insert(input.operation_id.clone(), receipt.clone());
                self.delivery.push(rv_protocol::e2ee::DeliveryEvent {
                    position: receipt.position.clone(),
                    content: rv_protocol::e2ee::DeliveryContent::Message(rv_protocol::e2ee::ApplicationMessage {
                        receipt: receipt.clone(),
                        proof: input.proof.clone(),
                        ciphertext: input.ciphertext.clone(),
                    }),
                });
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
                let through = query
                    .get("through")
                    .map(|s| s.parse::<u64>().unwrap())
                    .unwrap_or_else(|| self.delivery.last().unwrap().position.parse::<u64>().unwrap());
                let head = self.head.as_ref().unwrap();
                let events = self
                    .delivery
                    .iter()
                    .filter(|e| {
                        let position = e.position.parse::<u64>().unwrap();
                        after < position && position <= through
                    })
                    .cloned()
                    .collect();
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
            "/api/v1/uploads" => {
                let input: rv_protocol::parity::PrepareUpload = serde_json::from_str(&request.body).unwrap();
                assert!(input.encrypted && input.filename.is_none() && input.media_type == "application/octet-stream");
                let id = format!("upload-{}", self.uploads.len() + 1);
                let upload = upload(&id, &input, "prepared");
                self.uploads.insert(id, (input, None));
                json_response(upload)
            }
            path if path.starts_with("/api/v1/uploads/") && path.ends_with("/bytes") => {
                let id = path.trim_start_matches("/api/v1/uploads/").trim_end_matches("/bytes").to_owned();
                let (input, bytes) = self.uploads.get_mut(&id).unwrap();
                assert_eq!(request.raw.len().to_string(), input.bytes);
                assert_eq!(hex(&<sha2::Sha256 as sha2::Digest>::digest(&request.raw)), input.sha256);
                assert!(!request.raw.windows(9).any(|w| w == b"cleartext"), "the object is opaque");
                *bytes = Some(request.raw.clone());
                json_response(upload(&id, input, "ready"))
            }
            path if path.starts_with("/api/v1/files/") => {
                let id = path.trim_start_matches("/api/v1/files/");
                let Some((_, Some(bytes))) = self.uploads.get(id) else { return Some(missing()) };
                if request.headers.get("range").map(String::as_str) == Some("bytes=0-0") {
                    return Some(common::Response {
                        status: 206,
                        binary: Some(bytes[..1].to_vec()),
                        headers: vec![
                            ("content-type".into(), "application/octet-stream".into()),
                            ("content-range".into(), format!("bytes 0-0/{}", bytes.len())),
                        ],
                        ..Default::default()
                    });
                }
                common::Response {
                    status: 200,
                    binary: Some(bytes.clone()),
                    headers: vec![("content-type".into(), "application/octet-stream".into())],
                    ..Default::default()
                }
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
fn upload(id: &str, input: &rv_protocol::parity::PrepareUpload, state: &str) -> Value {
    json!({"id":id,"file":{"id":id,"room_id":input.room_id,"bytes":input.bytes,"sha256":input.sha256,
        "media_type":input.media_type,"filename":null,"encrypted":true},"state":state,
        "expires_at":"2099-01-01T00:00:00Z","message_id":null})
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
        delivery: vec![],
        receipts: BTreeMap::new(),
        posts: 0,
        lose_reply: false,
        message_submissions: BTreeMap::new(),
        message_receipts: BTreeMap::new(),
        message_posts: 0,
        lose_message_reply: false,
        drop_message: false,
        available: None,
        package_gets: 0,
        uploads: BTreeMap::new(),
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

#[tokio::test]
async fn renewed_peer_becomes_replaceable_and_requires_explicit_removal_before_fresh_package_fetch() {
    let (pilot, settings, book) = setup(true).await;
    let mut peer = Peer::new("bob-id");
    pilot.peer_directories.lock().unwrap().insert("bob-id".into(), peer.directory.clone());
    let directory = tempfile::tempdir().unwrap();
    let manager = Arc::new(
        Manager::new(
            directory.path().join("peer"),
            Scope {
                instance: "fixture-instance".into(),
                data_epoch: "fixture-epoch".into(),
                user: "bob-id".into(),
                device: "peer-device".into(),
                incarnation: hex(&peer.certificate.device.incarnation),
            },
            Arc::new(Memory::default()),
        )
        .unwrap(),
    );
    manager.initialize().unwrap();
    manager
        .transact(|_, records| {
            *records = std::mem::take(&mut peer.records);
            Ok(())
        })
        .unwrap();
    // The test HTTP peer acknowledges the actual protected package outbox.
    // No package bytes, certificate or reference are synthesized here.
    let package = |revision: &str| {
        let at = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs();
        let coordinator = packages::Coordinator::new(manager.clone(), peer.issuer.root().clone()).unwrap();
        let request = coordinator.prepare(revision, 1, at).unwrap();
        let expected: rv_protocol::e2ee::OperationReceipt = manager
            .inspect(|_, records| {
                let state: Value = serde_json::from_slice(&records["crypto-packages-v1"]).unwrap();
                Ok(serde_json::from_value(state["pending"]["expected"].clone()).unwrap())
            })
            .unwrap();
        coordinator.confirm(&expected, at).unwrap();
        rv_protocol::e2ee::AvailableKeyPackage {
            scope: request.scope,
            user_id: "bob-id".into(),
            device_id: "peer-device".into(),
            incarnation: manager.scope().incarnation.clone(),
            reference: expected.key_package_refs[0].clone(),
            wire: request.packages[0].clone(),
        }
    };
    book.lock().unwrap().available = Some(package("1"));
    approve_peer(&settings, "bob-id").await;
    let access = settings.room("room".into()).await.unwrap();
    let view = access.refresh().await.unwrap();
    let target = || vec![Target { user: "bob-id".into(), device: "peer-device".into() }];
    let preview = access.preview_create(view.revision, target()).await.unwrap();
    let accepted = access.confirm(preview.revision, preview.review.unwrap().fingerprint).await.unwrap();
    assert_eq!(accepted.participants.len(), 2);
    assert!(!accepted.devices.iter().find(|d| d.user == "bob-id").unwrap().eligible);
    let old = peer.certificate.fingerprint().unwrap();
    let renewed = manager
        .transact(|_, records| {
            let mut local = LocalDevice::load(peer.issuer.root(), "peer-device", records).unwrap();
            let at = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs();
            let request = local.request(at, records).unwrap();
            let consent = peer.issuer.preview_request(&request, at, 7200, records).unwrap();
            let grant = peer.issuer.approve_request(&request, &consent, at, records).unwrap();
            local.install(&grant, at, records).unwrap();
            Ok(grant.certificate)
        })
        .unwrap();
    assert_ne!(renewed.fingerprint().unwrap(), old);
    let mut current = peer.directory.clone();
    current["devices"][0]["certificate"] = json!(B64.encode(serde_json::to_vec(&renewed).unwrap()));
    current["devices"][0]["revision"] = json!("2");
    current["devices"][0]["expires_at"] = json!(renewed.device.expires_at.to_string());
    pilot.peer_directories.lock().unwrap().insert("bob-id".into(), current);
    book.lock().unwrap().available = Some(package("2"));
    let replacement = access.refresh().await.unwrap();
    let eligible = replacement.devices.iter().find(|d| d.user == "bob-id").unwrap();
    assert!(eligible.eligible && eligible.fingerprint == hex(&renewed.fingerprint().unwrap()));
    assert_eq!(replacement.participants.iter().find(|p| p.user == "bob-id").unwrap().fingerprint, hex(&old));
    let fetches = book.lock().unwrap().package_gets;
    assert!(access.preview_change(replacement.revision, vec![], target()).await.is_err());
    assert_eq!(book.lock().unwrap().package_gets, fetches);
    let replacement = access.refresh().await.unwrap();
    let preview = access.preview_change(replacement.revision, vec!["peer-device".into()], target()).await.unwrap();
    assert_eq!(book.lock().unwrap().package_gets, fetches + 1);
    let peer_preview = preview.review.as_ref().unwrap().recipients.iter().find(|p| p.user == "bob-id").unwrap();
    assert_eq!(peer_preview.fingerprint, hex(&renewed.fingerprint().unwrap()));
    book.lock().unwrap().lose_reply = true;
    assert!(access.confirm(preview.revision, preview.review.unwrap().fingerprint).await.is_err());
    assert_eq!(book.lock().unwrap().posts, 2);
    access.close();
    let reopened = reopen(&pilot).await;
    let pending = reopened.refresh().await.unwrap();
    let installed = reopened.resume(pending.revision).await.unwrap();
    assert!(installed.phase == Phase::Acknowledged);
    assert_eq!(installed.epoch.parse::<u64>().unwrap(), accepted.epoch.parse::<u64>().unwrap() + 1);
    assert_eq!(book.lock().unwrap().posts, 2);
    assert_eq!(
        installed.participants.iter().find(|p| p.user == "bob-id").unwrap().fingerprint,
        hex(&renewed.fingerprint().unwrap())
    );
    assert!(!installed.devices.iter().find(|d| d.user == "bob-id").unwrap().eligible);
}

async fn message_settings(pilot: &Pilot) -> crypto::enrollment::Access {
    pilot
        .session
        .crypto_settings(Guard::new(), pilot.directory.path().join("ceremony"), pilot.memory.clone())
        .await
        .unwrap()
}

fn encrypted_snapshot(pilot: &Pilot) {
    let mut encrypted = room();
    encrypted.encrypted = true;
    encrypted.read_state = Some(Box::new(rv_protocol::parity::ReadState {
        room_id: "room".into(),
        revision: "1".into(),
        membership_version: Some("private-membership".into()),
        favorite_revision: Some("1".into()),
        root_position: "0".into(),
        reply_position: "0".into(),
        unread_roots: "0".into(),
        unread_replies: "0".into(),
        mentions: "0".into(),
        group_mentions: "0".into(),
        favorite: false,
    }));
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
}

#[tokio::test]
async fn renewed_device_rotates_its_actual_room_leaf_recovers_lost_ack_and_keeps_private_history() {
    let (pilot, settings, book) = setup(false).await;
    let group = message_settings(&pilot).await.room("room".into()).await.unwrap();
    let view = group.refresh().await.unwrap();
    assert!(!view.needs_credential_update);
    let review = group.preview_create(view.revision, vec![]).await.unwrap();
    let accepted = group.confirm(review.revision, review.review.unwrap().fingerprint).await.unwrap();
    assert!(!accepted.needs_credential_update);
    group.close();
    encrypted_snapshot(&pilot);
    let group = message_settings(&pilot).await.room("room".into()).await.unwrap();
    let accepted = group.refresh().await.unwrap();
    let chat = message_settings(&pilot).await.messages("room".into(), None).await.unwrap();
    assert!(chat.refresh(None, 50).await.unwrap().can_send);
    let message = |operation: &str, text: &str| rv_protocol::SendMessage {
        operation_id: operation.into(),
        text: text.into(),
        reply_to: None,
        quotes: vec![],
        cards: vec![],
        files: vec![],
    };
    chat.send(message("before-renewal", "private-message-cleartext before renewal")).await.unwrap();
    assert_eq!(chat.refresh(None, 50).await.unwrap().messages.len(), 1);
    chat.set_draft("private-message-cleartext retained draft".into()).await.unwrap();
    let stale = group.preview_change(accepted.revision, vec![], vec![]).await.unwrap();
    let initial = settings.refresh().await.unwrap();
    let old_directory = pilot.crypto_directory.lock().unwrap().clone();
    let old: rv_crypto::identity::Certificate =
        serde_json::from_slice(&B64.decode(old_directory["devices"][0]["certificate"].as_str().unwrap()).unwrap())
            .unwrap();
    tokio::time::timeout(Duration::from_secs(5), async {
        while SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs() <= old.device.issued_at {
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .unwrap();
    let renewing = settings.renew(initial.root_fingerprint.clone()).await.unwrap();
    let preview = settings.preview(renewing.request_code).await.unwrap();
    let grant = settings.approve(preview).await.unwrap();
    settings.install(grant).await.unwrap();
    assert!(chat.refresh(None, 50).await.is_err());
    assert!(group.confirm(stale.revision, stale.review.unwrap().fingerprint).await.is_err());
    assert_eq!(book.lock().unwrap().posts, 1);
    let current_directory = pilot.crypto_directory.lock().unwrap().clone();
    let certificate: rv_crypto::identity::Certificate =
        serde_json::from_slice(&B64.decode(current_directory["devices"][0]["certificate"].as_str().unwrap()).unwrap())
            .unwrap();
    assert_eq!(certificate.device.incarnation, old.device.incarnation);
    let renewed_chat = message_settings(&pilot).await.messages("room".into(), None).await.unwrap();
    let history = renewed_chat.refresh(None, 50).await.unwrap();
    assert!(!history.can_send && !history.catching_up);
    assert_eq!(history.messages.len(), 1);
    assert_eq!(history.messages[0].row.text.as_deref(), Some("private-message-cleartext before renewal"));
    assert_eq!(history.draft, "private-message-cleartext retained draft");
    assert!(renewed_chat.send(message("unrotated", "private-message-cleartext blocked")).await.is_err());
    assert_eq!(book.lock().unwrap().message_posts, 1);
    let current = message_settings(&pilot).await.room("room".into()).await.unwrap();
    let view = current.refresh().await.unwrap();
    assert!(view.needs_credential_update && view.phase == Phase::Acknowledged);
    let review = current.preview_change(view.revision, vec![], vec![]).await.unwrap();
    assert_eq!(review.review.as_ref().unwrap().recipients[0].fingerprint, hex(&certificate.fingerprint().unwrap()));
    book.lock().unwrap().lose_reply = true;
    assert!(current.confirm(review.revision, review.review.unwrap().fingerprint).await.is_err());
    let pending = current.refresh().await.unwrap();
    assert!(pending.phase == Phase::Pending && pending.needs_credential_update);
    assert_eq!(book.lock().unwrap().posts, 2);
    let original = book.lock().unwrap().submission.clone().unwrap();
    current.close();
    let reopened = reopen(&pilot).await;
    let pending = reopened.refresh().await.unwrap();
    let acknowledged = reopened.resume(pending.revision).await.unwrap();
    // Receipt recovery must not skip unread ciphertext in the previous epoch.
    // The accepted rotation takes effect at its ordered journal position.
    assert!(acknowledged.phase == Phase::Pending && acknowledged.needs_credential_update);
    assert_eq!(acknowledged.epoch, "0");
    assert_eq!(book.lock().unwrap().posts, 2);
    assert_eq!(book.lock().unwrap().submission.as_ref().unwrap().operation_id, original.operation_id);
    let transition = Transition::from_bytes(&B64.decode(&original.transition).unwrap()).unwrap();
    assert_eq!(transition.certificate, certificate);
    assert_eq!(transition.plan.participants[0].certificate, certificate.fingerprint().unwrap());
    let after = renewed_chat.refresh(None, 50).await.unwrap();
    assert!(after.can_send && !after.catching_up);
    let rotated = reopened.refresh().await.unwrap();
    assert!(rotated.phase == Phase::Acknowledged && !rotated.needs_credential_update);
    assert_eq!(rotated.epoch, "1");
    assert_eq!(after.messages.len(), 1);
    assert_eq!(after.draft, "private-message-cleartext retained draft");
    renewed_chat.send(message("after-renewal", "private-message-cleartext after renewal")).await.unwrap();
    let after = renewed_chat.refresh(None, 50).await.unwrap();
    assert_eq!(after.messages.len(), 2);
    assert!(after.messages.iter().any(|m| m.row.text.as_deref() == Some("private-message-cleartext before renewal")));
    assert!(after.messages.iter().any(|m| m.row.text.as_deref() == Some("private-message-cleartext after renewal")));
    let wire = book.lock().unwrap().message_submissions["after-renewal"].clone();
    let proof = rv_crypto::groups::MessageSubmission::from_wire(&wire)
        .unwrap()
        .verified(SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs())
        .unwrap();
    assert_eq!(proof.header.epoch, 1);
    assert_eq!(proof.header.certificate, certificate.fingerprint().unwrap());
    assert_eq!(book.lock().unwrap().message_posts, 2);
    assert!(pilot.session.store.messages("room", 100).unwrap().is_empty());
    renewed_chat.close();
    reopened.close();
    settings.close();
    pilot.close().await;
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
    encrypted.read_state = Some(Box::new(rv_protocol::parity::ReadState {
        room_id: "room".into(),
        revision: "1".into(),
        membership_version: Some("private-membership".into()),
        favorite_revision: Some("1".into()),
        root_position: "0".into(),
        reply_position: "0".into(),
        unread_roots: "0".into(),
        unread_replies: "0".into(),
        mentions: "0".into(),
        group_mentions: "0".into(),
        favorite: false,
    }));
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
        files: vec![],
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
                cards: vec![],
                files: vec![],
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
                cards: vec![],
                files: vec![],
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
    // A reply can be quoted from the root conversation. Only its typed reference
    // is in the encrypted document, and a lost response reuses the original.
    let selected = thread.select_quote("private-message-2".into()).await.unwrap();
    assert_eq!(selected.selection.reference.revision, "9007199254740994");
    assert_eq!(selected.text, "private-message-cleartext thread draft");
    assert!(thread.select_source_quote("unseen-room".into(), "private-message-2".into()).await.is_err());
    let mut public_room = room();
    public_room.id = "plain-origin".into();
    let mut read = pilot.session.store.read_state("room").unwrap().unwrap();
    read.room_id = public_room.id.clone();
    read.membership_version = Some("plain-membership".into());
    public_room.read_state = Some(Box::new(read));
    let fixture: Value = serde_json::from_str(include_str!("../../../../../../docs/protocol/v1.fixture.json")).unwrap();
    let mut clear_message: rv_protocol::Message = serde_json::from_value(fixture["message"].clone()).unwrap();
    clear_message.id = "plain-source".into();
    clear_message.room_id = public_room.id.clone();
    clear_message.text = "Ordinary source words".into();
    clear_message.position = "10".into();
    clear_message.revision = "10".into();
    clear_message.quotes = vec![rv_protocol::MessageQuote {
        reference: selected.selection.reference.clone(),
        excerpt: None,
        view_position: "10".into(),
        source_membership_version: Some("private-membership".into()),
    }];
    pilot
        .session
        .store
        .batch(&rv_protocol::SyncBatch {
            protocol_version: 1,
            cursor: "plain-source".into(),
            has_more: false,
            changes: vec![
                rv_protocol::Change::RoomUpsert(public_room),
                rv_protocol::Change::MessageUpsert(clear_message.clone()),
            ],
        })
        .unwrap();
    let clear_selection = reopened.select_source_quote("plain-origin".into(), "plain-source".into()).await.unwrap();
    assert!(clear_selection.selection.admission.is_none());
    assert_eq!(clear_selection.text, "Ordinary source words");
    let quoted = rv_protocol::SendMessage {
        operation_id: "private-quote-one".into(),
        text: String::new(),
        reply_to: None,
        quotes: vec![selected.selection.reference.clone(), clear_selection.selection.reference.clone()],
        cards: vec![],
        files: vec![],
    };
    assert!(reopened.send(quoted.clone()).await.is_err(), "references require a current private selection");
    for field in 0..5 {
        let mut stale = selected.selection.clone();
        match field {
            0 => stale.membership.push('x'),
            1 => stale.admission.as_mut().unwrap()[0] ^= 1,
            2 => stale.instance.push('x'),
            3 => stale.reference.revision = "9007199254740995".into(),
            _ => stale.admission = None,
        }
        let mut invalid = quoted.clone();
        invalid.quotes = vec![stale.reference.clone()];
        assert!(reopened.send_selected(invalid, vec![stale]).await.is_err());
    }
    assert_eq!(book.lock().unwrap().message_posts, 2);
    book.lock().unwrap().lose_message_reply = true;
    assert!(
        reopened
            .send_selected(quoted, vec![selected.selection.clone(), clear_selection.selection.clone()])
            .await
            .is_err()
    );
    assert_eq!(book.lock().unwrap().message_posts, 3);
    reopened.close();
    let reopened = message_settings(&pilot).await.messages("room".into(), None).await.unwrap();
    reopened.refresh(Some("9007199254740997".into()), 50).await.unwrap();
    reopened.resume("private-quote-one".into()).await.unwrap();
    assert_eq!(book.lock().unwrap().message_posts, 3, "quoted original resumes by receipt GET");
    let view = reopened.refresh(None, 50).await.unwrap();
    let quote = view.messages.iter().find(|m| m.operation == "private-quote-one").unwrap();
    assert_eq!(quote.quotes, vec![selected.selection.reference, clear_selection.selection.reference]);
    assert_eq!(quote.row.text.as_deref(), Some(""));
    let cards: serde_json::Value = serde_json::from_str(quote.row.attachments.as_ref().unwrap()).unwrap();
    assert_eq!(cards[0]["text"], "private-message-cleartext thread draft");
    assert_eq!(cards[0]["native_unavailable"], false);
    assert_eq!(cards[1]["text"], "Ordinary source words");
    assert_eq!(cards[1]["attachments"][0]["text"], "private-message-cleartext thread draft");
    // The existing ordinary SQL row has a reference-only private child. Resolve
    // it in a reader with no draft/outbox API, without changing either cache.
    let ordinary_reader = message_settings(&pilot).await.quote_reader("plain-origin".into()).await.unwrap();
    let cached = pilot.session.store.messages("plain-origin", 50).unwrap();
    let presentation = cached
        .clone()
        .into_iter()
        .map(|row| row.presentation("plain-origin", &pilot.session.info.user_id))
        .collect::<Vec<_>>();
    assert!(crypto::enrollment::rooms::messages::QuoteReader::needed(&presentation));
    assert!(!cached[0].attachments.as_deref().unwrap().contains("private-message-cleartext"));
    let posts = book.lock().unwrap().message_posts;
    let projected = ordinary_reader.project(presentation.clone()).await.unwrap();
    let private_cards: Value = serde_json::from_str(projected[0].attachments.as_ref().unwrap()).unwrap();
    assert_eq!(private_cards[0]["text"], "private-message-cleartext thread draft");
    assert_eq!(book.lock().unwrap().message_posts, posts);
    assert_eq!(pilot.session.store.messages("plain-origin", 50).unwrap(), cached);
    ordinary_reader.close();
    assert!(ordinary_reader.project(presentation).await.is_err());
    assert_eq!(pilot.session.store.messages("plain-origin", 50).unwrap(), cached);
    let ordinary_reader = message_settings(&pilot).await.quote_reader("plain-origin".into()).await.unwrap();
    let author = message_settings(&pilot).await.quote_composer("plain-origin".into(), None).await.unwrap();
    let private_source = author.select_source_quote("room".into(), "private-message-2".into()).await.unwrap();
    let unverified = native::store::QuoteSelection {
        reference: private_source.selection.reference.clone(),
        identity: native::Identity {
            instance_id: private_source.selection.instance.clone(),
            data_epoch: private_source.selection.data_epoch.clone(),
        },
        membership_version: private_source.selection.membership.clone(),
    };
    assert!(
        pilot
            .session
            .send_quotes_from_membership("plain-origin", "unverified parent", Some("plain-membership"), &[unverified])
            .is_err()
    );
    let mut stale = private_source.selection.clone();
    stale.reference.revision = "9007199254740000".into();
    pilot
        .session
        .store
        .set_draft_from_membership("plain-origin", "  Ordinary quoted parent  ", Some("plain-membership"))
        .unwrap();
    assert!(author.send("stale parent".into(), vec![stale]).await.is_err());
    assert_eq!(
        pilot.session.store.draft_from_membership("plain-origin", Some("plain-membership")).unwrap(),
        "  Ordinary quoted parent  "
    );
    let private_reference = private_source.selection.reference.clone();
    let id = author.send("  Ordinary quoted parent  ".into(), vec![private_source.selection.clone()]).await.unwrap();
    assert_eq!(pilot.session.store.draft_from_membership("plain-origin", Some("plain-membership")).unwrap(), "");
    let pending = pilot.session.store.pending().unwrap().into_iter().find(|p| p.id == id).unwrap();
    assert_eq!(pending.quotes, vec![private_reference]);
    assert_eq!(pending.text, "Ordinary quoted parent");
    assert_eq!(pending.reply_to, None);
    assert!(!serde_json::to_string(&pending.quotes).unwrap().contains("admission"));
    assert_eq!(book.lock().unwrap().message_posts, posts, "ordinary reference enqueue never publishes an MLS document");
    pilot.session.store.set_draft_from_membership("plain-origin", "Newer caption", Some("plain-membership")).unwrap();
    author.send("Older caption".into(), vec![private_source.selection]).await.unwrap();
    assert_eq!(
        pilot.session.store.draft_from_membership("plain-origin", Some("plain-membership")).unwrap(),
        "Newer caption"
    );
    author.close();
    assert!(author.send("closed parent".into(), vec![]).await.is_err());
    assert!(
        message_settings(&pilot).await.quote_composer("room".into(), None).await.is_err(),
        "no ordinary composer in an encrypted destination"
    );
    clear_message.text = "Updated ordinary source words".into();
    clear_message.revision = "11".into();
    clear_message.position = "11".into();
    pilot.session.store.ingest(&[clear_message]).unwrap();
    let refreshed = reopened.refresh(None, 50).await.unwrap();
    let row = refreshed.messages.iter().find(|m| m.operation == "private-quote-one").unwrap();
    let cards: Value = serde_json::from_str(row.row.attachments.as_ref().unwrap()).unwrap();
    assert_eq!(cards[1]["text"], "Updated ordinary source words");
    pilot
        .session
        .store
        .batch(&rv_protocol::SyncBatch {
            protocol_version: 1,
            cursor: "plain-withdrawn".into(),
            has_more: false,
            changes: vec![rv_protocol::Change::RoomRemoved { room_id: "plain-origin".into() }],
        })
        .unwrap();
    assert!(reopened.refresh(None, 50).await.is_err(), "a source withdrawal invalidates the old public projection");
    assert!(ordinary_reader.check().is_err(), "the ordinary destination reader closes with its membership");
    let reopened = message_settings(&pilot).await.messages("room".into(), None).await.unwrap();
    let refreshed = reopened.refresh(None, 50).await.unwrap();
    let row = refreshed.messages.iter().find(|m| m.operation == "private-quote-one").unwrap();
    let cards: Value = serde_json::from_str(row.row.attachments.as_ref().unwrap()).unwrap();
    assert_eq!(cards[1]["native_unavailable"], true);
    assert!(cards[1].get("attachments").is_none());
    let selected = reopened.select_quote("private-message-3".into()).await.unwrap();
    assert!(selected.text.is_empty(), "quote-only sources do not copy their children's words");
    assert!(reopened.refresh(None, 50).await.unwrap().selected_quote.is_some());
    reopened.cancel_quote();
    assert!(reopened.refresh(None, 50).await.unwrap().selected_quote.is_none());
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
    assert_eq!(book.lock().unwrap().message_posts, 3);
}

#[tokio::test]
async fn private_edits_and_deletions_show_on_their_target_and_resume_like_sends() {
    use crypto::enrollment::rooms::messages::Delivery;
    let (pilot, settings, book) = setup(false).await;
    let group = settings.room("room".into()).await.unwrap();
    let view = group.refresh().await.unwrap();
    let preview = group.preview_create(view.revision, vec![]).await.unwrap();
    group.confirm(preview.revision, preview.review.unwrap().fingerprint).await.unwrap();
    group.close();
    encrypted_snapshot(&pilot);
    let chat = message_settings(&pilot).await.messages("room".into(), None).await.unwrap();
    chat.refresh(None, 50).await.unwrap();
    chat.send(rv_protocol::SendMessage {
        operation_id: "amend-original".into(),
        text: "private-message-cleartext original".into(),
        reply_to: None,
        quotes: vec![],
        cards: vec![],
        files: vec![],
    })
    .await
    .unwrap();
    let view = chat.refresh(None, 50).await.unwrap();
    let id = view.messages[0].row.id.clone();
    assert!(!view.messages[0].row.edited);
    // A failed POST leaves the edit unsettled: it shows on its target, which
    // carries the edit's operation until it is resumed.
    book.lock().unwrap().drop_message = true;
    assert!(chat.amend(id.clone(), Some("private-message-cleartext edited".into())).await.is_err());
    let pending = chat.refresh(None, 50).await.unwrap();
    assert_eq!(pending.messages.len(), 1);
    let row = &pending.messages[0];
    assert!(row.delivery == Delivery::Pending && row.row.outbox_status.as_deref() == Some("pending"));
    assert_eq!(row.row.text.as_deref(), Some("private-message-cleartext edited"));
    chat.resume(row.operation.clone()).await.unwrap();
    assert_eq!(book.lock().unwrap().message_posts, 2);
    let view = chat.refresh(None, 50).await.unwrap();
    assert_eq!(view.messages.len(), 1);
    let row = &view.messages[0];
    assert!(row.delivery == Delivery::Journaled && row.row.outbox_status.is_none() && row.row.edited);
    assert_eq!((row.row.id.as_str(), row.row.text.as_deref()), (id.as_str(), Some("private-message-cleartext edited")));
    // Reactions use canonical emoji names and show on the row; the latest wins.
    chat.react(id.clone(), ":+1:".into(), true).await.unwrap();
    let view = chat.refresh(None, 50).await.unwrap();
    assert_eq!(view.messages.len(), 1);
    let reactions: serde_json::Value =
        serde_json::from_str(view.messages[0].row.reactions.as_deref().unwrap()).unwrap();
    assert_eq!(reactions, serde_json::json!({":thumbsup:": {"usernames": ["alice"]}}));
    assert!(chat.react(id.clone(), "not-an-emoji".into(), true).await.is_err());
    chat.react(id.clone(), "thumbsup".into(), false).await.unwrap();
    assert!(chat.refresh(None, 50).await.unwrap().messages[0].row.reactions.is_none());
    // Private search runs on the device and finds the edited text only.
    let found = chat.search("CLEARTEXT EDITED".into()).await.unwrap();
    assert_eq!(found.iter().map(|m| m.row.id.as_str()).collect::<Vec<_>>(), [id.as_str()]);
    assert!(found[0].row.edited);
    assert!(chat.search("original".into()).await.unwrap().is_empty());
    assert!(chat.search("  ".into()).await.is_err());
    // An amendment is never a target, and a deletion removes the row.
    let amendment = book.lock().unwrap().message_receipts.len();
    assert!(chat.amend(format!("private-message-{amendment}"), None).await.is_err());
    chat.amend(id, None).await.unwrap();
    assert!(chat.refresh(None, 50).await.unwrap().messages.is_empty());
}

#[tokio::test]
async fn private_files_are_sealed_on_the_device_and_opened_only_while_shown() {
    let (pilot, settings, book) = setup(false).await;
    let group = settings.room("room".into()).await.unwrap();
    let view = group.refresh().await.unwrap();
    let preview = group.preview_create(view.revision, vec![]).await.unwrap();
    group.confirm(preview.revision, preview.review.unwrap().fingerprint).await.unwrap();
    group.close();
    encrypted_snapshot(&pilot);
    let chat = message_settings(&pilot).await.messages("room".into(), None).await.unwrap();
    chat.refresh(None, 50).await.unwrap();
    let plain = (0..70_000u32).map(|i| (i % 251) as u8).chain(*b"private-message-cleartext").collect::<Vec<_>>();
    let source = pilot.directory.path().join("photo.png");
    std::fs::write(&source, &plain).unwrap();
    chat.send_file(
        source.clone(),
        "photo privée.png".into(),
        "image/png".into(),
        "private-message-cleartext caption".into(),
    )
    .await
    .unwrap();
    assert_eq!(book.lock().unwrap().uploads.len(), 1);
    let view = chat.refresh(None, 50).await.unwrap();
    assert_eq!(view.messages.len(), 1);
    let row = &view.messages[0].row;
    assert_eq!(row.text.as_deref(), Some("private-message-cleartext caption"));
    let attachments: serde_json::Value = serde_json::from_str(row.attachments.as_deref().unwrap()).unwrap();
    assert_eq!(attachments[0]["title"], "photo privée.png");
    assert_eq!(attachments[0]["image_url"], "rv-file:~upload-1");
    // Opened on the device, through the session like any protected file.
    assert!(pilot.session.file_current("rv-file:~upload-1"));
    let local = pilot.session.local_file("rv-file:~upload-1").await.unwrap();
    assert_eq!(std::fs::read(&local).unwrap(), plain);
    assert_eq!(pilot.session.file_media("rv-file:~upload-1").await.unwrap().bytes, plain);
    // An ordinary id never resolves to a private file, nor the reverse.
    assert!(!pilot.session.file_current("rv-file:upload-1"));
    assert!(pilot.session.local_file("rv-file:~unknown").await.is_err());
    // Closing the view closes its files and their plaintext cache.
    chat.close();
    assert!(!pilot.session.file_current("rv-file:~upload-1"));
    assert!(pilot.session.local_file("rv-file:~upload-1").await.is_err());
    assert!(!local.exists());
}
