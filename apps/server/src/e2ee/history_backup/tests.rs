use super::history_shares::{group_scope, owner, record};
use super::*;
use rv_crypto_public::{
    groups::Member,
    history::{Record, chain_next, chain_start},
    history_backup::{
        Checkpoint, CheckpointBody, KeyHeader, KeyPackage, Period, Publication, PublicationBody,
    },
    recovery::Scope as PublicScope,
};

// Packages and records are signed but opaque: the server never decrypts, and
// the private SDK exercises the real sealing.
fn publish_input(keys: &Client, expected: Option<&str>, generation: u8) -> wire::PublishHistoryKey {
    let package = KeyPackage {
        header: KeyHeader {
            version: 1,
            root: keys.root.clone(),
            generation: [generation; 16],
            created_at: Utc::now().timestamp() as u64,
        },
        nonce: random_bytes(),
        ciphertext: vec![9; 96],
    };
    let body = PublicationBody {
        version: 1,
        scope: PublicScope {
            instance: keys.registration.scope.instance_id.clone(),
            data_epoch: keys.registration.scope.data_epoch.clone(),
        },
        operation: auth::random_token(),
        device: keys.certificate.device.device.clone(),
        incarnation: keys.certificate.device.incarnation,
        device_revision: "1".into(),
        expected_revision: expected.map(str::to_owned),
        package_digest: package.digest().unwrap(),
    };
    let publication = Publication {
        signature: keys.leaf.sign(&body.signing_bytes().unwrap()).unwrap(),
        body,
        package,
    };
    wire::PublishHistoryKey {
        scope: keys.registration.scope.clone(),
        operation_id: publication.body.operation.clone(),
        publication: B64.encode(&publication.to_bytes().unwrap()),
    }
}
fn period(keys: &Client, room: &str) -> Period {
    Period {
        scope: group_scope(keys, room),
        grant: Member {
            user: keys.certificate.device.root.user.clone(),
            access_version: "access".into(),
            activation_version: "activation".into(),
        },
        admission: [7; 32],
        device: keys.certificate.device.device.clone(),
        incarnation: keys.certificate.device.incarnation,
    }
}
/// The upload of `records` after `held`, with the checkpoint signed after them.
fn upload_input(
    keys: &Client,
    generation: u8,
    period: &Period,
    held: &[Record],
    records: &[Record],
) -> wire::UploadHistoryBackup {
    let all = held.iter().chain(records).collect::<Vec<_>>();
    let mut chain = chain_start().unwrap();
    for record in &all {
        chain = chain_next(chain, record.digest().unwrap()).unwrap();
    }
    let mut checkpoint = Checkpoint {
        body: CheckpointBody {
            version: 1,
            generation: [generation; 16],
            period: period.clone(),
            count: all.len() as u64,
            first: all[0].header.origin.position,
            last: all.last().unwrap().header.origin.position,
            chain,
        },
        certificate: keys.certificate.clone(),
        signature: Vec::new(),
    };
    checkpoint.signature = keys
        .leaf
        .sign(&checkpoint.signing_bytes().unwrap())
        .unwrap();
    wire::UploadHistoryBackup {
        scope: keys.registration.scope.clone(),
        start: held.len().to_string(),
        records: records
            .iter()
            .map(|r| B64.encode(&r.to_bytes().unwrap()))
            .collect(),
        checkpoint: B64.encode(&checkpoint.to_bytes().unwrap()),
    }
}
fn period_id(period: &Period, generation: u8) -> String {
    hex(&period.id(&[generation; 16]).unwrap())
}

#[sqlx::test]
async fn a_generation_is_published_once_by_compare_and_swap_and_settles_cancellations(
    pool: PgPool,
) {
    let app = App::from_pool(pool).await.unwrap();
    let o = owner(&app, "backup-key-owner").await;
    let first = publish_input(&o.desktop_keys, None, 1);
    let receipt = history_backup::publish(&app, &o.desktop, first.clone())
        .await
        .unwrap();
    assert_eq!(receipt.generation_revision, "1");
    assert_eq!(receipt.generation, hex(&[1; 16]));
    // A lost response: the same intent returns the same receipt.
    assert_eq!(
        history_backup::publish(&app, &o.desktop, first.clone())
            .await
            .unwrap()
            .package_digest,
        receipt.package_digest
    );
    assert_eq!(
        history_backup::operation(&app, &o.desktop, &first.operation_id)
            .await
            .unwrap()
            .generation_revision,
        "1"
    );
    // Any registered device of the account may rotate, against the active revision.
    rejected(
        history_backup::publish(&app, &o.phone, publish_input(&o.phone_keys, None, 2)).await,
        "history_key_revision_conflict",
    );
    let rotated =
        history_backup::publish(&app, &o.phone, publish_input(&o.phone_keys, Some("1"), 2))
            .await
            .unwrap();
    assert_eq!(rotated.generation_revision, "2");
    let active = history_backup::current(&app, &o.desktop)
        .await
        .unwrap()
        .active
        .unwrap();
    assert_eq!(active.receipt.generation, hex(&[2; 16]));
    // A device cannot publish with another device's signature.
    rejected(
        history_backup::publish(&app, &o.desktop, publish_input(&o.phone_keys, Some("2"), 3)).await,
        "crypto_proof_invalid",
    );
    // Cancelling an unsent intent settles it for good; an accepted one stays accepted.
    let abandoned = publish_input(&o.desktop_keys, Some("2"), 3);
    let wire::HistoryKeySettlement::Cancelled(_) =
        history_backup::cancel(&app, &o.desktop, &abandoned.operation_id, abandoned.clone())
            .await
            .unwrap()
    else {
        panic!("not cancelled")
    };
    rejected(
        history_backup::publish(&app, &o.desktop, abandoned).await,
        "history_key_cancelled",
    );
    let wire::HistoryKeySettlement::Accepted(_) =
        history_backup::cancel(&app, &o.desktop, &first.operation_id.clone(), first)
            .await
            .unwrap()
    else {
        panic!("accepted intent lost")
    };
    // Another account sees none of it.
    let (stranger, _) = actor(&app, "backup-key-stranger").await;
    assert!(
        history_backup::current(&app, &stranger)
            .await
            .unwrap()
            .active
            .is_none()
    );
}

#[sqlx::test]
async fn periods_grow_by_checked_pages_and_any_device_of_the_account_downloads_them(pool: PgPool) {
    let app = App::from_pool(pool).await.unwrap();
    let o = owner(&app, "backup-period-owner").await;
    history_backup::publish(&app, &o.desktop, publish_input(&o.desktop_keys, None, 1))
        .await
        .unwrap();
    let period = period(&o.desktop_keys, &o.room);
    let id = period_id(&period, 1);
    let records = (1..=5)
        .map(|p| record(&o.desktop_keys, &o.author, &o.room, 10 + p))
        .collect::<Vec<_>>();
    let first = upload_input(&o.desktop_keys, 1, &period, &[], &records[..3]);
    assert_eq!(
        history_backup::upload(&app, &o.desktop, &id, first.clone())
            .await
            .unwrap()
            .count,
        "3"
    );
    assert_eq!(
        history_backup::upload(&app, &o.desktop, &id, first)
            .await
            .unwrap()
            .count,
        "3"
    );
    // A gap, a wrong route, an unknown generation or another device's checkpoint is refused.
    rejected(
        history_backup::upload(
            &app,
            &o.desktop,
            &id,
            upload_input(&o.desktop_keys, 1, &period, &records[..4], &records[4..]),
        )
        .await,
        "history_record_gap",
    );
    rejected(
        history_backup::upload(
            &app,
            &o.desktop,
            &period_id(&period, 2),
            upload_input(&o.desktop_keys, 1, &period, &records[..3], &records[3..]),
        )
        .await,
        "crypto_proof_invalid",
    );
    let other_generation = period_id(&period, 7);
    rejected(
        history_backup::upload(
            &app,
            &o.desktop,
            &other_generation,
            upload_input(&o.desktop_keys, 7, &period, &[], &records[..1]),
        )
        .await,
        "not_found",
    );
    let phone_period = super::history_backups::period(&o.phone_keys, &o.room);
    rejected(
        history_backup::upload(
            &app,
            &o.desktop,
            &period_id(&phone_period, 1),
            upload_input(
                &o.phone_keys,
                1,
                &phone_period,
                &[],
                &[record(&o.phone_keys, &o.author, &o.room, 11)],
            ),
        )
        .await,
        "crypto_proof_invalid",
    );
    // The period grows; the listing carries its latest checkpoint.
    assert_eq!(
        history_backup::upload(
            &app,
            &o.desktop,
            &id,
            upload_input(&o.desktop_keys, 1, &period, &records[..3], &records[3..]),
        )
        .await
        .unwrap()
        .count,
        "5"
    );
    let listed = history_backup::periods(&app, &o.phone, &hex(&[1; 16]), None)
        .await
        .unwrap();
    assert_eq!(listed.periods.len(), 1);
    let checkpoint =
        Checkpoint::from_bytes(&B64.decode(listed.periods[0].checkpoint.as_bytes()).unwrap())
            .unwrap();
    assert_eq!(checkpoint.body.count, 5);
    // The phone downloads every record; another account cannot.
    let page = history_backup::records(&app, &o.phone, &id, "0", 3)
        .await
        .unwrap();
    assert_eq!(page.records.len(), 3);
    assert_eq!(page.next.as_deref(), Some("3"));
    let rest = history_backup::records(&app, &o.phone, &id, "3", 3)
        .await
        .unwrap();
    assert_eq!(rest.records.len(), 2);
    assert_eq!(rest.next, None);
    let (stranger, _) = actor(&app, "backup-period-stranger").await;
    rejected(
        history_backup::records(&app, &stranger, &id, "0", 3).await,
        "not_found",
    );
    assert!(
        history_backup::periods(&app, &stranger, &hex(&[1; 16]), None)
            .await
            .unwrap()
            .periods
            .is_empty()
    );
    // Four generations a day: the fifth publication waits.
    for (expected, generation) in [("1", 2), ("2", 3), ("3", 4)] {
        history_backup::publish(
            &app,
            &o.phone,
            publish_input(&o.phone_keys, Some(expected), generation),
        )
        .await
        .unwrap();
    }
    rejected(
        history_backup::publish(&app, &o.phone, publish_input(&o.phone_keys, Some("4"), 5)).await,
        "history_key_limit",
    );
    let count = || async {
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM e2ee_history_backup_records")
            .fetch_one(&app.pool)
            .await
            .unwrap()
    };
    assert_eq!(count().await, 5);
    // A day later, a fifth generation drops the oldest one with its periods.
    sqlx::query("UPDATE e2ee_history_key_operations SET created_at=created_at-interval '2 days'")
        .execute(&app.pool)
        .await
        .unwrap();
    history_backup::publish(&app, &o.phone, publish_input(&o.phone_keys, Some("4"), 5))
        .await
        .unwrap();
    assert_eq!(count().await, 0);
}
