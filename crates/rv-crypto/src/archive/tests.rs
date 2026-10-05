use super::*;
use crate::identity::Issuer;
use rv_crypto_public::{
    Fingerprint,
    groups::Scope,
    messages::{Header as MessageHeader, Kind},
};

const NOW: u64 = 1_800_000_000;
fn fixture() -> (LocalDevice, Receipt, Member, SendMessage, Records) {
    let issuer = Issuer::generate("instance", "alice").unwrap();
    let mut records = Records::new();
    issuer.save(&mut records).unwrap();
    let mut device = LocalDevice::create(issuer.root(), "desktop", &mut records).unwrap();
    let request = device.request(NOW, &mut records).unwrap();
    let consent = issuer
        .preview_request(&request, NOW, 3600, &records)
        .unwrap();
    let grant = issuer
        .approve_request(&request, &consent, NOW, &mut records)
        .unwrap();
    device.install(&grant, NOW, &mut records).unwrap();
    let certificate = &grant.certificate;
    let origin = Receipt {
        header: MessageHeader {
            version: 1,
            scope: Scope {
                instance: "instance".into(),
                data_epoch: "epoch".into(),
                room: "private".into(),
                incarnation: [3; 16],
            },
            operation: "archive-document".into(),
            group_revision: 9_007_199_254_740_993,
            epoch: 9_007_199_254_740_994,
            group_fingerprint: [4; 32],
            author: "alice".into(),
            device: "desktop".into(),
            incarnation: certificate.device.incarnation,
            certificate: certificate.fingerprint().unwrap(),
            kind: Kind::Chat,
            thread: Some("thread-root".into()),
            target: None,
            files: Vec::new(),
        },
        fingerprint: [5; 32],
        message: rv_crypto_public::messages::message_id(&[5; 32]),
        position: 9_007_199_254_740_995,
    };
    let member = Member {
        user: "alice".into(),
        access_version: "9007199254740996".into(),
        activation_version: "9007199254740997".into(),
    };
    let document = SendMessage {
        operation_id: origin.header.operation.clone(),
        text: "private archive document".into(),
        reply_to: origin.header.thread.clone(),
        quotes: Vec::new(),
        cards: Vec::new(),
        files: vec![],
    };
    (device, origin, member, document, records)
}
fn same(a: &SendMessage, b: &SendMessage) -> bool {
    serde_json::to_vec(a).unwrap() == serde_json::to_vec(b).unwrap()
}

#[test]
fn renewed_or_recovered_leaf_can_archive_an_observed_original_but_another_root_cannot() {
    let (device, origin, member, doc, mut records) = fixture();
    let original =
        Certificate::from_credential(&device.credential(NOW).unwrap().credential).unwrap();
    let issuer = Issuer::load(&records, "instance", "alice").unwrap();
    let mut recovered_records = Records::new();
    let mut recovered =
        LocalDevice::create(issuer.root(), "recovered", &mut recovered_records).unwrap();
    let time = NOW + 3601;
    let request = recovered.request(time, &mut recovered_records).unwrap();
    let consent = issuer
        .preview_request(&request, time, 3600, &records)
        .unwrap();
    let grant = issuer
        .approve_request(&request, &consent, time, &mut records)
        .unwrap();
    recovered
        .install(&grant, time, &mut recovered_records)
        .unwrap();
    assert!(original.verify(time).is_err());
    let (packet, key) =
        seal_from_origin(&recovered, &original, &origin, &member, &doc, time).unwrap();
    assert!(packet.original_certificate == original);
    assert_eq!(packet.certificate.device.device, "recovered");
    packet.verify_current(time).unwrap();
    assert!(same(&open(&packet, &key, &origin, &member).unwrap(), &doc));
    let (foreign_device, foreign_origin, _, _, _) = fixture(); // Same username, different immutable root.
    assert!(seal_from_origin(&recovered, &original, &foreign_origin, &member, &doc, time).is_err());
    assert!(seal_from_origin(&foreign_device, &original, &origin, &member, &doc, NOW).is_err());
}

#[test]
fn archive_is_independent_of_mls_and_keeps_exact_origin_after_key_reopen() {
    let (device, origin, member, doc, mut records) = fixture();
    let (packet, key) = seal(&device, &origin, &member, &doc, NOW).unwrap();
    let bytes = packet.to_bytes().unwrap();
    assert!(!String::from_utf8_lossy(&bytes).contains(&doc.text));
    let decoded = Packet::from_bytes(&bytes).unwrap();
    assert!(decoded.header.origin == origin);
    let json: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(json["header"]["origin"]["position"], "9007199254740995");
    assert_eq!(
        json["header"]["origin"]["header"]["group_revision"],
        "9007199254740993"
    );
    assert_eq!(
        json["header"]["origin"]["header"]["epoch"],
        "9007199254740994"
    );
    key.save(&packet, &mut records).unwrap();
    key.save(&packet, &mut records).unwrap();
    drop(key);
    let reopened = Key::load(&decoded, &records).unwrap();
    assert!(same(
        &open(&decoded, &reopened, &origin, &member).unwrap(),
        &doc
    ));
    assert!(packet.verify_current(NOW + 3600).is_err());
    packet.authenticate().unwrap(); // Historical authentication does not reapprove its author.
    assert!(same(
        &open(&packet, &reopened, &origin, &member).unwrap(),
        &doc
    ));
    // This artifact contains only disposable public signatures/ciphertext.
    if let Some(path) = std::env::var_os("RV_ARCHIVE_PUBLIC_VECTOR") {
        std::fs::write(path, bytes).unwrap();
    }
}

#[test]
fn archive_refuses_rebound_scope_membership_receipt_thread_and_reused_key() {
    let (device, origin, member, doc, mut records) = fixture();
    let (packet, key) = seal(&device, &origin, &member, &doc, NOW).unwrap();
    let (other, other_key) = seal(&device, &origin, &member, &doc, NOW).unwrap();
    assert_ne!(packet.header.key_id, other.header.key_id);
    assert_ne!(packet.header.nonce, other.header.nonce);
    assert!(open(&packet, &other_key, &origin, &member).is_err());
    assert!(open(&other, &key, &origin, &member).is_err());
    let mut wrong = origin.clone();
    wrong.header.scope.data_epoch = "another-epoch".into();
    assert!(open(&packet, &key, &wrong, &member).is_err());
    wrong = origin.clone();
    wrong.position += 1;
    assert!(open(&packet, &key, &wrong, &member).is_err());
    let mut wrong_member = member.clone();
    wrong_member.access_version = "9007199254740998".into();
    assert!(open(&packet, &key, &origin, &wrong_member).is_err());
    let mut wrong_doc = doc.clone();
    wrong_doc.reply_to = None;
    assert!(seal(&device, &origin, &member, &wrong_doc, NOW).is_err());
    wrong_doc = doc.clone();
    wrong_doc.operation_id = "different-operation".into();
    assert!(seal(&device, &origin, &member, &wrong_doc, NOW).is_err());
    assert!(seal(&device, &origin, &member, &doc, NOW + 3600).is_err());
    key.save(&packet, &mut records).unwrap();
    let name = record(&packet).unwrap();
    records.get_mut(&name).unwrap()[0] ^= 1;
    assert!(Key::load(&packet, &records).is_err());
    assert!(key.save(&packet, &mut records).is_err());
    Key::forget(&packet, &mut records).unwrap();
    assert!(Key::load(&packet, &records).is_err());
    assert!(
        same(&open(&packet, &key, &origin, &member).unwrap(), &doc),
        "Removing a local key does not recall an existing copy"
    );
}

#[test]
fn archive_authenticates_every_bound_field_and_aead_rejects_signed_corruption() {
    let (device, origin, member, doc, _) = fixture();
    let (packet, key) = seal(&device, &origin, &member, &doc, NOW).unwrap();
    for change in 0..6 {
        let mut bad = packet.clone();
        match change {
            0 => bad.header.nonce[0] ^= 1,
            1 => bad.header.key_id[0] ^= 1,
            2 => bad.ciphertext[0] ^= 1,
            3 => bad.header.origin.fingerprint[0] ^= 1,
            4 => bad.header.author_membership.activation_version = "9007199254740998".into(),
            _ => bad.signature[0] ^= 1,
        }
        assert!(bad.authenticate().is_err());
        assert!(open(&bad, &key, &origin, &member).is_err());
    }
    let mut signed_corruption = packet.clone();
    signed_corruption.ciphertext[0] ^= 1;
    signed_corruption.signature = device
        .sign(&signed_corruption.signing_bytes().unwrap())
        .unwrap();
    signed_corruption.authenticate().unwrap();
    assert!(open(&signed_corruption, &key, &origin, &member).is_err());
    let mut swapped_author = packet.clone();
    swapped_author.certificate.device.root.user = "bob".into();
    assert!(swapped_author.authenticate().is_err());
    let mut foreign_root = packet.clone();
    foreign_root.certificate.device.root.instance = "foreign".into();
    assert!(foreign_root.authenticate().is_err());
}

#[test]
fn archive_rejects_noncanonical_oversized_or_secret_bearing_wire_packets() {
    let (device, origin, member, doc, _) = fixture();
    let (packet, _) = seal(&device, &origin, &member, &doc, NOW).unwrap();
    let mut json = serde_json::to_value(&packet).unwrap();
    json["private_key"] = "not-allowed".into();
    assert!(Packet::from_bytes(&serde_json::to_vec(&json).unwrap()).is_err());
    for field in ["position", "group_revision", "epoch"] {
        let mut json = serde_json::to_value(&packet).unwrap();
        let target = if field == "position" {
            &mut json["header"]["origin"]
        } else {
            &mut json["header"]["origin"]["header"]
        };
        target[field] = serde_json::json!(17);
        assert!(serde_json::from_value::<Packet>(json).is_err());
    }
    let bytes = packet.to_bytes().unwrap();
    let mut trailing = bytes.clone();
    trailing.push(b' ');
    assert!(Packet::from_bytes(&trailing).is_err());
    assert!(Packet::from_bytes(&vec![b' '; rv_crypto_public::archive::WIRE_LIMIT + 1]).is_err());
    let mut oversized = packet.clone();
    oversized
        .ciphertext
        .resize(rv_crypto_public::archive::CIPHERTEXT_LIMIT + 1, 0);
    assert!(oversized.authenticate().is_err());
    let mut bad_revision = packet.clone();
    bad_revision.header.author_membership.access_version = "01".into();
    assert!(bad_revision.authenticate().is_err());
    let fingerprint: Fingerprint = packet.digest().unwrap();
    assert_ne!(fingerprint, [0; 32]);
}
