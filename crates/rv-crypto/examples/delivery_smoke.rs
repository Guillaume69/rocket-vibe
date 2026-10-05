//! Disposable combined HTTP/SQL fixture, launched by the server integration
//! test with public routing and temporary session tokens on stdin. The vault
//! is real; its external checkpoint storage here is an in-memory test backend.
use data_encoding::HEXLOWER;
use openmls::prelude::{GroupId, MlsGroup, OpenMlsProvider};
use rv_client::NativeClient;
use rv_crypto::{
    delivery::{self, Target, Worker},
    groups,
    identity::{Certificate, Issuer, Pins, Root, enrollment::LocalDevice},
    protected::{Manager, Storage},
    vault,
};
use rv_protocol::e2ee as http;
use serde::Deserialize;
use std::{
    collections::BTreeMap,
    io::Read,
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};
use zeroize::{Zeroize, Zeroizing};

type Result<T> = std::result::Result<T, Box<dyn std::error::Error + Send + Sync>>;
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Login {
    user: String,
    token: String,
}
impl Drop for Login {
    fn drop(&mut self) {
        self.token.zeroize();
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Input {
    base: String,
    room: String,
    alice: Login,
    bob: Login,
}
#[derive(Default)]
struct Keystore(Mutex<BTreeMap<String, Zeroizing<Vec<u8>>>>);
impl Storage for Keystore {
    fn read(&self, name: &str) -> std::result::Result<Option<Zeroizing<Vec<u8>>>, vault::Error> {
        Ok(self
            .0
            .lock()
            .unwrap()
            .get(name)
            .map(|v| Zeroizing::new(v.to_vec())))
    }
    fn write(&self, name: &str, bytes: &[u8]) -> std::result::Result<(), vault::Error> {
        self.0
            .lock()
            .unwrap()
            .insert(name.into(), Zeroizing::new(bytes.to_vec()));
        Ok(())
    }
}
struct Account {
    directory: tempfile::TempDir,
    storage: Arc<Keystore>,
    manager: Arc<Manager>,
    root: Root,
    certificate: Certificate,
    revision: String,
    client: NativeClient,
    base: String,
    token: Zeroizing<String>,
}
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs()
}
fn random<const N: usize>() -> [u8; N] {
    let mut value = [0; N];
    getrandom::fill(&mut value).unwrap();
    value
}
impl Account {
    async fn new(base: &str, login: &Login) -> Result<Self> {
        let client = NativeClient::new(base)?;
        client.update_token(login.token.clone());
        let info = client.discover().await?;
        assert!(!info.capabilities.e2ee, "fixture must not activate E2EE");
        assert!(client.me().await?.id == login.user, "wrong fixture account");
        let sessions = client.device_sessions().await?;
        let current: Vec<_> = sessions.into_iter().filter(|s| s.current).collect();
        assert!(current.len() == 1, "expected one current session");
        let incarnation = random::<16>();
        let directory = tempfile::tempdir()?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(directory.path(), std::fs::Permissions::from_mode(0o700))?;
        }
        let storage = Arc::new(Keystore::default());
        let manager = Arc::new(Manager::new(
            directory.path().into(),
            vault::Scope {
                instance: info.instance_id,
                data_epoch: info.data_epoch,
                user: login.user.clone(),
                device: current[0].id.clone(),
                incarnation: HEXLOWER.encode(&incarnation),
            },
            storage.clone(),
        )?);
        let owned = manager.clone();
        let (root, request, grant) = tokio::task::spawn_blocking(move || -> Result<_> {
            owned.initialize()?;
            Ok(owned.transact(|_, records| {
                let issuer =
                    Issuer::generate(&owned.scope().instance, &owned.scope().user).unwrap();
                let root = issuer.root().clone();
                issuer.save(records).unwrap();
                let mut local =
                    LocalDevice::create_bound(&root, &owned.scope().device, incarnation, records)
                        .unwrap();
                let at = now();
                let request = local.request(at, records).unwrap();
                let consent = issuer.preview_request(&request, at, 3600, records).unwrap();
                let grant = issuer
                    .approve_request(&request, &consent, at, records)
                    .unwrap();
                local.install(&grant, at, records).unwrap();
                Ok((root, request, grant))
            })?)
        })
        .await??;
        let operation = HEXLOWER.encode(&random::<32>());
        let registration = http::RegisterDevice {
            scope: http::Scope {
                instance_id: manager.scope().instance.clone(),
                data_epoch: manager.scope().data_epoch.clone(),
            },
            operation_id: operation.clone(),
            expected_root_fingerprint: None,
            expected_device_revision: None,
            request: data_encoding::BASE64URL_NOPAD.encode(&request.to_bytes()?),
            grant: data_encoding::BASE64URL_NOPAD.encode(&grant.to_bytes()?),
            revoke_previous: None,
        };
        let receipt = client.register_crypto_device(&registration).await?;
        assert!(
            receipt.operation_id == operation && receipt.kind == "register_device",
            "wrong registration receipt"
        );
        assert!(
            receipt.scope.instance_id == manager.scope().instance
                && receipt.scope.data_epoch == manager.scope().data_epoch,
            "wrong registration scope"
        );
        assert!(
            receipt.device_id == manager.scope().device
                && receipt.incarnation == manager.scope().incarnation,
            "wrong registered device"
        );
        assert!(
            receipt.root_fingerprint == HEXLOWER.encode(&root.fingerprint()?),
            "wrong registered root"
        );
        assert!(
            receipt.key_package_refs.is_empty(),
            "unexpected registration packages"
        );
        Ok(Self {
            directory,
            storage,
            manager,
            root,
            certificate: grant.certificate,
            revision: receipt.device_revision,
            client,
            base: base.into(),
            token: Zeroizing::new(login.token.clone()),
        })
    }
    fn worker(&self) -> Result<Worker> {
        // Reopen the database and use a fresh SDK; no live MLS/HTTP state is
        // shared with the interrupted worker. Checkpoint backend stays alive.
        let manager = Arc::new(Manager::new(
            self.directory.path().into(),
            self.manager.scope().clone(),
            self.storage.clone(),
        )?);
        let client = NativeClient::new(&self.base)?;
        client.update_token(self.token.to_string());
        Ok(Worker::new(manager, self.root.clone(), client)?)
    }
    async fn renew(&mut self) -> Result<()> {
        let manager = self.manager.clone();
        let root = self.root.clone();
        let old = self.certificate.clone();
        assert!(
            now() > old.device.issued_at,
            "renewal must advance the issuance time"
        );
        let (request, grant) = tokio::task::spawn_blocking(move || -> Result<_> {
            Ok(manager.transact(|_, records| {
                let issuer = Issuer::load(records, &root.instance, &root.user).unwrap();
                let mut local = LocalDevice::load(&root, &manager.scope().device, records).unwrap();
                let at = now();
                let request = local.request(at, records).unwrap();
                let consent = issuer.preview_request(&request, at, 7200, records).unwrap();
                let grant = issuer
                    .approve_request(&request, &consent, at, records)
                    .unwrap();
                local.install(&grant, at, records).unwrap();
                Ok((request, grant))
            })?)
        })
        .await??;
        assert!(
            grant.certificate.device.incarnation == self.certificate.device.incarnation
                && grant.certificate.device.signature_key == self.certificate.device.signature_key
                && grant.certificate.device.root == self.root,
            "renewal changed the installation identity"
        );
        let registration = http::RegisterDevice {
            scope: http::Scope {
                instance_id: self.manager.scope().instance.clone(),
                data_epoch: self.manager.scope().data_epoch.clone(),
            },
            operation_id: HEXLOWER.encode(&random::<32>()),
            expected_root_fingerprint: Some(HEXLOWER.encode(&self.root.fingerprint()?)),
            expected_device_revision: Some(self.revision.clone()),
            request: data_encoding::BASE64URL_NOPAD.encode(&request.to_bytes()?),
            grant: data_encoding::BASE64URL_NOPAD.encode(&grant.to_bytes()?),
            revoke_previous: None,
        };
        let receipt = self.client.register_crypto_device(&registration).await?;
        assert!(
            receipt.operation_id == registration.operation_id
                && receipt.kind == "register_device"
                && receipt.device_id == self.manager.scope().device
                && receipt.scope.instance_id == registration.scope.instance_id
                && receipt.scope.data_epoch == registration.scope.data_epoch
                && receipt.key_package_refs.is_empty()
                && receipt.incarnation == self.manager.scope().incarnation
                && receipt.root_fingerprint == HEXLOWER.encode(&self.root.fingerprint()?)
                && receipt.device_revision.parse::<u64>()? == self.revision.parse::<u64>()? + 1,
            "wrong renewal receipt"
        );
        self.revision = receipt.device_revision;
        self.certificate = grant.certificate;
        Ok(())
    }
    fn head(&self, room: &str) -> Result<groups::Receipt> {
        Ok(
            groups::Coordinator::new(self.manager.clone(), self.root.clone())?
                .accepted_receipt(room)?,
        )
    }
    fn secret(&self, room: &str) -> Result<Zeroizing<Vec<u8>>> {
        let head = self.head(room)?;
        Ok(self.manager.inspect(|provider, _| {
            let group = MlsGroup::load(
                provider.storage(),
                &GroupId::from_slice(&head.scope.group_id().unwrap()),
            )
            .unwrap()
            .unwrap();
            Ok(Zeroizing::new(
                group
                    .export_secret(provider.crypto(), "combined-http-fixture", &[], 32)
                    .unwrap(),
            ))
        })?)
    }
    async fn trust(&self, peer: &Self) -> Result<()> {
        let manager = self.manager.clone();
        let root = peer.root.clone();
        let certificate = peer.certificate.clone();
        tokio::task::spawn_blocking(move || -> Result<()> {
            manager.transact(|_, records| {
                let mut pins = Pins::load(records, &manager.scope().instance).unwrap();
                pins.accept_first(root.clone(), root.fingerprint().unwrap())
                    .unwrap();
                let at = now();
                let consent = pins.preview_device(&certificate, at).unwrap();
                pins.approve(&certificate, &consent, at).unwrap();
                pins.save(records).unwrap();
                Ok(())
            })?;
            Ok(())
        })
        .await??;
        Ok(())
    }
}
fn lost<T>(result: std::result::Result<T, delivery::Error>) {
    assert!(
        matches!(result, Err(delivery::Error::Network(_))),
        "expected an intentionally lost HTTP response"
    );
}
async fn catchup(account: &Account, room: &str, expected: &groups::Receipt) -> Result<()> {
    let worker = account.worker()?;
    let batch = worker.events(room).await?;
    assert!(batch.page.events.len() == 1, "expected exact next event");
    let preview = worker.preview_event(batch.page.events[0].clone()).await?;
    let fingerprint = preview.preview.fingerprint;
    assert!(
        worker.accept_event(preview, fingerprint).await? == *expected,
        "wrong accepted peer receipt"
    );
    assert!(
        worker.events(room).await?.page.events.is_empty(),
        "unexpected replay event"
    );
    Ok(())
}
async fn rotate(author: &Account, peer: &Account, room: &str) -> Result<()> {
    let parent = author.head(room)?;
    let old = author.secret(room)?;
    let worker = author.worker()?;
    let preview = worker
        .preview_change(room, HEXLOWER.encode(&random::<32>()), vec![], vec![])
        .await?;
    let fingerprint = preview.preview.fingerprint;
    lost(worker.prepare_change(preview, fingerprint).await);
    assert!(
        author.head(room)? == parent && author.secret(room)? == old,
        "unacknowledged rotation replaced the parent"
    );
    worker.stop();
    let accepted = author.worker()?.resume_group(room).await?;
    assert!(
        accepted.revision == parent.revision + 1 && accepted.epoch == parent.epoch + 1,
        "rotation skipped a revision"
    );
    assert!(
        author.head(room)? == parent,
        "rotation ACK discarded an unread epoch"
    );
    for account in [author, peer] {
        let batch = account.worker()?.journal_page(room).await?;
        assert!(
            batch.complete && batch.head == accepted && batch.messages.is_empty(),
            "rotation was not consumed at its journal position"
        );
    }
    assert!(
        author.secret(room)? == peer.secret(room)? && author.secret(room)? != old,
        "peer epoch secrets differ or did not rotate"
    );
    Ok(())
}
async fn exchange(
    alice: &Account,
    bob: &Account,
    room: &str,
    phase: u8,
    after: &str,
) -> Result<String> {
    let root = rv_protocol::SendMessage {
        operation_id: HEXLOWER.encode(&random::<32>()),
        text: format!("protected-worker-private-payload-phase-{phase}: **Bonjour** 🐾"),
        quotes: vec![rv_protocol::parity::QuoteReference {
            room_id: "opaque-quote-room".into(),
            message_id: "opaque-quote-message".into(),
            revision: "9007199254740993".into(),
        }],
        cards: vec![rv_protocol::cards::IntegrationCard {
            author: Some("Auteur privé".into()),
            title: Some("Carte privée".into()),
            url: Some("https://example.org/private".into()),
            text: Some("Texte privé de carte".into()),
            color: None,
            fields: vec![],
        }],
        reply_to: None,
    };
    let author = alice.worker()?;
    lost(author.send_message(room, root.clone()).await);
    let pending = groups::Coordinator::new(alice.manager.clone(), alice.root.clone())?
        .pending_message(&root.operation_id)?;
    author.stop();
    let root_ack = alice.worker()?.resume_message(&root.operation_id).await?;
    if phase == 1 {
        let groups::MessageSettlement::Accepted(settled) =
            alice.worker()?.cancel_message(&root.operation_id).await?
        else {
            panic!("accepted message was abandoned")
        };
        assert!(
            settled == root_ack,
            "terminal decision changed original receipt"
        );
    }
    assert!(
        root_ack.header == pending.header && root_ack.fingerprint == pending.fingerprint,
        "original message changed during reconciliation"
    );
    assert!(
        root_ack.position > 9007199254740992,
        "message position was rounded or sequencer was not seeded"
    );
    let reply = rv_protocol::SendMessage {
        operation_id: HEXLOWER.encode(&random::<32>()),
        text: format!("protected-worker-private-payload-phase-{phase}: réponse chiffrée"),
        quotes: vec![],
        cards: vec![],
        reply_to: Some(root_ack.message.clone()),
    };
    let peer = bob.worker()?;
    lost(peer.send_message(room, reply.clone()).await);
    peer.stop();
    let reply_ack = bob.worker()?.resume_message(&reply.operation_id).await?;
    assert!(
        reply_ack.position > root_ack.position,
        "replies were delivered out of order"
    );
    let page = bob.client.crypto_delivery(room, after, None).await?;
    assert!(
        page.next.is_none() && page.events.len() == 3,
        "expected one accepted transition and two messages"
    );
    assert!(
        page.through == reply_ack.position.to_string(),
        "wrong fixed delivery watermark"
    );
    for account in [alice, bob] {
        let worker = account.worker()?;
        let batch = worker.journal_page(room).await?;
        assert!(
            batch.complete
                && batch.after == reply_ack.position
                && batch.through == reply_ack.position
                && batch.messages.len() == 2,
            "wrong protected journal checkpoint"
        );
        worker.stop();
        let replay = account.worker()?.journal_last_batch(room).await?;
        assert!(
            replay.after == batch.after && replay.head == batch.head && replay.messages.len() == 2,
            "protected page was not replayable after reopen"
        );
        for result in [&batch, &replay] {
            for clear in &result.messages {
                let expected = if clear.receipt.header.operation == root.operation_id {
                    &root
                } else {
                    &reply
                };
                assert!(
                    clear.receipt.header.operation == expected.operation_id,
                    "unexpected application operation"
                );
                assert!(
                    clear.receipt
                        == if expected.operation_id == root.operation_id {
                            root_ack.clone()
                        } else {
                            reply_ack.clone()
                        },
                    "mismatched delivery receipt"
                );
                assert!(
                    serde_json::to_vec(&clear.message()?)? == serde_json::to_vec(expected)?,
                    "protected message document changed"
                );
            }
        }
    }
    // Both cursors and replayable private page bodies survive manager reopen.
    Ok(reply_ack.position.to_string())
}
async fn run(input: Input) -> Result<()> {
    eprintln!("protected-worker-http-smoke: accounts");
    let mut alice = Account::new(&input.base, &input.alice).await?;
    let mut bob = Account::new(&input.base, &input.bob).await?;
    alice.trust(&bob).await?;
    bob.trust(&alice).await?;
    eprintln!("protected-worker-http-smoke: key packages");
    let worker = alice.worker()?;
    lost(worker.publish_packages(alice.revision.clone(), 2).await);
    worker.stop();
    let publication = alice.worker()?.resume_packages().await?;
    assert!(
        publication.key_package_refs.len() == 2,
        "wrong publication receipt"
    );
    let publication = bob
        .worker()?
        .publish_packages(bob.revision.clone(), 2)
        .await?;
    assert!(
        publication.key_package_refs.len() == 2,
        "wrong peer publication receipt"
    );
    let worker = alice.worker()?;
    let preview = worker
        .preview_genesis(
            &input.room,
            random::<16>(),
            HEXLOWER.encode(&random::<32>()),
            vec![Target {
                user: bob.root.user.clone(),
                device: bob.manager.scope().device.clone(),
            }],
        )
        .await?;
    eprintln!("protected-worker-http-smoke: genesis");
    let fingerprint = preview.preview.fingerprint;
    lost(worker.prepare_genesis(preview, fingerprint).await);
    assert!(
        matches!(
            groups::Coordinator::new(alice.manager.clone(), alice.root.clone())?
                .accepted_receipt(&input.room),
            Err(groups::Error::NotReady)
        ),
        "unacknowledged genesis was merged"
    );
    worker.stop();
    let accepted = alice.worker()?.resume_group(&input.room).await?;
    catchup(&bob, &input.room, &accepted).await?;
    assert!(
        alice.secret(&input.room)? == bob.secret(&input.room)?,
        "initial peer epoch secrets differ"
    );
    eprintln!("protected-worker-http-smoke: group cancellation");
    // Abandon a true prepared successor without ever accepting it on the
    // server. A lost terminal response must repeat cancellation, never POST
    // that successor. The accepted group's secrets remain intact.
    let old = alice.secret(&input.room)?;
    let observed = alice.client.crypto_group_roster(&input.room).await?;
    let change = groups::Change::from_wire(&observed, &HEXLOWER.encode(&random::<32>()), &[], &[])?;
    let coordinator = groups::Coordinator::new(alice.manager.clone(), alice.root.clone())?;
    let (preview, consent) = coordinator.preview_change(&change, now())?;
    let original_group =
        coordinator.prepare_change(&change, &consent, preview.fingerprint, now())?;
    let worker = alice.worker()?;
    lost(worker.cancel_group(&input.room, &change.operation).await);
    worker.stop();
    assert!(
        matches!(
            alice.worker()?.resume_group(&input.room).await,
            Err(delivery::Error::Group(groups::Error::GroupCancelled))
        ),
        "abandoned transition was retried"
    );
    assert!(matches!(
        alice
            .worker()?
            .cancel_group(&input.room, &change.operation)
            .await?,
        groups::GroupSettlement::Cancelled(_)
    ));
    assert!(
        alice.secret(&input.room)? == old
            && alice.secret(&input.room)? == bob.secret(&input.room)?,
        "abandonment changed the accepted MLS epoch"
    );
    let late = alice
        .client
        .submit_crypto_group(&input.room, &original_group.to_wire()?)
        .await;
    assert!(
        matches!(late, Err(rv_client::Error::Server { status:409, ref code, .. }) if code=="crypto_group_cancelled"),
        "late original transition was accepted"
    );
    eprintln!("protected-worker-http-smoke: message cancellation");
    // Prepare a genuine private intention without POSTing it. Lose the first
    // durable cancellation response, reopen, recover the exact document, then
    // prove the peer can receive the next sender generation normally.
    let abandoned = rv_protocol::SendMessage {
        operation_id: HEXLOWER.encode(&random::<32>()),
        text: "protected-worker-abandoned-private-body".into(),
        quotes: vec![],
        cards: vec![],
        reply_to: None,
    };
    let observation = groups::MessageObservation::from_wire(
        &alice.client.crypto_group_roster(&input.room).await?,
        &alice.client.crypto_group_state(&input.room).await?,
    )?;
    let original = groups::Coordinator::new(alice.manager.clone(), alice.root.clone())?
        .prepare_message(&observation, &abandoned, now())?;
    let worker = alice.worker()?;
    lost(worker.cancel_message(&abandoned.operation_id).await);
    worker.stop();
    let groups::MessageSettlement::Cancelled(receipt) = alice
        .worker()?
        .cancel_message(&abandoned.operation_id)
        .await?
    else {
        panic!("unsent message was accepted")
    };
    let coordinator = groups::Coordinator::new(alice.manager.clone(), alice.root.clone())?;
    let recovered = coordinator.cancelled_message(&abandoned.operation_id)?;
    assert!(
        recovered.cancellation == receipt
            && serde_json::to_vec(&recovered.message()?)? == serde_json::to_vec(&abandoned)?,
        "abandoned document changed"
    );
    let late = alice
        .client
        .submit_crypto_message(&input.room, &original.to_wire()?)
        .await;
    assert!(
        matches!(late,Err(rv_client::Error::Server{status:409,ref code,..}) if code=="crypto_message_cancelled"),
        "late original POST was not fenced"
    );
    coordinator.forget_cancelled_message(&receipt)?;
    eprintln!("protected-worker-http-smoke: exchanges and rotations");
    let position = exchange(&alice, &bob, &input.room, 1, "0").await?;
    rotate(&alice, &bob, &input.room).await?;
    let position = exchange(&alice, &bob, &input.room, 2, &position).await?;
    rotate(&bob, &alice, &input.room).await?;
    let position = exchange(&alice, &bob, &input.room, 3, &position).await?;
    eprintln!("protected-worker-http-smoke: withdrawal and readmission");
    let old_secret = bob.secret(&input.room)?;
    let old_grant = bob
        .client
        .crypto_group_roster(&input.room)
        .await?
        .members
        .into_iter()
        .find(|m| m.user_id == bob.root.user)
        .unwrap();
    let details = bob.client.room_details(&input.room).await?;
    bob.client
        .leave_room(
            &input.room,
            &rv_protocol::parity::LeaveRoom {
                operation_id: HEXLOWER.encode(&random::<32>()),
                expected_revision: details.revision,
            },
        )
        .await?;
    assert!(
        bob.worker()?.journal_last_batch(&input.room).await.is_err(),
        "withdrawn reader replayed its protected batch"
    );
    let worker = alice.worker()?;
    let remove = worker
        .preview_change(
            &input.room,
            HEXLOWER.encode(&random::<32>()),
            vec![bob.manager.scope().device.clone()],
            vec![],
        )
        .await?;
    let fingerprint = remove.preview.fingerprint;
    lost(worker.prepare_change(remove, fingerprint).await);
    worker.stop();
    let removed = alice.worker()?.resume_group(&input.room).await?;
    let consumed = alice.worker()?.journal_page(&input.room).await?;
    assert!(
        consumed.complete && consumed.head == removed && consumed.messages.is_empty(),
        "remove did not preserve ordered delivery"
    );
    alice.client.add_member(&input.room, &bob.root.user).await?;
    let new_grant = bob
        .client
        .crypto_group_roster(&input.room)
        .await?
        .members
        .into_iter()
        .find(|m| m.user_id == bob.root.user)
        .unwrap();
    assert!(
        new_grant.access_version != old_grant.access_version,
        "rejoin reused the previous membership grant"
    );
    let worker = alice.worker()?;
    let add = worker
        .preview_change(
            &input.room,
            HEXLOWER.encode(&random::<32>()),
            vec![],
            vec![Target {
                user: bob.root.user.clone(),
                device: bob.manager.scope().device.clone(),
            }],
        )
        .await?;
    let fingerprint = add.preview.fingerprint;
    lost(worker.prepare_change(add, fingerprint).await);
    worker.stop();
    let joined = alice.worker()?.resume_group(&input.room).await?;
    let consumed = alice.worker()?.journal_page(&input.room).await?;
    assert!(
        consumed.complete && consumed.head == joined && consumed.messages.is_empty(),
        "add did not merge at its native position"
    );
    let worker = bob.worker()?;
    let events = worker.events(&input.room).await?;
    let welcome = events
        .page
        .events
        .into_iter()
        .find(|event| {
            event
                .welcome
                .as_ref()
                .is_some_and(|w| w.device_id == bob.manager.scope().device)
        })
        .expect("fresh targeted Welcome missing");
    let preview = worker.preview_event(welcome).await?;
    assert!(
        preview.kind == delivery::EventKind::Readmission && bob.secret(&input.room)? == old_secret,
        "preview replaced the old admission"
    );
    let fingerprint = preview.preview.fingerprint;
    assert!(
        worker.accept_event(preview, fingerprint).await? == joined,
        "wrong readmission receipt"
    );
    worker.stop();
    assert!(
        bob.secret(&input.room)? == alice.secret(&input.room)?
            && bob.secret(&input.room)? != old_secret,
        "fresh Welcome did not replace the old MLS secrets"
    );
    let joined_batch = bob.worker()?.journal_page(&input.room).await?;
    assert!(
        joined_batch.complete && joined_batch.head == joined && joined_batch.messages.is_empty(),
        "new admission exposed older journal contents"
    );
    let position = exchange(&alice, &bob, &input.room, 4, &position).await?;
    let head = alice.client.crypto_group_state(&input.room).await?;
    assert!(
        head.receipt.revision == "5" && head.receipt.epoch == "5" && !head.needs_rekey,
        "wrong final server head"
    );
    eprintln!("protected-worker-http-smoke: renewed peer replacement");
    alice.renew().await?;
    bob.renew().await?;
    assert!(
        alice
            .client
            .crypto_group_state(&input.room)
            .await?
            .needs_rekey,
        "renewal did not invalidate the previous roster"
    );
    assert!(
        !alice.worker()?.message_roster(&input.room).await?.1,
        "a renewed certificate authorized sending before the MLS update"
    );
    bob.worker()?
        .publish_packages(bob.revision.clone(), 1)
        .await?;
    let before = bob.secret(&input.room)?;
    let worker = alice.worker()?;
    let preview = worker
        .preview_change(
            &input.room,
            HEXLOWER.encode(&random::<32>()),
            vec![bob.manager.scope().device.clone()],
            vec![Target {
                user: bob.root.user.clone(),
                device: bob.manager.scope().device.clone(),
            }],
        )
        .await?;
    assert!(
        preview
            .preview
            .recipients
            .iter()
            .find(|p| p.user == bob.root.user)
            .unwrap()
            .certificate
            == bob.certificate.fingerprint()?,
        "replacement did not bind the current certificate"
    );
    let fingerprint = preview.preview.fingerprint;
    lost(worker.prepare_change(preview, fingerprint).await);
    worker.stop();
    let accepted = alice.worker()?.resume_group(&input.room).await?;
    let consumed = alice.worker()?.journal_page(&input.room).await?;
    assert!(
        consumed.complete && consumed.head == accepted,
        "renewed author skipped the ordered rotation position"
    );
    let worker = bob.worker()?;
    let batch = worker.events(&input.room).await?;
    assert!(
        batch.page.events.len() == 1 && batch.page.events[0].welcome.is_some(),
        "renewed peer did not receive its exact new Welcome"
    );
    let preview = worker.preview_event(batch.page.events[0].clone()).await?;
    assert!(
        preview.kind == delivery::EventKind::Readmission && bob.secret(&input.room)? == before,
        "renewed peer preview replaced its previous admission"
    );
    let fingerprint = preview.preview.fingerprint;
    assert!(
        worker.accept_event(preview, fingerprint).await? == accepted,
        "wrong renewed peer admission"
    );
    worker.stop();
    assert!(
        alice.secret(&input.room)? == bob.secret(&input.room)?
            && bob.secret(&input.room)? != before,
        "renewed peer did not receive the new actual MLS secret"
    );
    let consumed = bob.worker()?.journal_page(&input.room).await?;
    assert!(
        consumed.complete && consumed.head == accepted && consumed.messages.is_empty(),
        "renewed admission exposed the old retained messages"
    );
    exchange(&alice, &bob, &input.room, 5, &position).await?;
    let head = alice.client.crypto_group_state(&input.room).await?;
    assert!(
        head.receipt.revision == "6" && head.receipt.epoch == "6" && !head.needs_rekey,
        "wrong server head after renewed peer replacement"
    );
    println!("protected-worker-http-smoke: passed");
    Ok(())
}
#[tokio::main]
async fn main() {
    assert!(
        std::env::var_os("DATABASE_URL").is_none(),
        "private HTTP fixture must not receive SQL credentials"
    );
    let mut bytes = Zeroizing::new(Vec::new());
    std::io::stdin()
        .take(16_385)
        .read_to_end(&mut bytes)
        .unwrap();
    assert!(bytes.len() <= 16_384, "fixture input too large");
    let input = serde_json::from_slice(&bytes).unwrap();
    if let Err(error) = run(input).await {
        eprintln!("protected-worker-http-smoke: {error}");
        std::process::exit(1);
    }
}
