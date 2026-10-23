//! Interoperability with an independent implementation, driven as a black
//! box: `RV_SIGNAL_ORACLE=<binary>` speaks JSON lines on stdin and stdout
//! (`brain/decisions.md`, the clean-room rule). Ignored by default; run them
//! with `cargo test --test oracle -- --ignored`. CI replays recorded runs
//! instead (`tests/vectors.rs`).

use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};

use rv_signal::*;
use serde_json::{Value, json};

struct Oracle {
    _child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
}

impl Oracle {
    fn start() -> Self {
        let path =
            std::env::var("RV_SIGNAL_ORACLE").expect("RV_SIGNAL_ORACLE names the oracle binary");
        let mut child = Command::new(path)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .expect("oracle starts");
        let stdin = child.stdin.take().unwrap();
        let stdout = BufReader::new(child.stdout.take().unwrap());
        Self {
            _child: child,
            stdin,
            stdout,
        }
    }

    fn call(&mut self, request: Value) -> std::result::Result<Value, String> {
        writeln!(self.stdin, "{request}").unwrap();
        let mut line = String::new();
        self.stdout.read_line(&mut line).unwrap();
        let response: Value = serde_json::from_str(&line).expect("oracle answers JSON");
        match (response.get("ok"), response.get("err")) {
            (Some(ok), _) => Ok(ok.clone()),
            (_, Some(err)) => Err(err.as_str().unwrap_or_default().to_owned()),
            _ => panic!("oracle answered neither ok nor err: {line}"),
        }
    }

    fn ok(&mut self, request: Value) -> Value {
        let op = request["op"].clone();
        self.call(request)
            .unwrap_or_else(|e| panic!("oracle {op} failed: {e}"))
    }
}

fn hex(bytes: &[u8]) -> String {
    hex::encode(bytes)
}

fn unhex(v: &Value) -> Vec<u8> {
    hex::decode(v.as_str().expect("hex string")).expect("valid hex")
}

fn key(seed: u8) -> [u8; 32] {
    let mut k = [seed; 32];
    k[0] = seed.wrapping_mul(31).wrapping_add(7);
    k
}

fn kind_name(kind: Kind) -> &'static str {
    match kind {
        Kind::PreKey => "prekey",
        Kind::Whisper => "whisper",
        Kind::SenderKey => unreachable!(),
    }
}

/// My side of a conversation, with fixed keys.
struct Me {
    local: LocalIdentity,
    signed_prekey: KeyPair,
    prekey: KeyPair,
    record: SessionRecord,
}

impl Me {
    fn new(seed: u8) -> Self {
        Self {
            local: LocalIdentity {
                identity: KeyPair::from_private(PrivateKey::from_bytes(key(seed))),
                registration_id: 1000 + u32::from(seed),
            },
            signed_prekey: KeyPair::from_private(PrivateKey::from_bytes(key(seed + 1))),
            prekey: KeyPair::from_private(PrivateKey::from_bytes(key(seed + 2))),
            record: SessionRecord::default(),
        }
    }

    fn bundle_json(&self, with_prekey: bool) -> Value {
        let signature = self
            .local
            .identity
            .private
            .sign(&self.signed_prekey.public.serialize(), &mut rand::rng());
        json!({
            "registration_id": self.local.registration_id,
            "device_id": 1,
            "identity_public": hex(&self.local.identity.public.serialize()),
            "signed_prekey_id": 7,
            "signed_prekey_public": hex(&self.signed_prekey.public.serialize()),
            "signed_prekey_signature": hex(&signature),
            "prekey_id": if with_prekey { json!(42) } else { Value::Null },
            "prekey_public": if with_prekey { json!(hex(&self.prekey.public.serialize())) } else { Value::Null },
        })
    }

    fn receive(&mut self, kind: &str, bytes: &[u8]) -> Result<Vec<u8>> {
        let mut rng = rand::rng();
        match kind {
            "prekey" => {
                let message = PreKeySignalMessage::deserialize(bytes)?;
                let signed = (message.signed_prekey_id == 7).then_some(&self.signed_prekey);
                let prekey = (message.prekey_id == Some(42)).then_some(&self.prekey);
                Ok(self
                    .record
                    .decrypt_prekey(&message, &self.local, signed, prekey, &mut rng)?
                    .plaintext)
            }
            _ => self.record.decrypt(bytes, &mut rng),
        }
    }

    fn send(&mut self, plaintext: &[u8]) -> (String, Vec<u8>) {
        let (kind, bytes) = self.record.encrypt(plaintext).unwrap();
        (kind_name(kind).to_owned(), bytes)
    }
}

fn oracle_party(oracle: &mut Oracle, name: &str, seed: u8) {
    oracle.ok(json!({
        "op": "party", "name": name, "registration_id": 2000 + u32::from(seed),
        "identity_private": hex(&key(seed)),
        "signed_prekey": {"id": 7, "private": hex(&key(seed + 1)), "timestamp_ms": 1_700_000_000_000u64},
        "prekeys": [{"id": 42, "private": hex(&key(seed + 2))}],
    }));
}

fn bundle_from_json(b: &Value) -> PreKeyBundle {
    PreKeyBundle {
        registration_id: b["registration_id"].as_u64().unwrap() as u32,
        identity: PublicKey::deserialize(&unhex(&b["identity_public"])).unwrap(),
        signed_prekey_id: b["signed_prekey_id"].as_u64().unwrap() as u32,
        signed_prekey: PublicKey::deserialize(&unhex(&b["signed_prekey_public"])).unwrap(),
        signed_prekey_signature: unhex(&b["signed_prekey_signature"]).try_into().unwrap(),
        prekey: b["prekey_id"].as_u64().map(|id| {
            (
                id as u32,
                PublicKey::deserialize(&unhex(&b["prekey_public"])).unwrap(),
            )
        }),
    }
}

fn oracle_send(oracle: &mut Oracle, name: &str, peer: &str, plaintext: &[u8]) -> (String, Vec<u8>) {
    let out = oracle
        .ok(json!({"op": "encrypt", "name": name, "peer": peer, "plaintext": hex(plaintext)}));
    (
        out["type"].as_str().unwrap().to_owned(),
        unhex(&out["ciphertext"]),
    )
}

fn oracle_receive(
    oracle: &mut Oracle,
    name: &str,
    peer: &str,
    kind: &str,
    bytes: &[u8],
) -> std::result::Result<Vec<u8>, String> {
    oracle
        .call(json!({"op": "decrypt", "name": name, "peer": peer, "type": kind, "ciphertext": hex(bytes)}))
        .map(|out| unhex(&out["plaintext"]))
}

#[test]
#[ignore = "needs RV_SIGNAL_ORACLE"]
fn curve_operations_agree() {
    let mut oracle = Oracle::start();
    for seed in [1u8, 50, 99, 200] {
        let private = PrivateKey::from_bytes(key(seed));
        let ours = private.public_key();
        let theirs = oracle.ok(json!({"op": "public_key", "private": hex(&key(seed))}));
        assert_eq!(
            unhex(&theirs["public"]),
            ours.serialize(),
            "public key of seed {seed}"
        );
        let other = KeyPair::from_private(PrivateKey::from_bytes(key(seed + 3)));
        let shared = oracle.ok(json!({"op": "agree", "private": hex(&key(seed)), "public": hex(&other.public.serialize())}));
        assert_eq!(
            unhex(&shared["shared"]),
            private.agree(&other.public).unwrap(),
            "agreement of seed {seed}"
        );
        for message in [&b""[..], b"hello", &[7u8; 300]] {
            let theirs = oracle.ok(json!({"op": "sign", "private": hex(&key(seed)), "message": hex(message), "random": Value::Null}));
            let signature: [u8; 64] = unhex(&theirs["signature"]).try_into().unwrap();
            assert!(
                ours.verify(message, &signature),
                "their signature verifies here (seed {seed})"
            );
            let mine = private.sign(message, &mut rand::rng());
            let verdict = oracle.ok(json!({"op": "verify", "public": hex(&ours.serialize()), "message": hex(message), "signature": hex(&mine)}));
            assert_eq!(
                verdict["valid"],
                json!(true),
                "my signature verifies there (seed {seed})"
            );
        }
    }
}

#[test]
#[ignore = "needs RV_SIGNAL_ORACLE"]
fn oracle_initiates_and_we_answer() {
    let mut oracle = Oracle::start();
    for with_prekey in [true, false] {
        let mut me = Me::new(10);
        oracle_party(&mut oracle, "alice", 20);
        oracle.ok(json!({"op": "process_bundle", "name": "alice", "peer": "me", "bundle": me.bundle_json(with_prekey), "base_private": Value::Null}));
        for n in 0..3u8 {
            let (kind, bytes) = oracle_send(&mut oracle, "alice", "me", &[n]);
            assert_eq!(kind, "prekey");
            assert_eq!(
                me.receive(&kind, &bytes).unwrap(),
                [n],
                "prekey message {n} (one-time prekey: {with_prekey})"
            );
        }
        for n in 0..10u8 {
            let (kind, bytes) = me.send(&[n, 1]);
            assert_eq!(
                oracle_receive(&mut oracle, "alice", "me", &kind, &bytes).unwrap(),
                [n, 1]
            );
            let (kind, bytes) = oracle_send(&mut oracle, "alice", "me", &[n, 2]);
            assert_eq!(kind, "whisper");
            assert_eq!(me.receive(&kind, &bytes).unwrap(), [n, 2]);
        }
    }
}

#[test]
#[ignore = "needs RV_SIGNAL_ORACLE"]
fn we_initiate_and_the_oracle_answers() {
    let mut oracle = Oracle::start();
    for with_prekey in [true, false] {
        let mut me = Me::new(30);
        oracle_party(&mut oracle, "bob", 40);
        let bundle = oracle.ok(json!({"op": "bundle", "name": "bob", "prekey_id": if with_prekey { json!(42) } else { Value::Null }}));
        me.record
            .initiate(&me.local, &bundle_from_json(&bundle), &mut rand::rng())
            .unwrap();
        for n in 0..3u8 {
            let (kind, bytes) = me.send(&[n]);
            assert_eq!(kind, "prekey");
            assert_eq!(
                oracle_receive(&mut oracle, "bob", "me", &kind, &bytes).unwrap(),
                [n]
            );
        }
        for n in 0..10u8 {
            let (kind, bytes) = oracle_send(&mut oracle, "bob", "me", &[n, 1]);
            assert_eq!(me.receive(&kind, &bytes).unwrap(), [n, 1]);
            let (kind, bytes) = me.send(&[n, 2]);
            assert_eq!(kind, "whisper");
            assert_eq!(
                oracle_receive(&mut oracle, "bob", "me", &kind, &bytes).unwrap(),
                [n, 2]
            );
        }
    }
}

#[test]
#[ignore = "needs RV_SIGNAL_ORACLE"]
fn out_of_order_both_ways() {
    let mut oracle = Oracle::start();
    let mut me = Me::new(50);
    oracle_party(&mut oracle, "carol", 60);
    oracle.ok(json!({"op": "process_bundle", "name": "carol", "peer": "me", "bundle": me.bundle_json(true), "base_private": Value::Null}));
    let (kind, bytes) = oracle_send(&mut oracle, "carol", "me", b"hi");
    me.receive(&kind, &bytes).unwrap();
    let theirs: Vec<_> = (0..6u8)
        .map(|n| oracle_send(&mut oracle, "carol", "me", &[n]))
        .collect();
    for i in [0, 3, 1, 5, 2, 4] {
        assert_eq!(me.receive(&theirs[i].0, &theirs[i].1).unwrap(), [i as u8]);
    }
    assert!(matches!(
        me.receive(&theirs[1].0, &theirs[1].1),
        Err(Error::DuplicatedMessage(_))
    ));
    let mine: Vec<_> = (0..6u8).map(|n| me.send(&[n])).collect();
    for i in [5, 0, 2, 1, 4, 3] {
        assert_eq!(
            oracle_receive(&mut oracle, "carol", "me", &mine[i].0, &mine[i].1).unwrap(),
            [i as u8]
        );
    }
    assert!(oracle_receive(&mut oracle, "carol", "me", &mine[2].0, &mine[2].1).is_err());
}

#[test]
#[ignore = "needs RV_SIGNAL_ORACLE"]
fn group_messages_both_ways() {
    let mut oracle = Oracle::start();
    oracle_party(&mut oracle, "dave", 70);
    let skdm = oracle.ok(json!({"op": "sk_distribution", "name": "dave", "group": "g1", "chain_id": Value::Null, "chain_seed": Value::Null, "signing_private": Value::Null}));
    let mut theirs = SenderKeyRecord::default();
    theirs.process(&SenderKeyDistributionMessage::deserialize(&unhex(&skdm["skdm"])).unwrap());
    let sent: Vec<_> = (0..5u8)
        .map(|n| unhex(&oracle.ok(json!({"op": "group_encrypt", "name": "dave", "group": "g1", "plaintext": hex(&[n])}))["ciphertext"]))
        .collect();
    for i in [0, 2, 1, 4, 3] {
        assert_eq!(
            theirs.decrypt(&sent[i]).unwrap(),
            [i as u8],
            "their group message {i}"
        );
    }
    let mut mine = SenderKeyRecord::default();
    let distribution = mine.distribution(&mut rand::rng());
    oracle.ok(json!({"op": "sk_process", "name": "dave", "group": "g1", "sender": "me", "skdm": hex(distribution.serialized())}));
    let sent: Vec<_> = (0..5u8)
        .map(|n| mine.encrypt(&[n], &mut rand::rng()).unwrap())
        .collect();
    for i in [4, 0, 3, 1, 2] {
        let out = oracle.ok(json!({"op": "group_decrypt", "name": "dave", "group": "g1", "sender": "me", "ciphertext": hex(&sent[i])}));
        assert_eq!(unhex(&out["plaintext"]), [i as u8], "my group message {i}");
    }
}
