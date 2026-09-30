fn main() {
    println!(
        "{}",
        serde_json::to_string_pretty(&rv_protocol::schema()).unwrap()
    );
}
