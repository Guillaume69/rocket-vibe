use rv_core::native::{Identity, store::NativeStore};
use rv_protocol::{Change, Snapshot, SyncBatch};
#[test]
fn native_cards_survive_projection_restart_and_retire_with_membership() {
    let fixture: serde_json::Value =
        serde_json::from_str(include_str!("../../../../../docs/protocol/v1.fixture.json")).unwrap();
    let card = serde_json::json!({"author":"CI","title":"Build &amp; ready","url":"https://example.org/build","text":"Details","color":"#1177aa","fields":[{"title":"Commit","value":"abcdef","short":true}]});
    let mut m = fixture["message"].clone();
    m["cards"] = serde_json::json!([card]);
    let snapshot: Snapshot = serde_json::from_value(
        serde_json::json!({"protocol_version":1,"rooms":[fixture["room"]],"messages":[m],"cursor":"cards"}),
    )
    .unwrap();
    let identity = Identity { instance_id: "fixture-instance".into(), data_epoch: "fixture-epoch".into() };
    let path = std::env::temp_dir().join(format!("rv-cards-{:032x}.sqlite", fastrand::u128(..)));
    let store = NativeStore::open(&path, identity.clone()).unwrap();
    store.snapshot(&snapshot).unwrap();
    let row = store.messages("room-id", 10).unwrap().remove(0).presentation("room-id", "alice-id");
    let cards = rv_core::content::cards(row.attachments.as_deref());
    assert_eq!(cards.len(), 1);
    assert_eq!(cards[0].title.as_deref(), Some("Build &amp; ready"));
    assert_eq!(cards[0].fields[0].1, "abcdef");
    drop(store);
    let store = NativeStore::open(&path, identity).unwrap();
    assert!(store.messages("room-id", 10).unwrap()[0].attachments.is_some());
    let mut invalid = snapshot.messages[0].clone();
    invalid.revision = "9007199254740994".into();
    invalid.cards[0].url = Some("javascript:alert(1)".into());
    assert!(
        store
            .batch(&SyncBatch {
                protocol_version: 1,
                changes: vec![Change::MessageUpsert(invalid)],
                cursor: "bad".into(),
                has_more: false
            })
            .is_err()
    );
    assert_eq!(store.cursor().unwrap().as_deref(), Some("cards"));
    store
        .batch(&SyncBatch {
            protocol_version: 1,
            changes: vec![Change::RoomRemoved { room_id: "room-id".into() }],
            cursor: "removed".into(),
            has_more: false,
        })
        .unwrap();
    assert!(store.messages("room-id", 10).unwrap().is_empty());
    drop(store);
    std::fs::remove_file(path).unwrap();
}
