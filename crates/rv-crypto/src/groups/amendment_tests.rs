use super::application_messages as messages;
use super::journal_tests::{fixture, group, observation, page, send_document};
use super::*;
use rv_crypto_public::messages as packet;
use rv_protocol::e2ee as http;

const BASE: u64 = 9007199254740992;

fn delivered(
    account: &Account,
    submission: MessageSubmission,
    position: u64,
) -> http::DeliveryEvent {
    let receipt = messages::ack(&submission, position);
    account
        .coordinator()
        .confirm_message(&receipt, NOW)
        .unwrap();
    let wire = submission.to_wire().unwrap();
    http::DeliveryEvent {
        position: position.to_string(),
        content: http::DeliveryContent::Message(http::ApplicationMessage {
            receipt: wire::message_receipt_to_wire(&receipt).unwrap(),
            proof: wire.proof,
            ciphertext: wire.ciphertext,
        }),
    }
}
fn chat(id: &str, thread: Option<String>) -> rv_protocol::SendMessage {
    let mut document = messages::message(id);
    document.text = format!("Message {id} PRIVÉ");
    document.reply_to = thread;
    document
}
use messages::stored;
/// Alice posts a root, a reply to it and another message; Alice and Bob read
/// them through the journal.
fn conversation() -> (Account, Account, JournalObservation) {
    let (alice, bob, _, initial) = fixture(false);
    let observed = observation(&alice);
    let first = page(&observed, 0, 1, vec![group(&initial, 1, None)], None);
    let events = vec![
        send_document(&alice, chat("root", None), BASE + 1),
        send_document(&alice, chat("reply", Some(stored(BASE + 1))), BASE + 2),
        send_document(&alice, chat("plain", None), BASE + 3),
    ];
    let next = page(&observed, 1, BASE + 3, events, None);
    for account in [&alice, &bob] {
        let coordinator = account.coordinator();
        coordinator.receive_journal(&observed, &first, NOW).unwrap();
        coordinator.receive_journal(&observed, &next, NOW).unwrap();
    }
    (alice, bob, observed)
}
fn query(thread: Option<String>) -> ProjectionQuery {
    ProjectionQuery {
        before: None,
        limit: 20,
        thread,
    }
}
fn operations(messages: &[journal::ProjectedMessage]) -> Vec<String> {
    messages
        .iter()
        .map(|m| m.message.message().unwrap().operation_id)
        .collect()
}

#[test]
fn authors_edit_and_delete_their_messages_and_amendments_never_show_as_rows() {
    let (alice, bob, observed) = conversation();
    let amend = |target: u64, text: Option<&str>, operation: &str| {
        alice
            .coordinator()
            .prepare_amendment(
                &messages::observation(&alice),
                &stored(target),
                text.map(str::to_owned),
                operation.into(),
                NOW,
            )
            .unwrap()
    };
    // Bob cannot amend Alice's message, nor amend an unknown one.
    assert!(
        bob.coordinator()
            .prepare_amendment(
                &messages::observation(&bob),
                &stored(BASE + 1),
                Some("forged".into()),
                "bob-edit".into(),
                NOW,
            )
            .is_err()
    );
    assert!(
        alice
            .coordinator()
            .prepare_amendment(
                &messages::observation(&alice),
                "stored-unknown",
                None,
                "unknown-delete".into(),
                NOW,
            )
            .is_err()
    );
    let events = vec![
        delivered(
            &alice,
            amend(BASE + 1, Some("edited root"), "edit-root"),
            BASE + 4,
        ),
        delivered(&alice, amend(BASE + 2, None, "delete-reply"), BASE + 5),
        delivered(
            &alice,
            amend(BASE + 3, Some("first edit"), "edit-plain-1"),
            BASE + 6,
        ),
        delivered(
            &alice,
            amend(BASE + 3, Some("second edit"), "edit-plain-2"),
            BASE + 7,
        ),
        // A deletion is final: a later edit of the deleted reply is ignored.
        delivered(
            &alice,
            amend(BASE + 2, Some("too late"), "edit-deleted"),
            BASE + 8,
        ),
    ];
    let next = page(&observed, BASE + 3, BASE + 8, events, None);
    for account in [&alice, &bob] {
        account
            .coordinator()
            .receive_journal(&observed, &next, NOW)
            .unwrap();
        let main = account
            .reopened()
            .journal_projection(&observed, &query(None), NOW)
            .unwrap();
        assert_eq!(operations(&main.messages), ["root", "plain"]);
        let edits = main
            .messages
            .iter()
            .map(|m| m.edit.as_ref().map(|e| e.text.as_str().to_owned()))
            .collect::<Vec<_>>();
        assert_eq!(
            edits,
            [Some("edited root".into()), Some("second edit".into())]
        );
        assert!(!main.has_older);
        // The deleted reply leaves the thread and its count.
        assert_eq!(main.retained_replies.get(&stored(BASE + 1)), None);
        let thread = account
            .reopened()
            .journal_projection(&observed, &query(Some(stored(BASE + 1))), NOW)
            .unwrap();
        assert!(thread.messages.is_empty());
        let root = thread.root.unwrap();
        assert_eq!(root.edit.unwrap().text.as_str(), "edited root");
        // Quote sources apply the same amendments.
        let sources = account.reopened().journal_sources(&observed, NOW).unwrap();
        assert_eq!(operations(&sources.messages), ["root", "plain"]);
        assert_eq!(
            sources.messages[1].edit.as_ref().unwrap().text.as_str(),
            "second edit"
        );
    }
}

#[test]
fn an_amendment_by_another_author_is_ignored_and_payload_shapes_are_checked() {
    let (alice, bob, observed) = conversation();
    // Bob bypasses the sending check: readers still ignore his amendment.
    let forged = bob
        .coordinator()
        .prepare_document(
            &messages::observation(&bob),
            &rv_protocol::SendMessage {
                operation_id: "bob-forged".into(),
                text: String::new(),
                reply_to: None,
                quotes: Vec::new(),
                cards: Vec::new(),
                files: vec![],
            },
            packet::Kind::Delete,
            Some(stored(BASE + 3)),
            NOW,
        )
        .unwrap();
    let next = page(
        &observed,
        BASE + 3,
        BASE + 4,
        vec![delivered(&bob, forged, BASE + 4)],
        None,
    );
    for account in [&alice, &bob] {
        account
            .coordinator()
            .receive_journal(&observed, &next, NOW)
            .unwrap();
        let main = account
            .reopened()
            .journal_projection(&observed, &query(None), NOW)
            .unwrap();
        assert_eq!(operations(&main.messages), ["root", "plain"]);
        assert!(main.messages.iter().all(|m| m.edit.is_none()));
    }
    // An edit must carry text only; a deletion carries nothing.
    let shape = |text: &str, kind: packet::Kind| {
        let mut document = chat("shape", None);
        document.text = text.into();
        document.quotes.clear();
        document.cards.clear();
        messages_validate(&kind, &document)
    };
    assert!(shape("new text", packet::Kind::Edit));
    assert!(!shape("", packet::Kind::Edit));
    assert!(shape("", packet::Kind::Delete));
    assert!(!shape("text", packet::Kind::Delete));
    let mut quoted = chat("shape", None);
    quoted.text = "with a quote".into();
    assert!(!messages_validate(&packet::Kind::Edit, &quoted));
}
fn messages_validate(kind: &packet::Kind, document: &rv_protocol::SendMessage) -> bool {
    super::messages::validate_kind(kind, document).is_ok()
}

#[test]
fn recovered_history_carries_and_applies_the_amendments() {
    let (alice, bob, observed) = conversation();
    let amend = |target: u64, text: Option<&str>, operation: &str| {
        alice
            .coordinator()
            .prepare_amendment(
                &messages::observation(&alice),
                &stored(target),
                text.map(str::to_owned),
                operation.into(),
                NOW,
            )
            .unwrap()
    };
    let events = vec![
        delivered(
            &alice,
            amend(BASE + 3, Some("edited plain"), "edit-plain"),
            BASE + 4,
        ),
        delivered(&alice, amend(BASE + 1, None, "delete-root"), BASE + 5),
    ];
    let next = page(&observed, BASE + 3, BASE + 5, events, None);
    bob.coordinator()
        .receive_journal(&observed, &next, NOW)
        .unwrap();
    // Bob's tablet recovers the room's history, amendments included.
    let tablet = bob.sibling("bob-tablet", [9; 16]);
    let request = tablet.coordinator().history_request(NOW).unwrap();
    let (share, uploaded) = super::history_tests::share_all(&bob, &request);
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
    let recovered = tablet
        .reopened()
        .recovered_history("room", &query(None))
        .unwrap();
    let rows = recovered
        .iter()
        .map(|m| {
            (
                m.message.message().unwrap().operation_id,
                m.edit.as_ref().map(|e| e.text.as_str().to_owned()),
            )
        })
        .collect::<Vec<_>>();
    assert_eq!(
        rows,
        [("plain".to_owned(), Some("edited plain".to_owned()))]
    );
}

fn react(
    account: &Account,
    target: u64,
    emoji: &str,
    present: bool,
    operation: &str,
) -> Result<MessageSubmission> {
    account.coordinator().prepare_reaction(
        &messages::observation(account),
        &stored(target),
        emoji,
        present,
        operation.into(),
        NOW,
    )
}
fn reactions(message: &journal::ProjectedMessage) -> Vec<(String, Vec<String>)> {
    message
        .reactions
        .iter()
        .map(|r| (r.emoji.clone(), r.users.clone()))
        .collect()
}

#[test]
fn members_react_and_withdraw_and_the_latest_action_per_user_and_emoji_wins() {
    let (alice, bob, observed) = conversation();
    // An unknown target, an invalid emoji name and quotes are refused.
    assert!(react(&bob, 99, "thumbsup", true, "bob-unknown").is_err());
    for emoji in ["", "Thumbs Up", ":thumbsup:", "👍"] {
        assert!(react(&bob, BASE + 1, emoji, true, "bob-invalid").is_err());
    }
    let events = vec![
        delivered(
            &alice,
            react(&alice, BASE + 1, "thumbsup", true, "a-1").unwrap(),
            BASE + 4,
        ),
        delivered(
            &bob,
            react(&bob, BASE + 1, "heart", true, "b-1").unwrap(),
            BASE + 5,
        ),
        delivered(
            &bob,
            react(&bob, BASE + 1, "thumbsup", true, "b-2").unwrap(),
            BASE + 6,
        ),
        delivered(
            &bob,
            react(&bob, BASE + 1, "heart", false, "b-3").unwrap(),
            BASE + 7,
        ),
        // A reply's reaction stays in its thread.
        delivered(
            &bob,
            react(&bob, BASE + 2, "tada", true, "b-4").unwrap(),
            BASE + 8,
        ),
    ];
    let next = page(&observed, BASE + 3, BASE + 8, events, None);
    for account in [&alice, &bob] {
        account
            .coordinator()
            .receive_journal(&observed, &next, NOW)
            .unwrap();
        let main = account
            .reopened()
            .journal_projection(&observed, &query(None), NOW)
            .unwrap();
        assert_eq!(operations(&main.messages), ["root", "plain"]);
        let alice_id = alice.manager.scope().user.clone();
        let bob_id = bob.manager.scope().user.clone();
        let mut both = vec![alice_id, bob_id.clone()];
        both.sort();
        assert_eq!(
            reactions(&main.messages[0]),
            [("thumbsup".to_owned(), both.clone())]
        );
        assert!(main.messages[1].reactions.is_empty());
        let thread = account
            .reopened()
            .journal_projection(&observed, &query(Some(stored(BASE + 1))), NOW)
            .unwrap();
        assert_eq!(
            reactions(&thread.root.unwrap()),
            [("thumbsup".to_owned(), both)]
        );
        assert_eq!(
            reactions(&thread.messages[0]),
            [("tada".to_owned(), vec![bob_id])]
        );
        // Reactions are amendments: no row, no reply.
        assert_eq!(main.retained_replies.get(&stored(BASE + 1)), Some(&1));
    }
    // A reaction is not itself a target.
    assert!(react(&alice, BASE + 4, "heart", true, "a-chained").is_err());
}

#[test]
fn private_search_matches_the_shown_text_across_threads_newest_first() {
    let (alice, bob, observed) = conversation();
    let amend = |target: u64, text: Option<&str>, operation: &str| {
        alice
            .coordinator()
            .prepare_amendment(
                &messages::observation(&alice),
                &stored(target),
                text.map(str::to_owned),
                operation.into(),
                NOW,
            )
            .unwrap()
    };
    let events = vec![
        delivered(
            &alice,
            amend(BASE + 3, Some("Renamed CARROT"), "edit-plain"),
            BASE + 4,
        ),
        delivered(&alice, amend(BASE + 1, None, "delete-root"), BASE + 5),
    ];
    let next = page(&observed, BASE + 3, BASE + 5, events, None);
    bob.coordinator()
        .receive_journal(&observed, &next, NOW)
        .unwrap();
    let search = |account: &Account, text: &str, limit: usize| {
        let found = account
            .reopened()
            .journal_search(&observed, text, limit, NOW)
            .unwrap();
        (
            found
                .messages
                .iter()
                .map(|m| m.message.message().unwrap().operation_id)
                .collect::<Vec<_>>(),
            found.truncated,
        )
    };
    // Case-insensitive, thread replies included, deleted and edited-away text
    // left out, newest first.
    assert_eq!(
        search(&bob, "  privé ", 20),
        (vec!["reply".to_owned()], false)
    );
    assert_eq!(
        search(&bob, "carrot", 20),
        (vec!["plain".to_owned()], false)
    );
    assert_eq!(search(&bob, "message plain", 20), (vec![], false));
    assert_eq!(
        search(&bob, "message", 20),
        (vec!["reply".to_owned()], false)
    );
    for (text, limit) in [("", 20), ("   ", 20), ("x", 0), ("x", 201)] {
        assert!(
            bob.reopened()
                .journal_search(&observed, text, limit, NOW)
                .is_err()
        );
    }
    let long = "x".repeat(257);
    assert!(
        bob.reopened()
            .journal_search(&observed, &long, 20, NOW)
            .is_err()
    );
    // Truncation reports that more match.
    let both = vec![delivered(
        &alice,
        amend(BASE + 2, Some("carrot reply"), "edit-reply"),
        BASE + 6,
    )];
    let next = page(&observed, BASE + 5, BASE + 6, both, None);
    bob.coordinator()
        .receive_journal(&observed, &next, NOW)
        .unwrap();
    // Order is by message position, not by the time of its edit.
    assert_eq!(search(&bob, "CARROT", 1), (vec!["plain".to_owned()], true));
    assert_eq!(
        search(&bob, "CARROT", 2),
        (vec!["plain".to_owned(), "reply".to_owned()], false)
    );
}

fn file(id: &str) -> rv_protocol::parity::EncryptedFile {
    rv_protocol::parity::EncryptedFile {
        id: id.into(),
        key: crate::files::encode_key(&[3; 32]),
        filename: "rapport privé.pdf".into(),
        media_type: "application/pdf".into(),
        bytes: "12345".into(),
        sha256: "ab".repeat(32),
    }
}

#[test]
fn a_private_message_carries_encrypted_files_bound_to_its_header() {
    let (alice, bob, observed) = conversation();
    let mut document = chat("with-files", None);
    document.text = String::new();
    document.files = vec![file("upload-one"), file("upload-two")];
    let submission = alice
        .coordinator()
        .prepare_message(&messages::observation(&alice), &document, NOW)
        .unwrap();
    let event = delivered(&alice, submission, BASE + 4);
    let next = page(&observed, BASE + 3, BASE + 4, vec![event], None);
    bob.coordinator()
        .receive_journal(&observed, &next, NOW)
        .unwrap();
    let main = bob
        .reopened()
        .journal_projection(&observed, &query(None), NOW)
        .unwrap();
    let last = main.messages.last().unwrap();
    assert_eq!(
        last.message.receipt.header.files,
        ["upload-one", "upload-two"]
    );
    assert_eq!(last.message.message().unwrap().files, document.files);
    // Invalid descriptors, and files on an amendment, are refused.
    let refused = |files: Vec<rv_protocol::parity::EncryptedFile>, text: &str| {
        let mut bad = chat("bad-files", None);
        bad.text = text.into();
        bad.files = files;
        alice
            .coordinator()
            .prepare_message(&messages::observation(&alice), &bad, NOW)
            .is_err()
    };
    let with = |change: fn(&mut rv_protocol::parity::EncryptedFile)| {
        let mut f = file("upload-x");
        change(&mut f);
        vec![f]
    };
    assert!(refused(vec![file("same"), file("same")], ""));
    assert!(refused(
        (0..9).map(|i| file(&format!("f{i}"))).collect(),
        "x"
    ));
    assert!(refused(with(|f| f.key = "short".into()), ""));
    assert!(refused(with(|f| f.filename = "../etc".into()), ""));
    assert!(refused(with(|f| f.filename = " ".into()), ""));
    assert!(refused(
        with(|f| f.media_type = "text/plain; charset=utf 8".into()),
        ""
    ));
    assert!(refused(with(|f| f.bytes = "104831978".into()), ""));
    assert!(refused(with(|f| f.bytes = "012".into()), ""));
    assert!(refused(with(|f| f.sha256 = "AB".repeat(32)), ""));
    let mut edit = chat("edit-files", None);
    edit.files = vec![file("upload-three")];
    assert!(super::messages::validate_kind(&packet::Kind::Edit, &edit).is_err());
}
