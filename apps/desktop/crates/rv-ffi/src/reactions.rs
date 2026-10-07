//! The emoji I react with most, per account (rv-core's `EmojiUsage`), for the
//! quick reactions of the message menu. Each account's counts are read once
//! per run, in the config folder the GTK app shares on the same Mac and under
//! the same key, so both apps count into one file. Every reaction an export
//! adds counts one use; withdrawing does not.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

use rv_core::emoji_usage::{self, EmojiUsage, QUICK_COUNT};
use rv_core::session::SessionInfo;

/// The counts of one account (`<host>-<user id>`, as rv-gtk keys them), kept
/// for the run by file.
pub(crate) fn usage(config: &Path, info: &SessionInfo) -> Arc<EmojiUsage> {
    static ALL: OnceLock<Mutex<HashMap<PathBuf, Arc<EmojiUsage>>>> = OnceLock::new();
    let host = url::Url::parse(&info.base_url).ok().and_then(|u| u.host_str().map(str::to_owned)).unwrap_or_default();
    let path = EmojiUsage::path_for(config, &format!("{host}-{}", info.user_id));
    let mut all = ALL.get_or_init(Mutex::default).lock().unwrap();
    all.entry(path.clone()).or_insert_with(|| Arc::new(EmojiUsage::open(path))).clone()
}

/// The menu's quick reactions as they are sent (`:code:`): the most used
/// first, then the defaults, leaving out server emoji `custom` cannot show
/// (unknown here, or a conversation that takes standard emoji only).
pub(crate) fn quick(usage: &EmojiUsage, custom: impl Fn(&str) -> bool) -> Vec<String> {
    usage
        .top(usize::MAX)
        .into_iter()
        .filter(|code| rv_core::emoji::unicode(code).is_some() || custom(code))
        .take(QUICK_COUNT)
        .map(|code| format!(":{code}:"))
        .collect()
}

/// What a pick in the emoji picker reacts with (`:code:`): a standard emoji
/// under its canonical shortcode, so it joins the others' reaction whatever
/// alias named it; a server emoji by name where `custom` allows them; None
/// for anything else.
#[uniffi::export]
pub fn reaction_emoji(code: String, custom: bool) -> Option<String> {
    let code = emoji_usage::normalize(&code);
    if code.is_empty() {
        return None;
    }
    if rv_core::emoji::unicode(code).is_some() {
        return Some(format!(":{}:", emoji_usage::canonical(code)));
    }
    custom.then(|| format!(":{code}:"))
}

/// Whether two reaction codes name the same emoji (`:+1:` and `thumbsup`).
#[uniffi::export]
pub fn same_emoji(a: String, b: String) -> bool {
    emoji_usage::same(&a, &b)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn info(base_url: &str, user_id: &str) -> SessionInfo {
        SessionInfo {
            base_url: base_url.into(),
            user_id: user_id.into(),
            username: "me".into(),
            auth_token: String::new(),
            native: None,
        }
    }

    #[test]
    fn one_file_per_account_shared_for_the_run() {
        let dir = std::env::temp_dir().join(format!("rv-ffi-reactions-{}", std::process::id()));
        let a = usage(&dir, &info("https://chat.example.org/", "uid1"));
        let again = usage(&dir, &info("https://chat.example.org", "uid1"));
        let other = usage(&dir, &info("https://chat.example.org", "uid2"));
        assert!(Arc::ptr_eq(&a, &again), "read once per account");
        assert!(!Arc::ptr_eq(&a, &other));
        a.record("rocket");
        assert!(dir.join("emoji-usage").join("chat.example.org-uid1.tsv").exists(), "rv-gtk's file name");
        assert_eq!(EmojiUsage::open(EmojiUsage::path_for(&dir, "chat.example.org-uid1")).top(1), ["rocket"]);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn quick_reactions_skip_what_cannot_be_shown() {
        let usage = EmojiUsage::in_memory();
        for code in ["party_parrot", "party_parrot", "party_parrot", "thumbsup", ":+1:", "rocket"] {
            usage.record(code);
        }
        assert_eq!(quick(&usage, |c| c == "party_parrot"), [":party_parrot:", ":+1:", ":rocket:", ":heart:", ":joy:"]);
        assert_eq!(quick(&usage, |_| false), [":+1:", ":rocket:", ":heart:", ":joy:", ":tada:"]);
        assert_eq!(quick(&EmojiUsage::in_memory(), |_| true).len(), QUICK_COUNT);
    }

    #[test]
    fn a_pick_reacts_under_one_name() {
        assert_eq!(reaction_emoji(":thumbsup:".into(), false).as_deref(), Some(":+1:"));
        assert_eq!(reaction_emoji("rocket".into(), false).as_deref(), Some(":rocket:"));
        assert_eq!(reaction_emoji(":party_parrot:".into(), true).as_deref(), Some(":party_parrot:"));
        assert_eq!(reaction_emoji(":party_parrot:".into(), false), None, "standard emoji only");
        assert_eq!(reaction_emoji("::".into(), true), None);
        assert!(same_emoji(":+1:".into(), "thumbsup".into()));
        assert!(!same_emoji(":+1:".into(), ":heart:".into()));
    }
}
