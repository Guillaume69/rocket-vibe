//! Text helpers the providers share.

pub fn decode_entities(s: &str) -> String {
    if !s.contains('&') {
        return s.to_owned();
    }
    s.replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#039;", "'")
        .replace("&#39;", "'")
        .replace("&#x27;", "'")
        .replace("&#X27;", "'")
        .replace("&nbsp;", " ")
        .replace("&amp;", "&")
}

pub fn is_web_link(url: &str) -> bool {
    url::Url::parse(url).is_ok_and(|u| matches!(u.scheme(), "http" | "https") && u.host().is_some())
}

/// Turns back into plain text every `@name` and `#name` of a message-parser
/// tree that `user` or `channel` does not vouch for: the parser marks any
/// such word, existing or not. Whether anything changed.
pub fn unvouched_mentions_as_text(
    tree: &mut serde_json::Value,
    user: &dyn Fn(&str) -> bool,
    channel: &dyn Fn(&str) -> bool,
) -> bool {
    use serde_json::{Value, json};
    match tree {
        Value::Array(items) => {
            let mut changed = false;
            for item in items {
                changed |= unvouched_mentions_as_text(item, user, channel);
            }
            changed
        }
        Value::Object(node) => {
            let (sigil, vouched): (&str, &dyn Fn(&str) -> bool) = match node.get("type").and_then(Value::as_str) {
                Some("MENTION_USER") => ("@", user),
                Some("MENTION_CHANNEL") => ("#", channel),
                _ => {
                    let mut changed = false;
                    for value in node.values_mut() {
                        changed |= unvouched_mentions_as_text(value, user, channel);
                    }
                    return changed;
                }
            };
            let name = node.get("value").and_then(|v| v.get("value")).and_then(Value::as_str).unwrap_or_default();
            if vouched(name) {
                return false;
            }
            *tree = json!({"type": "PLAIN_TEXT", "value": format!("{sigil}{name}")});
            true
        }
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn mention(kind: &str, name: &str) -> serde_json::Value {
        json!({"type": kind, "value": {"type": "PLAIN_TEXT", "value": name}})
    }

    #[test]
    fn only_vouched_mentions_stay_mentions() {
        let mut tree = json!([{"type": "PARAGRAPH", "value": [
            mention("MENTION_USER", "bob"),
            {"type": "PLAIN_TEXT", "value": " and "},
            mention("MENTION_USER", "nobody"),
            {"type": "BOLD", "value": [mention("MENTION_CHANNEL", "nowhere")]},
            mention("MENTION_CHANNEL", "general"),
        ]}]);
        let changed = unvouched_mentions_as_text(&mut tree, &|u| u == "bob", &|c| c == "general");
        assert!(changed);
        assert_eq!(
            tree,
            json!([{"type": "PARAGRAPH", "value": [
                mention("MENTION_USER", "bob"),
                {"type": "PLAIN_TEXT", "value": " and "},
                {"type": "PLAIN_TEXT", "value": "@nobody"},
                {"type": "BOLD", "value": [{"type": "PLAIN_TEXT", "value": "#nowhere"}]},
                mention("MENTION_CHANNEL", "general"),
            ]}])
        );
        assert!(!unvouched_mentions_as_text(&mut tree, &|u| u == "bob", &|c| c == "general"));
    }
}
