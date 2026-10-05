use super::application_messages as messages;
use super::journal_tests::{fixture, group, observation, page, send_document};
use super::*;
use crate::history::Share;

const BASE: u64 = 9007199254740992;

/// Bob's desktop receives `count` messages from Alice through journal pages,
/// one in three as a thread reply.
fn history(count: u64) -> (Account, Account) {
    let (alice, bob, _, initial) = fixture(false);
    let observed = observation(&alice);
    let first = page(&observed, 0, 1, vec![group(&initial, 1, None)], None);
    for account in [&alice, &bob] {
        account
            .coordinator()
            .receive_journal(&observed, &first, NOW)
            .unwrap();
    }
    let root = format!("stored-{}", BASE + 1);
    let mut after = 1;
    for number in 1..=count {
        let mut document = messages::message(&format!("history-{number}"));
        document.reply_to = (number % 3 == 0).then(|| root.clone());
        let event = send_document(&alice, document, BASE + number);
        let next = page(&observed, after, BASE + number, vec![event], None);
        for account in [&alice, &bob] {
            account
                .coordinator()
                .receive_journal(&observed, &next, NOW)
                .unwrap();
        }
        after = BASE + number;
    }
    (alice, bob)
}
/// Runs the sharing device's job like the worker: page, upload, record.
fn share_all(
    bob: &Account,
    request: &crate::history::Request,
) -> (Share, Vec<(usize, Vec<crate::history::Record>)>) {
    let coordinator = bob.coordinator();
    coordinator.history_share_begin(request, NOW).unwrap();
    let mut uploaded = Vec::new();
    while let Some(page) = coordinator.history_share_page(NOW).unwrap() {
        // A lost upload asks for the same page again.
        let again = coordinator.history_share_page(NOW).unwrap().unwrap();
        assert_eq!(
            page.packets
                .iter()
                .map(|p| p.to_bytes().unwrap())
                .collect::<Vec<_>>(),
            again
                .packets
                .iter()
                .map(|p| p.to_bytes().unwrap())
                .collect::<Vec<_>>()
        );
        coordinator
            .history_share_uploaded(page.period, page.start, page.packets.len() as u64, NOW)
            .unwrap();
        uploaded.push((page.period, page.packets));
    }
    let share = coordinator.history_share_finish(NOW).unwrap();
    assert_eq!(
        bob.reopened()
            .history_share_finish(NOW + 1)
            .unwrap()
            .to_bytes()
            .unwrap(),
        share.to_bytes().unwrap()
    );
    (share, uploaded)
}

#[test]
fn a_new_device_of_the_account_recovers_the_shared_journal_history() {
    let (_alice, bob) = history(12);
    let tablet = bob.sibling("bob-tablet", [9; 16]);
    let request = tablet.coordinator().history_request(NOW).unwrap();
    // The request survives a lost response and a reopened vault.
    assert_eq!(tablet.reopened().history_request(NOW + 1).unwrap(), request);
    let preview = bob.coordinator().history_preview(&request, NOW).unwrap();
    assert_eq!(preview.len(), 1);
    assert_eq!(preview[0].documents, 12);
    let (share, uploaded) = share_all(&bob, &request);
    assert_eq!(uploaded.len(), 3);
    bob.coordinator().history_share_forget().unwrap();
    // The new device imports pages cut differently from the upload.
    let start = tablet
        .coordinator()
        .history_import_begin(&share, NOW)
        .unwrap();
    assert_eq!(start.next, Some((0, 0)));
    let packets = uploaded
        .into_iter()
        .flat_map(|(_, p)| p)
        .collect::<Vec<_>>();
    // Out of order: refused, nothing stored.
    assert!(
        tablet
            .coordinator()
            .history_import_page(0, &packets[1..3], NOW)
            .is_err()
    );
    let query = |before, thread: Option<&str>| ProjectionQuery {
        before,
        limit: 4,
        thread: thread.map(str::to_owned),
    };
    let mut imported = 0;
    for chunk in packets.chunks(7) {
        // Nothing shows before the period is complete.
        assert!(
            tablet
                .reopened()
                .recovered_history("room", &query(None, None))
                .unwrap()
                .is_empty()
        );
        let progress = tablet
            .reopened()
            .history_import_page(0, chunk, NOW)
            .unwrap();
        imported += chunk.len();
        assert_eq!(
            progress.next,
            (imported < packets.len()).then_some((0, imported as u64))
        );
    }
    // Import done: the job and the request are gone, the documents stay.
    assert!(tablet.reopened().history_import().unwrap().is_none());
    let latest = tablet
        .reopened()
        .recovered_history("room", &query(None, None))
        .unwrap();
    let operations = |items: &[RecoveredMessage]| {
        items
            .iter()
            .map(|m| m.message.message().unwrap().operation_id)
            .collect::<Vec<_>>()
    };
    assert_eq!(
        operations(&latest),
        ["history-7", "history-8", "history-10", "history-11"]
    );
    let older = tablet
        .reopened()
        .recovered_history("room", &query(Some(BASE + 7), None))
        .unwrap();
    assert_eq!(
        operations(&older),
        ["history-1", "history-2", "history-4", "history-5"]
    );
    let thread = tablet
        .reopened()
        .recovered_history("room", &query(None, Some(&format!("stored-{}", BASE + 1))))
        .unwrap();
    assert_eq!(
        operations(&thread),
        ["history-3", "history-6", "history-9", "history-12"]
    );
    assert!(
        latest
            .iter()
            .all(|m| m.sharer == bob.certificate.fingerprint().unwrap())
    );
}

#[test]
fn a_share_stays_within_one_account_and_one_request() {
    let (alice, bob) = history(3);
    let tablet = bob.sibling("bob-tablet", [9; 16]);
    let request = tablet.coordinator().history_request(NOW).unwrap();
    // Another account's device can neither ask nor share.
    let foreign = alice.coordinator();
    assert!(foreign.history_preview(&request, NOW).is_err());
    assert!(foreign.history_share_begin(&request, NOW).is_err());
    // A device does not answer its own request.
    assert!(
        tablet
            .coordinator()
            .history_share_begin(&request, NOW)
            .is_err()
    );
    let (share, _) = share_all(&bob, &request);
    // Alice's vault has no request for it; Bob's own desktop refuses it too.
    assert!(
        alice
            .coordinator()
            .history_import_begin(&share, NOW)
            .is_err()
    );
    assert!(bob.coordinator().history_import_begin(&share, NOW).is_err());
    // A second share for the same request is refused once one is opened.
    tablet
        .coordinator()
        .history_import_begin(&share, NOW)
        .unwrap();
    bob.coordinator().history_share_forget().unwrap();
    let (other, _) = share_all(&bob, &request);
    assert!(matches!(
        tablet.coordinator().history_import_begin(&other, NOW),
        Err(Error::Conflict)
    ));
    assert!(
        tablet
            .coordinator()
            .history_import_begin(&share, NOW + 1)
            .is_ok()
    );
}
