use super::super::testing::*;
use super::*;

fn phone(
    slot: &Installation,
    folder: &std::path::Path,
    keys: Arc<Keys>,
    wire: &mut http::Directory,
) -> Installation {
    let mut account = slot.account().clone();
    account.device = "phone".into();
    let phone = Installation::new(folder.join("phone-private"), account, keys).unwrap();
    let c = Coordinator::new(&phone);
    let own = c.directory(wire.clone()).unwrap();
    c.begin(&own, &wire.identity.as_ref().unwrap().fingerprint, NOW)
        .unwrap();
    let waiting = c.view(&own, NOW).unwrap();
    let controller = Coordinator::new(slot);
    let directory = controller.directory(wire.clone()).unwrap();
    let preview = controller
        .preview(&directory, &waiting.request_code, NOW)
        .unwrap();
    let grant = controller.approve(&directory, preview, NOW).unwrap();
    c.install(&own, &grant, NOW).unwrap();
    let original = c.pending().unwrap();
    let (receipt, device) = super::super::testing::publication(&original);
    wire.devices.push(device);
    c.acknowledge(&original, receipt).unwrap();
    phone
}
fn scope() -> http::Scope {
    empty().scope
}
/// The receipt the server issues for this request at `revision`.
fn issued(request: &http::PublishHistoryKey, revision: &str) -> http::HistoryKeyReceipt {
    let p = super::publication(request).unwrap();
    http::HistoryKeyReceipt {
        scope: request.scope.clone(),
        operation_id: request.operation_id.clone(),
        device_id: p.body.device.clone(),
        incarnation: hex(&p.body.incarnation),
        device_revision: p.body.device_revision.clone(),
        root_fingerprint: hex(&p.package.header.root.fingerprint().unwrap()),
        generation: hex(&p.package.header.generation),
        generation_revision: revision.into(),
        package_digest: hex(&p.body.package_digest),
    }
}

#[test]
fn a_generation_is_enabled_behind_its_code_and_another_device_joins_with_it() {
    let folder = tempfile::tempdir().unwrap();
    let keys = Arc::new(Keys::default());
    let desktop = slot(folder.path(), keys.clone());
    let mut wire = initialized(&desktop);
    let phone = phone(&desktop, folder.path(), keys, &mut wire);
    let d = Coordinator::new(&desktop);
    let directory = d.directory(wire.clone()).unwrap();
    let nothing = http::HistoryKeyState {
        scope: scope(),
        active: None,
    };
    assert!(!d.history_backup_status(&directory).unwrap().holds_key);
    let preview = d
        .preview_history_backup(&directory, nothing.clone())
        .unwrap();
    assert_eq!(preview.generation_revision, None);
    d.prepare_history_backup(&directory, preview, NOW).unwrap();
    // Nothing leaves before the code is confirmed saved, and only one intent.
    assert!(d.pending_history_backup().is_err());
    assert!(
        d.preview_history_backup(&directory, nothing.clone())
            .is_err()
    );
    let code = d.history_backup_code().unwrap();
    assert!(code.starts_with("rvh1-"));
    d.confirm_history_backup_code().unwrap();
    let request = d.pending_history_backup().unwrap();
    assert!(!request.publication.contains(code.as_str()));
    let receipt = issued(&request, "1");
    // A receipt for another revision is refused.
    assert!(
        d.acknowledge_history_backup(&request, issued(&request, "2"))
            .is_err()
    );
    d.acknowledge_history_backup(&request, receipt.clone())
        .unwrap();
    let status = d.history_backup_status(&directory).unwrap();
    assert!(status.holds_key && !status.pending);
    assert_eq!(
        status.generation.as_deref(),
        Some(receipt.generation.as_str())
    );
    assert!(
        d.history_backup_code().is_err(),
        "the code is gone once published"
    );
    // The phone joins with the code; wrong codes are refused.
    let active = http::HistoryKeyState {
        scope: scope(),
        active: Some(http::HistoryKeyVersion {
            publication: request.publication.clone(),
            receipt: receipt.clone(),
        }),
    };
    let p = Coordinator::new(&phone);
    let phone_directory = p.directory(wire.clone()).unwrap();
    assert!(
        p.join_history_backup(&phone_directory, &active, &code.replacen("rvh1", "rvk1", 1))
            .is_err()
    );
    let other = crate::history_backup::HistoryCode::generate()
        .unwrap()
        .for_display();
    assert!(
        p.join_history_backup(&phone_directory, &active, &other)
            .is_err()
    );
    assert_eq!(
        p.join_history_backup(&phone_directory, &active, &code)
            .unwrap(),
        receipt.generation
    );
    assert_eq!(
        p.history_backup_status(&phone_directory)
            .unwrap()
            .generation,
        Some(receipt.generation.clone())
    );
    // A new generation abandoned before publication leaves the old key held.
    let preview = d
        .preview_history_backup(&directory, active.clone())
        .unwrap();
    assert_eq!(preview.generation_revision.as_deref(), Some("1"));
    d.prepare_history_backup(&directory, preview, NOW + 1)
        .unwrap();
    let original = d.request_history_backup_cancellation().unwrap();
    let body = super::publication(&original).unwrap().body;
    d.settle_history_backup_cancellation(
        &original,
        http::HistoryKeySettlement::Cancelled(http::HistoryKeyCancellation {
            scope: original.scope.clone(),
            operation_id: original.operation_id.clone(),
            device_id: body.device.clone(),
            incarnation: hex(&body.incarnation),
            device_revision: body.device_revision.clone(),
            root_fingerprint: receipt.root_fingerprint.clone(),
            generation: hex(&super::publication(&original)
                .unwrap()
                .package
                .header
                .generation),
            expected_revision: body.expected_revision.clone(),
            package_digest: hex(&body.package_digest),
        }),
    )
    .unwrap();
    let status = d.history_backup_status(&directory).unwrap();
    assert!(!status.pending);
    assert_eq!(status.generation, Some(receipt.generation));
    assert!(d.holds_active(&active).unwrap() && p.holds_active(&active).unwrap());
    assert!(!d.holds_active(&nothing).unwrap());
    // A rotation retires the old key: the phone, still holding it, uploads
    // nothing under it until it joins the new generation.
    let preview = d
        .preview_history_backup(&directory, active.clone())
        .unwrap();
    d.prepare_history_backup(&directory, preview, NOW + 2)
        .unwrap();
    let code = d.history_backup_code().unwrap();
    d.confirm_history_backup_code().unwrap();
    let request = d.pending_history_backup().unwrap();
    let receipt = issued(&request, "2");
    d.acknowledge_history_backup(&request, receipt.clone())
        .unwrap();
    let rotated = http::HistoryKeyState {
        scope: scope(),
        active: Some(http::HistoryKeyVersion {
            publication: request.publication.clone(),
            receipt,
        }),
    };
    assert!(d.holds_active(&rotated).unwrap());
    assert!(!p.holds_active(&rotated).unwrap());
    assert!(
        p.history_backup_upload(&phone_directory, &rotated, NOW + 2)
            .unwrap()
            .is_none()
    );
    p.join_history_backup(&phone_directory, &rotated, &code)
        .unwrap();
    assert!(p.holds_active(&rotated).unwrap() && !p.holds_active(&active).unwrap());
}
