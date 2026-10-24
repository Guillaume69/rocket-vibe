use crate::*;

struct Party {
    local: LocalIdentity,
    signed_prekey: KeyPair,
    prekey: KeyPair,
}

impl Party {
    fn new(registration_id: u32) -> Self {
        let mut rng = rand::rng();
        Self {
            local: LocalIdentity {
                identity: KeyPair::generate(&mut rng),
                registration_id,
            },
            signed_prekey: KeyPair::generate(&mut rng),
            prekey: KeyPair::generate(&mut rng),
        }
    }

    fn bundle(&self, with_prekey: bool) -> PreKeyBundle {
        let signature = self
            .local
            .identity
            .private
            .sign(&self.signed_prekey.public.serialize(), &mut rand::rng());
        PreKeyBundle {
            registration_id: self.local.registration_id,
            identity: self.local.identity.public,
            signed_prekey_id: 7,
            signed_prekey: self.signed_prekey.public,
            signed_prekey_signature: signature,
            prekey: with_prekey.then_some((42, self.prekey.public)),
        }
    }

    fn receive(&self, record: &mut SessionRecord, kind: Kind, bytes: &[u8]) -> Result<Vec<u8>> {
        let mut rng = rand::rng();
        match kind {
            Kind::PreKey => {
                let message = PreKeySignalMessage::deserialize(bytes)?;
                let prekey = (message.prekey_id == Some(42)).then_some(&self.prekey);
                let signed = (message.signed_prekey_id == 7).then_some(&self.signed_prekey);
                Ok(record
                    .decrypt_prekey(&message, &self.local, signed, prekey, &mut rng)?
                    .plaintext)
            }
            Kind::Whisper => record.decrypt(bytes, &mut rng),
            Kind::SenderKey => unreachable!(),
        }
    }
}

fn pair(with_prekey: bool) -> (Party, SessionRecord, Party, SessionRecord) {
    let (alice, bob) = (Party::new(1), Party::new(2));
    let mut alice_record = SessionRecord::default();
    alice_record
        .initiate(&alice.local, &bob.bundle(with_prekey), &mut rand::rng())
        .unwrap();
    (alice, alice_record, bob, SessionRecord::default())
}

#[test]
fn first_messages_are_prekey_messages_until_answered() {
    for with_prekey in [true, false] {
        let (alice, mut a, bob, mut b) = pair(with_prekey);
        for n in 0..3u8 {
            let (kind, bytes) = a.encrypt(&[n]).unwrap();
            assert_eq!(kind, Kind::PreKey);
            assert_eq!(bob.receive(&mut b, kind, &bytes).unwrap(), [n]);
        }
        let (kind, bytes) = b.encrypt(b"pong").unwrap();
        assert_eq!(kind, Kind::Whisper);
        assert_eq!(alice.receive(&mut a, kind, &bytes).unwrap(), b"pong");
        let (kind, _) = a.encrypt(b"after").unwrap();
        assert_eq!(kind, Kind::Whisper);
    }
}

#[test]
fn ping_pong_through_many_ratchet_steps() {
    let (alice, mut a, bob, mut b) = pair(true);
    for n in 0..20u8 {
        let (kind, bytes) = a.encrypt(&[n]).unwrap();
        assert_eq!(bob.receive(&mut b, kind, &bytes).unwrap(), [n]);
        let (kind, bytes) = b.encrypt(&[n, n]).unwrap();
        assert_eq!(alice.receive(&mut a, kind, &bytes).unwrap(), [n, n]);
    }
}

#[test]
fn out_of_order_then_duplicate() {
    let (_alice, mut a, bob, mut b) = pair(true);
    let sent: Vec<_> = (0..6u8).map(|n| a.encrypt(&[n]).unwrap()).collect();
    for i in [0, 3, 1, 5, 2, 4] {
        let (kind, bytes) = &sent[i];
        assert_eq!(bob.receive(&mut b, *kind, bytes).unwrap(), [i as u8]);
    }
    let (kind, bytes) = &sent[1];
    assert!(matches!(
        bob.receive(&mut b, *kind, bytes),
        Err(Error::DuplicatedMessage(_))
    ));
}

#[test]
fn messages_from_an_old_chain_still_decrypt_after_a_ratchet() {
    let (alice, mut a, bob, mut b) = pair(true);
    let (kind, first) = a.encrypt(b"1").unwrap();
    bob.receive(&mut b, kind, &first).unwrap();
    let late = a.encrypt(b"late").unwrap();
    let (kind, reply) = b.encrypt(b"r").unwrap();
    alice.receive(&mut a, kind, &reply).unwrap();
    let (kind, next) = a.encrypt(b"next").unwrap();
    assert_eq!(bob.receive(&mut b, kind, &next).unwrap(), b"next");
    assert_eq!(bob.receive(&mut b, late.0, &late.1).unwrap(), b"late");
}

#[test]
fn tampering_is_refused_and_leaves_the_record_alone() {
    let (alice, mut a, bob, mut b) = pair(true);
    let (kind, bytes) = a.encrypt(b"x").unwrap();
    bob.receive(&mut b, kind, &bytes).unwrap();
    let (kind, bytes) = b.encrypt(b"ack").unwrap();
    alice.receive(&mut a, kind, &bytes).unwrap();
    let (kind, bytes) = a.encrypt(b"y").unwrap();
    assert_eq!(kind, Kind::Whisper);
    let before = b.serialize();
    let mut bad = bytes.clone();
    let last = bad.len() - 1;
    bad[last] ^= 1;
    assert!(bob.receive(&mut b, kind, &bad).is_err());
    assert_eq!(b.serialize(), before);
    assert_eq!(bob.receive(&mut b, kind, &bytes).unwrap(), b"y");
}

#[test]
fn records_survive_serialization_mid_conversation() {
    let (alice, mut a, bob, mut b) = pair(true);
    let skipped = a.encrypt(b"skipped").unwrap();
    let (kind, bytes) = a.encrypt(b"seen").unwrap();
    bob.receive(&mut b, kind, &bytes).unwrap();
    let mut a = SessionRecord::deserialize(&a.serialize()).unwrap();
    let mut b = SessionRecord::deserialize(&b.serialize()).unwrap();
    assert_eq!(
        bob.receive(&mut b, skipped.0, &skipped.1).unwrap(),
        b"skipped"
    );
    let (kind, bytes) = b.encrypt(b"back").unwrap();
    assert_eq!(alice.receive(&mut a, kind, &bytes).unwrap(), b"back");
}

#[test]
fn a_bad_bundle_signature_is_refused() {
    let (alice, bob) = (Party::new(1), Party::new(2));
    let mut bundle = bob.bundle(true);
    bundle.signed_prekey_signature[0] ^= 1;
    let mut record = SessionRecord::default();
    assert_eq!(
        record.initiate(&alice.local, &bundle, &mut rand::rng()),
        Err(Error::BadSignature)
    );
}

#[test]
fn group_messages_out_of_order_and_duplicate() {
    let mut rng = rand::rng();
    let mut mine = SenderKeyRecord::default();
    let distribution = mine.distribution(&mut rng);
    let mut theirs = SenderKeyRecord::default();
    theirs.process(&SenderKeyDistributionMessage::deserialize(distribution.serialized()).unwrap());
    let sent: Vec<_> = (0..5u8)
        .map(|n| mine.encrypt(&[n], &mut rng).unwrap())
        .collect();
    for i in [0, 2, 1, 4, 3] {
        assert_eq!(theirs.decrypt(&sent[i]).unwrap(), [i as u8]);
    }
    assert!(matches!(
        theirs.decrypt(&sent[2]),
        Err(Error::DuplicatedMessage(2))
    ));
    let mut theirs = SenderKeyRecord::deserialize(&theirs.serialize()).unwrap();
    let later = mine.encrypt(b"later", &mut rng).unwrap();
    assert_eq!(theirs.decrypt(&later).unwrap(), b"later");
    let mut forged = later.clone();
    forged[3] ^= 1;
    assert!(theirs.decrypt(&forged).is_err());
}

#[test]
fn a_state_survives_serialization_alone() {
    let (_alice, a, _bob, _b) = pair(true);
    let state = a.current().unwrap();
    let copy = SessionState::deserialize(&state.serialize()).unwrap();
    assert_eq!(copy.remote_identity(), state.remote_identity());
    assert_eq!(copy.alice_base_key(), state.alice_base_key());
    assert_eq!(
        copy.sender_chain_key().unwrap().index,
        state.sender_chain_key().unwrap().index
    );
    assert_eq!(copy.pending_prekey(), state.pending_prekey());
}

#[test]
fn moving_the_sender_chain_forward_skips_counters_the_peer_still_accepts() {
    let (_alice, mut a, bob, mut b) = pair(true);
    let (kind, first) = a.encrypt(b"0").unwrap();
    bob.receive(&mut b, kind, &first).unwrap();
    let state = a.current_mut().unwrap();
    let mut chain = state.sender_chain_key().unwrap().clone();
    while chain.index < 64 {
        chain = chain.next();
    }
    state.set_sender_chain_key(chain).unwrap();
    let (kind, after) = a.encrypt(b"after").unwrap();
    assert_eq!(bob.receive(&mut b, kind, &after).unwrap(), b"after");
}

#[test]
fn a_sender_key_fast_forwards_and_receivers_follow() {
    let mut rng = rand::rng();
    let mut mine = SenderKeyRecord::default();
    let distribution = mine.distribution(&mut rng);
    let mut theirs = SenderKeyRecord::default();
    theirs.process(&distribution);
    mine.fast_forward(40).unwrap();
    assert_eq!(mine.state().unwrap().chain_key().index, 40);
    let message = mine.encrypt(b"later", &mut rng).unwrap();
    assert_eq!(theirs.decrypt(&message).unwrap(), b"later");
    assert!(matches!(
        mine.fast_forward(40 + 2001 + 1),
        Err(Error::TooFarAhead(_))
    ));
}
