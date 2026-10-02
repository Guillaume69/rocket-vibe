use rv_protocol::{Contract, SendMessage};

#[test]
fn shared_fixture_preserves_positions_above_javascript_integer_limit() {
    let fixture = include_str!("../../../docs/protocol/v1.fixture.json");
    let contract: Contract = serde_json::from_str(fixture).unwrap();
    assert_eq!(contract.message.position, "9007199254740993");
    assert_eq!(contract.room.revision, "9007199254740993");
    assert_eq!(contract.thread_page.root.id, contract.message.id);
    assert_eq!(
        contract.thread_page.messages[0].position,
        "9007199254740995"
    );
    assert_eq!(
        contract.thread_page.messages[0].reply_to.as_deref(),
        Some(contract.message.id.as_str())
    );
    assert_eq!(contract.mark_thread_read.position, "9007199254740995");
    assert!(contract.message.reply_to.is_none());
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
    assert!(
        serde_json::from_str::<SendMessage>(
            r#"{"operation_id":"id","text":"hello","system":{"kind":"member_joined"}}"#
        )
        .is_err()
    );
}

#[test]
fn native_activity_is_structured_and_projects_without_embedded_sentences() {
    use rv_protocol::system::SystemMessage;
    let activity: SystemMessage = serde_json::from_value(serde_json::json!({"kind":"role_changed","user":{"id":"bob","username":"bob","display_name":"Robert"},"previous_role":"member","role":"moderator"})).unwrap();
    assert_eq!(activity.presentation(), ("rv-role-moderator", "bob".into()));
    assert!(
        serde_json::from_value::<SystemMessage>(
            serde_json::json!({"kind":"member_joined","text":"forged sentence"})
        )
        .is_err()
    );
    assert!(serde_json::from_value::<SystemMessage>(serde_json::json!({"kind":"role_changed","user":{"id":"bob","username":"bob","display_name":"Robert"},"previous_role":"member","role":"administrator"})).is_err());
    let old: rv_protocol::Message = serde_json::from_value(
        serde_json::from_str::<serde_json::Value>(include_str!(
            "../../../docs/protocol/v1.fixture.json"
        ))
        .unwrap()["message"]
            .clone(),
    )
    .unwrap();
    assert!(old.system.is_none());
}

#[test]
fn quotes_accept_only_typed_references_and_preserve_exact_source_revisions() {
    let old: SendMessage = serde_json::from_str(r#"{"operation_id":"id","text":"hello"}"#).unwrap();
    assert!(old.quotes.is_empty());
    let input = r#"{"operation_id":"reply","text":"hello","quotes":[{"room_id":"origin","message_id":"source","revision":"9007199254740993"}]}"#;
    let typed: SendMessage = serde_json::from_str(input).unwrap();
    assert_eq!(typed.quotes[0].revision, "9007199254740993");
    let mut forged: serde_json::Value = serde_json::from_str(input).unwrap();
    forged["quotes"][0]["excerpt"] = "private source text".into();
    assert!(serde_json::from_value::<SendMessage>(forged).is_err());
}

#[test]
fn quote_resolution_stamps_are_exact_and_legacy_views_are_not_authority() {
    let legacy = serde_json::json!({"reference":{"room_id":"origin","message_id":"source","revision":"1"},"excerpt":null});
    let quote: rv_protocol::MessageQuote = serde_json::from_value(legacy.clone()).unwrap();
    assert_eq!(quote.view_position, "0");
    assert!(quote.source_membership_version.is_none());
    let mut stamped = legacy;
    stamped["view_position"] = "9007199254740993".into();
    stamped["source_membership_version"] = "current-grant".into();
    let quote: rv_protocol::MessageQuote = serde_json::from_value(stamped.clone()).unwrap();
    assert_eq!(quote.view_position, "9007199254740993");
    assert_eq!(serde_json::to_value(quote).unwrap(), stamped);
}

#[test]
fn parity_fixture_keeps_permissions_personal_counts_and_opaque_crypto_separate() {
    let contract: Contract =
        serde_json::from_str(include_str!("../../../docs/protocol/v1.fixture.json")).unwrap();
    assert!(!contract.parity.account_permissions.manage_instance);
    assert!(!contract.parity.room_permissions.invite);
    assert!(contract.parity.message_permissions.edit);
    assert_eq!(contract.parity.read_state.root_position, "9007199254740993");
    assert_eq!(contract.parity.file.bytes, "9007199254740993");
    assert!(contract.parity.file.filename.is_none());
    assert_eq!(
        contract.parity.key_backup.crypto_identity,
        "historical-uid-preserved"
    );
    let value = serde_json::to_value(contract.parity).unwrap();
    let round_trip: rv_protocol::parity::ParityContract = serde_json::from_value(value).unwrap();
    assert_eq!(round_trip.read_state.unread_replies, "3");
}

#[test]
fn parity_commands_reject_forged_rights_and_plaintext_inside_ciphertext() {
    use rv_protocol::parity::{MarkRead, MessageContent, SetReaction};
    assert!(
        serde_json::from_str::<MarkRead>(r#"{"root_position":1,"reply_position":"0"}"#).is_err()
    );
    assert!(
        serde_json::from_str::<SetReaction>(
            r#"{"operation_id":"reaction-id","emoji":"rocket","present":true,"user_id":"other"}"#
        )
        .is_err()
    );
    assert!(serde_json::from_str::<MessageContent>(r#"{"kind":"encrypted","format":"opaque","key_version":"1","payload":"blob","markdown":"secret"}"#).is_err());
}

#[test]
fn additive_capabilities_default_to_unavailable_on_an_older_server() {
    let contract: Contract =
        serde_json::from_str(include_str!("../../../docs/protocol/v1.fixture.json")).unwrap();
    assert!(!contract.discovery.capabilities.editing);
    assert!(!contract.discovery.capabilities.typing);
    assert!(!contract.discovery.capabilities.room_discovery);
    assert!(!contract.discovery.capabilities.second_factors);
}

#[test]
fn discovery_does_not_enable_missing_client_handlers() {
    let mut server = rv_protocol::Capabilities {
        uploads: true,
        editing: true,
        ..Default::default()
    };
    let features = server.supported_features(&rv_protocol::Capabilities::default());
    assert!(features.iter().any(|f| f == "text_messages"));
    assert!(!features.iter().any(|f| f == "uploads" || f == "editing"));
    server.text_messages = false;
    assert!(
        !server
            .supported_features(&rv_protocol::Capabilities::default())
            .iter()
            .any(|f| f == "text_messages")
    );
}
