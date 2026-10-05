use super::application_messages as messages;
use super::*;

const BASE: u64 = 9_007_199_254_740_992;
fn observation(account: &Account) -> JournalObservation {
    let current = messages::observation(account);
    let transition = account
        .manager
        .inspect(|_, records| {
            Ok(read(records, "room")
                .unwrap()
                .unwrap()
                .active
                .unwrap()
                .transition
                .to_bytes()
                .unwrap())
        })
        .unwrap();
    JournalObservation {
        current,
        transition,
    }
}
#[test]
fn observed_history_keeps_real_mls_documents_after_cache_forgetting_and_pages_beyond_sixty_four() {
    let (alice, bob, _) = incoming_commits::fixture(false);
    let observed = observation(&bob);
    for index in 1..=130 {
        let now = NOW + index;
        let mut doc = messages::message(&format!("observed-archive-{index}"));
        doc.reply_to = None;
        let original = alice
            .coordinator()
            .prepare_message(&messages::observation(&alice), &doc, now)
            .unwrap();
        let receipt = messages::ack_at(&original, BASE + index, now);
        for account in [&alice, &bob] {
            account
                .coordinator()
                .receive_message(&messages::observation(account), &original, &receipt, now)
                .unwrap();
            account.coordinator().forget_message(&receipt).unwrap();
        }
    }
    let query = ProjectionQuery {
        before: None,
        limit: 20,
        thread: None,
    };
    let last = bob
        .reopened()
        .observed_archive(&observed, &query, NOW + 131)
        .unwrap();
    assert_eq!(last.len(), 20);
    assert_eq!(last[0].message.receipt.position, BASE + 111);
    let query = ProjectionQuery {
        before: Some(BASE + 66),
        limit: 20,
        thread: None,
    };
    let older = bob
        .reopened()
        .observed_archive(&observed, &query, NOW + 131)
        .unwrap();
    assert_eq!(older.len(), 20);
    assert_eq!(older[0].message.receipt.position, BASE + 46);
    assert_eq!(older[19].message.receipt.position, BASE + 65);
    assert_eq!(
        older[0].message.message().unwrap().operation_id,
        "observed-archive-46"
    );
    let first = bob
        .reopened()
        .observed_archive(
            &observed,
            &ProjectionQuery {
                before: Some(BASE + 2),
                limit: 20,
                thread: None,
            },
            NOW + 131,
        )
        .unwrap();
    assert_eq!(first.len(), 1);
    assert_eq!(first[0].message.receipt.position, BASE + 1);
    let mut foreign = observation(&bob);
    foreign
        .current
        .roster
        .members
        .iter_mut()
        .find(|m| m.user == "bob")
        .unwrap()
        .access_version = "new-admission".into();
    assert!(
        bob.reopened()
            .observed_archive(&foreign, &query, NOW + 131)
            .is_err()
    );
}
#[test]
fn an_aborted_page_does_not_publish_archive_nodes_or_spend_the_received_ratchet() {
    let (alice, bob, _) = incoming_commits::fixture(false);
    let mut doc = messages::message("observed-aborted-page");
    doc.reply_to = None;
    let original = alice
        .coordinator()
        .prepare_message(&messages::observation(&alice), &doc, NOW)
        .unwrap();
    let receipt = messages::ack(&original, BASE + 1);
    let observed = observation(&bob);
    let coordinator = bob.coordinator();
    let rejected: Result<()> = coordinator.transact_with_blobs(|provider, records, blobs| {
        coordinator.receive_message_inner(
            provider,
            records,
            blobs,
            &observed.current,
            &original,
            &receipt,
            NOW,
            false,
        )?;
        Err(Error::JournalOrder)
    });
    assert!(matches!(rejected, Err(Error::JournalOrder)));
    assert!(
        bob.reopened()
            .observed_archive(
                &observed,
                &ProjectionQuery {
                    before: None,
                    limit: 20,
                    thread: None
                },
                NOW
            )
            .unwrap()
            .is_empty()
    );
    bob.reopened()
        .receive_message(&observed.current, &original, &receipt, NOW)
        .unwrap();
    assert_eq!(
        bob.reopened()
            .observed_archive(
                &observed,
                &ProjectionQuery {
                    before: None,
                    limit: 20,
                    thread: None
                },
                NOW
            )
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn original_own_echoes_can_arrive_out_of_order_and_known_history_survives_author_withdrawal() {
    let (alice, bob, _) = incoming_commits::fixture(false);
    let observed = observation(&alice);
    let peer_observed = observation(&bob);
    let mut first = messages::message("archive-own-first");
    first.reply_to = None;
    let mut second = first.clone();
    second.operation_id = "archive-own-second".into();
    let a = alice
        .coordinator()
        .prepare_message(&messages::observation(&alice), &first, NOW)
        .unwrap();
    let b = alice
        .coordinator()
        .prepare_message(&messages::observation(&alice), &second, NOW)
        .unwrap();
    let ra = messages::ack(&a, BASE + 1);
    let rb = messages::ack(&b, BASE + 2);
    alice
        .coordinator()
        .receive_message(&observed.current, &b, &rb, NOW)
        .unwrap();
    alice
        .coordinator()
        .receive_message(&observed.current, &a, &ra, NOW)
        .unwrap();
    let query = ProjectionQuery {
        before: None,
        limit: 20,
        thread: None,
    };
    let history = alice
        .reopened()
        .observed_archive(&observed, &query, NOW)
        .unwrap();
    assert_eq!(history.len(), 2);
    assert_eq!(history[0].message.receipt.position, BASE + 1);
    bob.coordinator()
        .receive_message(&peer_observed.current, &a, &ra, NOW)
        .unwrap();
    bob.revoke(&alice);
    let history = bob
        .reopened()
        .observed_archive(&peer_observed, &query, NOW)
        .unwrap();
    assert_eq!(history.len(), 1);
    assert_eq!(
        history[0].message.message().unwrap().operation_id,
        "archive-own-first"
    );
    assert!(
        bob.reopened()
            .receive_message(&peer_observed.current, &b, &rb, NOW)
            .is_err()
    );
}
