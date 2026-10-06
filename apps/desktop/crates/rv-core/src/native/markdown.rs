//! Native document -> existing local message widgets. Wire types stay neutral.
use rv_protocol::markdown::{Document, Node};
use serde_json::{Value, json};

fn plain(text: &str) -> Value {
    json!({"type":"PLAIN_TEXT","value":text})
}
fn text(node: &Value) -> String {
    crate::markdown::text_of(node)
}
fn inlines(nodes: &[Node]) -> Vec<Value> {
    let mut out = vec![];
    for node in nodes {
        match node {
            Node::Text{text}=>out.push(plain(text)),
            Node::Bold{children}|Node::Italic{children}|Node::Strike{children}=>out.push(json!({"type":match node {Node::Bold{..}=>"BOLD",Node::Italic{..}=>"ITALIC",_=>"STRIKE"},"value":inlines(children)})),
            Node::InlineCode{text}|Node::CodeBlock{text,..}=>out.push(json!({"type":"INLINE_CODE","value":plain(text)})),
            Node::Link{href,children}=>{
                let mut label=inlines(children);
                if text(&Value::Array(label.clone())).trim().is_empty() {label=vec![plain(href)];}
                out.push(json!({"type":"LINK","value":{"src":plain(href),"label":label}}));
            }
            Node::Mention{name} if name=="here"=>out.push(plain("@here")),
            Node::Mention{name}|Node::RoomMention{name}=>out.push(json!({"type":if matches!(node,Node::Mention{..}) {"MENTION_USER"} else {"MENTION_CHANNEL"},"value":plain(name)})),
            Node::Emoji{shortcode}=>out.push(json!({"type":"EMOJI","value":plain(shortcode),"shortCode":shortcode})),
            Node::Break=>out.push(plain("\n")),
            Node::Rule=>out.push(plain("---")),
            Node::Paragraph{children}|Node::Heading{children,..}|Node::ListItem{children,..}=>{
                if !out.is_empty() {out.push(plain("\n"));}out.extend(inlines(children));
            }
            Node::Quote{children}=>{out.push(plain("\n> "));out.extend(inlines(children));}
            Node::List{start,children}=>{
                for (i,item) in children.iter().enumerate() {
                    let marker=match item {Node::ListItem{checked:Some(true),..}=>"☑ ".into(),Node::ListItem{checked:Some(false),..}=>"☐ ".into(),_=>start.map_or_else(||"• ".into(),|s|format!("{}. ",u64::from(s)+i as u64))};
                    out.push(plain(&format!("\n{marker}")));
                    if let Node::ListItem{children,..}=item {out.extend(inlines(children));} else {out.extend(inlines(std::slice::from_ref(item)));}
                }
            }
        }
    }
    out
}
fn big(nodes: &[Node]) -> bool {
    let count = nodes.iter().filter(|n| matches!(n, Node::Emoji { .. })).count();
    (1..=3).contains(&count)
        && nodes.iter().all(|n| match n {
            Node::Emoji { shortcode } => crate::emoji::unicode(shortcode).is_some(),
            Node::Text { text } => text.trim().is_empty(),
            _ => false,
        })
}
pub fn tree(document: &Document) -> Vec<Value> {
    fn blocks(nodes: &[Node]) -> Vec<Value> {
        let mut out = vec![];
        for node in nodes {
            match node {
                Node::Paragraph{children}=>out.push(if big(children) {json!({"type":"BIG_EMOJI","value":inlines(children).into_iter().filter(|n|n["type"]=="EMOJI").collect::<Vec<_>>()})} else {json!({"type":"PARAGRAPH","value":inlines(children)})}),
                Node::Heading{level,children}=>out.push(json!({"type":"HEADING","level":(*level).clamp(1,4),"value":inlines(children)})),
                Node::Quote{children}=>out.push(json!({"type":"QUOTE","value":blocks(children)})),
                Node::CodeBlock{text,..}=>out.push(json!({"type":"CODE","value":text.strip_suffix('\n').unwrap_or(text).split('\n').map(|line|json!({"type":"CODE_LINE","value":plain(line)})).collect::<Vec<_>>()})),
                Node::List{start,children}=>{
                    let mut at=0;
                    while at<children.len() {
                        let tasks=matches!(children[at],Node::ListItem{checked:Some(_),..});
                        let mut items=vec![];
                        while at<children.len() && matches!(children[at],Node::ListItem{checked:Some(_),..})==tasks {
                            let (content,checked)=match &children[at] {Node::ListItem{children,checked}=>(inlines(children),*checked),other=>(inlines(std::slice::from_ref(other)),None)};
                            let mut item=json!({"type":"LIST_ITEM","value":content});
                            if tasks {item["status"]=json!(checked==Some(true));} else if let Some(start)=start {item["number"]=json!(u64::from(*start)+at as u64);}
                            items.push(item);at+=1;
                        }
                        out.push(json!({"type":if tasks {"TASKS"} else if start.is_some() {"ORDERED_LIST"} else {"UNORDERED_LIST"},"value":items}));
                    }
                }
                other=>out.push(json!({"type":"PARAGRAPH","value":inlines(std::slice::from_ref(other))})),
            }
        }
        out
    }
    blocks(&document.nodes)
}
pub fn cached_tree(body: Option<&str>, source: &str) -> String {
    let document = body
        .and_then(|json| serde_json::from_str::<Document>(json).ok())
        .unwrap_or_else(|| rv_protocol::markdown::parse(source));
    serde_json::to_string(&tree(&document)).expect("native tree is serializable")
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn existing_composer_markers_keep_their_actual_styles() {
        let document = rv_protocol::markdown::parse("*gras* _italique_ ~barré~ __double italique__");
        let md = serde_json::to_string(&tree(&document)).unwrap();
        let blocks = crate::markdown::render(Some(&md), None, &crate::markdown::Context { me: "" });
        let crate::markdown::Block::Paragraph(markup) = &blocks[0] else { panic!("paragraph expected") };
        let runs = crate::runs::runs(markup);
        assert!(runs.iter().any(|r| r.text == "gras" && r.bold && !r.italic));
        assert!(runs.iter().any(|r| r.text == "italique" && r.italic && !r.bold));
        assert!(runs.iter().any(|r| r.text == "barré" && r.strike));
        assert!(runs.iter().any(|r| r.text == "double italique" && r.italic && !r.bold));
    }
    #[test]
    fn native_corpus_traverses_existing_gtk_and_swift_renderers() {
        let fixture: Value =
            serde_json::from_str(include_str!("../../../../../../docs/protocol/native-rendering.fixture.json"))
                .unwrap();
        for case in fixture["cases"].as_array().unwrap() {
            let document: Document = serde_json::from_value(case["document"].clone()).unwrap();
            assert_eq!(serde_json::to_value(tree(&document)).unwrap(), case["local_tree"], "{}", case["id"]);
            let md = serde_json::to_string(&tree(&document)).unwrap();
            let blocks = crate::markdown::render(Some(&md), None, &crate::markdown::Context { me: "alice" });
            let shown = crate::runs::text(&blocks);
            for expected in case["contains"].as_array().unwrap() {
                assert!(shown.contains(expected.as_str().unwrap()), "{} missing {}: {shown}", case["id"], expected);
            }
        }
    }
}
