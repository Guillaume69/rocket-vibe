//! Spell checking of the draft with Hunspell dictionaries (French and
//! English, the app's language first): the system's on Linux, the ones the
//! Windows and macOS packages carry beside the app. A word is right when one
//! of them, or the personal list, knows it. Without any dictionary nothing is
//! marked.

use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

use gtk::glib;
use spellbook::Dictionary;

static DICTIONARIES: OnceLock<Vec<Dictionary>> = OnceLock::new();
static PERSONAL: Mutex<Vec<String>> = Mutex::new(Vec::new());

fn personal_file() -> PathBuf {
    glib::user_config_dir().join("rocket-vibe-rs").join("dictionary")
}

fn search_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Ok(exe) = std::env::current_exe()
        && let Some(bin) = exe.parent()
    {
        dirs.push(bin.join("../share/hunspell"));
        dirs.push(bin.join("../Resources/share/hunspell"));
    }
    dirs.push(glib::user_data_dir().join("hunspell"));
    for dir in glib::system_data_dirs() {
        dirs.push(dir.join("hunspell"));
        dirs.push(dir.join("myspell"));
    }
    dirs
}

/// Dictionaries are usually UTF-8; older ones are Latin-1.
fn read_text(path: &std::path::Path) -> Option<String> {
    let bytes = std::fs::read(path).ok()?;
    Some(String::from_utf8(bytes).unwrap_or_else(|e| e.into_bytes().iter().map(|&b| b as char).collect()))
}

fn load(language: &str) -> Option<Dictionary> {
    search_dirs().into_iter().find_map(|dir| {
        let aff = read_text(&dir.join(format!("{language}.aff")))?;
        let dic = read_text(&dir.join(format!("{language}.dic")))?;
        Dictionary::new(&aff, &dic).ok()
    })
}

/// Loads the dictionaries off the main thread; checks answer "right" until then.
pub fn start() {
    let saved = std::fs::read_to_string(personal_file()).unwrap_or_default();
    *PERSONAL.lock().expect("personal words") = saved.lines().map(str::to_owned).collect();
    let languages =
        if crate::i18n::current() == crate::i18n::Lang::Fr { ["fr_FR", "en_US"] } else { ["en_US", "fr_FR"] };
    std::thread::spawn(move || {
        let _ = DICTIONARIES.set(languages.iter().filter_map(|l| load(l)).collect());
    });
}

pub fn check(word: &str) -> bool {
    let Some(dictionaries) = DICTIONARIES.get().filter(|d| !d.is_empty()) else { return true };
    dictionaries.iter().any(|d| d.check(word)) || PERSONAL.lock().expect("personal words").iter().any(|w| w == word)
}

/// What the first dictionary suggests, then the others.
pub fn suggest(word: &str) -> Vec<String> {
    let mut out = Vec::new();
    for dictionary in DICTIONARIES.get().into_iter().flatten() {
        let mut found = Vec::new();
        dictionary.suggest(word, &mut found);
        for s in found {
            if !out.contains(&s) {
                out.push(s);
            }
        }
        if out.len() >= 6 {
            break;
        }
    }
    out.truncate(6);
    out
}

/// Known from now on, on this machine.
pub fn learn(word: &str) {
    let mut personal = PERSONAL.lock().expect("personal words");
    if personal.iter().any(|w| w == word) {
        return;
    }
    personal.push(word.to_owned());
    let file = personal_file();
    if let Some(dir) = file.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let _ = std::fs::write(file, personal.join("\n"));
}
