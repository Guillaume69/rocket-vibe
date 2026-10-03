//! Public deterministic fixture, never an account key. Independent encoder for
//! the documented v1 certificate framing; redirects to fixtures/*.json.
use ed25519_dalek::{Signer, SigningKey};
use rv_crypto::identity::{Certificate, Device, Root};
fn main() {
    let root = SigningKey::from_bytes(&[7; 32]); // Public fixture seed.
    let device_key = SigningKey::from_bytes(&[11; 32]); // Public fixture seed.
    let device = Device {
        version: 1,
        root: Root {
            version: 1,
            instance: "fixture-instance".into(),
            user: "fixture-user".into(),
            generation: [9; 16],
            public_key: root.verifying_key().to_bytes(),
        },
        device: "fixture-device".into(),
        incarnation: [2; 16],
        serial: [3; 16],
        suite: 1,
        signature_key: device_key.verifying_key().to_bytes(),
        issued_at: 1_900_000_000,
        expires_at: 1_900_003_600,
    };
    let mut frame = b"rocketvibe-device-certificate-v1\0".to_vec();
    frame.extend(serde_json::to_vec(&device).unwrap());
    let certificate = Certificate {
        device,
        signature: root.sign(&frame).to_bytes().to_vec(),
    };
    println!("{}", serde_json::to_string_pretty(&certificate).unwrap());
}
