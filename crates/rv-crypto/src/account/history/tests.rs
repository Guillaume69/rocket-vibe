use super::super::testing::*;
use super::*;

/// A second installation of the account, approved by the desktop.
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
    let (receipt, device) = publication(&original);
    wire.devices.push(device);
    c.acknowledge(&original, receipt).unwrap();
    phone
}
fn entry(
    device: &str,
    fingerprint: &str,
    input: &http::PublishHistoryRequest,
) -> http::HistoryRequestEntry {
    http::HistoryRequestEntry {
        fingerprint: fingerprint.into(),
        device_id: device.into(),
        request: input.request.clone(),
        expires_at: (NOW + 7 * 86400).to_string(),
        sharer_device_id: None,
        committed: false,
    }
}
fn listed(entries: Vec<http::HistoryRequestEntry>) -> http::HistoryRequests {
    http::HistoryRequests {
        scope: empty().scope,
        requests: entries,
    }
}

#[test]
fn only_a_listed_sibling_request_is_offered_and_an_empty_history_is_not_shared() {
    let folder = tempfile::tempdir().unwrap();
    let keys = Arc::new(Keys::default());
    let desktop = slot(folder.path(), keys.clone());
    let mut wire = initialized(&desktop);
    let phone = phone(&desktop, folder.path(), keys, &mut wire);
    let d = Coordinator::new(&desktop);
    let p = Coordinator::new(&phone);
    let directory = d.directory(wire.clone()).unwrap();
    let (fingerprint, input) = p
        .history_request(&p.directory(wire.clone()).unwrap(), NOW)
        .unwrap();
    // The pending request is replayed, not drawn again.
    assert_eq!(
        p.history_request(&p.directory(wire.clone()).unwrap(), NOW + 1)
            .unwrap()
            .0,
        fingerprint
    );
    let (own_fingerprint, own_input) = d.history_request(&directory, NOW).unwrap();
    let mut tampered = entry("phone", &fingerprint, &input);
    tampered.fingerprint = own_fingerprint.clone();
    let mut claimed = entry("phone", &fingerprint, &input);
    claimed.sharer_device_id = Some("laptop".into());
    let mut committed = entry("phone", &fingerprint, &input);
    committed.committed = true;
    let mut misnamed = entry("laptop", &fingerprint, &input);
    misnamed.device_id = "laptop".into();
    let offers = d
        .history_offers(
            &directory,
            &listed(vec![
                entry("phone", &fingerprint, &input),
                entry("desktop", &own_fingerprint, &own_input),
                tampered,
                claimed,
                committed,
                misnamed,
            ]),
            NOW + 2,
        )
        .unwrap();
    assert_eq!(offers.len(), 1);
    assert_eq!(offers[0].fingerprint, fingerprint);
    assert_eq!(offers[0].device, "phone");
    // A device absent from the directory is not trusted, nor after expiry.
    let mut unlisted = wire.clone();
    unlisted.devices.retain(|d| d.device_id != "phone");
    assert!(
        d.history_offers(
            &d.directory(unlisted).unwrap(),
            &listed(vec![entry("phone", &fingerprint, &input)]),
            NOW + 2,
        )
        .unwrap()
        .is_empty()
    );
    assert!(
        d.history_offers(
            &directory,
            &listed(vec![entry("phone", &fingerprint, &input)]),
            NOW + 7 * 86400,
        )
        .unwrap()
        .is_empty()
    );
    // Nothing observed yet: the preview is empty and approval refused.
    let offer = d
        .history_offers(
            &directory,
            &listed(vec![entry("phone", &fingerprint, &input)]),
            NOW + 2,
        )
        .unwrap()
        .remove(0);
    let preview = d.history_preview(&directory, offer, NOW + 2).unwrap();
    assert!(preview.periods.is_empty());
    assert!(
        d.history_approve(&directory, preview, false, NOW + 2)
            .is_err()
    );
    assert_eq!(d.history_share_pending(&directory, NOW + 2).unwrap(), None);
    assert!(d.history_upload(&directory, NOW + 2).unwrap().is_none());
    // The phone acknowledges only its own requests it no longer waits for.
    let phone_directory = p.directory(wire.clone()).unwrap();
    let mut stale = entry("phone", &"ab".repeat(32), &input);
    stale.committed = true;
    assert_eq!(
        p.history_acknowledgeable(
            &phone_directory,
            &listed(vec![
                entry("phone", &fingerprint, &input),
                stale,
                entry("desktop", &own_fingerprint, &own_input),
            ]),
            NOW + 2,
        )
        .unwrap(),
        vec!["ab".repeat(32)]
    );
    assert_eq!(
        p.history_import_status(&phone_directory, NOW + 2).unwrap(),
        None
    );
}

#[test]
fn a_share_from_this_device_or_another_account_is_not_imported() {
    let folder = tempfile::tempdir().unwrap();
    let keys = Arc::new(Keys::default());
    let desktop = slot(folder.path(), keys.clone());
    let mut wire = initialized(&desktop);
    let phone = phone(&desktop, folder.path(), keys, &mut wire);
    let p = Coordinator::new(&phone);
    let directory = p.directory(wire.clone()).unwrap();
    p.history_request(&directory, NOW).unwrap();
    // Garbage, and a well-formed state whose bytes are not a share.
    let state = |share: String, sharer: &str| http::HistoryShareState {
        scope: empty().scope,
        fingerprint: "00".repeat(32),
        sharer_device_id: sharer.into(),
        share,
    };
    assert!(
        p.history_import_begin(&directory, &state("not-base64!".into(), "desktop"), NOW)
            .is_err()
    );
    assert!(
        p.history_import_begin(&directory, &state(B64.encode(b"{}"), "desktop"), NOW)
            .is_err()
    );
    // A page without an open import is refused.
    assert!(
        p.history_import_page(
            &directory,
            &http::HistoryRecordsPage {
                period: 0,
                start: "0".into(),
                records: vec![],
                next: None,
            },
            NOW,
        )
        .is_err()
    );
}

#[test]
fn a_delegated_root_is_adopted_only_when_it_is_the_accounts_own() {
    let folder = tempfile::tempdir().unwrap();
    let keys = Arc::new(Keys::default());
    let desktop = slot(folder.path(), keys.clone());
    let mut wire = initialized(&desktop);
    let phone = phone(&desktop, folder.path(), keys, &mut wire);
    let p = Coordinator::new(&phone);
    let own = p.directory(wire.clone()).unwrap();
    assert!(!p.view(&own, NOW).unwrap().controls_root);
    let deliver = |bytes: Vec<u8>| {
        phone
            .load()
            .unwrap()
            .unwrap()
            .transact(|_, records| {
                records.insert(crate::history::DELEGATED_ROOT.into(), bytes);
                Ok(())
            })
            .unwrap();
    };
    // Another root, even well formed, is dropped and never adopted.
    let stranger = Issuer::generate("instance", &phone.account().user).unwrap();
    deliver(stranger.export().unwrap().to_vec());
    assert!(!p.adopt_control().unwrap());
    assert!(!p.view(&own, NOW).unwrap().controls_root);
    // The account's own root makes the phone a controller.
    let manager = desktop.load().unwrap().unwrap();
    let exported = manager
        .inspect(|_, records| {
            let scope = manager.scope();
            Ok(Issuer::load(records, &scope.instance, &scope.user)
                .unwrap()
                .export()
                .unwrap()
                .to_vec())
        })
        .unwrap();
    deliver(exported);
    assert!(p.adopt_control().unwrap());
    assert!(
        !p.adopt_control().unwrap(),
        "adopted once, the record is gone"
    );
    let view = p.view(&own, NOW).unwrap();
    assert!(view.controls_root);
    // The new controller approves a device on its own.
    let mut account = phone.account().clone();
    account.device = "laptop".into();
    let laptop = Installation::new(
        folder.path().join("laptop-private"),
        account,
        Arc::new(Keys::default()),
    )
    .unwrap();
    let l = Coordinator::new(&laptop);
    let fresh = l.directory(wire.clone()).unwrap();
    l.begin(&fresh, &wire.identity.as_ref().unwrap().fingerprint, NOW)
        .unwrap();
    let request = l.view(&fresh, NOW).unwrap().request_code;
    let preview = p.preview(&own, &request, NOW).unwrap();
    assert!(p.approve(&own, preview, NOW).is_ok());
}
