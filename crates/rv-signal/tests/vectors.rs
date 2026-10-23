//! Recorded runs of the independent implementation (`tests/oracle.rs`),
//! replayed here with both parties played by this crate. Every key in them is
//! scripted, so pairwise ciphertexts and distribution messages must come out
//! byte for byte, and randomness must be drawn exactly where the recording
//! drew it. Signatures are checked by verification: the nonce derivation and
//! sign-bit encoding may legitimately differ.

use std::collections::HashMap;

use rv_signal::*;
use serde_json::Value;

/// Hands out the scripted bytes, then refuses: drawing more, or fewer, than
/// the recording did is a failure.
struct Scripted(Vec<u8>);

impl rand_core::TryRng for Scripted {
    type Error = std::convert::Infallible;
    fn try_next_u32(&mut self) -> std::result::Result<u32, Self::Error> {
        unreachable!("only fill_bytes is used")
    }
    fn try_next_u64(&mut self) -> std::result::Result<u64, Self::Error> {
        unreachable!("only fill_bytes is used")
    }
    fn try_fill_bytes(&mut self, dst: &mut [u8]) -> std::result::Result<(), Self::Error> {
        assert!(
            dst.len() <= self.0.len(),
            "drew {} random bytes, {} were scripted",
            dst.len(),
            self.0.len()
        );
        dst.copy_from_slice(&self.0[..dst.len()]);
        self.0.drain(..dst.len());
        Ok(())
    }
}
impl rand_core::TryCryptoRng for Scripted {}

fn bytes(v: &Value) -> Vec<u8> {
    hex::decode(v.as_str().expect("hex")).expect("valid hex")
}

fn key32(v: &Value) -> [u8; 32] {
    bytes(v).try_into().expect("32 bytes")
}

fn scripted(v: &Value) -> Scripted {
    Scripted(if v.is_null() { Vec::new() } else { bytes(v) })
}

fn uint(v: &Value) -> u32 {
    v.as_u64().expect("number") as u32
}

struct Party {
    local: LocalIdentity,
    signed_prekey_id: u32,
    signed_prekey: KeyPair,
    prekeys: HashMap<u32, KeyPair>,
}

#[derive(Default)]
struct World {
    parties: HashMap<String, Party>,
    sessions: HashMap<(String, String), SessionRecord>,
    sender_keys: HashMap<(String, String, String), SenderKeyRecord>,
}

fn error_name(e: &Error) -> &'static str {
    match e {
        Error::BadMac => "BadMac",
        Error::DuplicatedMessage(_) => "DuplicatedMessage",
        Error::InvalidProtobuf(_) | Error::InvalidMessage(_) => "InvalidProtobufEncoding",
        Error::BadSignature => "SignatureValidationFailed",
        Error::NoSession => "SessionNotFound",
        Error::NoSenderKey => "NoSenderKeyState",
        _ => "other",
    }
}

fn check<T>(step: &str, got: Result<T>, expected: &Value, on_ok: impl FnOnce(T, &Value)) {
    match (got, expected.get("ok"), expected.get("err")) {
        (Ok(value), Some(ok), _) => on_ok(value, ok),
        (Err(e), _, Some(err)) => assert_eq!(error_name(&e), err.as_str().unwrap(), "{step}: {e}"),
        (Ok(_), _, _) => panic!("{step}: succeeded, the recording failed with {expected}"),
        (Err(e), _, _) => panic!("{step}: failed with {e}, the recording succeeded"),
    }
}

impl World {
    fn step(&mut self, step: &str, request: &Value, response: &Value) {
        let name = request["name"].as_str().unwrap_or_default().to_owned();
        match request["op"].as_str().unwrap() {
            "party" => {
                let ok = &response["ok"];
                let identity = KeyPair::from_private(PrivateKey::from_bytes(key32(
                    &request["identity_private"],
                )));
                assert_eq!(
                    identity.public.serialize().to_vec(),
                    bytes(&ok["identity_public"]),
                    "{step}"
                );
                let spk = &request["signed_prekey"];
                let signed_prekey =
                    KeyPair::from_private(PrivateKey::from_bytes(key32(&spk["private"])));
                assert_eq!(
                    signed_prekey.public.serialize().to_vec(),
                    bytes(&ok["signed_prekey_public"]),
                    "{step}"
                );
                let signature: [u8; 64] = bytes(&ok["signed_prekey_signature"]).try_into().unwrap();
                assert!(
                    identity
                        .public
                        .verify(&signed_prekey.public.serialize(), &signature),
                    "{step}"
                );
                let mut prekeys = HashMap::new();
                for (p, out) in request["prekeys"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .zip(ok["prekeys"].as_array().unwrap())
                {
                    let pair = KeyPair::from_private(PrivateKey::from_bytes(key32(&p["private"])));
                    assert_eq!(
                        pair.public.serialize().to_vec(),
                        bytes(&out["public"]),
                        "{step}"
                    );
                    prekeys.insert(uint(&p["id"]), pair);
                }
                let local = LocalIdentity {
                    identity,
                    registration_id: uint(&request["registration_id"]),
                };
                self.parties.insert(
                    name,
                    Party {
                        local,
                        signed_prekey_id: uint(&spk["id"]),
                        signed_prekey,
                        prekeys,
                    },
                );
            }
            "bundle" => {
                let party = &self.parties[&name];
                let ok = &response["ok"];
                assert_eq!(
                    uint(&ok["registration_id"]),
                    party.local.registration_id,
                    "{step}"
                );
                assert_eq!(
                    bytes(&ok["signed_prekey_public"]),
                    party.signed_prekey.public.serialize(),
                    "{step}"
                );
                if let Some(id) = request["prekey_id"].as_u64() {
                    assert_eq!(
                        bytes(&ok["prekey_public"]),
                        party.prekeys[&(id as u32)].public.serialize(),
                        "{step}"
                    );
                }
            }
            "process_bundle" => {
                let b = &request["bundle"];
                let bundle = PreKeyBundle {
                    registration_id: uint(&b["registration_id"]),
                    identity: PublicKey::deserialize(&bytes(&b["identity_public"])).unwrap(),
                    signed_prekey_id: uint(&b["signed_prekey_id"]),
                    signed_prekey: PublicKey::deserialize(&bytes(&b["signed_prekey_public"]))
                        .unwrap(),
                    signed_prekey_signature: bytes(&b["signed_prekey_signature"])
                        .try_into()
                        .unwrap(),
                    prekey: b["prekey_id"].as_u64().map(|id| {
                        (
                            id as u32,
                            PublicKey::deserialize(&bytes(&b["prekey_public"])).unwrap(),
                        )
                    }),
                };
                let base =
                    KeyPair::from_private(PrivateKey::from_bytes(key32(&request["base_private"])));
                let mut rng = scripted(&request["ratchet_private"]);
                let local = self.parties[&name].local.clone();
                let peer = request["peer"].as_str().unwrap().to_owned();
                let record = self.sessions.entry((name, peer)).or_default();
                check(
                    step,
                    record.initiate_with_base_key(&local, &bundle, base, &mut rng),
                    response,
                    |_, _| {},
                );
                assert!(rng.0.is_empty(), "{step}: scripted ratchet key left unused");
            }
            "encrypt" => {
                let peer = request["peer"].as_str().unwrap().to_owned();
                let record = self.sessions.get_mut(&(name, peer)).expect("session");
                check(
                    step,
                    record.encrypt(&bytes(&request["plaintext"])),
                    response,
                    |(kind, ciphertext), ok| {
                        let expected = if kind == Kind::PreKey {
                            "prekey"
                        } else {
                            "whisper"
                        };
                        assert_eq!(ok["type"], expected, "{step}");
                        assert_eq!(
                            hex::encode(ciphertext),
                            ok["ciphertext"].as_str().unwrap(),
                            "{step}: ciphertext"
                        );
                    },
                );
            }
            "decrypt" => {
                let peer = request["peer"].as_str().unwrap().to_owned();
                let mut rng = scripted(&request["ratchet_private"]);
                let party = self.parties.get_mut(&name).unwrap();
                let record = self.sessions.entry((name, peer)).or_default();
                let ciphertext = bytes(&request["ciphertext"]);
                let result = match request["type"].as_str().unwrap() {
                    "prekey" => PreKeySignalMessage::deserialize(&ciphertext).and_then(|message| {
                        let signed = (message.signed_prekey_id == party.signed_prekey_id)
                            .then_some(&party.signed_prekey);
                        let prekey = message.prekey_id.and_then(|id| party.prekeys.get(&id));
                        record.decrypt_prekey(&message, &party.local, signed, prekey, &mut rng)
                    }),
                    _ => record
                        .decrypt(&ciphertext, &mut rng)
                        .map(|plaintext| Decrypted {
                            plaintext,
                            used_prekey: None,
                        }),
                };
                check(step, result, response, |decrypted, ok| {
                    assert_eq!(
                        hex::encode(&decrypted.plaintext),
                        ok["plaintext"].as_str().unwrap(),
                        "{step}"
                    );
                    assert_eq!(
                        decrypted.used_prekey.map(u64::from),
                        ok["consumed_prekey_id"].as_u64(),
                        "{step}"
                    );
                    if let Some(id) = decrypted.used_prekey {
                        party.prekeys.remove(&id);
                    }
                });
                let unused = response
                    .get("unused_random_bytes")
                    .and_then(Value::as_u64)
                    .unwrap_or(0);
                if response.get("ok").is_some() {
                    assert_eq!(
                        rng.0.len() as u64,
                        unused,
                        "{step}: random bytes drawn differ from the recording"
                    );
                }
            }
            "export_session" => {}
            "sk_distribution" => {
                let mut record = SenderKeyRecord::default();
                let signing = KeyPair::from_private(PrivateKey::from_bytes(key32(
                    &request["signing_private"],
                )));
                record.create(
                    uint(&request["chain_id"]),
                    key32(&request["chain_seed"]),
                    signing,
                );
                let skdm = record.distribution(&mut Scripted(Vec::new()));
                assert_eq!(
                    hex::encode(skdm.serialized()),
                    response["ok"]["skdm"].as_str().unwrap(),
                    "{step}"
                );
                let group = request["group"].as_str().unwrap().to_owned();
                self.sender_keys.insert((name.clone(), group, name), record);
            }
            "sk_process" => {
                let message =
                    SenderKeyDistributionMessage::deserialize(&bytes(&request["skdm"])).unwrap();
                let (group, sender) = (
                    request["group"].as_str().unwrap(),
                    request["sender"].as_str().unwrap(),
                );
                let record = self
                    .sender_keys
                    .entry((name, group.to_owned(), sender.to_owned()))
                    .or_default();
                record.process(&message);
            }
            "group_encrypt" => {
                let group = request["group"].as_str().unwrap().to_owned();
                let record = self
                    .sender_keys
                    .get_mut(&(name.clone(), group, name))
                    .unwrap();
                let mut rng = scripted(&request["random"]);
                check(
                    step,
                    record.encrypt(&bytes(&request["plaintext"]), &mut rng),
                    response,
                    |ours, ok| {
                        let theirs = bytes(&ok["ciphertext"]);
                        assert_eq!(
                            ours[..ours.len() - 64],
                            theirs[..theirs.len() - 64],
                            "{step}: body"
                        );
                    },
                );
                assert!(rng.0.is_empty(), "{step}: scripted nonce left unused");
            }
            "group_decrypt" => {
                let (group, sender) = (
                    request["group"].as_str().unwrap(),
                    request["sender"].as_str().unwrap(),
                );
                let record = self
                    .sender_keys
                    .get_mut(&(name, group.to_owned(), sender.to_owned()))
                    .unwrap();
                check(
                    step,
                    record.decrypt(&bytes(&request["ciphertext"])),
                    response,
                    |plaintext, ok| {
                        assert_eq!(
                            hex::encode(plaintext),
                            ok["plaintext"].as_str().unwrap(),
                            "{step}"
                        );
                    },
                );
            }
            "public_key" => {
                let public = PrivateKey::from_bytes(key32(&request["private"])).public_key();
                assert_eq!(
                    public.serialize().to_vec(),
                    bytes(&response["ok"]["public"]),
                    "{step}"
                );
            }
            "agree" => {
                let private = PrivateKey::from_bytes(key32(&request["private"]));
                let public = PublicKey::deserialize(&bytes(&request["public"])).unwrap();
                assert_eq!(
                    private.agree(&public).unwrap().to_vec(),
                    bytes(&response["ok"]["shared"]),
                    "{step}"
                );
            }
            "sign" => {
                let public = PrivateKey::from_bytes(key32(&request["private"])).public_key();
                let signature: [u8; 64] = bytes(&response["ok"]["signature"]).try_into().unwrap();
                assert!(
                    public.verify(&bytes(&request["message"]), &signature),
                    "{step}"
                );
            }
            "verify" => {
                let public = PublicKey::deserialize(&bytes(&request["public"])).unwrap();
                let valid =
                    bytes(&request["signature"])
                        .try_into()
                        .is_ok_and(|signature: [u8; 64]| {
                            public.verify(&bytes(&request["message"]), &signature)
                        });
                assert_eq!(Value::Bool(valid), response["ok"]["valid"], "{step}");
            }
            op => panic!("{step}: unknown op {op}"),
        }
    }
}

#[test]
fn recorded_runs_replay() {
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/vectors");
    let mut files: Vec<_> = std::fs::read_dir(&dir)
        .unwrap()
        .map(|e| e.unwrap().path())
        .collect();
    files.sort();
    assert_eq!(files.len(), 7, "every recorded run is present");
    let mut steps = 0;
    for file in files {
        let run: Vec<Value> =
            serde_json::from_str(&std::fs::read_to_string(&file).unwrap()).unwrap();
        let mut world = World::default();
        for (i, entry) in run.iter().enumerate() {
            let step = format!("{} step {i}", file.file_name().unwrap().to_string_lossy());
            world.step(&step, &entry["request"], &entry["response"]);
            steps += 1;
        }
    }
    assert_eq!(steps, 109);
}
