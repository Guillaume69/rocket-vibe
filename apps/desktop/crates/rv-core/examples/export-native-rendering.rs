fn main() {
    let mut fixture: serde_json::Value =
        serde_json::from_str(include_str!("../../../../../docs/protocol/native-rendering.fixture.json")).unwrap();
    for case in fixture["cases"].as_array_mut().unwrap() {
        let document: rv_protocol::markdown::Document = serde_json::from_value(case["document"].clone()).unwrap();
        case["local_tree"] = serde_json::to_value(rv_core::native::markdown::tree(&document)).unwrap();
    }
    println!("{}", serde_json::to_string_pretty(&fixture).unwrap());
}
