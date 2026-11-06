//! Slack canvases (Quip documents) read and written natively: the protobuf
//! sections Quip's editor exchanges, each block's text an Automerge document.
//! The wire format is in `brain/architecture/slack-session.md` (Canvases).

pub mod edit;
pub mod markdown;
pub mod model;
pub mod wire;

pub use edit::{Edit, Session, plan};
pub use markdown::to_markdown;
pub use model::Canvas;

/// `request_binary` of `load-data/editor/<n>`: the thread, a bulk load of it,
/// the user action `editor` and its sequence.
pub fn load_request(thread: &str, action_sequence: u64) -> Vec<u8> {
    use wire::Message;
    Message::default()
        .with_str(1, thread)
        .with_message(3, &Message::default().with_int(1, 1).with_str(2, thread))
        .with_str(5, "editor")
        .with_int(6, action_sequence)
        .encode()
}

#[cfg(test)]
mod tests {
    #[test]
    fn the_load_request_matches_the_web_client() {
        use base64::Engine;
        let captured = base64::engine::general_purpose::STANDARD
            .decode("CgtlVGQ5QUFSNGJUaBoPCAESC2VUZDlBQVI0YlRoKgZlZGl0b3IwAQ==")
            .unwrap();
        assert_eq!(super::load_request("eTd9AAR4bTh", 1), captured);
    }
}
