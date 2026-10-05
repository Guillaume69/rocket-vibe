use super::*;

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
} // Disposable test key.
fn create(path: &Path) -> Vault {
    let mut v = Vault::create(path, scope(), key()).unwrap();
    v.checkpoint_persisted(v.checkpoint()).unwrap();
    v
}
#[test]
fn blocks_exceed_snapshot_limit_and_reopen_beyond_sixty_four_without_plaintext_on_disk() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("private.sqlite");
    let mut v = create(&path);
    let bytes = Zeroizing::new(vec![73; 256 * 1024]);
    let (references, mark) = v
        .transact_with_blobs(|_, records, blobs| {
            let mut refs = Vec::new();
            for _ in 0..70 {
                refs.push(blobs.put(&bytes)?);
            }
            records.insert(
                "protected-block-index".into(),
                serde_json::to_vec(&refs).unwrap(),
            );
            Ok(refs)
        })
        .unwrap();
    assert!(v.inspect_with_blobs(|_, _, b| b.read(&references[0])).err() == Some(Error::Pending));
    v.checkpoint_persisted(mark).unwrap();
    drop(v);
    let v = Vault::open(&path, scope(), key(), mark).unwrap();
    v.inspect_with_blobs(|_, records, blobs| {
        let refs: Vec<Reference> =
            serde_json::from_slice(&records["protected-block-index"]).unwrap();
        assert!(refs == references);
        for reference in refs.iter().skip(64) {
            assert!(blobs.read(reference)?.as_slice() == bytes.as_slice());
        }
        Ok(())
    })
    .unwrap();
    let db = Connection::open(&path).unwrap();
    let state_size: i64 = db
        .query_row("SELECT length(ciphertext) FROM state", [], |r| r.get(0))
        .unwrap();
    assert!(
        state_size < 128 * 1024,
        "Only references belong in the main snapshot"
    );
    assert!(
        fs::read(&path)
            .unwrap()
            .windows(64)
            .all(|window| window != [73; 64])
    );
    if let Ok(wal) = fs::read(path.with_extension("sqlite-wal")) {
        assert!(wal.windows(64).all(|window| window != [73; 64]));
    }
}
#[test]
fn rejected_operation_rolls_back_blocks_references_and_mls_checkpoint_together() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("private.sqlite");
    let mut v = create(&path);
    let before = v.checkpoint();
    let result: Result<((), Checkpoint), Error> = v.transact_with_blobs(|_, records, blobs| {
        let reference = blobs.put(b"private fixture body")?;
        records.insert(
            "pending-reference".into(),
            serde_json::to_vec(&reference).unwrap(),
        );
        Err(Error::Rejected)
    });
    assert!(result.err() == Some(Error::Rejected));
    assert!(v.checkpoint() == before);
    v.inspect(|_, records| {
        assert!(!records.contains_key("pending-reference"));
        Ok(())
    })
    .unwrap();
    let count: i64 = Connection::open(&path)
        .unwrap()
        .query_row("SELECT count(*) FROM private_blobs", [], |r| r.get(0))
        .unwrap();
    assert_eq!(count, 0);
}
#[test]
fn missing_replaced_and_cross_scope_blocks_never_return_cleartext() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("private.sqlite");
    let mut v = create(&path);
    let (refs, mark) = v
        .transact_with_blobs(|_, records, b| {
            let a = b.put(b"first private fixture")?;
            let c = b.put(b"second private fixture")?;
            records.insert("refs".into(), serde_json::to_vec(&(a, c)).unwrap());
            Ok((a, c))
        })
        .unwrap();
    v.checkpoint_persisted(mark).unwrap();
    let db = Connection::open(&path).unwrap();
    db.execute("UPDATE private_blobs SET nonce=(SELECT nonce FROM private_blobs WHERE id=?),ciphertext=(SELECT ciphertext FROM private_blobs WHERE id=?) WHERE id=?",params![refs.1.id.as_slice(),refs.1.id.as_slice(),refs.0.id.as_slice()]).unwrap();
    assert!(v.inspect_with_blobs(|_, _, b| b.read(&refs.0)).err() == Some(Error::Integrity));
    let mut foreign = scope();
    foreign.user = "bob".into();
    let b = Access::new(&db, &foreign, &v.key);
    assert!(b.read(&refs.1).err() == Some(Error::Integrity));
    db.execute(
        "DELETE FROM private_blobs WHERE id=?",
        [refs.1.id.as_slice()],
    )
    .unwrap();
    assert!(v.inspect_with_blobs(|_, _, b| b.read(&refs.1)).err() == Some(Error::Integrity));
}
#[test]
fn table_upgrade_is_transactional_and_malicious_trigger_cannot_destroy_committed_new_blocks() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("legacy.sqlite");
    let mut v = create(&path);
    let db = Connection::open(&path).unwrap();
    db.execute_batch("DROP TABLE private_blobs;").unwrap();
    let (reference, mark) = v
        .transact_with_blobs(|_, r, b| {
            let reference = b.put(b"upgraded private fixture")?;
            r.insert("ref".into(), serde_json::to_vec(&reference).unwrap());
            Ok(reference)
        })
        .unwrap();
    v.checkpoint_persisted(mark).unwrap();
    assert!(v.inspect_with_blobs(|_, _, b| b.read(&reference)).is_ok());
    db.execute_batch(
        "CREATE TRIGGER corrupt_blocks AFTER UPDATE ON state BEGIN DELETE FROM private_blobs; END;",
    )
    .unwrap();
    let before = v.checkpoint();
    let result = v.transact_with_blobs(|_, r, b| {
        let reference = b.put(b"must not escape")?;
        r.insert("another".into(), serde_json::to_vec(&reference).unwrap());
        Ok(reference)
    });
    assert!(result.err() == Some(Error::Integrity));
    assert!(v.checkpoint() == before);
    assert!(v.inspect_with_blobs(|_, _, b| b.read(&reference)).is_ok());
}
#[test]
fn oversized_ciphertext_and_nonpristine_initialization_are_rejected() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("private.sqlite");
    let mut v = create(&path);
    assert!(
        v.transact_with_blobs(|_, _, b| b.put(&vec![0; LIMIT + 1]))
            .err()
            == Some(Error::Limit)
    );
    let (reference, mark) = v
        .transact_with_blobs(|_, r, b| {
            let reference = b.put(b"fixture")?;
            r.insert("ref".into(), serde_json::to_vec(&reference).unwrap());
            Ok(reference)
        })
        .unwrap();
    v.checkpoint_persisted(mark).unwrap();
    let db = Connection::open(&path).unwrap();
    db.execute(
        "UPDATE private_blobs SET ciphertext=zeroblob(?) WHERE id=?",
        params![(LIMIT + 17) as i64, reference.id.as_slice()],
    )
    .unwrap();
    assert!(v.inspect_with_blobs(|_, _, b| b.read(&reference)).err() == Some(Error::Integrity));
    let genesis = dir.path().join("genesis.sqlite");
    let initial = Vault::create(&genesis, scope(), key()).unwrap();
    drop(initial);
    Connection::open(&genesis)
        .unwrap()
        .execute(
            "INSERT INTO private_blobs(id,nonce,ciphertext) VALUES(?,zeroblob(24),zeroblob(16))",
            [[7_u8; 16].as_slice()],
        )
        .unwrap();
    assert!(Vault::recover_initial(&genesis, scope(), key()).err() == Some(Error::Integrity));
}

#[test]
fn rekeyed_blocks_keep_their_reference_and_any_change_is_refused() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("private.sqlite");
    let mut v = create(&path);
    let (reference, mark) = v
        .transact_with_blobs(|_, _, blobs| blobs.put(b"sealed before the rotation"))
        .unwrap();
    v.checkpoint_persisted(mark).unwrap();
    let mark = v.rotate(Key::from_keystore([7; 32]), |_| ()).unwrap();
    // Unusable until the rotation's checkpoint is protected.
    assert!(v.inspect_with_blobs(|_, _, b| b.read(&reference)).err() == Some(Error::Pending));
    v.checkpoint_persisted(mark).unwrap();
    v.scrub().unwrap();
    drop(v);
    // The old key opens nothing; the new one reads the same reference.
    assert!(Vault::open(&path, scope(), key(), mark).is_err());
    let v = Vault::open(&path, scope(), Key::from_keystore([7; 32]), mark).unwrap();
    let read = |v: &Vault| v.inspect_with_blobs(|_, _, b| b.read(&reference).map(|c| c.to_vec()));
    assert_eq!(read(&v).unwrap(), b"sealed before the rotation");
    let db = Connection::open(&path).unwrap();
    let marker: i64 = db
        .query_row("SELECT rekeyed FROM private_blobs", [], |r| r.get(0))
        .unwrap();
    assert_eq!(marker, 1);
    // A flipped byte, or a block claiming the old format, never opens.
    db.execute(
        "UPDATE private_blobs SET ciphertext=substr(ciphertext,1,10)||X'00'||substr(ciphertext,12)",
        [],
    )
    .unwrap();
    assert!(read(&v).is_err());
    db.execute("UPDATE private_blobs SET rekeyed=0", [])
        .unwrap();
    assert!(read(&v).is_err());
}

#[test]
fn blocks_written_before_rotations_existed_migrate_and_still_read() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("private.sqlite");
    let mut v = create(&path);
    let (reference, mark) = v
        .transact_with_blobs(|_, _, blobs| blobs.put(b"legacy block"))
        .unwrap();
    v.checkpoint_persisted(mark).unwrap();
    drop(v);
    // The previous schema had no rekeyed column.
    let db = Connection::open(&path).unwrap();
    db.execute_batch("CREATE TABLE legacy(id BLOB PRIMARY KEY CHECK(length(id)=16),nonce BLOB NOT NULL CHECK(length(nonce)=24),ciphertext BLOB NOT NULL); INSERT INTO legacy SELECT id,nonce,ciphertext FROM private_blobs; DROP TABLE private_blobs; ALTER TABLE legacy RENAME TO private_blobs;").unwrap();
    drop(db);
    let mut v = Vault::open(&path, scope(), key(), mark).unwrap();
    assert_eq!(
        v.inspect_with_blobs(|_, _, b| b.read(&reference).map(|c| c.to_vec()))
            .unwrap(),
        b"legacy block"
    );
    let mark = v.rotate(Key::from_keystore([8; 32]), |_| ()).unwrap();
    v.checkpoint_persisted(mark).unwrap();
    assert_eq!(
        v.inspect_with_blobs(|_, _, b| b.read(&reference).map(|c| c.to_vec()))
            .unwrap(),
        b"legacy block"
    );
}
