use super::*;

fn pattern(bytes: usize) -> Vec<u8> {
    (0..bytes).map(|i| (i % 251) as u8).collect()
}
fn sealed(plain: &[u8]) -> (Sealed, Vec<u8>) {
    let mut object = Vec::new();
    let sealed = seal(plain, &mut object).unwrap();
    (sealed, object)
}
fn opened(sealed: &Sealed, object: &[u8]) -> Result<Vec<u8>> {
    let mut plain = Vec::new();
    open(
        &sealed.key,
        sealed.bytes,
        &sealed.sha256,
        object,
        &mut plain,
    )?;
    Ok(plain)
}

#[test]
fn files_of_every_chunk_boundary_round_trip_with_exact_sizes() {
    for bytes in [0, 1, CHUNK - 1, CHUNK, CHUNK + 1, 3 * CHUNK, 200_000] {
        let plain = pattern(bytes);
        let (sealed, object) = sealed(&plain);
        assert_eq!(sealed.bytes, bytes as u64);
        assert_eq!(object.len() as u64, object_size(bytes as u64));
        assert_eq!(sealed.object_bytes, object.len() as u64);
        assert_eq!(
            sealed.object_sha256.as_slice(),
            Sha256::digest(&object).as_slice()
        );
        assert_eq!(sealed.sha256.as_slice(), Sha256::digest(&plain).as_slice());
        assert_eq!(opened(&sealed, &object).unwrap(), plain);
    }
    assert_eq!(object_size(0), 23 + 16);
    assert_eq!(object_size(104_831_977), MAX_OBJECT);
    assert!(object_size(104_831_978) > MAX_OBJECT);
}

#[test]
fn a_changed_truncated_extended_or_misdescribed_object_never_opens() {
    let plain = pattern(2 * CHUNK);
    let (sealed, object) = sealed(&plain);
    let mut flipped = object.clone();
    flipped[100] ^= 1;
    let mut magic = object.clone();
    magic[0] = b'X';
    // Dropping the last chunk leaves a valid first chunk not flagged last.
    let truncated = object[..object.len() - (CHUNK + 16)].to_vec();
    let mut extended = object.clone();
    extended.push(0);
    for bad in [flipped, magic, truncated, extended, Vec::new()] {
        assert!(opened(&sealed, &bad).is_err());
    }
    let mut plain_out = Vec::new();
    let mut wrong_sha = sealed.sha256;
    wrong_sha[0] ^= 1;
    assert!(
        open(
            &sealed.key,
            sealed.bytes,
            &wrong_sha,
            object.as_slice(),
            &mut plain_out
        )
        .is_err()
    );
    for bytes in [sealed.bytes - 1, sealed.bytes + 1, 0] {
        assert!(
            open(
                &sealed.key,
                bytes,
                &sealed.sha256,
                object.as_slice(),
                &mut Vec::new()
            )
            .is_err()
        );
    }
    let other = Zeroizing::new([7u8; 32]);
    assert!(
        open(
            &other,
            sealed.bytes,
            &sealed.sha256,
            object.as_slice(),
            &mut Vec::new()
        )
        .is_err()
    );
    assert!(matches!(
        open(
            &sealed.key,
            104_831_978,
            &sealed.sha256,
            object.as_slice(),
            &mut Vec::new()
        ),
        Err(Error::TooLarge)
    ));
    // Keys and digests have one text form.
    assert_eq!(*decode_key(&sealed.key_text()).unwrap(), *sealed.key);
    assert!(decode_key("short").is_err());
    assert_eq!(decode_sha256(&sealed.sha256_text()).unwrap(), sealed.sha256);
    assert!(decode_sha256(&sealed.sha256_text().to_uppercase()).is_err());
}

#[test]
fn paths_go_through_a_private_partial_file_published_only_when_valid() {
    let directory = tempfile::tempdir().unwrap();
    let source = directory.path().join("source.bin");
    let object = directory.path().join("object.rvf");
    let target = directory.path().join("target.bin");
    std::fs::write(&source, pattern(CHUNK + 5)).unwrap();
    let sealed = seal_path(&source, &object).unwrap();
    open_path(&sealed.key, sealed.bytes, &sealed.sha256, &object, &target).unwrap();
    assert_eq!(std::fs::read(&target).unwrap(), pattern(CHUNK + 5));
    std::fs::remove_file(&target).unwrap();
    let mut wrong = sealed.sha256;
    wrong[3] ^= 1;
    assert!(open_path(&sealed.key, sealed.bytes, &wrong, &object, &target).is_err());
    assert!(!target.exists() && !target.with_extension("part").exists());
}

/// Public vector: a fixed key and prefix over a two-chunk pattern and an empty
/// file. `RV_WRITE_FILE_VECTOR=1` regenerates it; the Node verifier rebuilds
/// both objects independently.
#[test]
fn public_file_vector_matches_the_format() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../rv-crypto-public/fixtures/file-v1.json");
    let key = Zeroizing::new(core::array::from_fn::<u8, 32, _>(|i| i as u8));
    let prefix = core::array::from_fn::<u8, PREFIX, _>(|i| 0xa0 + i as u8);
    let case = |bytes: usize| {
        let mut object = Vec::new();
        let sealed =
            seal_with(key.clone(), prefix, pattern(bytes).as_slice(), &mut object).unwrap();
        serde_json::json!({
            "bytes": sealed.bytes.to_string(),
            "sha256": sealed.sha256_text(),
            "object_bytes": sealed.object_bytes.to_string(),
            "object_sha256": sealed.object_sha256_text(),
            "object_head": HEXLOWER.encode(&object[..64.min(object.len())]),
        })
    };
    let vector = serde_json::json!({
        "format": "rv-file-v1",
        "key": encode_key(&key),
        "prefix": HEXLOWER.encode(&prefix),
        "plaintext": "byte i is i mod 251",
        "cases": [case(CHUNK + 300), case(0), case(CHUNK)],
    });
    let text = serde_json::to_string(&vector).unwrap() + "\n";
    if std::env::var_os("RV_WRITE_FILE_VECTOR").is_some() {
        std::fs::write(&path, &text).unwrap();
    }
    // Parsed, so a checkout with other line endings compares equal.
    let stored: serde_json::Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    assert_eq!(stored, vector);
}

#[test]
fn absurd_sizes_saturate_and_a_target_name_never_meets_its_object() {
    assert!(object_size(u64::MAX) > MAX_OBJECT);
    assert!(object_size(18_442_241_573_325_638_960) > MAX_OBJECT);
    // A target named so that `with_extension("part")` would be the object.
    let directory = tempfile::tempdir().unwrap();
    let source = directory.path().join("source.bin");
    let object = directory.path().join("object.0.part");
    let target = directory.path().join("object.0.bin");
    std::fs::write(&source, pattern(1000)).unwrap();
    let sealed = seal_path(&source, &object).unwrap();
    open_path(&sealed.key, sealed.bytes, &sealed.sha256, &object, &target).unwrap();
    assert_eq!(std::fs::read(&target).unwrap(), pattern(1000));
    assert!(object.exists());
}
