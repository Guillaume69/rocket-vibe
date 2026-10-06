use openmls::prelude::{tls_codec::Deserialize, *};
use openmls_basic_credential::SignatureKeyPair;
use openmls_rust_crypto::OpenMlsRustCrypto;

const SUITE: Ciphersuite = Ciphersuite::MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519;

struct Device {
    provider: OpenMlsRustCrypto,
    signer: SignatureKeyPair,
    credential: CredentialWithKey,
}

impl Device {
    fn new(identity: &[u8]) -> Self {
        let provider = OpenMlsRustCrypto::default();
        let signer = SignatureKeyPair::new(SUITE.signature_algorithm()).unwrap();
        signer.store(provider.storage()).unwrap();
        let credential = CredentialWithKey {
            credential: BasicCredential::new(identity.to_vec()).into(),
            signature_key: signer.to_public_vec().into(),
        };
        Self {
            provider,
            signer,
            credential,
        }
    }

    fn package(&self) -> KeyPackageBundle {
        KeyPackage::builder()
            .build(SUITE, &self.provider, &self.signer, self.credential.clone())
            .unwrap()
    }

    fn group(&self) -> MlsGroup {
        MlsGroup::new(
            &self.provider,
            &self.signer,
            &MlsGroupCreateConfig::builder()
                .ciphersuite(SUITE)
                .use_ratchet_tree_extension(true)
                .build(),
            self.credential.clone(),
        )
        .unwrap()
    }

    fn join(&self, welcome: MlsMessageOut) -> MlsGroup {
        let input = MlsMessageIn::tls_deserialize_exact(welcome.to_bytes().unwrap()).unwrap();
        let MlsMessageBodyIn::Welcome(welcome) = input.extract() else {
            panic!("Expected Welcome");
        };
        StagedWelcome::new_from_welcome(
            &self.provider,
            &MlsGroupJoinConfig::default(),
            welcome,
            None,
        )
        .unwrap()
        .into_group(&self.provider)
        .unwrap()
    }
}

fn protocol(bytes: &[u8]) -> ProtocolMessage {
    MlsMessageIn::tls_deserialize_exact(bytes)
        .unwrap()
        .try_into_protocol_message()
        .unwrap()
}

fn application(device: &Device, group: &mut MlsGroup, bytes: &[u8]) -> Vec<u8> {
    match group
        .process_message(&device.provider, protocol(bytes))
        .unwrap()
        .into_content()
    {
        ProcessedMessageContent::ApplicationMessage(message) => message.into_bytes(),
        _ => panic!("Expected application data"),
    }
}

#[test]
fn welcome_ciphertext_routing_tamper_and_replay() {
    let alice = Device::new(b"alice-desktop");
    let bob = Device::new(b"bob-mobile");
    let mut sender = alice.group();
    let (_, welcome, _) = sender
        .add_members(
            &alice.provider,
            &alice.signer,
            &[bob.package().key_package().clone()],
        )
        .unwrap();
    sender.merge_pending_commit(&alice.provider).unwrap();
    let mut receiver = bob.join(welcome);
    let plaintext = b"Private body must not appear in delivery or journal";
    let routing = b"instance/epoch/room/incarnation/operation/device";
    sender.set_aad(routing.to_vec());
    let bytes = sender
        .create_message(&alice.provider, &alice.signer, plaintext)
        .unwrap()
        .to_bytes()
        .unwrap();
    assert!(!bytes.windows(plaintext.len()).any(|part| part == plaintext));
    let mut changed = bytes.clone();
    *changed.last_mut().unwrap() ^= 1;
    let group_id = receiver.group_id().clone();
    let before = bob.provider.storage().values.read().unwrap().clone();
    assert!(
        receiver
            .process_message(&bob.provider, protocol(&changed))
            .is_err()
    );
    // The failed authentication consumed a receive secret. A production
    // transaction must roll back both provider writes and the in-memory group.
    assert!(
        receiver
            .process_message(&bob.provider, protocol(&bytes))
            .is_err()
    );
    *bob.provider.storage().values.write().unwrap() = before;
    receiver = MlsGroup::load(bob.provider.storage(), &group_id)
        .unwrap()
        .unwrap();
    let processed = receiver
        .process_message(&bob.provider, protocol(&bytes))
        .unwrap();
    assert_eq!(processed.aad(), routing);
    assert_eq!(
        processed.credential().serialized_content(),
        b"alice-desktop"
    );
    match processed.into_content() {
        ProcessedMessageContent::ApplicationMessage(message) => {
            assert_eq!(message.into_bytes(), plaintext)
        }
        _ => panic!("Expected application data"),
    }
    assert!(
        receiver
            .process_message(&bob.provider, protocol(&bytes))
            .is_err()
    );
}

#[test]
fn removed_device_cannot_open_next_epoch_even_with_previous_state() {
    let alice = Device::new(b"alice-desktop");
    let bob = Device::new(b"bob-mobile");
    let carol = Device::new(b"alice-mobile");
    let mut sender = alice.group();
    let (_, welcome, _) = sender
        .add_members(
            &alice.provider,
            &alice.signer,
            &[
                bob.package().key_package().clone(),
                carol.package().key_package().clone(),
            ],
        )
        .unwrap();
    sender.merge_pending_commit(&alice.provider).unwrap();
    let mut removed = bob.join(welcome.clone());
    let mut remaining = carol.join(welcome);
    let index = removed.own_leaf_index();
    let (commit, _, _) = sender
        .remove_members(&alice.provider, &alice.signer, &[index])
        .unwrap();
    let processed = remaining
        .process_message(&carol.provider, protocol(&commit.to_bytes().unwrap()))
        .unwrap();
    let ProcessedMessageContent::StagedCommitMessage(staged) = processed.into_content() else {
        panic!("Expected removal commit");
    };
    remaining
        .merge_staged_commit(&carol.provider, *staged)
        .unwrap();
    sender.merge_pending_commit(&alice.provider).unwrap();
    let bytes = sender
        .create_message(&alice.provider, &alice.signer, b"After withdrawal")
        .unwrap()
        .to_bytes()
        .unwrap();
    assert_eq!(
        application(&carol, &mut remaining, &bytes),
        b"After withdrawal"
    );
    assert!(
        removed
            .process_message(&bob.provider, protocol(&bytes))
            .is_err()
    );
}

#[test]
fn fresh_device_has_no_history_and_pending_commit_requires_application_gate() {
    let alice = Device::new(b"alice-desktop");
    let bob = Device::new(b"bob-mobile");
    let carol = Device::new(b"alice-mobile");
    let mut sender = alice.group();
    let (_, welcome, _) = sender
        .add_members(
            &alice.provider,
            &alice.signer,
            &[bob.package().key_package().clone()],
        )
        .unwrap();
    sender.merge_pending_commit(&alice.provider).unwrap();
    let mut receiver = bob.join(welcome);
    let old = sender
        .create_message(&alice.provider, &alice.signer, b"Historical body")
        .unwrap()
        .to_bytes()
        .unwrap();
    assert_eq!(application(&bob, &mut receiver, &old), b"Historical body");
    let epoch = sender.epoch();
    let (_, welcome, _) = sender
        .add_members(
            &alice.provider,
            &alice.signer,
            &[carol.package().key_package().clone()],
        )
        .unwrap();
    assert_eq!(sender.epoch(), epoch);
    assert!(sender.pending_commit().is_some());
    assert!(
        sender
            .create_message(
                &alice.provider,
                &alice.signer,
                b"Old epoch remains writable"
            )
            .is_ok()
    );
    // The application must explicitly fence sending while its commit waits
    // for a durable receipt; the library alone does not enforce that policy.
    assert_eq!(sender.epoch(), epoch);
    let group_id = sender.group_id().clone();
    drop(sender);
    let mut resumed = MlsGroup::load(alice.provider.storage(), &group_id)
        .unwrap()
        .unwrap();
    assert_eq!(resumed.epoch(), epoch);
    assert!(resumed.pending_commit().is_some());
    // The simulated delivery service has accepted this exact prepared commit.
    resumed.merge_pending_commit(&alice.provider).unwrap();
    let mut fresh = carol.join(welcome);
    assert!(
        fresh
            .process_message(&carol.provider, protocol(&old))
            .is_err()
    );
    let current = resumed
        .create_message(
            &alice.provider,
            &alice.signer,
            b"New device current content",
        )
        .unwrap()
        .to_bytes()
        .unwrap();
    assert_eq!(
        application(&carol, &mut fresh, &current),
        b"New device current content"
    );
}
