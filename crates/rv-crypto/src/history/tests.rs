use super::*;
use crate::identity::Issuer;
use openmls_rust_crypto::OpenMlsRustCrypto;
use openmls_traits::OpenMlsProvider;
use rv_crypto_public::messages::{Header as MessageHeader, Kind};

pub(crate) const NOW: u64 = 1_800_000_000;
const BASE: u64 = 9_007_199_254_740_992;

pub(crate) fn device(issuer: &Issuer, name: &str, records: &mut Records) -> LocalDevice {
    let mut device = LocalDevice::create(issuer.root(), name, records).unwrap();
    let request = device.request(NOW, records).unwrap();
    let mut issuer_records = Records::new();
    issuer.save(&mut issuer_records).unwrap();
    let consent = issuer
        .preview_request(&request, NOW, 30 * 86400, &issuer_records)
        .unwrap();
    let grant = issuer
        .approve_request(&request, &consent, NOW, &mut issuer_records)
        .unwrap();
    device.install(&grant, NOW, records).unwrap();
    device
}
pub(crate) fn scope(room: &str) -> Scope {
    Scope {
        instance: "instance".into(),
        data_epoch: "epoch".into(),
        room: room.into(),
        incarnation: [3; 16],
    }
}
pub(crate) fn grant(user: &str) -> Member {
    Member {
        user: user.into(),
        access_version: "9007199254740996".into(),
        activation_version: "9007199254740997".into(),
    }
}
pub(crate) fn document(author: &LocalDevice, room: &str, number: u64) -> Document {
    let certificate =
        Certificate::from_credential(&author.credential(NOW).unwrap().credential).unwrap();
    let operation = format!("{room}-{number}");
    let origin = Receipt {
        header: MessageHeader {
            version: 1,
            scope: scope(room),
            operation: operation.clone(),
            group_revision: 9_007_199_254_740_993,
            epoch: 9_007_199_254_740_994,
            group_fingerprint: [4; 32],
            author: certificate.device.root.user.clone(),
            device: certificate.device.device.clone(),
            incarnation: certificate.device.incarnation,
            certificate: certificate.fingerprint().unwrap(),
            kind: Kind::Chat,
            thread: None,
            target: None,
        },
        fingerprint: [5; 32],
        message: format!("message-{room}-{number}"),
        position: BASE + number,
    };
    Document {
        message: SendMessage {
            operation_id: operation,
            text: format!("recovered words {room} {number}"),
            reply_to: None,
            quotes: Vec::new(),
            cards: Vec::new(),
        },
        membership: grant(&certificate.device.root.user),
        original_certificate: certificate,
        origin,
        observed_at: NOW - 100 + number,
    }
}
fn period(author: &LocalDevice, room: &str, numbers: &[u64]) -> PeriodInput {
    PeriodInput {
        scope: scope(room),
        grant: grant("alice"),
        admission: [7; 32],
        documents: numbers.iter().map(|n| document(author, room, *n)).collect(),
    }
}
struct Fixture {
    crypto: OpenMlsRustCrypto,
    issuer: Issuer,
    desktop: LocalDevice,
    phone: LocalDevice,
    phone_records: Records,
}
fn fixture() -> Fixture {
    let issuer = Issuer::generate("instance", "alice").unwrap();
    let mut desktop_records = Records::new();
    let desktop = device(&issuer, "desktop", &mut desktop_records);
    let mut phone_records = Records::new();
    let phone = device(&issuer, "phone", &mut phone_records);
    Fixture {
        crypto: OpenMlsRustCrypto::default(),
        issuer,
        desktop,
        phone,
        phone_records,
    }
}

#[test]
fn a_device_of_the_same_account_recovers_every_shared_period() {
    let mut f = fixture();
    let crypto = f.crypto.crypto();
    let request = request(&f.phone, crypto, &mut f.phone_records, NOW, 3600).unwrap();
    // A lost response replays the same pending request and key.
    assert_eq!(
        super::request(&f.phone, crypto, &mut f.phone_records, NOW + 1, 3600).unwrap(),
        request
    );
    let (share, packets) = share(
        &f.desktop,
        crypto,
        &request,
        vec![
            period(&f.desktop, "general", &[3, 1, 2]),
            period(&f.desktop, "private", &[10]),
            period(&f.desktop, "empty", &[]),
        ],
        NOW + 2,
    )
    .unwrap();
    // The share travels as bytes; empty periods are not shared.
    let share = Share::from_bytes(&share.to_bytes().unwrap()).unwrap();
    assert_eq!(share.manifest.periods.len(), 2);
    let (keys, _) = open(crypto, &f.phone_records, &share, NOW + 3).unwrap();
    for ((period, key), packets) in share.manifest.periods.iter().zip(&keys).zip(&packets) {
        let packets = packets
            .iter()
            .map(|p| Record::from_bytes(&p.to_bytes().unwrap()).unwrap())
            .collect::<Vec<_>>();
        check_period(period, &packets).unwrap();
        for (index, packet) in packets.iter().enumerate() {
            let message =
                open_packet(crypto, &share, period, key, index as u64 + 1, packet).unwrap();
            assert_eq!(message.operation_id, packet.header.origin.header.operation);
            assert!(message.text.starts_with("recovered words"));
        }
    }
    assert_eq!(share.manifest.periods[0].first, BASE + 1);
    assert_eq!(share.manifest.periods[0].last, BASE + 3);
    assert_eq!(share.manifest.periods[0].count, 3);
}

#[test]
fn packets_must_be_complete_ordered_bound_and_from_the_share() {
    let mut f = fixture();
    let crypto = f.crypto.crypto();
    let request = request(&f.phone, crypto, &mut f.phone_records, NOW, 3600).unwrap();
    let (share, packets) = share(
        &f.desktop,
        crypto,
        &request,
        vec![
            period(&f.desktop, "general", &[1, 2, 3]),
            period(&f.desktop, "private", &[4]),
        ],
        NOW,
    )
    .unwrap();
    let (keys, _) = open(crypto, &f.phone_records, &share, NOW).unwrap();
    let general = &share.manifest.periods[0];
    let mut missing = packets[0].clone();
    missing.remove(1);
    assert!(check_period(general, &missing).is_err());
    let mut reordered = packets[0].clone();
    reordered.swap(0, 1);
    assert!(check_period(general, &reordered).is_err());
    let mut extra = packets[0].clone();
    extra.push(packets[1][0].clone());
    assert!(check_period(general, &extra).is_err());
    // A packet of another period: other room, other key.
    assert!(open_packet(crypto, &share, general, &keys[0], 1, &packets[1][0]).is_err());
    assert!(open_packet(crypto, &share, general, &keys[1], 1, &packets[0][0]).is_err());
    // A packet served at another rank of its own period does not open.
    assert!(open_packet(crypto, &share, general, &keys[0], 1, &packets[0][1]).is_err());
    assert!(open_packet(crypto, &share, general, &keys[0], 2, &packets[0][1]).is_ok());
    // A packet sealed by another device of the account is not this share's.
    let (_, foreign) = super::share(
        &f.phone,
        crypto,
        &{
            let mut desktop_records = Records::new();
            let desktop = device(&f.issuer, "laptop", &mut desktop_records);
            super::request(&desktop, crypto, &mut desktop_records, NOW, 3600).unwrap()
        },
        vec![period(&f.phone, "general", &[1])],
        NOW,
    )
    .unwrap();
    assert!(open_packet(crypto, &share, general, &keys[0], 1, &foreign[0][0]).is_err());
}

#[test]
fn a_share_answers_one_request_of_one_account_within_its_window() {
    let mut f = fixture();
    let crypto = f.crypto.crypto();
    let first = request(&f.phone, crypto, &mut f.phone_records, NOW, 3600).unwrap();
    let (old_share, _) = share(
        &f.desktop,
        crypto,
        &first,
        vec![period(&f.desktop, "general", &[1])],
        NOW,
    )
    .unwrap();
    // A replaced request (and key) refuses the share of the previous one.
    forget_request(&mut f.phone_records);
    request(&f.phone, crypto, &mut f.phone_records, NOW + 1, 3600).unwrap();
    assert!(matches!(
        open(crypto, &f.phone_records, &old_share, NOW + 1),
        Err(Error::NotRequested)
    ));
    // Expired request: no share.
    assert!(
        share(
            &f.desktop,
            crypto,
            &first,
            vec![period(&f.desktop, "general", &[1])],
            NOW + 3600,
        )
        .is_err()
    );
    // Another account's device can neither be answered nor answer.
    let other = Issuer::generate("instance", "mallory").unwrap();
    let mut mallory_records = Records::new();
    let mallory = device(&other, "phone", &mut mallory_records);
    let foreign = request(&mallory, crypto, &mut mallory_records, NOW, 3600).unwrap();
    assert!(
        share(
            &f.desktop,
            crypto,
            &foreign,
            vec![period(&f.desktop, "general", &[1])],
            NOW,
        )
        .is_err()
    );
    let current = pending_request(&f.phone_records).unwrap().unwrap();
    assert!(
        share(
            &mallory,
            crypto,
            &current,
            vec![period(&mallory, "general", &[1])],
            NOW + 1,
        )
        .is_err()
    );
    // A device does not answer its own request.
    assert!(
        share(
            &f.phone,
            crypto,
            &current,
            vec![period(&f.phone, "general", &[1])],
            NOW + 1,
        )
        .is_err()
    );
    // A tampered manifest breaks the share signature.
    let (mut tampered, _) = share(
        &f.desktop,
        crypto,
        &current,
        vec![period(&f.desktop, "general", &[1, 2])],
        NOW + 1,
    )
    .unwrap();
    tampered.manifest.periods[0].count = 1;
    assert!(open(crypto, &f.phone_records, &tampered, NOW + 1).is_err());
}

#[test]
fn pages_seal_again_identically_and_both_sides_resume_from_their_vault() {
    let mut f = fixture();
    let crypto = f.crypto.crypto();
    let request = request(&f.phone, crypto, &mut f.phone_records, NOW, 3600).unwrap();
    let input = period(&f.desktop, "general", &[1, 2, 3, 4, 5]);
    let mut job = ShareJob::new(
        &f.desktop,
        &request,
        vec![PeriodPlan {
            scope: input.scope.clone(),
            grant: input.grant.clone(),
            admission: input.admission,
            total: 5,
        }],
        NOW,
    )
    .unwrap();
    let first = job
        .seal_page(crypto, &f.desktop, 0, &input.documents[..2], NOW)
        .unwrap();
    // A lost upload seals the same page again, byte for byte.
    let again = job
        .seal_page(crypto, &f.desktop, 0, &input.documents[..2], NOW + 5)
        .unwrap();
    let bytes = |page: &Page| {
        page.packets
            .iter()
            .map(|p| p.to_bytes().unwrap())
            .collect::<Vec<_>>()
    };
    assert_eq!(bytes(&first), bytes(&again));
    job.advance(&first).unwrap();
    assert!(job.advance(&again).is_err());
    let mut job = ShareJob::from_bytes(&job.to_bytes().unwrap()).unwrap();
    assert_eq!(job.next(), Some((0, 2)));
    // A page must continue after the sealed prefix.
    assert!(
        job.seal_page(crypto, &f.desktop, 0, &input.documents[1..3], NOW)
            .is_err()
    );
    let second = job
        .seal_page(crypto, &f.desktop, 0, &input.documents[2..], NOW)
        .unwrap();
    job.advance(&second).unwrap();
    let share = job.finish(crypto, &f.desktop, None, NOW).unwrap();
    // The envelope is drawn once: a lost commit response gets the same share.
    assert_eq!(
        job.finish(crypto, &f.desktop, None, NOW + 1)
            .unwrap()
            .to_bytes()
            .unwrap(),
        share.to_bytes().unwrap()
    );
    let mut import = ImportJob::open(crypto, &f.phone_records, &share, NOW)
        .unwrap()
        .0;
    assert_eq!(import.next(), Some((0, 0)));
    let documents = import.accept(crypto, 0, &first.packets[..1]).unwrap();
    assert_eq!(documents[0].operation_id, "general-1");
    let mut import = ImportJob::from_bytes(&import.to_bytes().unwrap()).unwrap();
    // Out of sequence: refused, nothing changes.
    assert!(import.accept(crypto, 0, &second.packets).is_err());
    assert_eq!(import.next(), Some((0, 1)));
    import.accept(crypto, 0, &first.packets[1..]).unwrap();
    assert!(!import.complete(0));
    import.accept(crypto, 0, &second.packets).unwrap();
    assert!(import.complete(0));
    assert_eq!(import.next(), None);
}

/// Public vector: Alice's desktop shares two of Bob's messages (one a thread
/// reply) with Alice's phone. `RV_WRITE_HISTORY_VECTOR=1` regenerates it; the
/// Node verifier checks it independently, and the phone side reopens it here.
#[test]
fn public_history_vector_opens_on_the_requesting_device() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../rv-crypto-public/fixtures/history-share-v1.json");
    let crypto = OpenMlsRustCrypto::default();
    let crypto = crypto.crypto();
    if std::env::var_os("RV_WRITE_HISTORY_VECTOR").is_some() {
        let mut f = fixture();
        let bob = Issuer::generate("instance", "bob").unwrap();
        let laptop = device(&bob, "laptop", &mut Records::new());
        let request = request(&f.phone, crypto, &mut f.phone_records, NOW, 3600).unwrap();
        let seed = pending(&f.phone_records).unwrap().unwrap().seed;
        let mut input = period(&f.desktop, "general", &[]);
        let mut reply = document(&laptop, "general", 2);
        reply.origin.header.thread = Some("general-root".into());
        reply.message.reply_to = Some("general-root".into());
        input.documents = vec![document(&laptop, "general", 1), reply];
        let (share, records) = share(&f.desktop, crypto, &request, vec![input], NOW + 2).unwrap();
        let records = records[0]
            .iter()
            .map(|r| String::from_utf8(r.to_bytes().unwrap()).unwrap())
            .collect::<Vec<_>>()
            .join(",");
        let vector = format!(
            "{{\"recipient_seed\":\"{}\",\"request\":{},\"share\":{},\"records\":[{records}]}}\n",
            HEXLOWER.encode(seed.as_slice()),
            String::from_utf8(request.to_bytes().unwrap()).unwrap(),
            String::from_utf8(share.to_bytes().unwrap()).unwrap(),
        );
        std::fs::write(&path, vector).unwrap();
    }
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Vector {
        recipient_seed: String,
        request: Request,
        share: Share,
        records: Vec<Record>,
    }
    let vector: Vector = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    let mut seed = Zeroizing::new([0; 32]);
    seed.copy_from_slice(&HEXLOWER.decode(vector.recipient_seed.as_bytes()).unwrap());
    let mut records = Records::new();
    records.insert(
        RECORD.into(),
        serde_json::to_vec(&Pending {
            request: vector.request.clone(),
            seed,
        })
        .unwrap(),
    );
    vector.request.verify(NOW + 3).unwrap();
    let mut import = ImportJob::open(crypto, &records, &vector.share, NOW + 3)
        .unwrap()
        .0;
    let messages = import.accept(crypto, 0, &vector.records).unwrap();
    assert!(import.complete(0));
    assert_eq!(
        messages.iter().map(|m| m.text.as_str()).collect::<Vec<_>>(),
        ["recovered words general 1", "recovered words general 2"]
    );
    assert_eq!(messages[1].reply_to.as_deref(), Some("general-root"));
    // Bob's messages, attested by Alice's desktop for Alice's phone.
    let record = &vector.records[0];
    assert_eq!(record.original_certificate.device.root.user, "bob");
    assert_eq!(record.certificate, vector.share.certificate);
    assert_eq!(
        vector.share.certificate.device.root,
        vector.request.body.certificate.device.root
    );
}
