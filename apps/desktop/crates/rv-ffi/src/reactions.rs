//! The emoji I react with most, per account (rv-core's `EmojiUsage`, one
//! shared instance per account file, the GTK app's file on the same Mac),
//! for the quick reactions of the message menu. Every reaction an export
//! adds counts one use; withdrawing does not. Rocket.Chat takes only the
//! names of its own list (`emoji::rc_reaction`): a standard emoji goes out
//! under an accepted alias, one it has no name for is not offered.

use std::path::Path;
use std::sync::Arc;

use rv_core::emoji_usage::{self, EmojiUsage, QUICK_COUNT};
use rv_core::session::SessionInfo;

/// The counts of one account.
pub(crate) fn usage(config: &Path, info: &SessionInfo) -> Arc<EmojiUsage> {
    EmojiUsage::for_account(config, &info.base_url, &info.user_id)
}

/// Whether a code names a standard emoji (else a server's own, by name).
fn standard(code: &str) -> bool {
    rv_core::emoji::unicode(code).is_some()
}

/// The menu's quick reactions as they are sent (`:code:`): the most used
/// first, then the defaults, leaving out server emoji `custom` cannot show
/// (unknown here, or a conversation that takes standard emoji only).
pub(crate) fn quick(usage: &EmojiUsage, custom: impl Fn(&str) -> bool) -> Vec<String> {
    usage
        .top_filtered(QUICK_COUNT, |code| standard(code) || custom(code))
        .into_iter()
        .map(|code| format!(":{code}:"))
        .collect()
}

/// The same on Rocket.Chat: standard emoji under the name it accepts, those
/// it has no name for left out.
pub(crate) fn quick_rocket_chat(usage: &EmojiUsage, custom: impl Fn(&str) -> bool) -> Vec<String> {
    usage
        .top_filtered(QUICK_COUNT, |code| {
            if standard(code) { rv_core::emoji::rc_reaction(code).is_some() } else { custom(code) }
        })
        .into_iter()
        .filter_map(|code| reaction_emoji(code, true, true))
        .collect()
}

/// What a pick in the emoji picker reacts with (`:code:`): a standard emoji
/// under its canonical shortcode, so it joins the others' reaction whatever
/// alias named it, and on Rocket.Chat under a name it accepts (None when it
/// has none); a server emoji by name where `custom` allows them; None for
/// anything else.
#[uniffi::export]
pub fn reaction_emoji(code: String, custom: bool, rocket_chat: bool) -> Option<String> {
    let code = emoji_usage::normalize(&code);
    if code.is_empty() {
        return None;
    }
    if standard(code) {
        let canonical = emoji_usage::canonical(code);
        if !rocket_chat {
            return Some(format!(":{canonical}:"));
        }
        return rv_core::emoji::rc_reaction(&canonical).map(|accepted| format!(":{accepted}:"));
    }
    custom.then(|| format!(":{code}:"))
}

/// Whether Rocket.Chat takes a reaction with this standard emoji: the
/// reaction picker hides the others there.
#[uniffi::export]
pub fn rocket_chat_reacts_with(code: String) -> bool {
    rv_core::emoji::rc_reaction(&code).is_some()
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
        let rc = quick_rocket_chat(&usage, |c| c == "party_parrot");
        assert_eq!(rc.len(), QUICK_COUNT);
        assert_eq!(rc[0], ":party_parrot:");
        assert!(rc.iter().all(|code| reaction_emoji(code.clone(), true, true).as_deref() == Some(code.as_str())));
    }

    #[test]
    fn a_pick_reacts_under_one_name() {
        assert_eq!(reaction_emoji(":thumbsup:".into(), false, false).as_deref(), Some(":+1:"));
        assert_eq!(reaction_emoji("rocket".into(), false, false).as_deref(), Some(":rocket:"));
        assert_eq!(reaction_emoji(":party_parrot:".into(), true, false).as_deref(), Some(":party_parrot:"));
        assert_eq!(reaction_emoji(":party_parrot:".into(), false, false), None, "standard emoji only");
        assert_eq!(reaction_emoji("::".into(), true, false), None);
        assert_eq!(reaction_emoji(":thumbsup:".into(), true, true).as_deref(), Some(":+1:"), "an accepted alias");
        assert_eq!(reaction_emoji(":party_parrot:".into(), true, true).as_deref(), Some(":party_parrot:"));
        assert!(rocket_chat_reacts_with(":+1:".into()));
        assert!(same_emoji(":+1:".into(), "thumbsup".into()));
        assert!(!same_emoji(":+1:".into(), ":heart:".into()));
    }
}
