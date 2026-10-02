#[test]
fn canonical_native_corpus_keeps_source_rules_and_neutral_documents() {
    let fixture: serde_json::Value = serde_json::from_str(include_str!(
        "../../../docs/protocol/native-rendering.fixture.json"
    ))
    .unwrap();
    for case in fixture["cases"].as_array().unwrap() {
        let source = case["source"].as_str().unwrap();
        let document = rv_protocol::markdown::parse(source);
        assert_eq!(
            serde_json::to_value(&document).unwrap(),
            case["document"],
            "{}",
            case["id"]
        );
        let names = rv_protocol::markdown::mention_names(source)
            .into_iter()
            .collect::<Vec<_>>();
        assert_eq!(
            serde_json::to_value(names).unwrap(),
            case["mentions"],
            "{}",
            case["id"]
        );
        let round_trip: rv_protocol::markdown::Document =
            serde_json::from_value(case["document"].clone()).unwrap();
        assert_eq!(round_trip, document);
    }
}
