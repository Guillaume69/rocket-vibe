//! Canonical shortnames from the same MIT data as the existing clients.
use std::{collections::HashMap, sync::OnceLock};

pub fn canonical(input: &str) -> Option<&'static str> {
    static ALIASES: OnceLock<HashMap<String, String>> = OnceLock::new();
    if input.len() > 80 {
        return None;
    }
    let code = input
        .strip_prefix(':')
        .and_then(|s| s.strip_suffix(':'))
        .unwrap_or(input);
    ALIASES
        .get_or_init(|| {
            serde_json::from_str(include_str!("../data/emoji-aliases.json"))
                .expect("generated emoji aliases")
        })
        .get(code)
        .map(String::as_str)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn aliases_share_a_glyph_and_unknown_values_are_not_emojis() {
        assert_eq!(canonical(":thumbsup:"), canonical("+1"));
        assert_eq!(canonical("rocket"), Some("rocket"));
        assert_eq!(canonical("not_a_real_emoji"), None);
        assert_eq!(canonical(":rocket"), None);
        assert_eq!(canonical("🚀"), None);
    }
}
