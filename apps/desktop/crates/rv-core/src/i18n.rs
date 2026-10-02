//! French and English, like the Android app, whose strings these reuse.
//! Every UI reads this one catalog; which language is on is the UI's choice.

use std::sync::atomic::{AtomicU8, Ordering};

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
    ("composer.emoji", "Émojis", "Emoji"),
    ("day.today", "Aujourd'hui", "Today"),
    ("day.yesterday", "Hier", "Yesterday"),
    ("message.edited", "(modifié)", "(edited)"),
    ("message.sending", "⏳ envoi…", "⏳ sending…"),
    ("message.failed", "⚠️ Échec, réessayer", "⚠️ Failed, retry"),
    ("message.replies", "{n} réponse | {n} réponses", "{n} reply | {n} replies"),
    ("message.encrypted", "🔒 Message chiffré, non pris en charge", "🔒 Encrypted message, not supported"),
    ("message.image", "Image", "Image"),
    ("room.new_messages", "Nouveaux messages", "New messages"),
    ("room.latest", "Aller aux derniers messages", "Jump to the latest messages"),
    ("room.call", "Lancer un appel vidéo", "Start a video call"),
    ("typing.one", "{a} écrit…", "{a} is typing…"),
    ("typing.two", "{a} et {b} écrivent…", "{a} and {b} are typing…"),
    ("typing.many", "{n} personnes écrivent…", "{n} people are typing…"),
    ("presence.online", "En ligne", "Online"),
    ("presence.away", "Absent", "Away"),
    ("presence.busy", "Occupé", "Busy"),
    ("presence.offline", "Hors ligne", "Offline"),
    ("attach.choose", "Joindre des fichiers", "Attach files"),
    ("attach.pasted_name", "image-collee", "pasted-image"),
    ("spell.learn", "Ajouter au dictionnaire", "Add to dictionary"),
    ("spell.none", "Aucune suggestion", "No suggestions"),
    ("format.bold", "Gras (Ctrl+B)", "Bold (Ctrl+B)"),
    ("format.italic", "Italique (Ctrl+I)", "Italic (Ctrl+I)"),
    ("format.strike", "Barré (Ctrl+Maj+X)", "Strikethrough (Ctrl+Shift+X)"),
    ("format.heading", "Titre", "Heading"),
    ("format.link", "Lien (Ctrl+K)", "Link (Ctrl+K)"),
    ("format.code", "Code (Ctrl+E)", "Code (Ctrl+E)"),
    ("format.code_block", "Bloc de code (Ctrl+Maj+E)", "Code block (Ctrl+Shift+E)"),
    ("format.quote", "Citation (Ctrl+Maj+9)", "Quote (Ctrl+Shift+9)"),
    ("format.bullets", "Liste à puces (Ctrl+Maj+8)", "Bulleted list (Ctrl+Shift+8)"),
    ("format.numbers", "Liste numérotée (Ctrl+Maj+7)", "Numbered list (Ctrl+Shift+7)"),
    ("attach.original", "Images en qualité d'origine", "Images in original quality"),
    ("emoji.server", "Émojis du serveur", "Server emoji"),
    ("attach.preview", "Aperçu", "Preview"),
    ("attach.remove", "Retirer", "Remove"),
    ("attach.too_large", "{name} dépasse {max} Mo", "{name} is over {max} MB"),
    (
        "attach.encrypted_off",
        "{name} : ce serveur n'accepte pas de fichiers dans un salon chiffré",
        "{name}: this server accepts no files in an encrypted room",
    ),
    (
        "attach.type_refused",
        "Le serveur refuse les fichiers {type} ({name})",
        "The server refuses {type} files ({name})",
    ),
    ("upload.waiting", "En attente", "Waiting"),
    ("text.open_link", "Ouvrir le lien", "Open link"),
    ("text.copy_link", "Copier l'adresse du lien", "Copy link address"),
    ("upload.retrying", "Connexion perdue, nouvel essai…", "Connection lost, retrying…"),
    ("upload.failed", "Échec de l'envoi", "Upload failed"),
    ("upload.retry", "Réessayer", "Retry"),
    ("upload.discard", "Abandonner", "Discard"),
    ("rooms.section_unread", "Non lus", "Unread"),
    ("rooms.section_favorites", "Favoris", "Favorites"),
    ("rooms.favorite_add", "Ajouter aux favoris", "Add to favorites"),
    ("rooms.favorite_remove", "Retirer des favoris", "Remove from favorites"),
    ("rooms.section_channels", "Salons", "Channels"),
    ("rooms.section_direct", "Messages privés", "Direct messages"),
    ("rooms.new", "Nouvelle conversation", "New conversation"),
    ("nav.back", "Précédent", "Back"),
    ("nav.forward", "Suivant", "Forward"),
    ("rooms.back_to_room", "Retour à la conversation", "Back to the conversation"),
    ("spotlight.placeholder", "Chercher des personnes ou des salons", "Search people or channels"),
    ("spotlight.failed", "Recherche impossible", "Search failed"),
    ("spotlight.open_failed", "Impossible d'ouvrir cette conversation", "Couldn't open this conversation"),
    ("spotlight.join", "Rejoindre", "Join"),
    ("spotlight.none", "Aucun résultat", "No results"),
    ("info.room", "Informations du salon", "Room information"),
    ("info.profile", "Profil", "Profile"),
    ("info.failed", "Informations indisponibles", "Information unavailable"),
    ("info.public", "Salon public", "Public channel"),
    ("info.private", "Groupe privé", "Private group"),
    ("info.members", "{n} membre | {n} membres", "{n} member | {n} members"),
    ("info.read_only", "lecture seule", "read-only"),
    ("info.encrypted", "chiffré", "encrypted"),
    ("info.archived", "archivé", "archived"),
    ("info.default", "par défaut", "default"),
    ("info.topic", "Sujet", "Topic"),
    ("info.announcement", "Annonce", "Announcement"),
    ("info.description", "Description", "Description"),
    ("info.nothing", "Pas de description", "No description"),
    ("info.local_time", "Heure locale : {time}", "Local time: {time}"),
    ("info.roles", "Rôles", "Roles"),
    ("info.bio", "Bio", "Bio"),
    ("info.message", "Message", "Message"),
    ("info.call", "Appeler", "Call"),
    ("search.title", "Rechercher dans le salon", "Search in room"),
    ("search.placeholder", "Chercher des messages", "Search messages"),
    ("search.none", "Aucun message trouvé", "No messages found"),
    ("search.failed", "Recherche impossible", "Search failed"),
    ("settings.title", "Paramètres", "Settings"),
    ("settings.edit_profile", "Mon profil", "My profile"),
    ("settings.status", "Statut", "Status"),
    ("settings.presence", "Présence", "Presence"),
    ("settings.status_text", "Message de statut", "Status message"),
    ("settings.notifications", "Notifications", "Notifications"),
    ("settings.desktop_notifications", "Notifications de bureau", "Desktop notifications"),
    ("settings.notify_default", "Réglage du serveur", "Server default"),
    ("settings.notify_all", "Tous les messages", "All messages"),
    ("settings.notify_mention", "Mentions et messages privés", "Mentions and direct messages"),
    ("settings.notify_nothing", "Aucune", "None"),
    ("settings.language", "Langue", "Language"),
    ("settings.lang_auto", "Automatique", "Automatic"),
    ("settings.lang_fr", "Français", "Français"),
    ("settings.lang_en", "English", "English"),
    ("settings.language_restart", "Prend effet au prochain lancement", "Takes effect on next launch"),
    ("settings.account", "Compte", "Account"),
    ("settings.server", "Serveur", "Server"),
    ("settings.about", "À propos", "About"),
    ("settings.version", "Version", "Version"),
    ("settings.logs", "Journaux (à joindre à un signalement)", "Logs (attach them to a report)"),
    ("settings.logs_open", "Ouvrir le dossier", "Open the folder"),
    ("settings.updates_auto", "Chercher les mises à jour", "Check for updates"),
    ("settings.updates_auto_hint", "Au démarrage, toutes les 6 heures au plus", "At startup, every 6 hours at most"),
    ("settings.updates_check", "Chercher maintenant", "Check now"),
    ("settings.updates_none", "Tu as la dernière version ✨", "You have the latest version ✨"),
    ("settings.background", "Démarrage et arrière-plan", "Startup and background"),
    ("settings.keep_running", "Rester lancée à la fermeture de la fenêtre", "Keep running when the window is closed"),
    (
        "settings.keep_running_tray",
        "Dans la zone de notification ; les notifications continuent d'arriver",
        "In the notification area; notifications keep coming",
    ),
    (
        "settings.keep_running_dock",
        "Dans le Dock ; les notifications continuent d'arriver",
        "In the Dock; notifications keep coming",
    ),
    ("settings.start_at_login", "Lancer à l'ouverture de session", "Start at login"),
    ("settings.start_at_login_hint", "Sans ouvrir la fenêtre", "Without opening the window"),
    (
        "settings.start_at_login_failed",
        "Impossible de changer le lancement à l'ouverture de session",
        "Couldn't change starting at login",
    ),
    ("tray.open", "Ouvrir rocket-vibe", "Open rocket-vibe"),
    ("tray.quit", "Quitter", "Quit"),
    ("settings.updates_failed", "Impossible de chercher les mises à jour", "Couldn't check for updates"),
    ("update.available", "rocket-vibe {version} est disponible", "rocket-vibe {version} is available"),
    ("update.install", "Mettre à jour", "Update"),
    ("update.download", "Télécharger", "Download"),
    ("update.notes", "Nouveautés", "What's new"),
    ("update.later", "Plus tard", "Later"),
    ("update.downloading", "Téléchargement… {percent} %", "Downloading… {percent}%"),
    ("update.installed", "Mise à jour installée", "Update installed"),
    ("update.restart", "Redémarrer", "Restart"),
    ("update.failed", "La mise à jour a échoué", "The update failed"),
    ("update.dmg", "Glisse rocket-vibe dans Applications", "Drag rocket-vibe into Applications"),
    ("settings.photo", "Photo", "Photo"),
    ("settings.photo_change", "Changer…", "Change…"),
    ("settings.photo_remove", "Retirer", "Remove"),
    ("settings.name", "Nom", "Name"),
    ("settings.username", "Nom d'utilisateur", "Username"),
    ("settings.email", "E-mail", "Email"),
    ("settings.current_password", "Mot de passe actuel", "Current password"),
    ("settings.code", "Code de vérification", "Verification code"),
    ("settings.code_needed", "Le serveur demande un code de vérification", "The server asks for a verification code"),
    ("settings.save", "Enregistrer", "Save"),
    ("settings.saved", "Enregistré", "Saved"),
    ("settings.save_failed", "Échec de l'enregistrement", "Couldn't save"),
    ("notify.open", "Ouvrir", "Open"),
    ("notify.test_body", "Les notifications fonctionnent ✨", "Notifications work ✨"),
    ("notify.test", "Envoyer une notification de test", "Send a test notification"),
    (
        "notify.test_hint",
        "Rien ne s'affiche ? Vérifie les réglages du système.",
        "Nothing shows? Check the system's settings.",
    ),
    ("notify.system_settings", "Réglages des notifications du système", "System notification settings"),
    ("notify.shown_by", "Affichées par", "Shown by"),
    (
        "notify.backend_server",
        "{name} {version} · réponse depuis la notification : {reply}",
        "{name} {version} · reply from the notification: {reply}",
    ),
    ("notify.reply_yes", "oui", "yes"),
    ("notify.reply_no", "non", "no"),
    ("notify.backend_none", "Aucun serveur de notifications ne répond", "No notification server answers"),
    (
        "notify.backend_windows",
        "Notifications de Windows · réponse depuis la notification : oui",
        "Windows notifications · reply from the notification: yes",
    ),
    (
        "notify.backend_macos",
        "Centre de notifications de macOS · réponse depuis la notification : oui",
        "macOS Notification Center · reply from the notification: yes",
    ),
    ("notify.reply", "Répondre", "Reply"),
    ("notify.reply_placeholder", "Répondre…", "Reply…"),
    ("login.probe_failed", "Pas de Rocket.Chat joignable à cette adresse", "No Rocket.Chat reachable at this address"),
    (
        "login.probe_no_password",
        "Ce serveur n'accepte pas la connexion par mot de passe",
        "This server does not accept password sign-in",
    ),
    ("login.probe_2fa", "double authentification", "two-factor"),
    ("login.probe_e2e", "chiffrement de bout en bout", "end-to-end encryption"),
    ("login.cancel_add", "Revenir à mon compte", "Back to my account"),
    ("settings.accounts", "Comptes", "Accounts"),
    ("settings.add_account", "Ajouter un compte", "Add an account"),
    ("settings.current", "Compte actuel", "Current account"),
    ("message.encrypted_locked", "🔒 Message chiffré", "🔒 Encrypted message"),
    ("e2e.banner", "Ce salon est chiffré de bout en bout.", "This room is end-to-end encrypted."),
    ("e2e.unlock", "Déverrouiller", "Unlock"),
    ("e2e.lock", "Verrouiller", "Lock"),
    ("e2e.title", "Déverrouiller les salons chiffrés", "Unlock encrypted rooms"),
    (
        "e2e.body",
        "Votre mot de passe de chiffrement ouvre votre clé, qui reste en mémoire jusqu'à ce que vous verrouilliez ou quittiez.",
        "Your encryption password opens your key, which stays in memory until you lock or quit.",
    ),
    ("e2e.password", "Mot de passe de chiffrement", "Encryption password"),
    ("e2e.wrong", "Mot de passe de chiffrement incorrect", "Wrong encryption password"),
    ("e2e.no_keys", "Ce compte n'a pas encore de clés de chiffrement", "This account has no encryption keys yet"),
    ("e2e.failed", "Déverrouillage impossible", "Couldn't unlock"),
    ("e2e.read_only", "Déverrouillez le salon pour y écrire.", "Unlock the room to write in it."),
    ("e2e.status", "Chiffrement de bout en bout", "End-to-end encryption"),
    ("e2e.locked", "Verrouillé", "Locked"),
    ("e2e.unlocked", "Déverrouillé", "Unlocked"),
    ("voice.record", "Enregistrer un message vocal", "Record a voice message"),
    ("voice.cancel", "Annuler", "Cancel"),
    ("voice.send", "Envoyer", "Send"),
    ("voice.failed", "Enregistrement impossible : {error}", "Couldn't record: {error}"),
    ("voice.empty", "Rien n'a été enregistré", "Nothing was recorded"),
    ("voice.refused", "Le serveur refuse les messages vocaux", "The server refuses voice messages"),
    ("voice.file_name", "message-vocal", "voice-message"),
    ("message.call", "Appel vidéo", "Video call"),
    ("message.join", "Rejoindre", "Join"),
    ("call.failed", "Impossible de rejoindre l'appel", "Couldn't join the call"),
    ("call.window_title", "Appel vidéo · {room}", "Video call · {room}"),
    ("call.open_browser", "Ouvrir dans le navigateur", "Open in browser"),
    ("call.copy_link", "Copier le lien", "Copy link"),
    ("call.info", "Informations de la réunion", "Meeting information"),
    ("call.link", "Lien de la réunion", "Meeting link"),
    ("call.close", "Fermer", "Close"),
    (
        "call.in_browser",
        "La fenêtre d'appel n'a pas pu s'ouvrir : l'appel s'ouvre dans le navigateur",
        "The call window could not open: the call opens in your browser",
    ),
    ("file.open", "Ouvrir", "Open"),
    ("viewer.copy", "Copier l'image", "Copy image"),
    ("viewer.save", "Enregistrer sous…", "Save as…"),
    ("viewer.open", "Ouvrir avec l'application par défaut", "Open in the default app"),
    ("file.play", "Lire", "Play"),
    ("file.loading", "Téléchargement…", "Downloading…"),
    ("file.failed", "Échec du téléchargement", "Download failed"),
    ("file.downloading", "Téléchargement… {percent} %", "Downloading… {percent}%"),
    ("file.no_app", "Aucune application pour ouvrir ce fichier", "No application to open this file"),
    ("video.fullscreen", "Plein écran", "Fullscreen"),
    (
        "video.unsupported",
        "Format non lisible ici : ouvre-la dans une autre application",
        "Can't play this format here: open it in another application",
    ),
    ("video.open_elsewhere", "Ouvrir dans une autre application", "Open in another application"),
    ("file.saved", "Enregistré dans Téléchargements : {name}", "Saved to Downloads: {name}"),
    ("actions.more", "Actions", "Actions"),
    ("actions.reply", "Répondre", "Reply"),
    ("actions.reply_thread", "Répondre dans un fil", "Reply in thread"),
    ("actions.copy", "Copier", "Copy"),
    ("actions.download", "Télécharger", "Download"),
    ("actions.edit", "Modifier", "Edit"),
    ("actions.delete", "Supprimer", "Delete"),
    ("actions.delete_title", "Supprimer ce message ?", "Delete this message?"),
    ("actions.delete_body", "Il disparaîtra pour tout le monde.", "It will be gone for everyone."),
    ("actions.pin", "Épingler", "Pin"),
    ("actions.save", "Enregistrer", "Save"),
    ("edit.hint", "Échap pour annuler · Entrée pour enregistrer", "Escape to cancel · Enter to save"),
    ("edit.too_late", "Ce message ne peut plus être modifié.", "This message can no longer be edited."),
    ("actions.cancel", "Annuler", "Cancel"),
    ("actions.refused", "Action refusée.", "Action refused."),
    ("actions.copied", "Copié", "Copied"),
    ("actions.pinned", "Message épinglé", "Message pinned"),
    ("actions.unpin", "Désépingler", "Unpin"),
    ("marked.title", "Épinglés et favoris", "Pinned and starred"),
    ("marked.pinned", "Épinglés", "Pinned"),
    ("marked.starred", "Mes favoris", "My starred"),
    ("marked.no_pinned", "Aucun message épinglé ici", "No pinned messages here"),
    ("marked.no_starred", "Aucun favori dans ce salon", "No starred messages in this room"),
    ("marked.attachment", "Pièce jointe", "Attachment"),
    ("marked.not_loaded", "Ce message est trop ancien pour être affiché", "This message is too old to show"),
    ("actions.unpinned", "Message désépinglé", "Message unpinned"),
    ("actions.star", "Ajouter aux favoris", "Star"),
    ("actions.starred", "Message ajouté aux favoris", "Message starred"),
    ("actions.unstar", "Retirer des favoris", "Unstar"),
    ("actions.unstarred", "Message retiré des favoris", "Message unstarred"),
    ("actions.saved", "Enregistré dans Téléchargements", "Saved to Downloads"),
    ("actions.save_failed", "Impossible d'enregistrer ce fichier.", "Couldn't save this file."),
    ("composer.replying", "Réponse à {name}", "Replying to {name}"),
    ("command.only_you", "Visible par toi uniquement", "Only you can see this"),
    ("command.failed", "Commande refusée : {error}", "Command refused: {error}"),
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
