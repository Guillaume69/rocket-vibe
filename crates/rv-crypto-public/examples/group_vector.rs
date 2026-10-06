//! Public framing fixture. The claimed TLS digests are synthetic, not an MLS group.
use ed25519_dalek::{Signer, SigningKey};
use rv_crypto_public::{
    Certificate,
    groups::{Member, Participant, Plan, Scope, Transition, Welcome},
};
use sha2::{Digest, Sha256};
fn main() {
    let certificate: Certificate = serde_json::from_slice(include_bytes!(
        "../../rv-crypto/fixtures/identity-certificate-v1.json"
    ))
    .unwrap();
    let scope = Scope {
        instance: "fixture-instance".into(),
        data_epoch: "fixture-data-epoch".into(),
        room: "fixture-room".into(),
        incarnation: [5; 16],
    };
    let plan = Plan {
        version: 1,
        scope: scope.clone(),
        operation: "fixture-transition".into(),
        expected_revision: 8,
        expected_epoch: Some(6),
        epoch: 7,
        previous: [40; 32],
        authority_version: "fixture-authority".into(),
        members: vec![
            Member {
                user: "fixture-other-user".into(),
                access_version: "other-access".into(),
                activation_version: "other-activation".into(),
            },
            Member {
                user: "fixture-user".into(),
                access_version: "user-access".into(),
                activation_version: "user-activation".into(),
            },
        ],
        participants: vec![
            Participant {
                user: "fixture-user".into(),
                device: "fixture-device".into(),
                incarnation: certificate.device.incarnation,
                root: certificate.device.root.fingerprint().unwrap(),
                certificate: certificate.fingerprint().unwrap(),
                leaf: 0,
                key_package: None,
            },
            Participant {
                user: "fixture-other-user".into(),
                device: "fixture-other-device".into(),
                incarnation: [4; 16],
                root: [41; 32],
                certificate: [43; 32],
                leaf: 3,
                key_package: Some([42; 32]),
            },
        ],
        context: Sha256::digest(b"synthetic public group context").into(),
        commit: Some(Sha256::digest(b"synthetic public commit").into()),
        tree: Sha256::digest(b"synthetic public tree").into(),
        welcomes: vec![Welcome {
            device: "fixture-other-device".into(),
            incarnation: [4; 16],
            key_package: [42; 32],
            digest: Sha256::digest(b"synthetic public Welcome").into(),
        }],
    };
    let transition = Transition {
        certificate,
        signature: SigningKey::from_bytes(&[11; 32])
            .sign(&plan.signing_bytes().unwrap())
            .to_bytes()
            .to_vec(),
        plan,
    };
    println!("{}",serde_json::to_string_pretty(&serde_json::json!({"fingerprint":transition.fingerprint().unwrap(),"group_id":scope.group_id().unwrap(),"transition":transition})).unwrap());
}
