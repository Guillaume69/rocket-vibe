use rv_protocol::cards::*;
fn card() -> IntegrationCard {
    IntegrationCard {
        author: Some("CI".into()),
        title: Some("Build ready".into()),
        url: Some("https://example.org/build/1".into()),
        text: Some("Result\nDetails".into()),
        color: Some("#1177aa".into()),
        fields: vec![CardField {
            title: "Commit".into(),
            value: "abcdef".into(),
            short: true,
        }],
    }
}
#[test]
fn cards_bound_utf8_and_structured_navigation() {
    assert!(validate(&[card()]));
    let mut c = card();
    c.url = Some("javascript:alert(1)".into());
    assert!(!validate(&[c.clone()]));
    c.url = Some("https://user:password@example.org".into());
    assert!(!validate(&[c.clone()]));
    c = card();
    c.title = Some("é".repeat(257));
    assert!(!validate(&[c.clone()]));
    c = card();
    c.fields = vec![c.fields[0].clone(); 13];
    assert!(!validate(&[c.clone()]));
    c = card();
    c.color = Some("red;url(...)".into());
    assert!(!validate(&[c]));
    assert!(!validate(&vec![card(); 4]));
    assert!(
        serde_json::from_value::<IntegrationCard>(
            serde_json::json!({"title":"a","html":"<script>"})
        )
        .is_err()
    );
}
#[test]
fn old_messages_and_sends_default_to_no_cards() {
    let fixture: serde_json::Value =
        serde_json::from_str(include_str!("../../../docs/protocol/v1.fixture.json")).unwrap();
    let message: rv_protocol::Message = serde_json::from_value(fixture["message"].clone()).unwrap();
    assert!(message.cards.is_empty());
    let input: rv_protocol::SendMessage =
        serde_json::from_value(serde_json::json!({"operation_id":"old","text":"text"})).unwrap();
    assert!(input.cards.is_empty());
    assert!(serde_json::to_value(input).unwrap().get("cards").is_none());
}
