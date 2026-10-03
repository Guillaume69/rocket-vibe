//! Public deterministic enrollment fixture; never account/device secrets.
use ed25519_dalek::{Signer, SigningKey};
use rv_crypto::identity::{
    Certificate,
    enrollment::{Grant, Request, RequestBody},
};
use serde::Serialize;
use sha2::{Digest, Sha256};

fn frame(domain: &str, value: &impl Serialize) -> Vec<u8> {
    let mut bytes = domain.as_bytes().to_vec();
    bytes.push(0);
    bytes.extend(serde_json::to_vec(value).unwrap());
    bytes
}
#[derive(Serialize)]
struct Fixture {
    request: Request,
    grant: Grant,
}
fn main() {
    let root = SigningKey::from_bytes(&[7; 32]); // Public fixture seed.
    let leaf = SigningKey::from_bytes(&[11; 32]); // Public fixture seed.
    let certificate: Certificate =
        serde_json::from_str(include_str!("../fixtures/identity-certificate-v1.json")).unwrap();
    let body = RequestBody {
        version: 1,
        root: certificate.device.root.clone(),
        device: "fixture-device".into(),
        incarnation: [2; 16],
        request_id: [5; 32],
        signature_key: leaf.verifying_key().to_bytes(),
        issued_at: 1_900_000_000,
        expires_at: 1_900_000_600,
    };
    let request = Request {
        signature: leaf
            .sign(&frame("rocketvibe-device-request-v1", &body))
            .to_bytes()
            .to_vec(),
        body,
    };
    let fingerprint = Sha256::digest(frame("rocketvibe-request-fingerprint-v1", &request)).into();
    let signature = root
        .sign(&frame(
            "rocketvibe-device-grant-v1",
            &(fingerprint, &certificate),
        ))
        .to_bytes()
        .to_vec();
    let fixture = Fixture {
        request,
        grant: Grant {
            request: fingerprint,
            certificate,
            signature,
        },
    };
    println!("{}", serde_json::to_string_pretty(&fixture).unwrap());
}
