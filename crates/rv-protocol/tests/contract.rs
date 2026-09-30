use rv_protocol::{Contract, SendMessage};

#[test]
fn shared_fixture_preserves_positions_above_javascript_integer_limit() {
    let fixture = include_str!("../../../docs/protocol/v1.fixture.json");
    let contract: Contract = serde_json::from_str(fixture).unwrap();
    assert_eq!(contract.message.position, "9007199254740993");
    assert_eq!(contract.room.revision, "9007199254740993");
    let round_trip: Contract =
        serde_json::from_value(serde_json::to_value(contract).unwrap()).unwrap();
    assert_eq!(round_trip.message.text, "Bonjour 🚀");
}

#[test]
fn send_intention_rejects_unknown_server_controlled_fields() {
    assert!(
        serde_json::from_str::<SendMessage>(
            r#"{"operation_id":"id","text":"hello","author_id":"someone-else"}"#
        )
        .is_err()
    );
}
