//! `{{path.to.value}}` in a step's text: a lookup in the run's context, no
//! logic. A missing path renders empty; an object or a list renders as JSON.
use serde_json::Value;

pub(crate) fn render(template: &str, context: &Value) -> String {
    let mut out = String::with_capacity(template.len());
    let mut rest = template;
    while let Some(start) = rest.find("{{") {
        out.push_str(&rest[..start]);
        let after = &rest[start + 2..];
        let Some(end) = after.find("}}") else {
            out.push_str(&rest[start..]);
            return out;
        };
        out.push_str(&value_text(lookup(context, after[..end].trim())));
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
        Some(other @ (Value::Bool(_) | Value::Number(_))) => other.to_string(),
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
}
