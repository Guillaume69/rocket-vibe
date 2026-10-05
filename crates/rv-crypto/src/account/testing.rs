use super::*;
use crate::{installation::Account, protected::Storage};
use std::{collections::BTreeMap, sync::Mutex};
use zeroize::Zeroizing;

pub(super) const NOW: u64 = 1_800_000_000;
#[derive(Default)]
pub(super) struct Keys(Mutex<BTreeMap<String, Vec<u8>>>);
impl Storage for Keys {
    fn read(&self, name: &str) -> std::result::Result<Option<Zeroizing<Vec<u8>>>, vault::Error> {
        Ok(self
            .0
            .lock()
            .unwrap()
            .get(name)
            .map(|v| Zeroizing::new(v.clone())))
    }
    fn write(&self, name: &str, bytes: &[u8]) -> std::result::Result<(), vault::Error> {
        self.0.lock().unwrap().insert(name.into(), bytes.to_vec());
        Ok(())
    }
}
pub(super) fn empty() -> http::Directory {
    http::Directory {
        scope: http::Scope {
            instance_id: "instance".into(),
            data_epoch: "epoch".into(),
        },
        identity: None,
        devices: vec![],
        revocations: vec![],
        next_revocation: None,
    }
}
pub(super) fn publication(
    request: &http::RegisterDevice,
) -> (http::OperationReceipt, http::Device) {
    let grant = Grant::from_bytes(&decode(&request.grant, 8192).unwrap()).unwrap();
    let body = &grant.certificate.device;
    let revision = request
        .expected_device_revision
        .as_ref()
        .map(|r| r.parse::<u64>().unwrap())
        .unwrap_or(0)
        + 1;
    let receipt = http::OperationReceipt {
        scope: request.scope.clone(),
        operation_id: request.operation_id.clone(),
        kind: "register_device".into(),
        device_id: body.device.clone(),
        incarnation: hex(&body.incarnation),
        device_revision: revision.to_string(),
        root_fingerprint: hex(&body.root.fingerprint().unwrap()),
        key_package_refs: vec![],
    };
    let device = http::Device {
        device_id: body.device.clone(),
        incarnation: hex(&body.incarnation),
        certificate: B64.encode(&serde_json::to_vec(&grant.certificate).unwrap()),
        revision: revision.to_string(),
        expires_at: body.expires_at.to_string(),
    };
    (receipt, device)
}
pub(super) fn initialized(slot: &Installation) -> http::Directory {
    let c = Coordinator::new(slot);
    let mut wire = empty();
    let directory = c.directory(wire.clone()).unwrap();
    c.begin(&directory, "", NOW).unwrap();
    let view = c.view(&directory, NOW).unwrap();
    let preview = c.preview(&directory, &view.request_code, NOW).unwrap();
    let grant = c.approve(&directory, preview, NOW).unwrap();
    c.install(&directory, &grant, NOW).unwrap();
    let original = c.pending().unwrap();
    let (receipt, device) = publication(&original);
    let grant = Grant::from_bytes(&decode(&original.grant, 8192).unwrap()).unwrap();
    wire.identity = Some(http::Identity {
        user_id: "alice".into(),
        root: B64.encode(&serde_json::to_vec(&grant.certificate.device.root).unwrap()),
        fingerprint: receipt.root_fingerprint.clone(),
        revision: "1".into(),
    });
    wire.devices.push(device);
    c.acknowledge(&original, receipt).unwrap();
    wire
}
pub(super) fn slot(path: &std::path::Path, keys: Arc<Keys>) -> Installation {
    Installation::new(
        path.join("private"),
        Account {
            origin: "https://example.org".into(),
            instance: "instance".into(),
            data_epoch: "epoch".into(),
            user: "alice".into(),
            device: "desktop".into(),
        },
        keys,
    )
    .unwrap()
}
