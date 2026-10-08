//! `{{path.to.value}}` in a step's text: a lookup in the run's context, no
//! logic. A missing path renders empty; an object or a list renders as JSON.
use serde_json::Value;

pub(crate) fn render(template: &str, context: &Value) -> String {
    render_with(template, context, |value| value)
}

/// A message's text: what a person typed (a command's text, a form answer, a
/// message) never pings a whole room through the bot. Only the template's own
/// `@all` / `@here` do, written by the owner.
pub(crate) fn render_message(template: &str, context: &Value) -> String {
    render_with(template, context, |value| quiet_room_mentions(&value))
}

/// A URL: each value is percent-encoded, so it stays inside the path segment or
/// query value it was put in and never moves the host or adds parameters.
pub(crate) fn render_url(template: &str, context: &Value) -> String {
    render_with(template, context, |value| {
        percent_encoding::utf8_percent_encode(&value, percent_encoding::NON_ALPHANUMERIC)
            .to_string()
    })
}

fn quiet_room_mentions(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(at) = rest.find('@') {
        out.push_str(&rest[..=at]);
        rest = &rest[at + 1..];
        let word: String = rest
            .chars()
            .take_while(|c| c.is_alphanumeric() || matches!(c, '_' | '-' | '.'))
            .collect();
        if word.eq_ignore_ascii_case("all") || word.eq_ignore_ascii_case("here") {
            // A word joiner after `@`: shown the same, no longer a mention.
            out.push('\u{2060}');
        }
    }
    out.push_str(rest);
    out
}

fn render_with(template: &str, context: &Value, value: impl Fn(String) -> String) -> String {
    let mut out = String::with_capacity(template.len());
    let mut rest = template;
    while let Some(start) = rest.find("{{") {
        out.push_str(&rest[..start]);
        let after = &rest[start + 2..];
        let Some(end) = after.find("}}") else {
            out.push_str(&rest[start..]);
            return out;
        };
        out.push_str(&value(value_text(lookup(context, after[..end].trim()))));
        rest = &after[end + 2..];
    }
    out.push_str(rest);
    out
}

fn lookup<'a>(context: &'a Value, path: &str) -> Option<&'a Value> {
    let mut current = context;
    for part in path.split('.').filter(|p| !p.is_empty()) {
        current = match current {
            Value::Object(map) => map.get(part)?,
            Value::Array(items) => items.get(part.parse::<usize>().ok()?)?,
            _ => return None,
        };
    }
    Some(current)
}

fn value_text(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(text)) => text.clone(),
        Some(other) => other.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn paths_walk_objects_and_lists_and_missing_ones_vanish() {
        let context = json!({
            "trigger": {"user": {"username": "alice"}, "text": "hi"},
            "order": {"body": {"items": [{"name": "tea"}], "total": 4.5, "ok": true}},
        });
        assert_eq!(
            render(
                "Hello {{ trigger.user.username }}: {{trigger.text}}!",
                &context
            ),
            "Hello alice: hi!"
        );
        assert_eq!(render("{{order.body.items.0.name}}", &context), "tea");
        assert_eq!(
            render("{{order.body.total}} {{order.body.ok}}", &context),
            "4.5 true"
        );
        assert_eq!(render("[{{missing.path}}]", &context), "[]");
        assert_eq!(
            render("{{order.body.items}}", &context),
            r#"[{"name":"tea"}]"#
        );
        assert_eq!(
            render("open {{ never closed", &context),
            "open {{ never closed"
        );
    }

    #[test]
    fn values_never_ping_a_room_nor_move_a_url() {
        let context = json!({"trigger": {"text": "@all @Here @alice x@all"}, "q": "a&b=c/d?e"});
        let text = render_message("@here {{trigger.text}}", &context);
        assert_eq!(
            text,
            "@here @\u{2060}all @\u{2060}Here @alice x@\u{2060}all"
        );
        assert_eq!(
            rv_protocol::markdown::mention_names(&text)
                .into_iter()
                .collect::<Vec<_>>(),
            vec!["alice".to_owned(), "here".to_owned()]
        );
        assert_eq!(
            render_url("https://h.test/s/{{q}}?q={{q}}", &context),
            "https://h.test/s/a%26b%3Dc%2Fd%3Fe?q=a%26b%3Dc%2Fd%3Fe"
        );
    }
}
