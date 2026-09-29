//! French and English, like the Android app, whose strings these reuse.
//! `auto` follows the desktop's language; the choice lives in the config dir.

use gtk::glib;
pub use rv_core::i18n::*;

fn choice_file() -> std::path::PathBuf {
    glib::user_config_dir().join("rocket-vibe-rs").join("language")
}

/// `auto`, `fr` or `en`.
pub fn saved_choice() -> String {
    std::fs::read_to_string(choice_file()).map(|s| s.trim().to_owned()).unwrap_or_else(|_| "auto".into())
}

fn apply(choice: &str) {
    let lang = match choice {
        "fr" => Lang::Fr,
        "en" => Lang::En,
        _ if glib::language_names().first().is_some_and(|l| l.starts_with("fr")) => Lang::Fr,
        _ => Lang::En,
    };
    set(lang);
}

pub fn save_choice(choice: &str) {
    let file = choice_file();
    if let Some(dir) = file.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let _ = std::fs::write(file, choice);
}

pub fn init() {
    apply(&saved_choice());
}

pub fn locale() -> chrono::Locale {
    match current() {
        Lang::Fr => chrono::Locale::fr_FR,
        Lang::En => chrono::Locale::en_US,
    }
}
