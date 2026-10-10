//! The system's own notifications and app badge on Windows (WinRT toasts,
//! taskbar badge) and macOS (UNUserNotificationCenter, dock badge), where
//! GLib's backends fall short: a tray balloon without clicks on Windows, the
//! deprecated NSUserNotification on macOS. No GTK here: events come back on
//! whatever thread the system uses, and the caller hops to its own.
//!
//! On other systems every call is a no-op and `available` is false.
//!
//! The app's life outside its window lives here too: the Windows
//! notification-area icon and single instance, the macOS dock's reopen, and
//! starting at login on both.

/// What the user did with a notification: opened it, answered from it,
/// reacted to its message, or marked its room read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Event {
    Open { room: String, message: String },
    Reply { room: String, message: String, text: String },
    React { room: String, message: String, shortcode: String },
    MarkRead { room: String, message: String },
}

pub type Handler = Box<dyn Fn(Event) + Send + Sync>;

/// One notification per room: a newer one replaces it.
#[derive(Default)]
pub struct Toast<'a> {
    pub room: &'a str,
    pub message: &'a str,
    pub title: &'a str,
    pub body: &'a str,
    /// The registered app protocol can launch a stopped process for a click.
    pub activation_link: Option<&'a str>,
    /// Offer an inline reply field.
    pub reply: Option<ReplyLabels<'a>>,
    /// The conversation, as a header grouping its toasts in the Action Center (Windows).
    pub header: Option<&'a str>,
    /// Local files as `file:` URIs: the author's photo, shown round, and the
    /// message's picture (Windows reads no remote image for an unpackaged app).
    pub avatar: Option<&'a str>,
    pub image: Option<&'a str>,
    /// Buttons that act without opening the app (Windows).
    pub quick: Option<QuickActions<'a>>,
    /// The app plays its own sound: the system's stays quiet (Windows).
    pub silent: bool,
}

#[derive(Clone, Copy)]
pub struct ReplyLabels<'a> {
    pub placeholder: &'a str,
    pub send: &'a str,
}

/// Reactions as (glyph, shortcode), and the mark-as-read button's label.
#[derive(Clone, Copy)]
pub struct QuickActions<'a> {
    pub reactions: &'a [(&'a str, &'a str)],
    pub mark_read: &'a str,
}

/// A toast's quick reactions, in its button row. Codes of the server's
/// emoji list, which `chat.react` requires.
pub const QUICK_REACTIONS: [(&str, &str); 3] = [("👍", ":+1:"), ("❤️", ":heart:"), ("😂", ":joy:")];

/// What the tray icon, the dock or a second launch asks of the running app.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AppEvent {
    Show,
    Quit,
    /// A link handed over by a second launch.
    Open(String),
}

/// Called on the main thread.
pub type AppHandler = std::rc::Rc<dyn Fn(AppEvent)>;

/// The tray icon's menu.
pub struct TrayLabels<'a> {
    pub open: &'a str,
    pub quit: &'a str,
}

/// Where the inline video player lets a navigation go.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Go {
    Allow,
    /// Cancelled in the player, opened in the browser.
    Browser,
    Block,
}

/// (address, main frame, followed link) → where it goes.
pub type Decide = fn(&str, bool, bool) -> Go;

/// A rectangle of the window, in its logical pixels from its top-left corner.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// The macOS launch agent's label.
pub const LOGIN_ENTRY: &str = "com.rocketvibe.app";

/// The option that starts the app without its window.
pub const BACKGROUND_FLAG: &str = "--background";

#[cfg(windows)]
mod windows_call;
#[cfg(windows)]
mod windows_impl;
#[cfg(windows)]
mod windows_player;
#[cfg(windows)]
mod windows_shell;
#[cfg(windows)]
mod windows_toast;
#[cfg(windows)]
pub use windows_call::call_window;
#[cfg(windows)]
pub use windows_impl::{available, badge, delivered, init, set_window, show, withdraw};
#[cfg(windows)]
pub use windows_player::{Player, player};
#[cfg(windows)]
pub use windows_shell::{app_events, autostart, autostart_supported, claim_instance, set_autostart, tray};

#[cfg(target_os = "macos")]
mod macos_call;
#[cfg(target_os = "macos")]
mod macos_impl;
#[cfg(target_os = "macos")]
mod macos_player;
#[cfg(target_os = "macos")]
mod macos_shell;
#[cfg(target_os = "macos")]
pub use macos_call::call_window;
#[cfg(target_os = "macos")]
pub use macos_impl::{available, badge, delivered, init, set_window, show, withdraw};
#[cfg(target_os = "macos")]
pub use macos_player::{Player, player};
#[cfg(target_os = "macos")]
pub use macos_shell::{app_events, autostart, autostart_supported, claim_instance, set_autostart, tray};

#[cfg(not(any(windows, target_os = "macos")))]
mod other {
    use super::{AppHandler, Handler, Toast, TrayLabels};

    pub fn app_events(_handler: AppHandler) {}
    pub fn claim_instance(_args: &[String]) -> bool {
        true
    }
    pub fn tray(_labels: Option<TrayLabels>) {}
    pub fn autostart_supported() -> bool {
        false
    }
    pub fn autostart() -> bool {
        false
    }
    pub fn set_autostart(_on: bool) -> Result<(), String> {
        Err("not supported here".to_owned())
    }

    pub fn init(_app_id: &str, _display_name: &str, _handler: Handler) {}
    pub fn available() -> bool {
        false
    }
    pub fn show(_toast: &Toast) {}
    pub fn withdraw(_room: &str) {}
    pub fn badge(_count: i64, _dot: bool) {}
    pub fn delivered() -> Option<usize> {
        None
    }
    pub fn set_window(_hwnd: isize) {}
    pub fn call_window(_url: &str, _title: &str, _allowed: fn(&str, &str) -> bool) -> Result<(), String> {
        Err("no call window here".to_owned())
    }
}
#[cfg(not(any(windows, target_os = "macos")))]
pub use other::{
    app_events, autostart, autostart_supported, available, badge, call_window, claim_instance, delivered, init,
    set_autostart, set_window, show, tray, withdraw,
};

/// Whether the system holds notifications back now (Windows only), so the
/// app keeps its own notification sound quiet too.
#[cfg(windows)]
pub use windows_impl::quiet;
#[cfg(not(windows))]
pub fn quiet() -> bool {
    false
}

/// The smoke run's stand-in for a keyboard layout change (Windows only).
#[cfg(windows)]
pub use windows_impl::input_language_changed;
#[cfg(not(windows))]
pub fn input_language_changed() {}

/// What the call window does, in the log, for the smoke run to read.
#[cfg(any(windows, target_os = "macos"))]
pub(crate) fn call_event(what: &str, detail: &str) {
    println!("native: call {what} {detail}");
}

#[cfg(any(windows, target_os = "macos"))]
pub(crate) fn player_event(what: &str, detail: &str) {
    println!("native: player {what} {detail}");
}

/// What a second launch asks of the first, from its arguments (one per line):
/// the link it was started with, else the window, unless it was a start at
/// login, which leaves the running app as it is.
pub fn forwarded(args: &str) -> Option<AppEvent> {
    match args.lines().find(|a| a.starts_with("rocketvibe:")) {
        Some(link) => Some(AppEvent::Open(link.to_owned())),
        None if args.lines().any(|a| a == BACKGROUND_FLAG || notification_flag(a)) => None,
        None => Some(AppEvent::Show),
    }
}

fn notification_flag(arg: &str) -> bool {
    arg.eq_ignore_ascii_case("-ToastActivated") || arg.eq_ignore_ascii_case("-Embedding")
}

/// COM delivers the toast arguments and input to its callback, not on the
/// command line. Remove the server launch switches before GTK parses options.
pub fn take_notification_flags(args: &mut Vec<String>) {
    args.retain(|arg| !notification_flag(arg));
}

/// The Windows `Run` command starting `exe` at login.
pub fn run_command(exe: &str) -> String {
    format!("\"{exe}\" {BACKGROUND_FLAG}")
}

/// The `.app` bundle an executable runs from.
pub fn bundle_of(exe: &std::path::Path) -> Option<std::path::PathBuf> {
    exe.ancestors().find(|p| p.extension().is_some_and(|e| e == "app")).map(std::path::Path::to_path_buf)
}

/// A macOS launch agent opening `bundle` in the background at login.
pub fn launch_agent(bundle: &str) -> String {
    let arguments = ["/usr/bin/open", "-g", "-a", bundle, "--args", BACKGROUND_FLAG]
        .iter()
        .map(|a| format!("\t\t<string>{}</string>\n", xml_escape(a)))
        .collect::<String>();
    format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n\
         <!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n\
         <plist version=\"1.0\">\n<dict>\n\
         \t<key>Label</key>\n\t<string>{LOGIN_ENTRY}</string>\n\
         \t<key>ProgramArguments</key>\n\t<array>\n{arguments}\t</array>\n\
         \t<key>RunAtLoad</key>\n\t<true/>\n\
         </dict>\n</plist>\n"
    )
}

/// A badge's number: empty when there is none to show, capped at "99+".
pub fn badge_text(count: i64) -> String {
    match count {
        ..=0 => String::new(),
        100.. => "99+".to_owned(),
        n => n.to_string(),
    }
}

/// Toast arguments carry the room and the message, `|`-separated; ids never hold one.
pub fn encode(room: &str, message: &str) -> String {
    format!("{room}|{message}")
}

pub fn decode(arguments: &str) -> Option<(String, String)> {
    let (room, message) = arguments.split_once('|')?;
    (!room.is_empty()).then(|| (room.to_owned(), message.to_owned()))
}

/// A quick action's arguments: the toast's, then `react|<shortcode>` or `read`.
fn quick_arguments(room: &str, message: &str, action: &str) -> String {
    format!("{}|{action}", encode(room, message))
}

/// What a toast activation means, from its arguments and the reply typed (if
/// any): `room|message` opens or answers, `room|message|react|:code:` reacts,
/// `room|message|read` marks read. Anything else is refused.
pub fn activation(arguments: &str, reply: Option<String>) -> Option<Event> {
    let (room, rest) = arguments.split_once('|')?;
    let mut parts = rest.splitn(3, '|');
    let message = parts.next().filter(|m| !m.is_empty() && !room.is_empty())?;
    let (room, message) = (room.to_owned(), message.to_owned());
    match (parts.next(), parts.next()) {
        (None, None) => Some(match reply.filter(|text| !text.trim().is_empty()) {
            Some(text) => Event::Reply { room, message, text },
            None => Event::Open { room, message },
        }),
        (Some("read"), None) => Some(Event::MarkRead { room, message }),
        (Some("react"), Some(code))
            if code.len() > 2 && code.starts_with(':') && code.ends_with(':') && !code.contains('|') =>
        {
            Some(Event::React { room, message, shortcode: code.to_owned() })
        }
        _ => None,
    }
}

/// XML text, escaped.
pub fn xml_escape(text: &str) -> String {
    text.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;").replace('\'', "&apos;")
}

/// A Windows toast: a header naming the conversation, title, body, the
/// author's round photo and the message's picture; then when asked a reply
/// box and its button, quick reactions and mark as read (five buttons at
/// most, Windows' limit), and the system's sound or silence.
pub fn toast_xml(toast: &Toast) -> String {
    let callback = xml_escape(&encode(toast.room, toast.message));
    let launch = toast.activation_link.map(xml_escape).unwrap_or_else(|| callback.clone());
    let activation = if toast.activation_link.is_some() { " activationType=\"protocol\"" } else { "" };
    let header = toast.header.map_or_else(String::new, |title| {
        format!(
            "<header id=\"{}\" title=\"{}\" arguments=\"{launch}\"{activation}/>",
            xml_escape(&tag(toast.room)),
            xml_escape(title)
        )
    });
    let mut images = String::new();
    if let Some(avatar) = toast.avatar {
        images +=
            &format!("<image placement=\"appLogoOverride\" hint-crop=\"circle\" src=\"{}\"/>", xml_escape(avatar));
    }
    if let Some(image) = toast.image {
        images += &format!("<image src=\"{}\"/>", xml_escape(image));
    }
    let mut actions = String::new();
    if let Some(labels) = &toast.reply {
        actions += &format!(
            "<input id=\"reply\" type=\"text\" placeHolderContent=\"{}\"/>\
             <action content=\"{}\" arguments=\"{callback}\" activationType=\"foreground\" hint-inputId=\"reply\"/>",
            xml_escape(labels.placeholder),
            xml_escape(labels.send),
        );
    }
    if let Some(quick) = &toast.quick {
        let button = |content: &str, action: &str| {
            format!(
                "<action content=\"{}\" arguments=\"{}\" activationType=\"foreground\"/>",
                xml_escape(content),
                xml_escape(&quick_arguments(toast.room, toast.message, action))
            )
        };
        // Mark as read keeps its place: the reactions share what is left.
        let room = 5 - usize::from(toast.reply.is_some()) - 1;
        for (glyph, shortcode) in quick.reactions.iter().take(room) {
            actions += &button(glyph, &format!("react|{shortcode}"));
        }
        actions += &button(quick.mark_read, "read");
    }
    let actions = if actions.is_empty() { actions } else { format!("<actions>{actions}</actions>") };
    let audio = if toast.silent { "<audio silent=\"true\"/>" } else { "" };
    format!(
        "<toast launch=\"{launch}\"{activation}>{header}<visual><binding template=\"ToastGeneric\">\
         <text>{}</text><text>{}</text>{images}</binding></visual>{actions}{audio}</toast>",
        xml_escape(toast.title),
        xml_escape(toast.body),
    )
}

/// A toast tag names the room: at most 64 chars, so a long id is hashed.
pub fn tag(room: &str) -> String {
    if room.len() <= 64 {
        return room.to_owned();
    }
    let hash = room.bytes().fold(0xcbf29ce484222325u64, |h, b| (h ^ b as u64).wrapping_mul(0x100000001b3));
    format!("{hash:016x}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn arguments_round_trip() {
        assert_eq!(decode(&encode("r1", "m1")), Some(("r1".into(), "m1".into())));
        assert_eq!(decode("nothing"), None);
        assert_eq!(decode("|m"), None);
    }

    #[test]
    fn activations_name_the_action() {
        let (room, message) = (String::from("r1"), String::from("m1"));
        assert_eq!(activation("r1|m1", None), Some(Event::Open { room: room.clone(), message: message.clone() }));
        assert_eq!(
            activation("r1|m1", Some("  ".into())),
            Some(Event::Open { room: room.clone(), message: message.clone() })
        );
        assert_eq!(
            activation("r1|m1", Some("hi".into())),
            Some(Event::Reply { room: room.clone(), message: message.clone(), text: "hi".into() })
        );
        assert_eq!(
            activation("r1|m1|react|:+1:", Some("typed".into())),
            Some(Event::React { room: room.clone(), message: message.clone(), shortcode: ":+1:".into() })
        );
        assert_eq!(activation("r1|m1|read", None), Some(Event::MarkRead { room, message }));
        for refused in
            ["", "r1", "|m1", "r1|", "r1|m1|x", "r1|m1|read|x", "r1|m1|react|+1", "r1|m1|react|::", "r1|m1|react"]
        {
            assert_eq!(activation(refused, None), None, "{refused}");
        }
    }

    #[test]
    fn a_rich_toast_groups_shows_pictures_and_offers_quick_buttons() {
        let quick = QuickActions { reactions: &QUICK_REACTIONS, mark_read: "Mark as read" };
        let toast = Toast {
            room: "r",
            message: "m",
            title: "bob",
            body: "look",
            header: Some("#general & co"),
            avatar: Some("file:///C:/cache/a.png"),
            image: Some("file:///C:/cache/b%20c.png"),
            reply: Some(ReplyLabels { placeholder: "Reply", send: "Send" }),
            quick: Some(quick),
            silent: true,
            ..Default::default()
        };
        let xml = toast_xml(&toast);
        assert!(xml.contains("<header id=\"r\" title=\"#general &amp; co\" arguments=\"r|m\"/>"));
        assert!(
            xml.contains("<image placement=\"appLogoOverride\" hint-crop=\"circle\" src=\"file:///C:/cache/a.png\"/>")
        );
        assert!(xml.contains("<image src=\"file:///C:/cache/b%20c.png\"/></binding>"));
        assert!(xml.contains("<action content=\"👍\" arguments=\"r|m|react|:+1:\" activationType=\"foreground\"/>"));
        assert!(
            xml.contains("<action content=\"Mark as read\" arguments=\"r|m|read\" activationType=\"foreground\"/>")
        );
        assert_eq!(xml.matches("<action ").count(), 5, "Windows shows five buttons at most");
        assert!(xml.ends_with("</actions><audio silent=\"true\"/></toast>"));
        // Without a reply box, the reactions still leave room for mark as read.
        let plain = toast_xml(&Toast { reply: None, silent: false, ..toast });
        assert_eq!(plain.matches("<action ").count(), 4);
        assert!(!plain.contains("<audio"));
        let protocol = toast_xml(&Toast {
            room: "r",
            message: "m",
            header: Some("x"),
            activation_link: Some("rocketvibe://notification?key=r&msg=m"),
            ..Default::default()
        });
        assert!(
            protocol.contains("arguments=\"rocketvibe://notification?key=r&amp;msg=m\" activationType=\"protocol\"/>")
        );
    }

    #[test]
    fn toast_xml_escapes_and_offers_a_reply() {
        let toast = Toast {
            room: "r",
            message: "m",
            title: "bob <3",
            body: "a & b",
            activation_link: None,
            reply: Some(ReplyLabels { placeholder: "Reply", send: "Send" }),
            ..Default::default()
        };
        let xml = toast_xml(&toast);
        assert!(xml.contains("<text>bob &lt;3</text><text>a &amp; b</text>"));
        assert!(xml.contains("launch=\"r|m\""));
        assert!(xml.contains("hint-inputId=\"reply\""));
        let plain = toast_xml(&Toast { reply: None, ..toast });
        assert!(!plain.contains("<actions>"));
        let native = toast_xml(&Toast { activation_link: Some("rocketvibe://notification?key=scope&msg=m"), ..toast });
        assert!(
            native.contains("launch=\"rocketvibe://notification?key=scope&amp;msg=m\" activationType=\"protocol\"")
        );
        assert!(native.contains("arguments=\"r|m\" activationType=\"foreground\""));
    }

    #[test]
    fn a_second_launch_forwards_its_link() {
        assert_eq!(
            forwarded("C:\\app.exe\nrocketvibe://room/r1?host=x"),
            Some(AppEvent::Open("rocketvibe://room/r1?host=x".into()))
        );
        assert_eq!(forwarded("C:\\app.exe"), Some(AppEvent::Show));
        assert_eq!(forwarded("C:\\app.exe\n--background"), None);
        assert_eq!(forwarded("C:\\app.exe\n-ToastActivated\n-Embedding"), None);
        let mut args = vec!["app.exe".into(), "-ToastActivated".into(), "-Embedding".into(), "--background".into()];
        take_notification_flags(&mut args);
        assert_eq!(args, ["app.exe", "--background"]);
    }

    #[test]
    fn login_entries_start_in_the_background() {
        assert_eq!(run_command("C:\\a b\\x.exe"), "\"C:\\a b\\x.exe\" --background");
        let plist = launch_agent("/Applications/R & V.app");
        assert!(plist.contains("<string>com.rocketvibe.app</string>"));
        assert!(plist.contains("<string>/Applications/R &amp; V.app</string>\n\t\t<string>--args</string>\n\t\t<string>--background</string>"));
        assert!(plist.contains("<key>RunAtLoad</key>\n\t<true/>"));
    }

    #[test]
    fn the_bundle_is_found_from_the_executable() {
        let exe = std::path::Path::new("/Applications/rocket-vibe.app/Contents/MacOS/rocket-vibe-gtk");
        assert_eq!(bundle_of(exe), Some(std::path::PathBuf::from("/Applications/rocket-vibe.app")));
        assert_eq!(bundle_of(std::path::Path::new("/usr/bin/rocket-vibe-gtk")), None);
    }

    #[test]
    fn badge_numbers_are_capped() {
        assert_eq!(badge_text(0), "");
        assert_eq!(badge_text(7), "7");
        assert_eq!(badge_text(100), "99+");
    }

    #[test]
    fn tags_stay_short() {
        assert_eq!(tag("GENERAL"), "GENERAL");
        assert_eq!(tag(&"x".repeat(80)).len(), 16);
    }
}
