use super::*;
use rv_protocol::parity::ReadState;

fn identity(epoch: &str) -> Identity {
    Identity { instance_id: "quote-instance".into(), data_epoch: epoch.into() }
}
fn room(id: &str, revision: &str, grant: &str) -> Room {
    Room {
        id: id.into(),
        name: id.into(),
        kind: rv_protocol::RoomKind::Private,
        revision: revision.into(),
        encrypted: false,
        read_state: Some(Box::new(ReadState {
            room_id: id.into(),
            revision: revision.into(),
            membership_version: Some(grant.into()),
            favorite_revision: Some(revision.into()),
            root_position: "0".into(),
            reply_position: "0".into(),
            unread_roots: "0".into(),
            unread_replies: "0".into(),
            mentions: "0".into(),
            group_mentions: "0".into(),
            favorite: false,
        })),
    }
}
fn message(id: &str, rid: &str, revision: &str, text: &str) -> Message {
    let fixture: Value =
        serde_json::from_str(include_str!("../../../../../../../../docs/protocol/v1.fixture.json")).unwrap();
    let mut m: Message = serde_json::from_value(fixture["message"].clone()).unwrap();
    m.id = id.into();
    m.room_id = rid.into();
    m.position = revision.into();
    m.revision = revision.into();
    m.text = text.into();
    m.quotes.clear();
    m
}
fn initial() -> Snapshot {
    let source = message("source", "origin", "10", "*Privé* _texte_ :rocket:");
    let mut reply = message("reply", "destination", "20", "Ma réponse");
    reply.quotes.push(MessageQuote {
        reference: QuoteReference {
            message_id: source.id.clone(),
            room_id: source.room_id.clone(),
            revision: source.revision.clone(),
        },
        excerpt: Some(Box::new(QuoteExcerpt {
            author: source.author.as_ref().clone(),
            text: source.text.clone(),
            created_at: source.created_at.clone(),
            revision: source.revision.clone(),
            membership_version: "source-grant".into(),
            files: vec![],
            references: vec![],
            quotes: vec![],
        })),
        view_position: "20".into(),
        source_membership_version: Some("source-grant".into()),
    });
    Snapshot {
        protocol_version: 1,
        rooms: vec![room("origin", "1", "source-grant"), room("destination", "1", "destination-grant")],
        messages: vec![source, reply],
        cursor: "initial".into(),
    }
}
fn store() -> NativeStore {
    let store = NativeStore::open(Path::new(":memory:"), identity("epoch")).unwrap();
    store.snapshot(&initial()).unwrap();
    store
}

#[test]
fn nested_cards_use_each_grant_and_parents_keep_no_private_descendant_copy() {
    let store = NativeStore::open(Path::new(":memory:"), identity("epoch")).unwrap();
    let mut snapshot = initial();
    let mut leaf = message("leaf", "leaf-room", "25", "Nested private leaf");
    leaf.files = vec![rv_protocol::parity::FileDescriptor {
        id: "leaf-file".into(),
        room_id: leaf.room_id.clone(),
        bytes: "5".into(),
        sha256: "a".repeat(64),
        media_type: "application/pdf".into(),
        filename: Some("leaf.pdf".into()),
        encrypted: false,
    }];
    let reference =
        QuoteReference { room_id: leaf.room_id.clone(), message_id: leaf.id.clone(), revision: leaf.revision.clone() };
    let child = MessageQuote {
        reference: reference.clone(),
        view_position: "40".into(),
        source_membership_version: Some("leaf-grant".into()),
        excerpt: Some(Box::new(QuoteExcerpt {
            author: leaf.author.as_ref().clone(),
            text: leaf.text.clone(),
            created_at: leaf.created_at.clone(),
            revision: leaf.revision.clone(),
            membership_version: "leaf-grant".into(),
            files: leaf.files.clone(),
            references: vec![],
            quotes: vec![],
        })),
    };
    snapshot.messages[0].revision = "26".into();
    snapshot.messages[0].position = "26".into();
    snapshot.messages[0].quotes = vec![child.clone()];
    let reply = &mut snapshot.messages[1];
    reply.revision = "30".into();
    reply.position = "30".into();
    reply.quotes[0].reference.revision = "26".into();
    reply.quotes[0].view_position = "40".into();
    let parent = reply.quotes[0].excerpt.as_mut().unwrap();
    parent.revision = "26".into();
    parent.references = vec![reference];
    parent.quotes = vec![child];
    let stale = reply.clone();
    snapshot.rooms.push(room("leaf-room", "1", "leaf-grant"));
    snapshot.messages.insert(0, leaf.clone());
    store.snapshot(&snapshot).unwrap();
    assert_eq!(cards(&store)[0].quotes[0].text, leaf.text);
    let raw: String = store
        .conn
        .lock()
        .unwrap()
        .query_row("SELECT payload FROM native_quote_sources WHERE id='source'", [], |r| r.get(0))
        .unwrap();
    assert!(!raw.contains(&leaf.text));
    assert!(!raw.contains("leaf-file"));
    assert_eq!(cards(&store)[0].quotes[0].files[0].title, "leaf.pdf");
    assert!(store.file_descriptor("leaf-file").unwrap().is_some());
    store.batch(&batch(vec![Change::RoomRemoved { room_id: "leaf-room".into() }])).unwrap();
    assert!(!cards(&store)[0].unavailable && cards(&store)[0].quotes[0].unavailable);
    assert!(store.file_descriptor("leaf-file").unwrap().is_none());
    store.ingest(&[stale]).unwrap();
    assert!(cards(&store)[0].quotes[0].unavailable);
    let raw: Vec<String> = store
        .conn
        .lock()
        .unwrap()
        .prepare("SELECT payload FROM native_quote_sources WHERE payload IS NOT NULL")
        .unwrap()
        .query_map([], |r| r.get(0))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap();
    assert!(raw.iter().all(|row| !row.contains(&leaf.text)));
}
fn cards(store: &NativeStore) -> Vec<crate::content::Quote> {
    let row = store.selected_messages(&["reply".into()]).unwrap().pop().unwrap().presentation("destination", "self");
    crate::content::quotes(row.attachments.as_deref())
}
fn unavailable(store: &NativeStore) {
    let cards = cards(store);
    assert_eq!(cards.len(), 1);
    assert!(cards[0].author.is_none());
    assert!(cards[0].text.is_empty());
    assert!(cards[0].md.is_none());
}
fn batch(changes: Vec<Change>) -> SyncBatch {
    SyncBatch { protocol_version: 1, changes, cursor: "next".into(), has_more: false }
}

#[test]
fn quoted_files_need_no_fabricated_history_and_follow_source_authority() {
    for mime in ["image/png", "audio/ogg", "video/mp4", "application/pdf"] {
        let store = NativeStore::open(Path::new(":memory:"), identity("epoch")).unwrap();
        let mut snapshot = initial();
        let source = snapshot.messages.remove(0);
        let file = rv_protocol::parity::FileDescriptor {
            id: "quoted-file".into(),
            room_id: "origin".into(),
            bytes: "42".into(),
            sha256: "a".repeat(64),
            media_type: mime.into(),
            filename: Some("Private attachment".into()),
            encrypted: false,
        };
        snapshot.messages[0].quotes[0].excerpt.as_mut().unwrap().files = vec![file.clone()];
        store.snapshot(&snapshot).unwrap();
        assert!(store.selected_messages(std::slice::from_ref(&source.id)).unwrap().is_empty());
        assert_eq!(store.file_descriptor(&file.id).unwrap(), Some(file.clone()));
        let quotes = cards(&store);
        if mime == "image/png" {
            assert_eq!(quotes[0].images[0].source, "rv-file:quoted-file");
        } else {
            assert_eq!(quotes[0].files[0].title, "Private attachment");
        }
        let mut malformed = snapshot.messages[0].clone();
        malformed.revision = "21".into();
        malformed.quotes[0].excerpt.as_mut().unwrap().files[0].room_id = "destination".into();
        assert!(store.ingest(&[malformed]).is_err());
        assert_eq!(store.file_descriptor(&file.id).unwrap(), Some(file.clone()));
        let mut deleted = source;
        deleted.revision = "30".into();
        deleted.deleted = true;
        deleted.text.clear();
        store.ingest(&[deleted]).unwrap();
        assert!(cards(&store)[0].unavailable);
        assert!(store.file_descriptor(&file.id).unwrap().is_none());
        store.ingest(&snapshot.messages).unwrap();
        assert!(store.file_descriptor(&file.id).unwrap().is_none());
    }
    let store = store();
    let mut snapshot = initial();
    let file = rv_protocol::parity::FileDescriptor {
        id: "grant-file".into(),
        room_id: "origin".into(),
        bytes: "10".into(),
        sha256: "b".repeat(64),
        media_type: "application/pdf".into(),
        filename: Some("grant.pdf".into()),
        encrypted: false,
    };
    snapshot.messages[0].files = vec![file.clone()];
    snapshot.messages[1].quotes[0].excerpt.as_mut().unwrap().files = vec![file.clone()];
    store.snapshot(&snapshot).unwrap();
    let mut unavailable = snapshot.messages[1].clone();
    unavailable.quotes[0].view_position = "30".into();
    unavailable.quotes[0].excerpt = None;
    store.ingest(&[unavailable]).unwrap();
    assert!(store.file_descriptor(&file.id).unwrap().is_none());
    assert!(!store.selected_messages(&["source".into()]).unwrap().is_empty());
    store.batch(&batch(vec![Change::RoomRemoved { room_id: "origin".into() }])).unwrap();
    store.ingest(&[snapshot.messages[1].clone()]).unwrap();
    assert!(store.file_descriptor(&file.id).unwrap().is_none());
    store.batch(&batch(vec![Change::RoomUpsert(room("origin", "40", "new-grant"))])).unwrap();
    store.ingest(&[snapshot.messages[1].clone()]).unwrap();
    assert!(store.file_descriptor(&file.id).unwrap().is_none());
}

#[test]
fn durable_edits_keep_ordered_references_without_source_authority_across_restart_and_reset() {
    let path = std::env::temp_dir().join(format!("rv-quote-edit-{:032x}.sqlite", fastrand::u128(..)));
    let first = NativeStore::open(&path, identity("epoch")).unwrap();
    let mut snapshot = initial();
    let mut second = snapshot.messages[1].quotes[0].clone();
    second.reference.message_id = "source-two".into();
    second.reference.revision = "9007199254740993".into();
    second.excerpt = None;
    snapshot.messages[1].quotes.push(second);
    let expected: Vec<_> = snapshot.messages[1].quotes.iter().map(|q| q.reference.clone()).collect();
    first.snapshot(&snapshot).unwrap();
    first.batch(&batch(vec![Change::RoomRemoved { room_id: "origin".into() }])).unwrap();
    assert!(first.command("destination", "reply", "19", MessageCommandKind::Edit, "Stale").unwrap().is_none());
    assert!(first.has_command_revision_conflict("reply").unwrap());
    assert_eq!(first.command_draft("reply").unwrap().as_deref(), Some("Stale"));
    let command = first.command("destination", "reply", "20", MessageCommandKind::Edit, "Saved edit").unwrap().unwrap();
    assert_eq!(command.quotes.as_ref().unwrap(), &expected);
    let persisted: String =
        first.conn.lock().unwrap().query_row("SELECT quotes FROM native_commands", [], |r| r.get(0)).unwrap();
    assert!(!persisted.contains("Privé") && !persisted.contains("membership") && !persisted.contains("author"));
    // Projection and snapshot can change after the first request lost its response.
    let mut updated = message("reply", "destination", "50", "Another version");
    updated.position = "20".into();
    first.ingest(&[updated.clone()]).unwrap();
    let reset = Snapshot {
        protocol_version: 1,
        rooms: vec![room("destination", "1", "destination-grant")],
        messages: vec![updated],
        cursor: "reset".into(),
    };
    first.snapshot(&reset).unwrap();
    drop(first);
    let reopened = NativeStore::open(&path, identity("epoch")).unwrap();
    let replay =
        reopened.command("destination", "reply", "50", MessageCommandKind::Edit, "Saved edit").unwrap().unwrap();
    assert_eq!(replay.id, command.id);
    assert_eq!(replay.expected_revision, "20");
    assert_eq!(replay.quotes.unwrap(), expected);
    reopened.fail_command(&command.id, "revision_conflict").unwrap();
    assert_eq!(reopened.command_draft("reply").unwrap().as_deref(), Some("Saved edit"));
    let fresh = reopened.command("destination", "reply", "50", MessageCommandKind::Edit, "New edit").unwrap().unwrap();
    assert_ne!(fresh.id, command.id);
    assert!(fresh.quotes.unwrap().is_empty());
    drop(reopened);
    std::fs::remove_file(path).unwrap();
}

#[test]
fn quoted_outbox_keeps_original_body_and_existing_cards_after_source_loss_restart_and_reset() {
    let path = std::env::temp_dir().join(format!("rv-quoted-outbox-{:032x}.sqlite", fastrand::u128(..)));
    let first = NativeStore::open(&path, identity("epoch")).unwrap();
    first.snapshot(&initial()).unwrap();
    let selected = first.quote_selection("origin", "source").unwrap();
    let pending = Pending {
        reply_to: None,
        id: "pending-reply".into(),
        room_id: "destination".into(),
        text: String::new(),
        quotes: vec![selected.reference.clone()],
    };
    assert!(
        first
            .enqueue_quoted(&pending, "alice", Some(Some("destination-grant")), std::slice::from_ref(&selected))
            .unwrap()
    );
    let row = first.selected_messages(std::slice::from_ref(&pending.id)).unwrap().pop().unwrap();
    assert_eq!(crate::content::quotes(row.attachments.as_deref())[0].text, "*Privé* _texte_ :rocket:");
    first.batch(&batch(vec![Change::RoomRemoved { room_id: "origin".into() }])).unwrap();
    let reset = Snapshot {
        protocol_version: 1,
        rooms: vec![room("destination", "1", "destination-grant")],
        messages: vec![],
        cursor: "reset".into(),
    };
    first.snapshot(&reset).unwrap();
    drop(first);
    let reopened = NativeStore::open(&path, identity("epoch")).unwrap();
    assert_eq!(reopened.pending().unwrap(), vec![pending.clone()]);
    let row = reopened.selected_messages(std::slice::from_ref(&pending.id)).unwrap().pop().unwrap();
    let cards = crate::content::quotes(row.attachments.as_deref());
    assert_eq!(cards.len(), 1);
    assert!(cards[0].author.is_none() && cards[0].text.is_empty());
    let raw: String =
        reopened.conn.lock().unwrap().query_row("SELECT quotes FROM native_outbox", [], |r| r.get(0)).unwrap();
    assert!(!raw.contains("Privé") && !raw.contains("membership") && !raw.contains("epoch"));
    reopened.fail(&pending.id, "quote_revision_conflict").unwrap();
    reopened.retry(&pending.id).unwrap();
    assert_eq!(reopened.pending().unwrap(), vec![pending.clone()]);
    reopened.abandon(&pending.id).unwrap();
    assert!(reopened.pending().unwrap().is_empty());
    assert!(quotes::references(&reopened.conn.lock().unwrap(), &pending.id).unwrap().is_empty());
    drop(reopened);
    std::fs::remove_file(path).unwrap();
}

#[test]
fn source_selections_are_fenced_before_atomic_enqueue_and_old_outboxes_migrate_as_plain_text() {
    let store = store();
    let selected = store.quote_selection("origin", "source").unwrap();
    let pending = Pending {
        reply_to: None,
        id: "pending".into(),
        room_id: "destination".into(),
        text: "Saved words".into(),
        quotes: vec![selected.reference.clone()],
    };
    for mutation in 0..5 {
        let mut invalid = selected.clone();
        match mutation {
            0 => invalid.identity.data_epoch = "another".into(),
            1 => invalid.identity.instance_id = "another".into(),
            2 => invalid.membership_version = "another".into(),
            3 => invalid.reference.revision = "9".into(),
            _ => invalid.reference.room_id = "destination".into(),
        }
        assert!(store.enqueue_quoted(&pending, "alice", None, &[invalid]).is_err());
        assert!(store.pending().unwrap().is_empty());
        assert!(store.selected_messages(std::slice::from_ref(&pending.id)).unwrap().is_empty());
    }
    assert!(
        store
            .enqueue_quoted(&pending, "alice", Some(Some("old-destination-grant")), std::slice::from_ref(&selected))
            .is_ok_and(|applied| !applied)
    );
    store.ingest(&[message("source", "origin", "30", "Updated")]).unwrap();
    assert!(store.enqueue_quoted(&pending, "alice", None, &[selected]).is_err());
    let selected = store.quote_selection("origin", "source").unwrap();
    let mut duplicate = pending.clone();
    duplicate.quotes = vec![selected.reference.clone(); 2];
    assert!(store.enqueue_quoted(&duplicate, "alice", None, &[selected.clone(), selected]).is_err());
    let path = std::env::temp_dir().join(format!("rv-old-outbox-{:032x}.sqlite", fastrand::u128(..)));
    let first = NativeStore::open(&path, identity("epoch")).unwrap();
    first.snapshot(&initial()).unwrap();
    first.conn.lock().unwrap().execute_batch("ALTER TABLE native_outbox DROP COLUMN quotes; INSERT INTO native_outbox(id,rid,text,created) VALUES('old','destination','Old words',1);").unwrap();
    drop(first);
    let reopened = NativeStore::open(&path, identity("epoch")).unwrap();
    assert_eq!(
        reopened.pending().unwrap(),
        vec![Pending {
            reply_to: None,
            id: "old".into(),
            room_id: "destination".into(),
            text: "Old words".into(),
            quotes: vec![]
        }]
    );
    drop(reopened);
    std::fs::remove_file(path).unwrap();
}

#[test]
fn current_source_views_flow_through_the_existing_card_independently_of_reply_revisions() {
    let store = store();
    let before = cards(&store);
    assert_eq!(before[0].text, initial().messages[0].text);
    assert_eq!(before[0].author.as_deref(), Some("alice"));
    let md = before[0].md.as_deref().unwrap();
    assert!(md.contains("BOLD") && md.contains("ITALIC") && md.contains("EMOJI"));
    store.ingest(&[message("source", "origin", "30", "Nouvelle source")]).unwrap();
    assert_eq!(cards(&store)[0].text, "Nouvelle source");
    store.ingest(&[initial().messages[1].clone()]).unwrap();
    assert_eq!(cards(&store)[0].text, "Nouvelle source");
    let mut older_reply = initial().messages[1].clone();
    older_reply.revision = "19".into();
    older_reply.text = "Ancienne réponse".into();
    older_reply.quotes[0].view_position = "40".into();
    let excerpt = older_reply.quotes[0].excerpt.as_mut().unwrap();
    excerpt.revision = "35".into();
    excerpt.text = "Source manquée par la socket".into();
    store.ingest(&[older_reply]).unwrap();
    let rows = store.messages("destination", 50).unwrap();
    assert_eq!(rows[0].text, "Ma réponse");
    assert_eq!(cards(&store)[0].text, "Source manquée par la socket");
    assert_eq!(rows[0].attachments, store.selected_messages(&["reply".into()]).unwrap()[0].attachments);
}

#[test]
fn unavailable_stamps_win_ties_and_late_echoes_cannot_restore_deleted_source_text() {
    let store = store();
    let mut missing = initial().messages[1].clone();
    missing.quotes[0].view_position = "40".into();
    missing.quotes[0].excerpt = None;
    store.ingest(&[missing]).unwrap();
    unavailable(&store);
    store.ingest(&[initial().messages[1].clone()]).unwrap();
    unavailable(&store);
    let mut tied = initial().messages[1].clone();
    tied.quotes[0].view_position = "40".into();
    store.ingest(&[tied]).unwrap();
    unavailable(&store);
    let mut legacy = initial().messages[1].clone();
    legacy.quotes[0].view_position = "0".into();
    legacy.quotes[0].source_membership_version = None;
    store.ingest(&[legacy]).unwrap();
    unavailable(&store);
    store.ingest(&[message("source", "origin", "35", "Ancienne source")]).unwrap();
    unavailable(&store);
    let mut tombstone = message("source", "origin", "45", "");
    tombstone.deleted = true;
    store.ingest(&[tombstone]).unwrap();
    store.ingest(&[message("source", "origin", "10", "Source tardive")]).unwrap();
    unavailable(&store);
    let mut edited = message("reply", "destination", "50", "Réponse sans citation");
    edited.position = "20".into();
    store.ingest(&[edited]).unwrap();
    assert!(cards(&store).is_empty());
    store.ingest(&[initial().messages[1].clone()]).unwrap();
    assert!(cards(&store).is_empty());
}

#[test]
fn source_withdrawal_and_rejoin_purge_cards_in_other_rooms_and_fence_old_requests() {
    let store = store();
    let token = store.projection_token();
    store.batch(&batch(vec![Change::RoomRemoved { room_id: "origin".into() }])).unwrap();
    unavailable(&store);
    assert_eq!(
        store
            .conn
            .lock()
            .unwrap()
            .query_row("SELECT count(*) FROM native_quote_sources WHERE rid='origin'", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        0
    );
    assert!(!store.ingest_at(&[initial().messages[1].clone()], token).unwrap());
    store.batch(&batch(vec![Change::RoomUpsert(room("origin", "40", "new-grant"))])).unwrap();
    store.ingest(&[message("source", "origin", "10", "Source actuelle de la nouvelle adhésion")]).unwrap();
    let mut old = initial().messages[1].clone();
    old.quotes[0].view_position = "999".into();
    store.ingest(&[old]).unwrap();
    assert_eq!(cards(&store)[0].text, "Source actuelle de la nouvelle adhésion");
    let mut pre_join = initial().messages[1].clone();
    pre_join.quotes[0].view_position = "30".into();
    pre_join.quotes[0].source_membership_version = None;
    pre_join.quotes[0].excerpt = None;
    store.ingest(&[pre_join]).unwrap();
    assert!(cards(&store)[0].author.is_some());
    let mut post_loss = initial().messages[1].clone();
    post_loss.quotes[0].view_position = "50".into();
    post_loss.quotes[0].source_membership_version = None;
    post_loss.quotes[0].excerpt = None;
    store.ingest(&[post_loss]).unwrap();
    unavailable(&store);
    store.ingest(&[message("source", "origin", "11", "Ancienne trame de la source")]).unwrap();
    unavailable(&store);
    store
        .batch(&batch(vec![
            Change::RoomUpsert(room("origin", "55", "third-grant")),
            Change::MessageUpsert(message("source", "origin", "60", "Source réautorisée")),
        ]))
        .unwrap();
    assert_eq!(cards(&store)[0].text, "Source réautorisée");
}

#[test]
fn missed_membership_change_without_removal_still_purges_source_views() {
    let store = store();
    let token = store.projection_token();
    store.batch(&batch(vec![Change::RoomUpsert(room("origin", "40", "new-grant"))])).unwrap();
    unavailable(&store);
    assert!(store.projection_token() > token);
    store.ingest(&[initial().messages[1].clone()]).unwrap();
    unavailable(&store);
    store.ingest(&[message("source", "origin", "10", "Source relue sous la nouvelle adhésion")]).unwrap();
    assert_eq!(cards(&store)[0].text, "Source relue sous la nouvelle adhésion");
}

#[test]
fn source_and_quote_changes_roll_back_with_the_cursor_and_reject_forged_lifetimes() {
    let store = store();
    let before = cards(&store);
    let mut malformed = initial().messages[1].clone();
    malformed.quotes[0].view_position = "40".into();
    malformed.quotes[0].excerpt.as_mut().unwrap().membership_version = "wrong-grant".into();
    assert!(
        store
            .batch(&batch(vec![
                Change::MessageUpsert(message("source", "origin", "30", "À annuler")),
                Change::MessageUpsert(malformed)
            ]))
            .is_err()
    );
    assert_eq!(cards(&store), before);
    assert_eq!(store.cursor().unwrap().as_deref(), Some("initial"));
    store
        .conn
        .lock()
        .unwrap()
        .execute_batch(
            "CREATE TRIGGER reject_cursor BEFORE UPDATE ON native_state BEGIN SELECT RAISE(ABORT,'injected'); END;",
        )
        .unwrap();
    assert!(store.batch(&batch(vec![Change::MessageUpsert(message("source", "origin", "30", "À annuler"))])).is_err());
    assert_eq!(cards(&store), before);
    assert_eq!(store.cursor().unwrap().as_deref(), Some("initial"));
}

#[test]
fn quote_cache_reopens_with_same_authority_and_snapshot_reset_discards_missed_deletions() {
    let path = std::env::temp_dir().join(format!("rv-quotes-{:032x}.sqlite", fastrand::u128(..)));
    let store = NativeStore::open(&path, identity("epoch")).unwrap();
    store.snapshot(&initial()).unwrap();
    drop(store);
    let store = NativeStore::open(&path, identity("epoch")).unwrap();
    assert!(cards(&store)[0].author.is_some());
    let mut reset = initial();
    reset.messages = vec![reset.messages[1].clone()];
    reset.messages[0].quotes[0].excerpt = None;
    reset.messages[0].quotes[0].view_position = "40".into();
    store.snapshot(&reset).unwrap();
    unavailable(&store);
    drop(store);
    let store = NativeStore::open(&path, identity("other-epoch")).unwrap();
    assert!(store.messages("destination", 50).unwrap().is_empty());
    let mut snapshot = initial();
    snapshot.rooms.retain(|r| r.id == "destination");
    snapshot.messages = vec![snapshot.messages[1].clone()];
    store.snapshot(&snapshot).unwrap();
    unavailable(&store);
    store.clear().unwrap();
    assert_eq!(
        store
            .conn
            .lock()
            .unwrap()
            .query_row("SELECT count(*) FROM native_quote_sources", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        0
    );
    drop(store);
    std::fs::remove_file(path).unwrap();
}

#[test]
fn malformed_reference_ids_revisions_bounds_and_source_room_collisions_are_atomic() {
    let store = store();
    let before = cards(&store);
    for mutation in 0..5 {
        let mut bad = initial().messages[1].clone();
        bad.revision = "50".into();
        match mutation {
            0 => bad.quotes[0].view_position = "9223372036854775808".into(),
            1 => bad.quotes[0].reference.room_id = "destination".into(),
            2 => bad.quotes[0].reference.revision = "01".into(),
            3 => bad.quotes[0].reference.message_id = "../source".into(),
            _ => bad.quotes = vec![bad.quotes[0].clone(); 9],
        }
        assert!(store.ingest(&[bad]).is_err());
        assert_eq!(cards(&store), before);
        assert_eq!(store.messages("destination", 50).unwrap()[0].text, "Ma réponse");
    }
}

#[test]
fn quote_view_positions_keep_their_order_above_javascript_integer_precision() {
    let store = store();
    let mut latest = initial().messages[1].clone();
    latest.quotes[0].view_position = "9007199254740993".into();
    let excerpt = latest.quotes[0].excerpt.as_mut().unwrap();
    excerpt.revision = "9007199254740993".into();
    excerpt.text = "Exact".into();
    store.ingest(&[latest.clone()]).unwrap();
    latest.quotes[0].view_position = "9007199254740992".into();
    latest.quotes[0].excerpt = None;
    store.ingest(&[latest]).unwrap();
    assert_eq!(cards(&store)[0].text, "Exact");
}

#[test]
fn reference_order_survives_late_replies_and_a_source_grant_loss_clears_all_its_excerpts() {
    let store = store();
    store.ingest(&[message("second-source", "origin", "15", "Deuxième source")]).unwrap();
    let mut reply = initial().messages[1].clone();
    reply.revision = "40".into();
    let mut second = reply.quotes[0].clone();
    second.reference.message_id = "second-source".into();
    second.reference.revision = "15".into();
    second.view_position = "40".into();
    let excerpt = second.excerpt.as_mut().unwrap();
    excerpt.text = "Deuxième source".into();
    excerpt.revision = "15".into();
    reply.quotes.insert(0, second);
    store.ingest(&[reply.clone()]).unwrap();
    store.ingest(&[initial().messages[1].clone()]).unwrap();
    assert_eq!(
        cards(&store).iter().map(|c| c.text.as_str()).collect::<Vec<_>>(),
        ["Deuxième source", "*Privé* _texte_ :rocket:"]
    );
    reply.quotes[0].view_position = "50".into();
    reply.quotes[0].source_membership_version = None;
    reply.quotes[0].excerpt = None;
    store.ingest(&[reply]).unwrap();
    assert!(cards(&store).iter().all(|c| c.author.is_none() && c.text.is_empty()));
    assert_eq!(
        store
            .conn
            .lock()
            .unwrap()
            .query_row(
                "SELECT count(*) FROM native_quote_sources WHERE rid='origin' AND payload IS NOT NULL",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
        0
    );
}
