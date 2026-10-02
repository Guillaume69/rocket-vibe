fn main() {
    let mut fixture: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../docs/protocol/native-rendering.fixture.json"
    ))
    .unwrap();
    for case in fixture["cases"].as_array_mut().unwrap() {
        case["document"] = serde_json::to_value(rv_protocol::markdown::parse(
            case["source"].as_str().unwrap(),
        ))
        .unwrap();
    }
    println!("{}", serde_json::to_string_pretty(&fixture).unwrap());
}
