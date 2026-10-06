use super::*;
use crate::identity::Issuer;

const NOW: u64 = 1_800_000_000;

#[test]
fn the_history_code_is_distinct_from_the_identity_code_and_checked() {
    let code = HistoryCode::generate().unwrap();
    let text = code.for_display();
    assert_eq!(text.len(), 78);
    assert!(text.starts_with("rvh1-"));
    assert!(HistoryCode::from_code(&text).is_ok());
    assert!(HistoryCode::from_code(&text.to_uppercase().replacen("RVH1", "rvh1", 1)).is_ok());
    // An identity code, a typo and a wrong checksum are refused.
    assert!(HistoryCode::from_code(&text.replacen("rvh1", "rvk1", 1)).is_err());
    let mut typo = text.to_string();
    typo.replace_range(10..11, if &typo[10..11] == "0" { "1" } else { "0" });
    assert!(HistoryCode::from_code(&typo).is_err());
}

#[test]
fn the_key_package_opens_only_with_its_code_and_root() {
    let issuer = Issuer::generate("instance", "alice").unwrap();
    let other = Issuer::generate("instance", "mallory").unwrap();
    let key = HistoryKey::generate().unwrap();
    let code = HistoryCode::generate().unwrap();
    let package = key.seal(&code, issuer.root(), NOW).unwrap();
    let package = KeyPackage::from_bytes(&package.to_bytes().unwrap()).unwrap();
    let opened = HistoryKey::open(&package, &code, issuer.root()).unwrap();
    assert_eq!(opened.generation, key.generation);
    assert_eq!(*opened.key, *key.key);
    assert!(HistoryKey::open(&package, &HistoryCode::generate().unwrap(), issuer.root()).is_err());
    assert!(HistoryKey::open(&package, &code, other.root()).is_err());
    let mut moved = package.clone();
    moved.header.created_at += 1;
    assert!(HistoryKey::open(&moved, &code, issuer.root()).is_err());
    // Period secrets differ per period and per generation.
    let crypto = openmls_rust_crypto::OpenMlsRustCrypto::default();
    let crypto = openmls_traits::OpenMlsProvider::crypto(&crypto);
    let period = |room: &str| Period {
        scope: rv_crypto_public::groups::Scope {
            instance: "instance".into(),
            data_epoch: "epoch".into(),
            room: room.into(),
            incarnation: [3; 16],
        },
        grant: rv_crypto_public::groups::Member {
            user: "alice".into(),
            access_version: "access".into(),
            activation_version: "activation".into(),
        },
        admission: [7; 32],
        device: "desktop".into(),
        incarnation: [1; 16],
    };
    let general = key.period_secret(crypto, &period("general")).unwrap();
    assert_eq!(
        *general,
        *opened.period_secret(crypto, &period("general")).unwrap()
    );
    assert_ne!(
        *general,
        *key.period_secret(crypto, &period("private")).unwrap()
    );
    assert_ne!(
        *general,
        *HistoryKey::generate()
            .unwrap()
            .period_secret(crypto, &period("general"))
            .unwrap()
    );
}

/// Public vector: Alice's desktop publishes a history key generation and backs
/// up two of Bob's messages (one a thread reply). `RV_WRITE_HISTORY_BACKUP_VECTOR=1`
/// regenerates it; the Node verifier checks it independently.
#[test]
fn public_history_backup_vector_opens_with_its_code() {
    use crate::history::tests::{NOW as AT, device, document, grant, scope};
    use crate::history::{Record, chain, material, open_record, seal_record};
    use crate::vault::Records;
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../rv-crypto-public/fixtures/history-backup-v1.json");
    let provider = openmls_rust_crypto::OpenMlsRustCrypto::default();
    let crypto = openmls_traits::OpenMlsProvider::crypto(&provider);
    if std::env::var_os("RV_WRITE_HISTORY_BACKUP_VECTOR").is_some() {
        let alice = Issuer::generate("instance", "alice").unwrap();
        let desktop = device(&alice, "desktop", &mut Records::new());
        let bob = Issuer::generate("instance", "bob").unwrap();
        let laptop = device(&bob, "laptop", &mut Records::new());
        let certificate = crate::identity::Certificate::from_credential(
            &desktop.credential(AT).unwrap().credential,
        )
        .unwrap();
        let key = HistoryKey::generate().unwrap();
        let code = HistoryCode::generate().unwrap();
        let package = key.seal(&code, alice.root(), AT).unwrap();
        let publication = publish(
            &desktop,
            PublicationBody {
                version: 1,
                scope: rv_crypto_public::recovery::Scope {
                    instance: "instance".into(),
                    data_epoch: "epoch".into(),
                },
                operation: "fixture-history-key".into(),
                device: "desktop".into(),
                incarnation: certificate.device.incarnation,
                device_revision: "1".into(),
                expected_revision: None,
                package_digest: package.digest().unwrap(),
            },
            package,
            AT,
        )
        .unwrap();
        let period = Period {
            scope: scope("general"),
            grant: grant("alice"),
            admission: [7; 32],
            device: "desktop".into(),
            incarnation: certificate.device.incarnation,
        };
        let secret = key.period_secret(crypto, &period).unwrap();
        let mut reply = document(&laptop, "general", 2);
        reply.origin.header.thread = Some("general-root".into());
        reply.message.reply_to = Some("general-root".into());
        let records = [document(&laptop, "general", 1), reply]
            .iter()
            .enumerate()
            .map(|(index, d)| {
                let (k, id, nonce) = material(crypto, &secret, index as u64 + 1).unwrap();
                seal_record(&desktop, d, AT, &k, id, nonce).unwrap()
            })
            .collect::<Vec<_>>();
        let checkpoint = checkpoint(
            &desktop,
            CheckpointBody {
                version: 1,
                generation: key.generation,
                period,
                count: 2,
                first: records[0].header.origin.position,
                last: records[1].header.origin.position,
                chain: chain(records.iter().map(|r| r.digest().unwrap())).unwrap(),
            },
            AT,
        )
        .unwrap();
        let text = |bytes: Vec<u8>| String::from_utf8(bytes).unwrap();
        let vector = format!(
            "{{\"code\":\"{}\",\"certificate\":{},\"publication\":{},\"checkpoint\":{},\"records\":[{}]}}\n",
            code.for_display().as_str(),
            text(serde_json::to_vec(&certificate).unwrap()),
            text(publication.to_bytes().unwrap()),
            text(checkpoint.to_bytes().unwrap()),
            records
                .iter()
                .map(|r| text(r.to_bytes().unwrap()))
                .collect::<Vec<_>>()
                .join(","),
        );
        std::fs::write(&path, vector).unwrap();
    }
    #[derive(serde::Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Vector {
        code: String,
        certificate: crate::identity::Certificate,
        publication: Publication,
        checkpoint: Checkpoint,
        records: Vec<Record>,
    }
    let vector: Vector = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    vector.publication.verify(&vector.certificate).unwrap();
    vector.checkpoint.verify().unwrap();
    let root = &vector.publication.package.header.root;
    let key = HistoryKey::open(
        &vector.publication.package,
        &HistoryCode::from_code(&vector.code).unwrap(),
        root,
    )
    .unwrap();
    let secret = key
        .period_secret(crypto, &vector.checkpoint.body.period)
        .unwrap();
    let texts = vector
        .records
        .iter()
        .enumerate()
        .map(|(index, record)| {
            record.authenticate().unwrap();
            let (k, _, _) = material(crypto, &secret, index as u64 + 1).unwrap();
            open_record(record, &k).unwrap().text
        })
        .collect::<Vec<_>>();
    assert_eq!(
        texts,
        ["recovered words general 1", "recovered words general 2"]
    );
    assert_eq!(
        chain(vector.records.iter().map(|r| r.digest().unwrap())).unwrap(),
        vector.checkpoint.body.chain
    );
}
