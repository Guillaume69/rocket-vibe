use rv_crypto_public::recovery::{PUBLICATION_LIMIT, Publication};
#[test]
fn root_signed_backup_vector_verifies_exact_revisions_and_refuses_substitution() {
    let bytes = include_bytes!("../fixtures/root-backup-publication-v1.json");
    let original = Publication::from_bytes(bytes).unwrap();
    assert_eq!(original.body.device_revision, "9007199254740993");
    assert_eq!(
        original.body.expected_revision.as_deref(),
        Some("9007199254740992")
    );
    for changed in [
        {
            let mut p = original.clone();
            p.packet.nonce[0] ^= 1;
            p
        },
        {
            let mut p = original.clone();
            p.packet.ciphertext[0] ^= 1;
            p.body.packet_digest = p.packet.digest().unwrap();
            p
        },
        {
            let mut p = original.clone();
            p.body.scope.data_epoch = "foreign".into();
            p
        },
        {
            let mut p = original.clone();
            p.body.device = "other".into();
            p
        },
        {
            let mut p = original.clone();
            p.body.expected_revision = None;
            p
        },
        {
            let mut p = original.clone();
            p.packet.header.root.user = "other".into();
            p
        },
    ] {
        assert!(changed.verify().is_err());
    }
    for field in ["recovery_code", "private_key", "seed", "plaintext"] {
        let mut changed = serde_json::to_value(&original).unwrap();
        changed[field] = serde_json::json!("forbidden");
        assert!(Publication::from_bytes(&serde_json::to_vec(&changed).unwrap()).is_err());
    }
    assert!(Publication::from_bytes(&vec![b' '; PUBLICATION_LIMIT + 1]).is_err());
    let mut changed = serde_json::to_value(&original).unwrap();
    changed["body"]["device_revision"] = serde_json::json!(9007199254740993u64);
    assert!(Publication::from_bytes(&serde_json::to_vec(&changed).unwrap()).is_err());
}
