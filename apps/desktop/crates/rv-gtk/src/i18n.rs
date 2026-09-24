//! French and English, like the Android app, whose strings these reuse.
//! `auto` follows the desktop's language; the choice lives in the config dir.

use std::sync::atomic::{AtomicU8, Ordering};

use gtk::glib;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Lang {
    Fr,
    En,
}

static LANG: AtomicU8 = AtomicU8::new(1);

pub fn current() -> Lang {
    if LANG.load(Ordering::Relaxed) == 0 { Lang::Fr } else { Lang::En }
}

pub fn set(lang: Lang) {
    LANG.store(if lang == Lang::Fr { 0 } else { 1 }, Ordering::Relaxed);
}

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

pub fn init() {
    apply(&saved_choice());
}

pub fn locale() -> chrono::Locale {
    match current() {
        Lang::Fr => chrono::Locale::fr_FR,
        Lang::En => chrono::Locale::en_US,
    }
}

/// (key, French, English). A `{name}` is filled by `tf`; `a | b` is the
/// singular and plural of `tn`.
const CATALOG: &[(&str, &str, &str)] = &[
    ("login.slogan", "Ton coin de chat magique ✨", "Your magical little chat corner ✨"),
    ("login.server", "Adresse du serveur", "Server address"),
    ("login.user", "Identifiant ou email", "Username or email"),
    ("login.password", "Mot de passe", "Password"),
    ("login.sign_in", "Se connecter", "Sign in"),
    ("login.signing_in", "Connexion…", "Signing in…"),
    ("login.confirm", "Valider", "Confirm"),
    ("login.magic", "Vérification magique", "Magic verification"),
    ("login.code_totp", "Code de l'application d'authentification", "Authenticator app code"),
    ("login.code_email", "Code reçu par email", "Code received by email"),
    ("login.code_password", "Confirme ton mot de passe", "Confirm your password"),
    (
        "login.intro_totp",
        "Entre le code de ton application\nd'authentification ✨",
        "Enter the code from your\nauthenticator app ✨",
    ),
    (
        "login.intro_email",
        "Ce compte est protégé par un code envoyé par email.",
        "This account is protected by a code sent via email.",
    ),
    ("login.intro_password", "Ressaisis ton mot de passe pour confirmer.", "Re-enter your password to confirm."),
    (
        "login.unreachable",
        "Serveur injoignable. Vérifie l'adresse et ta connexion.",
        "Server unreachable. Check the address and your connection.",
    ),
    ("login.bad_code", "Code refusé. Réessaie.", "Code rejected. Try again."),
    ("login.rejected", "Identifiant ou mot de passe refusé.", "Username or password rejected."),
    (
        "login.too_many",
        "Trop d'essais. Attends une minute et réessaie.",
        "Too many attempts. Wait a minute and try again.",
    ),
    ("login.bad_server", "Adresse de serveur invalide.", "Invalid server address."),
    ("login.expired", "Ta session a expiré. Reconnecte-toi.", "Your session has expired. Please sign in again."),
    ("login.no_database", "Impossible d'ouvrir la base locale : {error}", "Cannot open the local database: {error}"),
    ("rooms.encrypted", "Message chiffré", "Encrypted message"),
    ("rooms.call", "Appel vidéo", "Video call"),
    ("rooms.offline", "Hors ligne, clique pour te reconnecter", "Offline, click to reconnect"),
    ("rooms.connecting", "Connexion…", "Connecting…"),
    ("rooms.online", "Connecté", "Connected"),
    ("rooms.sign_out", "Se déconnecter", "Sign out"),
    ("room.pick", "Choisis une conversation", "Pick a conversation"),
    ("room.synced", "Tout est synchronisé et scintille ✨", "Everything is synced and sparkling ✨"),
    ("room.read_only", "Ce salon est en lecture seule.", "This channel is read-only."),
    ("composer.placeholder", "Message", "Message"),
    ("composer.send", "Envoyer", "Send"),
    ("day.today", "Aujourd'hui", "Today"),
    ("day.yesterday", "Hier", "Yesterday"),
    ("message.edited", "(modifié)", "(edited)"),
    ("message.sending", "⏳ envoi…", "⏳ sending…"),
    ("message.failed", "⚠️ Échec, réessayer", "⚠️ Failed, retry"),
    ("message.replies", "{n} réponse | {n} réponses", "{n} reply | {n} replies"),
    ("message.encrypted", "🔒 Message chiffré, non pris en charge", "🔒 Encrypted message, not supported"),
    ("message.image", "Image", "Image"),
    ("actions.more", "Actions", "Actions"),
    ("actions.reply", "Répondre", "Reply"),
    ("actions.reply_thread", "Répondre dans un fil", "Reply in thread"),
    ("actions.copy", "Copier", "Copy"),
    ("actions.download", "Télécharger", "Download"),
    ("actions.edit", "Modifier", "Edit"),
    ("actions.delete", "Supprimer", "Delete"),
    ("actions.pin", "Épingler", "Pin"),
    ("actions.save", "Enregistrer", "Save"),
    ("actions.cancel", "Annuler", "Cancel"),
    ("actions.none", "Rien à faire sur ce message.", "Nothing to do with this message."),
    ("actions.refused", "Action refusée.", "Action refused."),
    ("actions.copied", "Copié", "Copied"),
    ("actions.pinned", "Message épinglé", "Message pinned"),
    ("actions.saved", "Enregistré dans Téléchargements", "Saved to Downloads"),
    ("actions.save_failed", "Impossible d'enregistrer ce fichier.", "Couldn't save this file."),
    ("composer.replying", "Réponse à {name}", "Replying to {name}"),
    ("thread.title", "Fil", "Thread"),
    ("thread.not_found", "Fil introuvable.", "Thread not found."),
    ("sys.uj", "a rejoint le salon", "joined the channel"),
    ("sys.ujt", "a rejoint l'équipe", "joined the team"),
    ("sys.ul", "a quitté le salon", "left the channel"),
    ("sys.ult", "a quitté l'équipe", "left the team"),
    ("sys.ru", "a retiré {p} du salon", "removed {p} from the channel"),
    ("sys.au", "a ajouté {p} au salon", "added {p} to the channel"),
    ("sys.r", "a renommé le salon en {p}", "renamed the channel to {p}"),
    ("sys.rm", "(message supprimé)", "(message removed)"),
    ("sys.wm_empty", "bienvenue !", "welcome!"),
    ("sys.wm", "bienvenue, {p} !", "welcome, {p}!"),
    ("sys.uploaded", "a envoyé le fichier {p}", "sent the file {p}"),
    ("sys.pinned", "a épinglé un message", "pinned a message"),
    ("sys.unpinned", "a désépinglé un message", "unpinned a message"),
    ("sys.topic_removed", "a retiré le sujet", "removed the topic"),
    ("sys.topic", "a changé le sujet : {p}", "changed the topic: {p}"),
    ("sys.announcement_removed", "a retiré l'annonce", "removed the announcement"),
    ("sys.announcement", "a changé l'annonce : {p}", "changed the announcement: {p}"),
    ("sys.description_removed", "a retiré la description", "removed the description"),
    ("sys.description", "a changé la description : {p}", "changed the description: {p}"),
    ("sys.avatar", "a changé l'avatar du salon", "changed the channel's avatar"),
    ("sys.privacy", "a changé la confidentialité du salon : {p}", "changed the channel's privacy: {p}"),
    ("sys.read_only", "a passé le salon en lecture seule", "set the channel to read-only"),
    ("sys.writable", "a repassé le salon en écriture", "set the channel to writable"),
    ("sys.archived", "a archivé le salon", "archived the channel"),
    ("sys.unarchived", "a désarchivé le salon", "unarchived the channel"),
    ("sys.muted", "a rendu {p} muet", "muted {p}"),
    ("sys.unmuted", "a rendu la parole à {p}", "unmuted {p}"),
    ("sys.role_added", "a donné un rôle à {p}", "gave a role to {p}"),
    ("sys.role_removed", "a retiré un rôle à {p}", "removed a role from {p}"),
    ("sys.reactions_allowed", "a autorisé les réactions", "allowed reactions"),
    ("sys.reactions_disallowed", "a interdit les réactions", "disallowed reactions"),
    ("sys.message_deleted", "a supprimé un message", "deleted a message"),
    ("sys.call", "a lancé un appel vidéo", "started a video call"),
    ("sys.unknown", "(action système « {type} »)", "(system action “{type}”)"),
    ("sys.unknown_param", "(action système « {type} » : {p})", "(system action “{type}”: {p})"),
];

pub fn t(key: &str) -> &'static str {
    let entry = CATALOG.iter().find(|(k, _, _)| *k == key);
    match (entry, current()) {
        (Some((_, fr, _)), Lang::Fr) => fr,
        (Some((_, _, en)), Lang::En) => en,
        (None, _) => {
            debug_assert!(false, "missing translation key {key}");
            "?"
        }
    }
}

pub fn tf(key: &str, args: &[(&str, &str)]) -> String {
    args.iter().fold(t(key).to_owned(), |text, (name, value)| text.replace(&format!("{{{name}}}"), value))
}

/// French puts 0 and 1 in the singular, English only 1.
pub fn tn(key: &str, n: i64) -> String {
    let text = t(key);
    let (one, many) = text.split_once(" | ").unwrap_or((text, text));
    let singular = match current() {
        Lang::Fr => n <= 1,
        Lang::En => n == 1,
    };
    (if singular { one } else { many }).replace("{n}", &n.to_string())
}

/// The sentence a system message stands for, said after its author's name.
pub fn system_message(kind: &str, param: &str) -> String {
    let with_p = |key: &str| tf(key, &[("p", param)]);
    let either = |removed: &str, set: &str| if param.is_empty() { t(removed).to_owned() } else { with_p(set) };
    match kind {
        "wm" => either("sys.wm_empty", "sys.wm"),
        "room_changed_topic" => either("sys.topic_removed", "sys.topic"),
        "room_changed_announcement" => either("sys.announcement_removed", "sys.announcement"),
        "room_changed_description" => either("sys.description_removed", "sys.description"),
        "uj" => with_p("sys.uj"),
        "ujt" => with_p("sys.ujt"),
        "ul" => with_p("sys.ul"),
        "ult" => with_p("sys.ult"),
        "ru" => with_p("sys.ru"),
        "au" => with_p("sys.au"),
        "r" => with_p("sys.r"),
        "rm" => with_p("sys.rm"),
        "uploaded" => with_p("sys.uploaded"),
        "message_pinned" | "message_pinned_e2e" => with_p("sys.pinned"),
        "message_unpinned" | "message_unpinned_e2e" => with_p("sys.unpinned"),
        "room_changed_avatar" => with_p("sys.avatar"),
        "room_changed_privacy" => with_p("sys.privacy"),
        "room-set-read-only" => with_p("sys.read_only"),
        "room-removed-read-only" => with_p("sys.writable"),
        "room-archived" => with_p("sys.archived"),
        "room-unarchived" => with_p("sys.unarchived"),
        "user-muted" => with_p("sys.muted"),
        "user-unmuted" => with_p("sys.unmuted"),
        "subscription-role-added" => with_p("sys.role_added"),
        "subscription-role-removed" => with_p("sys.role_removed"),
        "room-allowed-reacting" => with_p("sys.reactions_allowed"),
        "room-disallowed-reacting" => with_p("sys.reactions_disallowed"),
        "message-deleted-notification" => with_p("sys.message_deleted"),
        "videoconf" => t("sys.call").to_owned(),
        _ if param.is_empty() => tf("sys.unknown", &[("type", kind)]),
        _ => tf("sys.unknown_param", &[("type", kind), ("p", param)]),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    static LANGUAGE: std::sync::Mutex<()> = std::sync::Mutex::new(());

    #[test]
    fn keys_are_unique_and_both_languages_filled() {
        let mut keys: Vec<&str> = CATALOG.iter().map(|(k, _, _)| *k).collect();
        keys.sort_unstable();
        let before = keys.len();
        keys.dedup();
        assert_eq!(before, keys.len(), "duplicate key");
        for (key, fr, en) in CATALOG {
            assert!(!fr.is_empty() && !en.is_empty(), "{key}");
            let placeholders = |s: &str| s.matches('{').count();
            assert_eq!(placeholders(fr), placeholders(en), "{key}: placeholders differ");
        }
    }

    #[test]
    fn plurals_follow_each_language() {
        let _serial = LANGUAGE.lock().unwrap();
        set(Lang::Fr);
        assert_eq!(tn("message.replies", 0), "0 réponse");
        assert_eq!(tn("message.replies", 2), "2 réponses");
        set(Lang::En);
        assert_eq!(tn("message.replies", 0), "0 replies");
        assert_eq!(tn("message.replies", 1), "1 reply");
    }

    #[test]
    fn system_messages() {
        let _serial = LANGUAGE.lock().unwrap();
        set(Lang::En);
        assert_eq!(system_message("uj", ""), "joined the channel");
        assert_eq!(system_message("room_changed_topic", ""), "removed the topic");
        assert_eq!(system_message("room_changed_topic", "Tea"), "changed the topic: Tea");
        assert_eq!(system_message("au", "bob"), "added bob to the channel");
        assert_eq!(system_message("livechat-close", ""), "(system action “livechat-close”)");
        set(Lang::Fr);
        assert_eq!(system_message("r", "général"), "a renommé le salon en général");
    }
}
