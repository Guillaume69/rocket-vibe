use super::Error;
use super::*;
use openmls::prelude::{
    tls_codec::{Deserialize, Serialize},
    *,
};
use openmls_basic_credential::SignatureKeyPair;
use std::{
    io::{BufRead, BufReader},
    process::{Child, Command, Stdio},
    sync::mpsc,
};

const SUITE: Ciphersuite = Ciphersuite::MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519;
fn scope() -> Scope {
    Scope {
        instance: "instance".into(),
        data_epoch: "epoch".into(),
        user: "alice".into(),
        device: "device".into(),
        incarnation: "incarnation".into(),
    }
}
fn key() -> Key {
    Key::from_keystore([42; 32])
} // Public fixture, never a real account key.
fn create(path: &Path) -> Vault {
    let mut vault = Vault::create(path, scope(), key()).unwrap();
    vault.checkpoint_persisted(vault.checkpoint()).unwrap();
    vault
}
fn protect(vault: &mut Vault, checkpoint: Checkpoint) {
    vault.checkpoint_persisted(checkpoint).unwrap();
}

#[test]
fn disk_reopen_private_rows_and_scope_integrity() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("account.sqlite");
    let mut vault = create(&path);
    let (_, marker) = vault
        .transact(|_, records| {
            records.insert(
                "private-description".into(),
                b"Fixture private content".to_vec(),
            );
            Ok(())
        })
        .unwrap();
    assert_eq!(vault.inspect(|_, _| Ok(())), Err(Error::Pending));
    protect(&mut vault, marker);
    drop(vault);
    let vault = Vault::open(&path, scope(), key(), marker).unwrap();
    assert_eq!(
        vault
            .inspect(|_, records| Ok(records["private-description"].clone()))
            .unwrap(),
        b"Fixture private content"
    );
    assert!(
        !fs::read(&path)
            .unwrap()
            .windows(b"private-description".len())
            .any(|s| s == b"private-description")
    );
    assert!(matches!(
        Vault::open(&path, scope(), Key::from_keystore([8; 32]), marker),
        Err(Error::Integrity)
    ));
    for field in 0..5 {
        let mut wrong = scope();
        match field {
            0 => wrong.instance = "other".into(),
            1 => wrong.data_epoch = "other".into(),
            2 => wrong.user = "other".into(),
            3 => wrong.device = "other".into(),
            _ => wrong.incarnation = "other".into(),
        }
        assert!(matches!(
            Vault::open(&path, wrong, key(), marker),
            Err(Error::Stale)
        ));
    }
    assert!(matches!(
        Vault::create(&path, scope(), key()),
        Err(Error::Storage)
    ));
    let before = read(&vault.db).unwrap();
    let mut changed = before.ciphertext;
    *changed.last_mut().unwrap() ^= 1;
    vault
        .db
        .execute("UPDATE state SET ciphertext=?", [changed])
        .unwrap();
    assert!(matches!(
        Vault::open(&path, scope(), key(), marker),
        Err(Error::Stale)
    ));
    let forged = checkpoint(&scope(), &read(&vault.db).unwrap()).unwrap();
    assert!(matches!(
        Vault::open(&path, scope(), key(), forged),
        Err(Error::Integrity)
    ));
}

#[test]
fn checkpoint_gate_sql_failure_and_stale_writer_preserve_original_state() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("account.sqlite");
    let mut first = create(&path);
    let marker = first.checkpoint();
    let old_row = read(&first.db).unwrap();
    let mut second = Vault::open(&path, scope(), key(), marker).unwrap();
    first.db.execute_batch("CREATE TRIGGER fail_state BEFORE UPDATE ON state BEGIN SELECT RAISE(ABORT,'fixture failure'); END;").unwrap();
    assert_eq!(
        first.transact(|_, records| {
            records.insert("uncommitted".into(), vec![1]);
            Ok(())
        }),
        Err(Error::Storage)
    );
    assert_eq!(first.checkpoint(), marker);
    assert_eq!(first.inspect(|_, r| Ok(r.len())).unwrap(), 0);
    first.db.execute_batch("DROP TRIGGER fail_state;").unwrap();
    let (_, next) = first
        .transact(|_, records| {
            records.insert("committed".into(), vec![2]);
            Ok(())
        })
        .unwrap();
    assert_eq!(first.transact(|_, _| Ok(())), Err(Error::Pending));
    assert_eq!(first.checkpoint_persisted(marker), Err(Error::Stale));
    protect(&mut first, next);
    assert_eq!(second.transact(|_, _| Ok(())), Err(Error::Stale));
    // Restoring an authenticated older row must not reset MLS with a newer protected marker.
    assert!(matches!(
        Vault::open(&path, scope(), key(), marker),
        Err(Error::Stale)
    ));
    first
        .db
        .execute(
            "UPDATE state SET revision=?,nonce=?,ciphertext=?",
            params![old_row.revision, old_row.nonce, old_row.ciphertext],
        )
        .unwrap();
    assert!(matches!(
        Vault::open(&path, scope(), key(), next),
        Err(Error::Stale)
    ));
    assert!(matches!(
        Vault::recover_committed(&path, scope(), key(), next),
        Err(Error::Stale)
    ));
}

#[test]
fn oversized_private_state_and_invalid_rows_do_not_replace_the_last_checkpoint() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("account.sqlite");
    let mut vault = create(&path);
    let marker = vault.checkpoint();
    assert_eq!(
        vault.transact(|_, records| {
            records.insert("too-large".into(), vec![7; LIMIT]);
            Ok(())
        }),
        Err(Error::Limit)
    );
    assert_eq!(vault.checkpoint(), marker);
    assert_eq!(vault.inspect(|_, records| Ok(records.len())), Ok(0));
    vault
        .db
        .execute("UPDATE state SET nonce=zeroblob(23)", [])
        .unwrap();
    assert!(matches!(
        Vault::open(&path, scope(), key(), marker),
        Err(Error::Integrity)
    ));
    vault
        .db
        .execute(
            "UPDATE state SET nonce=zeroblob(24),ciphertext=zeroblob(?)",
            [(LIMIT + 17) as i64],
        )
        .unwrap();
    assert!(matches!(
        Vault::open(&path, scope(), key(), marker),
        Err(Error::Integrity)
    ));
}

#[cfg(unix)]
#[test]
fn private_file_permissions_links_and_incomplete_creation_are_rejected() {
    use std::os::unix::fs::{MetadataExt, PermissionsExt, symlink};
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("account.sqlite");
    let vault = create(&path);
    let marker = vault.checkpoint();
    drop(vault);
    assert_eq!(fs::metadata(&path).unwrap().mode() & 0o777, 0o600);
    let link = directory.path().join("linked.sqlite");
    symlink(&path, &link).unwrap();
    assert!(matches!(
        Vault::open(&link, scope(), key(), marker),
        Err(Error::Storage)
    ));
    fs::remove_file(&link).unwrap();
    fs::hard_link(&path, &link).unwrap();
    assert!(matches!(
        Vault::open(&path, scope(), key(), marker),
        Err(Error::Storage)
    ));
    fs::remove_file(&link).unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
    assert!(matches!(
        Vault::open(&path, scope(), key(), marker),
        Err(Error::Storage)
    ));
    let incomplete = directory.path().join("incomplete.sqlite");
    fs::File::create(&incomplete).unwrap();
    fs::set_permissions(&incomplete, fs::Permissions::from_mode(0o600)).unwrap();
    assert!(matches!(
        Vault::open(&incomplete, scope(), key(), marker),
        Err(Error::Storage)
    ));
    assert!(matches!(
        Vault::create(&incomplete, scope(), key()),
        Err(Error::Storage)
    ));
}

fn initialize(vault: &mut Vault, identity: &[u8]) -> Vec<u8> {
    let (package, marker) = vault
        .transact(|provider, records| {
            let signer = SignatureKeyPair::new(SUITE.signature_algorithm()).unwrap();
            signer.store(provider.storage()).unwrap();
            records.insert("signature".into(), signer.to_public_vec());
            records.insert("identity".into(), identity.to_vec());
            let credential = CredentialWithKey {
                credential: BasicCredential::new(identity.to_vec()).into(),
                signature_key: signer.to_public_vec().into(),
            };
            Ok(KeyPackage::builder()
                .build(SUITE, provider, &signer, credential)
                .unwrap()
                .key_package()
                .tls_serialize_detached()
                .unwrap())
        })
        .unwrap();
    protect(vault, marker);
    package
}
fn signer(provider: &OpenMlsRustCrypto, records: &Records) -> SignatureKeyPair {
    SignatureKeyPair::read(
        provider.storage(),
        &records["signature"],
        SUITE.signature_algorithm(),
    )
    .unwrap()
}
fn group(provider: &OpenMlsRustCrypto, records: &Records) -> MlsGroup {
    MlsGroup::load(provider.storage(), &GroupId::from_slice(&records["group"]))
        .unwrap()
        .unwrap()
}
fn wire(bytes: &[u8]) -> ProtocolMessage {
    MlsMessageIn::tls_deserialize_exact(bytes)
        .unwrap()
        .try_into_protocol_message()
        .unwrap()
}

#[test]
fn actual_mls_restarts_and_failed_authentication_roll_back_provider_and_private_records() {
    let directory = tempfile::tempdir().unwrap();
    let alice_path = directory.path().join("alice.sqlite");
    let bob_path = directory.path().join("bob.sqlite");
    let bob_scope = Scope {
        user: "bob".into(),
        device: "bob-mobile".into(),
        ..scope()
    };
    let mut alice = create(&alice_path);
    let mut bob = Vault::create(&bob_path, bob_scope.clone(), key()).unwrap();
    let initial = bob.checkpoint();
    protect(&mut bob, initial);
    initialize(&mut alice, b"alice-desktop");
    let bob_package = initialize(&mut bob, b"bob-mobile");
    let (welcome, marker) = alice
        .transact(|provider, records| {
            let signer = signer(provider, records);
            let credential = CredentialWithKey {
                credential: BasicCredential::new(records["identity"].clone()).into(),
                signature_key: signer.to_public_vec().into(),
            };
            let mut group = MlsGroup::new(
                provider,
                &signer,
                &MlsGroupCreateConfig::builder()
                    .ciphersuite(SUITE)
                    .use_ratchet_tree_extension(true)
                    .build(),
                credential,
            )
            .unwrap();
            let incoming = KeyPackageIn::tls_deserialize_exact(&bob_package)
                .unwrap()
                .validate(provider.crypto(), ProtocolVersion::Mls10)
                .unwrap();
            let (commit, welcome, _) = group.add_members(provider, &signer, &[incoming]).unwrap();
            records.insert("group".into(), group.group_id().as_slice().to_vec());
            records.insert("pending-commit".into(), commit.to_bytes().unwrap());
            Ok(welcome.to_bytes().unwrap())
        })
        .unwrap();
    protect(&mut alice, marker);
    let (_, marker) = alice
        .transact(|provider, records| {
            let mut current = group(provider, records);
            assert!(current.pending_commit().is_some());
            current.merge_pending_commit(provider).unwrap();
            records.remove("pending-commit");
            Ok(())
        })
        .unwrap();
    protect(&mut alice, marker);
    let (_, marker) = bob
        .transact(|provider, records| {
            let MlsMessageBodyIn::Welcome(welcome) = MlsMessageIn::tls_deserialize_exact(&welcome)
                .unwrap()
                .extract()
            else {
                panic!("Welcome required")
            };
            let joined = StagedWelcome::new_from_welcome(
                provider,
                &MlsGroupJoinConfig::default(),
                welcome,
                None,
            )
            .unwrap()
            .into_group(provider)
            .unwrap();
            records.insert("group".into(), joined.group_id().as_slice().to_vec());
            Ok(())
        })
        .unwrap();
    protect(&mut bob, marker);
    let alice_marker = alice.checkpoint();
    let bob_marker = bob.checkpoint();
    drop(alice);
    drop(bob);
    let mut alice = Vault::open(&alice_path, scope(), key(), alice_marker).unwrap();
    let mut bob = Vault::open(&bob_path, bob_scope.clone(), key(), bob_marker).unwrap();
    let (ciphertext, marker) = alice
        .transact(|provider, records| {
            let mut current = group(provider, records);
            current.set_aad(b"instance/epoch/room/message".to_vec());
            let ciphertext = current
                .create_message(
                    provider,
                    &signer(provider, records),
                    b"Secret fixture with durable sender state",
                )
                .unwrap()
                .to_bytes()
                .unwrap();
            records.insert("outbox-message".into(), ciphertext.clone());
            Ok(ciphertext)
        })
        .unwrap();
    protect(&mut alice, marker);
    drop(alice);
    let alice = Vault::open(&alice_path, scope(), key(), marker).unwrap();
    assert_eq!(
        alice
            .inspect(|_, r| Ok(r["outbox-message"].clone()))
            .unwrap(),
        ciphertext
    );
    let original = bob.checkpoint();
    let mut tampered = ciphertext.clone();
    *tampered.last_mut().unwrap() ^= 1;
    assert_eq!(
        bob.transact(|provider, records| {
            records.insert("must-rollback".into(), vec![9]);
            group(provider, records)
                .process_message(provider, wire(&tampered))
                .map_err(|_| Error::Rejected)?;
            Ok(())
        }),
        Err(Error::Rejected)
    );
    assert_eq!(bob.checkpoint(), original);
    drop(bob);
    let mut bob = Vault::open(&bob_path, bob_scope.clone(), key(), original).unwrap();
    assert!(
        !bob.inspect(|_, r| Ok(r.contains_key("must-rollback")))
            .unwrap()
    );
    let (plain, marker) = bob
        .transact(|provider, records| {
            let processed = group(provider, records)
                .process_message(provider, wire(&ciphertext))
                .map_err(|_| Error::Rejected)?;
            assert_eq!(processed.aad(), b"instance/epoch/room/message");
            let ProcessedMessageContent::ApplicationMessage(message) = processed.into_content()
            else {
                return Err(Error::Rejected);
            };
            let plain = message.into_bytes();
            records.insert("private-inbox".into(), plain.clone());
            Ok(plain)
        })
        .unwrap();
    assert_eq!(plain, b"Secret fixture with durable sender state");
    protect(&mut bob, marker);
    assert_eq!(
        bob.transact(|provider, records| {
            group(provider, records)
                .process_message(provider, wire(&ciphertext))
                .map_err(|_| Error::Rejected)?;
            Ok(())
        }),
        Err(Error::Rejected)
    );
    drop(bob);
    let bob = Vault::open(&bob_path, bob_scope, key(), marker).unwrap();
    assert_eq!(
        bob.inspect(|_, r| Ok(r["private-inbox"].clone())).unwrap(),
        plain
    );
}

struct Process(Child);
impl Drop for Process {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}
#[test]
fn real_process_kill_before_and_after_commit_recovers_only_the_authenticated_successor() {
    for boundary in ["before-commit", "after-commit"] {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("account.sqlite");
        let vault = create(&path);
        let marker = vault.checkpoint();
        drop(vault);
        let mut child = Process(
            Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "vault::tests::crash_child",
                    "--ignored",
                    "--nocapture",
                ])
                .env("RV_CRYPTO_TEST_PATH", &path)
                .env(
                    "RV_CRYPTO_TEST_MARKER",
                    serde_json::to_string(&marker).unwrap(),
                )
                .env("RV_CRYPTO_TEST_KILL", boundary)
                .stdout(Stdio::piped())
                .stderr(Stdio::null())
                .spawn()
                .unwrap(),
        );
        let stdout = child.0.stdout.take().unwrap();
        let (sent, received) = mpsc::channel();
        let reader = std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                if line == "crypto-test-at-boundary" {
                    let _ = sent.send(());
                    break;
                }
            }
        });
        received.recv_timeout(Duration::from_secs(10)).unwrap();
        child.0.kill().unwrap();
        child.0.wait().unwrap();
        reader.join().unwrap();
        if boundary == "before-commit" {
            let vault = Vault::open(&path, scope(), key(), marker).unwrap();
            assert!(
                !vault
                    .inspect(|_, r| Ok(r.contains_key("crash-record")))
                    .unwrap()
            );
            assert!(matches!(
                Vault::recover_committed(&path, scope(), key(), marker),
                Err(Error::Stale)
            ));
        } else {
            assert!(matches!(
                Vault::open(&path, scope(), key(), marker),
                Err(Error::Stale)
            ));
            let mut wrong = marker;
            wrong.digest[0] ^= 1;
            assert!(matches!(
                Vault::recover_committed(&path, scope(), key(), wrong),
                Err(Error::Stale)
            ));
            let mut vault = Vault::recover_committed(&path, scope(), key(), marker).unwrap();
            assert_eq!(vault.inspect(|_, _| Ok(())), Err(Error::Pending));
            let successor = vault.checkpoint();
            protect(&mut vault, successor);
            assert_eq!(
                vault.inspect(|_, r| Ok(r["crash-record"].clone())).unwrap(),
                b"Committed fixture"
            );
        }
    }
}
#[test]
#[ignore = "invoked only as a disposable child process"]
fn crash_child() {
    let path = std::env::var("RV_CRYPTO_TEST_PATH").unwrap();
    let marker = serde_json::from_str(&std::env::var("RV_CRYPTO_TEST_MARKER").unwrap()).unwrap();
    let mut vault = Vault::open(Path::new(&path), scope(), key(), marker).unwrap();
    vault
        .transact(|_, records| {
            records.insert("crash-record".into(), b"Committed fixture".to_vec());
            Ok(())
        })
        .unwrap();
    panic!("Expected parent to terminate this child at the boundary");
}
