use rv_core::{content, markdown, media, parse};
use serde_json::Value;

fn corpus() -> Value {
    serde_json::from_str(include_str!("../../../../../docs/protocol/rendering.fixture.json")).unwrap()
}
fn has_type(value: &Value, expected: &str) -> bool {
    match value {
        Value::Array(values) => values.iter().any(|v| has_type(v, expected)),
        Value::Object(fields) => {
            fields.get("type").and_then(Value::as_str) == Some(expected)
                || fields.values().any(|v| has_type(v, expected))
        }
        _ => false,
    }
}
fn visible(blocks: &[markdown::Block]) -> String {
    blocks
        .iter()
        .map(|b| match b {
            markdown::Block::Paragraph(s) | markdown::Block::Heading { markup: s, .. } => markdown::without_custom(s),
            markdown::Block::Code(s) | markdown::Block::BigEmoji(s) => s.clone(),
            markdown::Block::Quote(children) => visible(children),
            markdown::Block::List(items) => {
                items.iter().map(|(_, s)| markdown::without_custom(s)).collect::<Vec<_>>().join(" ")
            }
            markdown::Block::Break => "\n".into(),
        })
        .collect::<Vec<_>>()
        .join(" ")
}

#[test]
fn shared_markdown_corpus_reaches_the_desktop_renderer() {
    for case in corpus()["markdown"].as_array().unwrap() {
        let source = case["source"].as_str().unwrap();
        let tree = Value::Array(parse::tree(source));
        for expected in case["nodes"].as_array().unwrap() {
            assert!(has_type(&tree, expected.as_str().unwrap()), "{}: missing {expected}", case["id"]);
        }
        let context = markdown::Context { me: "alice" };
        let rendered = markdown::render(None, Some(source), &context);
        assert_eq!(rendered, markdown::render(Some("corrupt-json"), Some(source), &context));
        let shown = visible(&rendered);
        for expected in case["contains"].as_array().unwrap() {
            let expected = expected.as_str().unwrap();
            assert!(
                shown.contains(expected) || shown.contains(&markdown::escape(expected)),
                "{}: missing {expected} in {shown}",
                case["id"]
            );
        }
        for hidden in case["hidden"].as_array().into_iter().flatten() {
            assert!(!shown.contains(hidden.as_str().unwrap()));
        }
        if case["id"] == "literal-html" {
            assert!(!shown.contains("<script>"));
            assert!(shown.contains("&lt;script&gt;"));
        }
    }
}

#[test]
fn shared_attachment_corpus_preserves_quote_and_file_boundaries() {
    for case in corpus()["attachments"].as_array().unwrap() {
        let json = case["items"].to_string();
        let files = content::files(Some(&json));
        assert_eq!(files.len(), case["files"].as_u64().unwrap() as usize, "{}", case["id"]);
        assert_eq!(content::quotes(Some(&json)).len(), case["quotes"].as_u64().unwrap() as usize);
        let images = media::image_attachments(Some(&json));
        assert_eq!(
            images.first().map(|image| image.source.as_str()),
            case["image_full"].as_str().or_else(|| case["image"].as_str())
        );
        if let Some(url) = case["share"].as_str() {
            assert_eq!(files[0].url, url);
        }
    }
}
