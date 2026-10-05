use super::application_messages as messages;
use super::journal_tests::{fixture, group, observation, page, send_document};
use super::*;
use crate::history::Share;

const BASE: u64 = 9007199254740992;

/// Bob's desktop receives `count` messages from Alice through journal pages,
/// one in three as a thread reply.
pub(super) fn history(count: u64) -> (Account, Account) {
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
pub(super) fn share_all(
    bob: &Account,
    request: &crate::history::Request,
) -> (Share, Vec<(usize, Vec<crate::history::Record>)>) {
    let coordinator = bob.coordinator();
    coordinator
        .history_share_begin(request, false, NOW)
        .unwrap();
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
    assert!(foreign.history_share_begin(&request, false, NOW).is_err());
    // A device does not answer its own request.
    assert!(
        tablet
            .coordinator()
            .history_share_begin(&request, false, NOW)
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

#[test]
fn the_new_devices_conversation_continues_into_recovered_history() {
    use super::{admission, changes};
    let (alice, bob) = history(6);
    let tablet = bob.sibling("bob-tablet", [9; 16]);
    for account in [&alice, &bob] {
        account.trust(&tablet, true);
        tablet.trust(account, true);
    }
    // Recovered first, while the tablet has no admission of its own yet.
    let request = tablet.coordinator().history_request(NOW).unwrap();
    let (share, uploaded) = share_all(&bob, &request);
    tablet
        .coordinator()
        .history_import_begin(&share, NOW)
        .unwrap();
    let records = uploaded
        .into_iter()
        .flat_map(|(_, p)| p)
        .collect::<Vec<_>>();
    tablet
        .coordinator()
        .history_import_page(0, &records, NOW)
        .unwrap();
    // Alice adds the tablet; its own journal starts at that change.
    let change = changes::change(
        &alice,
        "add-tablet",
        &["alice", "bob"],
        &[],
        vec![tablet.package()],
    );
    let submission = changes::prepare_change(&alice, &change, NOW);
    let genesis = Genesis {
        roster: change.roster.clone(),
        operation: change.operation.clone(),
        packages: vec![],
    };
    admission::accept(
        &tablet,
        &admission::event(&genesis, &submission, "bob-tablet"),
    );
    alice
        .coordinator()
        .confirm(&receipt(&submission), NOW)
        .unwrap();
    // The server's current head is the change, settled for Alice by the journal.
    let observed = JournalObservation {
        current: MessageObservation {
            roster: change.roster.clone(),
            head: receipt(&submission),
            needs_rekey: false,
        },
        transition: submission.transition.clone(),
    };
    // Only the admitted device's page carries its Welcome.
    let changed = |welcome| vec![group(&submission, BASE + 7, welcome)];
    let after = tablet.coordinator().journal_request("room").unwrap().after;
    for (account, from, welcome) in [
        (&alice, BASE + 6, None),
        (&bob, BASE + 6, None),
        (&tablet, after, Some("bob-tablet")),
    ] {
        account
            .coordinator()
            .receive_journal(
                &observed,
                &page(&observed, from, BASE + 7, changed(welcome), None),
                NOW,
            )
            .unwrap();
    }
    let events = [8, 9]
        .map(|number| {
            let mut document = messages::message(&format!("own-{number}"));
            document.reply_to = None;
            send_document(&alice, document, BASE + number)
        })
        .to_vec();
    for account in [&alice, &bob, &tablet] {
        account
            .coordinator()
            .receive_journal(
                &observed,
                &page(&observed, BASE + 7, BASE + 9, events.clone(), None),
                NOW,
            )
            .unwrap();
    }
    let own = observation(&tablet);
    let query = |before, limit, thread: Option<String>| ProjectionQuery {
        before,
        limit,
        thread,
    };
    let operations = |p: &JournalProjection| {
        p.messages
            .iter()
            .map(|m| m.message.message().unwrap().operation_id)
            .collect::<Vec<_>>()
    };
    let latest = tablet
        .reopened()
        .journal_projection(&own, &query(None, 4, None), NOW)
        .unwrap();
    assert_eq!(
        operations(&latest),
        ["history-4", "history-5", "own-8", "own-9"]
    );
    assert!(latest.has_older);
    // Recovered documents keep the time the sharing device observed them.
    assert!(latest.messages[..2].iter().all(|m| m.observed_at == NOW));
    let older = tablet
        .reopened()
        .journal_projection(&own, &query(Some(BASE + 4), 4, None), NOW)
        .unwrap();
    assert_eq!(operations(&older), ["history-1", "history-2"]);
    assert!(!older.has_older);
    // A thread rooted before the tablet's admission finds its recovered root.
    let root = format!("stored-{}", BASE + 1);
    let thread = tablet
        .reopened()
        .journal_projection(&own, &query(None, 10, Some(root.clone())), NOW)
        .unwrap();
    assert_eq!(operations(&thread), ["history-3", "history-6"]);
    assert_eq!(thread.root.unwrap().message.receipt.message, root);
    // Bob's own view is unchanged: his history is his own.
    let bobs = bob
        .reopened()
        .journal_projection(&observed, &query(None, 4, None), NOW)
        .unwrap();
    assert_eq!(
        operations(&bobs),
        ["history-4", "history-5", "own-8", "own-9"]
    );
    // Private search continues into the recovered history, newest first.
    let search = |limit| {
        let found = tablet
            .reopened()
            .journal_search(&own, "PRIVÉ", limit, NOW)
            .unwrap();
        let ids = found
            .messages
            .iter()
            .map(|m| m.message.message().unwrap().operation_id)
            .collect::<Vec<_>>();
        (ids, found.truncated)
    };
    assert_eq!(
        search(20),
        (
            [9, 8]
                .map(|n| format!("own-{n}"))
                .into_iter()
                .chain((1..=6).rev().map(|n| format!("history-{n}")))
                .collect::<Vec<_>>(),
            false
        )
    );
    assert_eq!(search(3).0, ["own-9", "own-8", "history-6"]);
    assert!(search(3).1);
}

#[test]
fn control_travels_with_a_share_only_on_request_and_only_from_the_root_holder() {
    let (_, bob) = history(3);
    let tablet = bob.sibling("bob-tablet", [9; 16]);
    let request = tablet.coordinator().history_request(NOW).unwrap();
    // A device without the private root cannot hand control over.
    let laptop = bob.sibling("bob-laptop", [8; 16]);
    assert!(
        laptop
            .coordinator()
            .history_share_begin(&request, true, NOW)
            .is_err()
    );
    // Begun without delegation, the job learns it before its share is drawn.
    let coordinator = bob.coordinator();
    coordinator
        .history_share_begin(&request, false, NOW)
        .unwrap();
    coordinator
        .history_share_begin(&request, true, NOW)
        .unwrap();
    while let Some(page) = coordinator.history_share_page(NOW).unwrap() {
        coordinator
            .history_share_uploaded(page.period, page.start, page.packets.len() as u64, NOW)
            .unwrap();
    }
    let share = coordinator.history_share_finish(NOW).unwrap();
    tablet
        .coordinator()
        .history_import_begin(&share, NOW)
        .unwrap();
    // The new device holds the delegated root, exactly the account's.
    tablet
        .manager
        .inspect(|_, records| {
            let bytes = records.get(crate::history::DELEGATED_ROOT).unwrap();
            assert!(crate::identity::Issuer::import(bytes, &bob.root).is_ok());
            Ok(())
        })
        .unwrap();
    // An ordinary share carries no root.
    let phone = bob.sibling("bob-phone", [7; 16]);
    let other = phone.coordinator().history_request(NOW).unwrap();
    let (plain, _) = super::history_tests::share_all(&bob, &other);
    phone
        .coordinator()
        .history_import_begin(&plain, NOW)
        .unwrap();
    phone
        .manager
        .inspect(|_, records| {
            assert!(records.get(crate::history::DELEGATED_ROOT).is_none());
            Ok(())
        })
        .unwrap();
}
