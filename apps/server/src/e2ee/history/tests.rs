use super::*;
use crate::store;
use rv_crypto_public::{
    Fingerprint,
    archive::Header,
    groups::{Member, Scope as GroupScope},
    history::{
        Envelope, Manifest, Period, Record, Request as HistoryRequest, RequestBody, Share, chain,
    },
    messages::{Header as MessageHeader, Kind, Receipt},
};
use rv_protocol::CreateRoom;

// Records and shares here are signed but carry opaque ciphertexts: the server
// never decrypts, and the private SDK exercises the real sealing.
pub(super) struct Owner {
    pub(super) desktop: Account,
    pub(super) desktop_keys: Client,
    pub(super) phone: Account,
    pub(super) phone_keys: Client,
    pub(super) author: Client,
    pub(super) room: String,
}
pub(super) async fn owner(app: &App, name: &str) -> Owner {
    let (desktop, _) = actor(app, name).await;
    let desktop_keys = client(app, &desktop, None).await;
    register(app, &desktop, desktop_keys.registration.clone())
        .await
        .unwrap();
    let (phone, _) = login(app, name).await;
    let phone_keys = client(
        app,
        &phone,
        Some((desktop_keys.root.clone(), desktop_keys.signing.clone())),
    )
    .await;
    let mut registration = phone_keys.registration.clone();
    registration.expected_root_fingerprint = Some(hex(&desktop_keys.root.fingerprint().unwrap()));
    register(app, &phone, registration).await.unwrap();
    // The author is another account; the server never checks its device.
    let (bob, _) = actor(app, &format!("{name}-author")).await;
    let author = client(app, &bob, None).await;
    let room = store::create_room(
        app,
        &desktop,
        CreateRoom {
            name: format!("history-{}", auth::random_token()),
            private: true,
            operation_id: None,
        },
    )
    .await
    .unwrap()
    .id;
    Owner {
        desktop,
        desktop_keys,
        phone,
        phone_keys,
        author,
        room,
    }
}
fn history_request(keys: &Client, lifetime: u64) -> wire::PublishHistoryRequest {
    let now = Utc::now().timestamp() as u64;
    let body = RequestBody {
        version: 1,
        certificate: keys.certificate.clone(),
        request_id: random_bytes(),
        recipient: random_bytes(),
        issued_at: now,
        expires_at: now + lifetime,
    };
    let signature = keys
        .leaf
        .sign(
            &rv_crypto_public::signing_bytes(rv_crypto_public::history::REQUEST_DOMAIN, &body)
                .unwrap(),
        )
        .unwrap();
    let request = HistoryRequest { body, signature };
    wire::PublishHistoryRequest {
        scope: keys.registration.scope.clone(),
        request: B64.encode(&request.to_bytes().unwrap()),
    }
}
pub(super) fn group_scope(keys: &Client, room: &str) -> GroupScope {
    GroupScope {
        instance: keys.registration.scope.instance_id.clone(),
        data_epoch: keys.registration.scope.data_epoch.clone(),
        room: room.into(),
        incarnation: [3; 16],
    }
}
pub(super) fn record(sharer: &Client, author: &Client, room: &str, position: u64) -> Record {
    let original = &author.certificate;
    let mut record = Record {
        header: Header {
            version: 1,
            origin: Receipt {
                header: MessageHeader {
                    version: 1,
                    scope: group_scope(sharer, room),
                    operation: format!("history-{position}"),
                    group_revision: 1,
                    epoch: 1,
                    group_fingerprint: [4; 32],
                    author: original.device.root.user.clone(),
                    device: original.device.device.clone(),
                    incarnation: original.device.incarnation,
                    certificate: original.fingerprint().unwrap(),
                    kind: Kind::Chat,
                    thread: None,
                    target: None,
                },
                fingerprint: [5; 32],
                message: format!("message-{position}"),
                position,
            },
            author_membership: Member {
                user: original.device.root.user.clone(),
                access_version: "access".into(),
                activation_version: "activation".into(),
            },
            key_id: random_bytes(),
            nonce: random_bytes(),
        },
        original_certificate: original.clone(),
        certificate: sharer.certificate.clone(),
        observed_at: Utc::now().timestamp() as u64,
        ciphertext: vec![7; 64],
        signature: Vec::new(),
    };
    record.signature = sharer.leaf.sign(&record.signing_bytes().unwrap()).unwrap();
    record
}
fn upload_input(keys: &Client, start: u64, records: &[Record]) -> wire::UploadHistoryRecords {
    wire::UploadHistoryRecords {
        scope: keys.registration.scope.clone(),
        period: 0,
        start: start.to_string(),
        records: records
            .iter()
            .map(|r| B64.encode(&r.to_bytes().unwrap()))
            .collect(),
    }
}
fn signed_share(
    keys: &Client,
    request: &str,
    room: &str,
    records: &[Record],
    envelope: u8,
) -> wire::CommitHistoryShare {
    let fingerprint: Fingerprint = data_encoding::HEXLOWER
        .decode(request.as_bytes())
        .unwrap()
        .try_into()
        .unwrap();
    let mut share = Share {
        manifest: Manifest {
            version: 1,
            request: fingerprint,
            periods: vec![Period {
                scope: group_scope(keys, room),
                grant: Member {
                    user: keys.certificate.device.root.user.clone(),
                    access_version: "access".into(),
                    activation_version: "activation".into(),
                },
                admission: [7; 32],
                first: records[0].header.origin.position,
                last: records.last().unwrap().header.origin.position,
                count: records.len() as u64,
                chain: chain(records.iter().map(|r| r.digest().unwrap())).unwrap(),
            }],
        },
        envelope: Envelope {
            kem_output: vec![envelope; 32],
            ciphertext: vec![2; 48],
        },
        certificate: keys.certificate.clone(),
        signature: Vec::new(),
    };
    share.signature = keys.leaf.sign(&share.signing_bytes().unwrap()).unwrap();
    wire::CommitHistoryShare {
        scope: keys.registration.scope.clone(),
        share: B64.encode(&share.to_bytes().unwrap()),
    }
}

#[sqlx::test]
async fn a_share_goes_from_one_device_to_its_sibling_once_and_idempotently(pool: PgPool) {
    let app = App::from_pool(pool).await.unwrap();
    let o = owner(&app, "history-owner").await;
    let input = history_request(&o.phone_keys, 3600);
    let entry = history::publish_request(&app, &o.phone, input.clone())
        .await
        .unwrap();
    let replay = history::publish_request(&app, &o.phone, input)
        .await
        .unwrap();
    assert_eq!(entry.fingerprint, replay.fingerprint);
    let listed = history::requests(&app, &o.desktop).await.unwrap();
    assert_eq!(listed.requests.len(), 1);
    assert_eq!(listed.requests[0].sharer_device_id, None);
    let request = entry.fingerprint.clone();
    let records = (1..=3)
        .map(|p| record(&o.desktop_keys, &o.author, &o.room, 10 + p))
        .collect::<Vec<_>>();
    // The requesting device cannot answer itself.
    rejected(
        history::upload(
            &app,
            &o.phone,
            &request,
            upload_input(&o.phone_keys, 0, &records[..1]),
        )
        .await,
        "history_own_request",
    );
    let first = upload_input(&o.desktop_keys, 0, &records[..2]);
    assert_eq!(
        history::upload(&app, &o.desktop, &request, first.clone())
            .await
            .unwrap()
            .count,
        "2"
    );
    // A lost response: the same page again changes nothing.
    assert_eq!(
        history::upload(&app, &o.desktop, &request, first)
            .await
            .unwrap()
            .count,
        "2"
    );
    rejected(
        history::upload(
            &app,
            &o.desktop,
            &request,
            upload_input(&o.desktop_keys, 3, &records[2..]),
        )
        .await,
        "history_record_gap",
    );
    // Another record at a held rank is a conflict, not a replacement.
    let other = record(&o.desktop_keys, &o.author, &o.room, 11);
    rejected(
        history::upload(
            &app,
            &o.desktop,
            &request,
            upload_input(&o.desktop_keys, 0, &[other]),
        )
        .await,
        "operation_conflict",
    );
    // Too early: the share does not match what the server holds.
    rejected(
        history::commit(
            &app,
            &o.desktop,
            &request,
            signed_share(&o.desktop_keys, &request, &o.room, &records, 1),
        )
        .await,
        "history_share_incomplete",
    );
    history::upload(
        &app,
        &o.desktop,
        &request,
        upload_input(&o.desktop_keys, 2, &records[2..]),
    )
    .await
    .unwrap();
    rejected(
        history::commit(
            &app,
            &o.desktop,
            &request,
            signed_share(&o.desktop_keys, &request, &o.room, &records[..2], 1),
        )
        .await,
        "history_share_incomplete",
    );
    // Not committed yet: nothing to download.
    rejected(history::share(&app, &o.phone, &request).await, "not_found");
    let commit = signed_share(&o.desktop_keys, &request, &o.room, &records, 1);
    let state = history::commit(&app, &o.desktop, &request, commit.clone())
        .await
        .unwrap();
    assert_eq!(
        history::commit(&app, &o.desktop, &request, commit)
            .await
            .unwrap()
            .share,
        state.share
    );
    // Once committed, a different share or new records are refused.
    rejected(
        history::commit(
            &app,
            &o.desktop,
            &request,
            signed_share(&o.desktop_keys, &request, &o.room, &records, 2),
        )
        .await,
        "history_share_committed",
    );
    rejected(
        history::upload(
            &app,
            &o.desktop,
            &request,
            upload_input(
                &o.desktop_keys,
                3,
                &[record(&o.desktop_keys, &o.author, &o.room, 20)],
            ),
        )
        .await,
        "history_share_committed",
    );
    // Only the requesting device downloads.
    rejected(
        history::share(&app, &o.desktop, &request).await,
        "not_found",
    );
    let fetched = history::share(&app, &o.phone, &request).await.unwrap();
    assert_eq!(fetched.share, state.share);
    assert_eq!(fetched.sharer_device_id, state.sharer_device_id);
    let page = history::records(&app, &o.phone, &request, 0, "0", 2)
        .await
        .unwrap();
    assert_eq!(page.records.len(), 2);
    assert_eq!(page.next.as_deref(), Some("2"));
    let rest = history::records(&app, &o.phone, &request, 0, "2", 2)
        .await
        .unwrap();
    assert_eq!(rest.records.len(), 1);
    assert_eq!(rest.next, None);
    let downloaded = page
        .records
        .iter()
        .chain(&rest.records)
        .map(|r| {
            Record::from_bytes(&B64.decode(r.as_bytes()).unwrap())
                .unwrap()
                .digest()
                .unwrap()
        })
        .collect::<Vec<_>>();
    assert_eq!(
        downloaded,
        records
            .iter()
            .map(|r| r.digest().unwrap())
            .collect::<Vec<_>>()
    );
    assert!(history::requests(&app, &o.desktop).await.unwrap().requests[0].committed);
    // The acknowledgement deletes everything; repeating it is harmless.
    history::acknowledge(&app, &o.phone, &request)
        .await
        .unwrap();
    history::acknowledge(&app, &o.phone, &request)
        .await
        .unwrap();
    rejected(history::share(&app, &o.phone, &request).await, "not_found");
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM e2ee_history_records")
            .fetch_one(&app.pool)
            .await
            .unwrap(),
        0
    );
}

#[sqlx::test]
async fn records_need_the_sharing_certificate_a_readable_room_and_a_live_request(pool: PgPool) {
    let app = App::from_pool(pool).await.unwrap();
    let o = owner(&app, "history-guard").await;
    let request = history::publish_request(&app, &o.phone, history_request(&o.phone_keys, 3600))
        .await
        .unwrap()
        .fingerprint;
    // Signed by the phone, uploaded by the desktop.
    rejected(
        history::upload(
            &app,
            &o.desktop,
            &request,
            upload_input(
                &o.desktop_keys,
                0,
                &[record(&o.phone_keys, &o.author, &o.room, 1)],
            ),
        )
        .await,
        "crypto_proof_invalid",
    );
    // A room the account cannot read.
    let (stranger, _) = actor(&app, "history-stranger").await;
    let closed = store::create_room(
        &app,
        &stranger,
        CreateRoom {
            name: format!("closed-{}", auth::random_token()),
            private: true,
            operation_id: None,
        },
    )
    .await
    .unwrap()
    .id;
    rejected(
        history::upload(
            &app,
            &o.desktop,
            &request,
            upload_input(
                &o.desktop_keys,
                0,
                &[record(&o.desktop_keys, &o.author, &closed, 1)],
            ),
        )
        .await,
        "not_found",
    );
    // Another account sees no request of this one.
    let stranger_keys = client(&app, &stranger, None).await;
    register(&app, &stranger, stranger_keys.registration.clone())
        .await
        .unwrap();
    rejected(
        history::upload(
            &app,
            &stranger,
            &request,
            upload_input(
                &stranger_keys,
                0,
                &[record(&stranger_keys, &o.author, &o.room, 1)],
            ),
        )
        .await,
        "not_found",
    );
    assert!(
        history::requests(&app, &stranger)
            .await
            .unwrap()
            .requests
            .is_empty()
    );
    // The first device to upload claims the share.
    let records = [record(&o.desktop_keys, &o.author, &o.room, 1)];
    history::upload(
        &app,
        &o.desktop,
        &request,
        upload_input(&o.desktop_keys, 0, &records),
    )
    .await
    .unwrap();
    let (laptop, _) = login(&app, "history-guard").await;
    let laptop_keys = client(
        &app,
        &laptop,
        Some((o.desktop_keys.root.clone(), o.desktop_keys.signing.clone())),
    )
    .await;
    let mut registration = laptop_keys.registration.clone();
    registration.expected_root_fingerprint = Some(hex(&o.desktop_keys.root.fingerprint().unwrap()));
    register(&app, &laptop, registration).await.unwrap();
    rejected(
        history::upload(
            &app,
            &laptop,
            &request,
            upload_input(
                &laptop_keys,
                0,
                &[record(&laptop_keys, &o.author, &o.room, 1)],
            ),
        )
        .await,
        "history_share_claimed",
    );
    // A new request of the phone replaces the old one and drops its share.
    let renewed = history::publish_request(&app, &o.phone, history_request(&o.phone_keys, 3600))
        .await
        .unwrap()
        .fingerprint;
    assert_ne!(renewed, request);
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM e2ee_history_shares")
            .fetch_one(&app.pool)
            .await
            .unwrap(),
        0
    );
    // An expired request takes no new record, and maintenance forgets it.
    sqlx::query(
        "UPDATE e2ee_history_requests SET expires_at=clock_timestamp()-interval '1 second'",
    )
    .execute(&app.pool)
    .await
    .unwrap();
    rejected(
        history::upload(
            &app,
            &o.desktop,
            &renewed,
            upload_input(&o.desktop_keys, 0, &records),
        )
        .await,
        "not_found",
    );
    assert!(
        history::requests(&app, &o.desktop)
            .await
            .unwrap()
            .requests
            .is_empty()
    );
    sqlx::query("UPDATE e2ee_history_requests SET retained_until=expires_at")
        .execute(&app.pool)
        .await
        .unwrap();
    app.cleanup().await.unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM e2ee_history_requests")
            .fetch_one(&app.pool)
            .await
            .unwrap(),
        0
    );
}
