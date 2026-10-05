use super::application_messages as messages;
use super::history_tests::{history, share_all};
use super::journal_tests::{observation, page, send_document};
use super::*;
use crate::history_backup::{Checkpoint, HistoryKey};

const BASE: u64 = 9007199254740992;

/// Puts the same history key generation in each vault, as joining does.
fn hold(key: &HistoryKey, accounts: &[&Account]) {
    let bytes = key.to_bytes().unwrap();
    for account in accounts {
        account
            .manager
            .transact(|_, records| {
                records.insert(crate::account::history_backup::KEY.into(), bytes.to_vec());
                Ok(())
            })
            .unwrap();
    }
}
/// Uploads every pending page like the worker, checking identical re-sealing.
fn upload_all(account: &Account) -> Vec<(u64, Vec<crate::history::Record>, Checkpoint)> {
    let mut pages = Vec::new();
    while let Some(page) = account.coordinator().history_backup_page(NOW).unwrap() {
        let again = account
            .reopened()
            .history_backup_page(NOW + 5)
            .unwrap()
            .unwrap();
        assert_eq!(
            page.checkpoint.to_bytes().unwrap(),
            again.checkpoint.to_bytes().unwrap()
        );
        assert!(page.records == again.records);
        account
            .coordinator()
            .history_backup_uploaded(&page.id, page.start, page.records.len() as u64, NOW)
            .unwrap();
        pages.push((page.start, page.records, page.checkpoint));
    }
    pages
}
fn operations(items: &[RecoveredMessage]) -> Vec<String> {
    items
        .iter()
        .map(|m| m.message.message().unwrap().operation_id)
        .collect()
}
fn everything() -> ProjectionQuery {
    ProjectionQuery {
        before: None,
        limit: 100,
        thread: None,
    }
}

#[test]
fn a_device_backs_up_continuously_and_a_new_device_imports_with_the_key_alone() {
    let (alice, bob) = history(12);
    let tablet = bob.sibling("bob-tablet", [9; 16]);
    let key = HistoryKey::generate().unwrap();
    // Without the key, nothing is backed up.
    assert!(
        bob.coordinator()
            .history_backup_page(NOW)
            .unwrap()
            .is_none()
    );
    hold(&key, &[&bob, &tablet]);
    let first = upload_all(&bob);
    assert_eq!(first.len(), 3, "12 documents in pages of 5");
    let checkpoint = first.last().unwrap().2.clone();
    assert_eq!(checkpoint.body.count, 12);
    // Later messages extend the same period.
    let observed = observation(&alice);
    let events = (13..=15)
        .map(|number| {
            let mut document = messages::message(&format!("history-{number}"));
            document.reply_to = None;
            send_document(&alice, document, BASE + number)
        })
        .collect::<Vec<_>>();
    bob.coordinator()
        .receive_journal(
            &observed,
            &page(&observed, BASE + 12, BASE + 15, events, None),
            NOW,
        )
        .unwrap();
    let second = upload_all(&bob);
    assert_eq!(second.len(), 1);
    assert_eq!(second[0].0, 12);
    let grown = second[0].2.clone();
    assert_eq!(grown.body.count, 15);
    assert_eq!(grown.body.period, checkpoint.body.period);
    // The tablet imports with the first checkpoint, in chunks cut differently.
    let records = first
        .iter()
        .flat_map(|(_, r, _)| r.clone())
        .collect::<Vec<_>>();
    // Out of order or past the checkpoint: refused.
    assert!(
        tablet
            .coordinator()
            .history_backup_import(&checkpoint, 1, &records[1..3], NOW)
            .is_err()
    );
    let mut held = 0;
    for chunk in records.chunks(7) {
        held = tablet
            .reopened()
            .history_backup_import(&checkpoint, held, chunk, NOW)
            .unwrap();
    }
    assert_eq!(held, 12);
    let recovered = tablet
        .reopened()
        .recovered_history("room", &everything())
        .unwrap();
    // One message in three is a thread reply, outside the main view.
    assert_eq!(recovered.len(), 8);
    // The grown checkpoint continues the period without hiding what was shown.
    assert_eq!(
        tablet.reopened().history_backup_imported(&grown).unwrap(),
        12
    );
    tablet
        .reopened()
        .history_backup_import(&grown, 12, &second[0].1, NOW)
        .unwrap();
    let recovered = tablet
        .reopened()
        .recovered_history("room", &everything())
        .unwrap();
    assert_eq!(recovered.len(), 11);
    assert_eq!(operations(&recovered).last().unwrap(), "history-15");
    // The same documents shared by path A show once.
    let request = tablet.coordinator().history_request(NOW).unwrap();
    let (share, uploaded) = share_all(&bob, &request);
    tablet
        .coordinator()
        .history_import_begin(&share, NOW)
        .unwrap();
    let shared = uploaded
        .into_iter()
        .flat_map(|(_, p)| p)
        .collect::<Vec<_>>();
    tablet
        .coordinator()
        .history_import_page(0, &shared, NOW)
        .unwrap();
    assert_eq!(
        tablet
            .reopened()
            .recovered_history("room", &everything())
            .unwrap()
            .len(),
        11
    );
}

#[test]
fn imports_refuse_foreign_accounts_wrong_keys_and_misplaced_records() {
    let (alice, bob) = history(6);
    let tablet = bob.sibling("bob-tablet", [9; 16]);
    let key = HistoryKey::generate().unwrap();
    hold(&key, &[&bob, &alice]);
    let pages = upload_all(&bob);
    let (_, records, checkpoint) = pages[0].clone();
    // A device holding another generation cannot import this one.
    hold(&HistoryKey::generate().unwrap(), &[&tablet]);
    assert!(
        tablet
            .coordinator()
            .history_backup_import(&checkpoint, 0, &records, NOW)
            .is_err()
    );
    hold(&key, &[&tablet]);
    // Another account (Alice) holding the same key still refuses Bob's checkpoint.
    assert!(
        alice
            .coordinator()
            .history_backup_import(&checkpoint, 0, &records, NOW)
            .is_err()
    );
    // Alice's own backed-up period is not one of Bob's tablet's.
    let alices = upload_all(&alice);
    let (_, foreign, foreign_checkpoint) = alices[0].clone();
    assert!(
        tablet
            .coordinator()
            .history_backup_import(&foreign_checkpoint, 0, &foreign, NOW)
            .is_err()
    );
    // Records under the wrong checkpoint or at the wrong rank are refused.
    assert!(
        tablet
            .coordinator()
            .history_backup_import(&checkpoint, 0, &foreign, NOW)
            .is_err()
    );
    assert!(
        tablet
            .coordinator()
            .history_backup_import(&checkpoint, 0, &records[1..], NOW)
            .is_err()
    );
    // A tampered checkpoint does not verify.
    let mut tampered = checkpoint.clone();
    tampered.body.count += 1;
    assert!(
        tablet
            .coordinator()
            .history_backup_import(&tampered, 0, &records, NOW)
            .is_err()
    );
    assert!(
        tablet
            .reopened()
            .recovered_history("room", &everything())
            .unwrap()
            .is_empty()
    );
    tablet
        .coordinator()
        .history_backup_import(&checkpoint, 0, &records, NOW)
        .unwrap();
    assert_eq!(
        tablet
            .reopened()
            .recovered_history("room", &everything())
            .unwrap()
            .len(),
        4,
        "history-1, 2, 4 and 5; history-3 is a thread reply"
    );
}
