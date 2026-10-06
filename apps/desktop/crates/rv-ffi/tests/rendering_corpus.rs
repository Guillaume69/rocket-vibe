use rv_core::markdown;
use rv_ffi::markup::{self, BodyBlock};
use serde_json::Value;

fn visible(blocks: &[BodyBlock]) -> String {
    blocks
        .iter()
        .map(|block| match block {
            BodyBlock::Paragraph { runs } | BodyBlock::Heading { runs, .. } | BodyBlock::BigEmoji { runs } => {
                runs.iter().map(|r| r.text.clone()).collect::<String>()
            }
            BodyBlock::Quote { blocks } => visible(blocks),
            BodyBlock::Code { text } => text.clone(),
            BodyBlock::List { items } => items.iter().flat_map(|i| &i.runs).map(|r| r.text.clone()).collect(),
            BodyBlock::Break => "\n".into(),
        })
        .collect::<Vec<_>>()
        .join(" ")
}

#[test]
fn shared_corpus_survives_the_swift_styled_run_projection() {
    let corpus: Value =
        serde_json::from_str(include_str!("../../../../../docs/protocol/rendering.fixture.json")).unwrap();
    for case in corpus["markdown"].as_array().unwrap() {
        let source = case["source"].as_str().unwrap();
        let blocks = markup::blocks(markdown::render(None, Some(source), &markdown::Context { me: "alice" }));
        let shown = visible(&blocks);
        for expected in case["contains"].as_array().unwrap() {
            assert!(shown.contains(expected.as_str().unwrap()), "{}: {shown}", case["id"]);
        }
        for hidden in case["hidden"].as_array().into_iter().flatten() {
            assert!(!shown.contains(hidden.as_str().unwrap()));
        }
    }
}
