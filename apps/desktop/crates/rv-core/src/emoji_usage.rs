//! The emoji I react with most, per account, for the quick reactions of the
//! message menu. Kept on the device in a small text file (`code<TAB>count<TAB>last
//! use in seconds`), never on the server. Codes are shortcodes without colons,
//! as the menus send them; custom emoji names count like any other code.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::actions::QUICK_REACTIONS;

/// How many quick reactions the menus show.
pub const QUICK_COUNT: usize = 5;
/// Codes beyond this are forgotten, least used first, so the file stays small.
const KEPT: usize = 64;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct Usage {
    count: u32,
    last: u64,
}

pub struct EmojiUsage {
    path: Option<PathBuf>,
    counts: Mutex<HashMap<String, Usage>>,
}

/// `:+1:` and `+1` are the same code.
pub fn normalize(code: &str) -> &str {
    code.trim().trim_matches(':')
}

/// The code a reaction is counted and sent under: one name per standard
/// emoji whatever alias named it (`thumbsup` and `thumbs_up` count as `+1`),
/// the default quick reactions keeping their own names; a custom emoji's name
/// as it is.
pub fn canonical(code: &str) -> String {
    let code = normalize(code);
    let Some(glyph) = crate::emoji::unicode(code) else { return code.to_owned() };
    QUICK_REACTIONS
        .iter()
        .map(|quick| normalize(quick))
        .find(|quick| crate::emoji::unicode(quick) == Some(glyph))
        .or_else(|| crate::emoji::shortcode(glyph))
        .unwrap_or(code)
        .to_owned()
}

/// Whether two codes name the same emoji (`:+1:`, `thumbsup` and 👍's code).
pub fn same(a: &str, b: &str) -> bool {
    let (a, b) = (normalize(a), normalize(b));
    a == b || crate::emoji::unicode(a).is_some_and(|glyph| crate::emoji::unicode(b) == Some(glyph))
}

impl EmojiUsage {
    /// Reads `path` when it exists; a missing or damaged file starts empty.
    pub fn open(path: impl Into<PathBuf>) -> Self {
        let path = path.into();
        let counts = std::fs::read_to_string(&path).map(|text| parse(&text)).unwrap_or_default();
        Self { path: Some(path), counts: Mutex::new(counts) }
    }

    /// Kept in memory only, for tests and for an account with no file yet.
    pub fn in_memory() -> Self {
        Self { path: None, counts: Mutex::new(HashMap::new()) }
    }

    /// The file of one account under `dir`; `account` is any stable key of
    /// the account (host and user id), reduced to a safe file name.
    pub fn path_for(dir: &Path, account: &str) -> PathBuf {
        let name: String =
            account.chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '.' { c } else { '_' }).collect();
        dir.join("emoji-usage").join(format!("{name}.tsv"))
    }

    /// One more use of `code`, saved at once; a failed write keeps the count
    /// in memory for this session.
    pub fn record(&self, code: &str) {
        let code = canonical(code);
        if code.is_empty() {
            return;
        }
        let now = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
        let text = {
            let mut counts = self.counts.lock().unwrap();
            let usage = counts.entry(code).or_default();
            usage.count = usage.count.saturating_add(1);
            usage.last = usage.last.max(now);
            prune(&mut counts);
            render(&counts)
        };
        if let Some(path) = &self.path {
            let _ = write(path, &text);
        }
    }

    /// The `n` codes to offer first: most used, then most recent, then the
    /// default quick reactions to fill the row.
    pub fn top(&self, n: usize) -> Vec<String> {
        let counts = self.counts.lock().unwrap();
        top(&counts, n)
    }
}

fn top(counts: &HashMap<String, Usage>, n: usize) -> Vec<String> {
    let mut used: Vec<(&String, &Usage)> = counts.iter().collect();
    used.sort_by(|a, b| b.1.count.cmp(&a.1.count).then(b.1.last.cmp(&a.1.last)).then(a.0.cmp(b.0)));
    let mut out: Vec<String> = used.into_iter().take(n).map(|(code, _)| code.clone()).collect();
    for code in QUICK_REACTIONS.iter().map(|c| normalize(c)) {
        if out.len() >= n {
            break;
        }
        if !out.iter().any(|c| c == code) {
            out.push(code.to_owned());
        }
    }
    out
}

fn prune(counts: &mut HashMap<String, Usage>) {
    if counts.len() <= KEPT {
        return;
    }
    let keep: Vec<String> = top(counts, KEPT);
    counts.retain(|code, _| keep.contains(code));
}

/// Lines naming one emoji differently (an older file) add up.
fn parse(text: &str) -> HashMap<String, Usage> {
    let mut counts: HashMap<String, Usage> = HashMap::new();
    let lines = text.lines().filter_map(|line| {
        let mut parts = line.split('\t');
        let code = canonical(parts.next()?);
        let count: u32 = parts.next()?.parse().ok()?;
        let last = parts.next().and_then(|v| v.parse().ok()).unwrap_or(0);
        (!code.is_empty()).then_some((code, Usage { count, last }))
    });
    for (code, read) in lines {
        let usage = counts.entry(code).or_default();
        usage.count = usage.count.saturating_add(read.count);
        usage.last = usage.last.max(read.last);
    }
    counts
}

fn render(counts: &HashMap<String, Usage>) -> String {
    let mut lines: Vec<String> = counts.iter().map(|(code, u)| format!("{code}\t{}\t{}", u.count, u.last)).collect();
    lines.sort();
    lines.join("\n") + "\n"
}

fn write(path: &Path, text: &str) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, text)?;
    std::fs::rename(&tmp, path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_fill_an_empty_history() {
        let usage = EmojiUsage::in_memory();
        assert_eq!(usage.top(QUICK_COUNT), ["+1", "heart", "joy", "tada", "open_mouth"]);
    }

    #[test]
    fn most_used_first_then_recent_then_defaults() {
        let mut counts = HashMap::new();
        counts.insert("rocket".to_owned(), Usage { count: 3, last: 10 });
        counts.insert("eyes".to_owned(), Usage { count: 1, last: 50 });
        counts.insert("heart".to_owned(), Usage { count: 1, last: 20 });
        assert_eq!(top(&counts, 5), ["rocket", "eyes", "heart", "+1", "joy"]);
    }

    #[test]
    fn colons_do_not_split_a_code_and_the_file_round_trips() {
        let dir = tempfile::tempdir().unwrap();
        let path = EmojiUsage::path_for(dir.path(), "chat.example.org/uid 1");
        assert!(path.ends_with("emoji-usage/chat.example.org_uid_1.tsv"));
        let usage = EmojiUsage::open(&path);
        usage.record(":rocket:");
        usage.record("rocket");
        usage.record("party_parrot");
        let again = EmojiUsage::open(&path);
        assert_eq!(again.top(2), ["rocket", "party_parrot"]);
    }

    #[test]
    fn aliases_of_one_emoji_count_together() {
        assert_eq!(canonical(":thumbsup:"), "+1");
        assert_eq!(canonical("thumbs_up"), "+1");
        assert_eq!(canonical("party_parrot"), "party_parrot");
        assert!(same(":+1:", "thumbsup") && !same("+1", "heart"));
        let usage = EmojiUsage::in_memory();
        usage.record("thumbsup");
        usage.record(":+1:");
        usage.record("rocket");
        assert_eq!(usage.top(3), ["+1", "rocket", "heart"]);
        assert_eq!(parse("thumbsup\t2\t5\n+1\t1\t9\n")["+1"], Usage { count: 3, last: 9 });
    }

    #[test]
    fn a_damaged_file_starts_empty_and_old_codes_are_pruned() {
        assert!(parse("garbage\n\tx\n").is_empty());
        let usage = EmojiUsage::in_memory();
        for i in 0..(KEPT + 10) {
            usage.record(&format!("code{i}"));
        }
        assert!(usage.counts.lock().unwrap().len() <= KEPT);
    }
}
