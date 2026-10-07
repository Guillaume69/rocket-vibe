//! The emoji I react with most, per account, for the quick reactions of the
//! message menu. Kept on the device in a small text file (`code<TAB>count<TAB>last
//! use in seconds`), never on the server. Codes are shortcodes without colons,
//! as the menus send them; custom emoji names count like any other code.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
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

    /// The counts of one account (`<host>-<user id>` under `config_dir`), one
    /// shared instance per file in the process: every UI of the app, and both
    /// desktop apps on one machine through the file, count together.
    pub fn for_account(config_dir: &Path, base_url: &str, user_id: &str) -> Arc<EmojiUsage> {
        static ALL: OnceLock<Mutex<HashMap<PathBuf, Arc<EmojiUsage>>>> = OnceLock::new();
        let host = url::Url::parse(base_url).ok().and_then(|u| u.host_str().map(str::to_owned)).unwrap_or_default();
        let path = Self::path_for(config_dir, &format!("{host}-{user_id}"));
        let mut all = ALL.get_or_init(Mutex::default).lock().unwrap();
        all.entry(path.clone()).or_insert_with(|| Arc::new(EmojiUsage::open(path))).clone()
    }

    /// The file of one account under `dir`; `account` is any stable key of
    /// the account (host and user id), reduced to a safe file name.
    pub fn path_for(dir: &Path, account: &str) -> PathBuf {
        let name: String =
            account.chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '.' { c } else { '_' }).collect();
        dir.join("emoji-usage").join(format!("{name}.tsv"))
    }

    /// One more use of `code`, saved at once. The file is read again first,
    /// so another process writing it meanwhile (the other desktop app) is
    /// merged, not overwritten; a failed write keeps the count in memory.
    pub fn record(&self, code: &str) {
        let code = canonical(code);
        if code.is_empty() {
            return;
        }
        let now = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
        let mut counts = self.counts.lock().unwrap();
        if let Some(on_disk) = self.path.as_ref().and_then(|path| std::fs::read_to_string(path).ok()) {
            *counts = parse(&on_disk);
        }
        let usage = counts.entry(code.clone()).or_default();
        usage.count = usage.count.saturating_add(1);
        usage.last = usage.last.max(now);
        prune(&mut counts, &code);
        if let Some(path) = &self.path {
            let _ = write(path, &render(&counts));
        }
    }

    /// The `n` codes to offer first: most used, then most recent, then the
    /// default quick reactions to fill the row.
    pub fn top(&self, n: usize) -> Vec<String> {
        self.top_filtered(n, |_| true)
    }

    /// `top`, with only the codes `allowed` takes: what the server accepts
    /// (Rocket.Chat's own list, the server's custom emoji, standard ones only
    /// in a private conversation).
    pub fn top_filtered(&self, n: usize, allowed: impl Fn(&str) -> bool) -> Vec<String> {
        let counts = self.counts.lock().unwrap();
        top(&counts, n, &allowed)
    }
}

fn ranked(counts: &HashMap<String, Usage>) -> Vec<(&String, &Usage)> {
    let mut used: Vec<(&String, &Usage)> = counts.iter().collect();
    used.sort_by(|a, b| b.1.count.cmp(&a.1.count).then(b.1.last.cmp(&a.1.last)).then(a.0.cmp(b.0)));
    used
}

fn top(counts: &HashMap<String, Usage>, n: usize, allowed: &dyn Fn(&str) -> bool) -> Vec<String> {
    let mut out: Vec<String> =
        ranked(counts).into_iter().filter(|(code, _)| allowed(code)).take(n).map(|(code, _)| code.clone()).collect();
    for code in QUICK_REACTIONS.iter().map(|c| normalize(c)) {
        if out.len() >= n {
            break;
        }
        if allowed(code) && !out.iter().any(|c| c == code) {
            out.push(code.to_owned());
        }
    }
    out
}

/// Forgets the lowest-ranked codes beyond `KEPT`, never `fresh` (the code
/// just used), so a new emoji can grow past the established ones.
fn prune(counts: &mut HashMap<String, Usage>, fresh: &str) {
    if counts.len() <= KEPT {
        return;
    }
    let mut keep: Vec<String> =
        ranked(counts).into_iter().map(|(code, _)| code.clone()).filter(|code| code != fresh).take(KEPT - 1).collect();
    keep.push(fresh.to_owned());
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
    // A name of its own: two processes writing at once never share a temp file.
    let tmp = path.with_extension(format!("tmp-{}-{:016x}", std::process::id(), fastrand::u64(..)));
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
        assert_eq!(top(&counts, 5, &|_| true), ["rocket", "eyes", "heart", "+1", "joy"]);
        assert_eq!(top(&counts, 3, &|code| code != "eyes" && code != "+1"), ["rocket", "heart", "joy"]);
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
    fn a_new_emoji_survives_pruning_and_two_writers_merge() {
        let mut counts: HashMap<String, Usage> =
            (0..KEPT).map(|i| (format!("code{i}"), Usage { count: 5, last: 1 })).collect();
        counts.insert("fresh".into(), Usage { count: 1, last: 2 });
        prune(&mut counts, "fresh");
        assert!(counts.contains_key("fresh") && counts.len() == KEPT);
        let dir = tempfile::tempdir().unwrap();
        let path = EmojiUsage::path_for(dir.path(), "host-uid");
        let (gtk, swift) = (EmojiUsage::open(&path), EmojiUsage::open(&path));
        gtk.record("rocket");
        swift.record("tada");
        gtk.record("rocket");
        let both = EmojiUsage::open(&path).top(2);
        assert_eq!(both, ["rocket", "tada"], "the second writer read the first writer's use");
        assert_eq!(std::fs::read_dir(path.parent().unwrap()).unwrap().count(), 1, "no temp file left");
    }

    #[test]
    fn one_instance_per_account() {
        let dir = tempfile::tempdir().unwrap();
        let a = EmojiUsage::for_account(dir.path(), "https://chat.example.org", "uid");
        let b = EmojiUsage::for_account(dir.path(), "https://chat.example.org/", "uid");
        assert!(Arc::ptr_eq(&a, &b));
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
