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
