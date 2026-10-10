//! Unattended end-to-end run, driven by environment variables:
//!   RV_SMOKE_LOGIN  "server|user|password"
//!   RV_SMOKE_KIND   `kchat`: server type chosen before filling (server and user may stay empty)
//!   RV_SMOKE_ROOM   room name to open once the room list is loaded
//!   RV_SMOKE_SEND   text to send in that room
//!   RV_SMOKE_SHOT   PNG path; the window is rendered after RV_SMOKE_DELAY_MS, then the app quits
//!   RV_SMOKE_EXPECT        `|`-separated texts the open room must show by then
//!   RV_SMOKE_EXPECT_ABSENT `|`-separated texts it must NOT show
//!   RV_SMOKE_SIZE          `WIDTHxHEIGHT` of the window
//!   RV_SMOKE_NATIVE=1      asserts the native provider in the existing chat UI
//!   RV_SMOKE_QUOTES=1      checks native references through the existing reply bar and composer
//!   RV_SMOKE_COMPOSER=1    checks the composer: no window handle around it, a scrollbar
//!                          only once it overflows, one line high when short
//!   RV_SMOKE_ACTIONS=<tag>  reacts to bob's last message, quotes it, edits my last one,
//!                          replies in a thread, then opens the actions menu, reacts through its
//!                          emoji picker and opens the menu again (RV_SMOKE_MENU_SHOT: a PNG of
//!                          it); texts carry <tag>
//!   RV_SMOKE_DRAFTS=<other room>  completes `@bo` and `:smil`, leaves a draft, opens the
//!                          other room and comes back: the draft must be restored
//!   RV_SMOKE_COMMANDS=<tag>  completes `/shr`, runs `/join` on a missing channel (the
//!                          server's private answer must show), then sends `/shrug <tag>`
//!   RV_SMOKE_FILES=1       fetches every file attached in the room to the local cache
//!   RV_SMOKE_JOIN_VOICE=<n>  RocketVibe: joins the room's voice session as the header's call
//!                          button does (ringing in a direct room), then checks it connected
//!                          with n people in it
//!   RV_SMOKE_VIDEO=1         with RV_SMOKE_JOIN_VOICE: then turns the camera on and shares the
//!                          screen, and checks a card shows a camera and the stage a screen
//!                          (RV_VOICE_FAKE_VIDEO=pattern without devices); `camera`: the camera
//!                          only, and no stage; `picker`, `menu`: opens the share picker or the
//!                          microphone's menu, for a screenshot; `again`: leaves, then joins
//!                          again from the page's Join button; `fullscreen`: shares, then the
//!                          stage full screen must show it; `declined`: a direct call the
//!                          other side declines must hang up
//!   RV_SMOKE_UPLOAD="<path>|<caption>"  stages the file in the composer, types the caption and
//!                          sends (RV_SMOKE_UPLOAD_HOLD=1: left staged, for a screenshot)
//!   RV_SMOKE_SPOTLIGHT=<query>  finds a channel, joins it and opens it
//!   RV_SMOKE_REPORT, RV_SMOKE_ADMIN  members' reports and the administration: see `admin`
//!   RV_SMOKE_DETAILS=profile:<user> | room | search:<text> | settings | emoji:<code> | marked
//!                          | threads | jump:<message id> | permissions:<expected, comma-separated>
//!                          checks the read and opens the dialog; emoji: a custom one completes;
//!                          threads: follows the newest thread and back, then opens it;
//!                          unread: marks the open room read, then unread (it is left and
//!                          stays unread), then read from the list, then opens it again
//!   RV_SMOKE_NOTIFY=<reply>  stands in for the desktop's notification server (inline reply
//!                          included), answers the first notification with <reply>, then clicks
//!                          it: its room must open on that message (`-`: a server without inline
//!                          reply, whose Reply button must open it the same way)
//!   RV_SMOKE_SECOND="<user>|<password>"  adds a second account on the same server,
//!                          then switches back to the first
//!   RV_SMOKE_E2E=<password>  unlocks encrypted rooms (a wrong one first must be refused)
//!   RV_SMOKE_VOICE=1       records two seconds (RV_AUDIO_SOURCE picks the source) and sends them
//!   RV_SMOKE_REENTER=1     after opening the room: back to the list, tap the same room, expect it open
//!   RV_SMOKE_EDIT=<tag>    sends "<tag> before", presses Up, types "<tag> after" in the row
//!                          and saves after RV_SMOKE_EDIT_SAVE_MS (default 3000)
//!   RV_SMOKE_REACT=<code>  reacts with <code> to the latest message from someone else: its row
//!                          must neither leave the screen nor move while the reaction lands
//!   RV_SMOKE_PAGING=1     scrolls to the top: an older page loads and the row that was on top
//!                          stays on screen
//!   RV_SMOKE_JUMP=1       scrolls to the top: the button back to the latest message shows, and
//!                          a click on it (after RV_SMOKE_JUMP_CLICK_MS, default 1500) pins the list again
//!   RV_SMOKE_FOLD=1       folds the channels section: its rooms leave the list, then come back
//!                          (`keep`: left folded, for a screenshot)
//!   RV_SMOKE_VIDEO=1      plays the last video card built; it must be playing, controls shown
//!   RV_SMOKE_PLAYER=1     plays the last YouTube, Dailymotion or Vimeo card built, in the card;
//!                          with the gallery, `<provider>:<id>` plays that video in a frame of its own
//!   RV_SMOKE_PLAYER_LEAVE=<other room>  with RV_SMOKE_PLAYER=1: scrolls away and back, the
//!                          video must still play in its card; then opens the other room, and no
//!                          card may still show its player
//!   RV_SMOKE_DRAFT_TEXT=<text>  typed in the composer (\n breaks lines), for a screenshot
//!   RV_SMOKE_NAV=<other room>  opens the other room, then mouse back and forward between the two;
//!                          in a narrow window, back to the list and forward into the room again
//!   RV_SMOKE_GALLERY=1     sample messages and a composer, no server: see `gallery`
//!   RV_SMOKE_AUTOSTART=on|off  sets starting at login, prints the result and exits
//!   RV_SMOKE_SOAK=<secs>   with the gallery: rows, toasts and badges churned that long: see `soak`
//!   RV_SMOKE_LOG_FLOOD=<n> with the gallery: the same GLib critical n times, then another message
//!   RV_SMOKE_MEDIA=<files> with the gallery: `|`-separated audio and video files, each must play
//!   RV_SMOKE_IME=1         with the gallery (Windows): the composer focused, three keyboard layout
//!                          changes, then typing (`unpinned`: without pinning the input method)
//!   RV_SMOKE_CALL=<url>    with the gallery: the call window opened on <url>
//!   RV_SMOKE_UPDATE=1      the update card must offer a newer release (RV_SMOKE_UPDATE_FROM plays an
//!                          older version); `install`: its Update button must replace the binary,
//!                          which must still be found to restart
//! A failed expectation makes the process exit with status 1.

use std::cell::Cell;
use std::rc::Rc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use adw::prelude::*;
use gtk::glib;

use crate::window::AppWindow;

mod admin;
mod email_factor;
mod email_settings;
mod native_crypto;
mod native_files;
mod native_quotes;
mod native_reads;
mod room_management;
mod security;

static FAILED: AtomicBool = AtomicBool::new(false);

thread_local! {
    static SMOKE_WINDOW: std::cell::RefCell<std::rc::Weak<AppWindow>> = std::cell::RefCell::default();
}

pub fn failed() -> bool {
    FAILED.load(Ordering::SeqCst)
}

fn list(var: &str) -> Vec<String> {
    std::env::var(var).unwrap_or_default().split('|').filter(|s| !s.is_empty()).map(str::to_owned).collect()
}

/// `RV_SMOKE_AUTOSTART=on|off`: sets starting at login that way, says what
/// the system now has, and exits.
pub fn autostart() -> Option<glib::ExitCode> {
    let wanted = match std::env::var("RV_SMOKE_AUTOSTART").ok()?.as_str() {
        "on" => true,
        "off" => false,
        _ => return None,
    };
    let set = rv_native::set_autostart(wanted);
    let now = rv_native::autostart();
    println!("smoke: autostart supported {} set {set:?} now {now}", rv_native::autostart_supported());
    Some(if set.is_ok() && now == wanted { glib::ExitCode::SUCCESS } else { glib::ExitCode::FAILURE })
}

pub fn install_early() {
    if let Ok(reply) = std::env::var("RV_SMOKE_NOTIFY")
        && !reply.is_empty()
    {
        fake_notification_server(reply);
    }
}

pub fn install(window: &Rc<AppWindow>) {
    SMOKE_WINDOW.with_borrow_mut(|w| *w = Rc::downgrade(window));
    security::install(window);
    admin::install(window);
    room_management::install(window);
    native_reads::install(window);
    native_quotes::install(window);
    native_files::install(window);
    native_crypto::install(window);
    email_factor::install(window);
    email_settings::install(window);
    let login = std::env::var("RV_SMOKE_LOGIN").unwrap_or_default();
    let room = std::env::var("RV_SMOKE_ROOM").unwrap_or_default();
    let text = std::env::var("RV_SMOKE_SEND").unwrap_or_default();
    let shot = std::env::var("RV_SMOKE_SHOT").unwrap_or_default();
    let parts: Vec<String> = login.split('|').map(str::to_owned).collect();
    let server = parts.first().cloned().unwrap_or_default();
    if let Ok(path) = std::env::var("RV_SMOKE_FACTOR_FILE") {
        factor_flow(window, &path);
    }
    if let Some((w, h)) = std::env::var("RV_SMOKE_SIZE").ok().and_then(|s| {
        let (w, h) = s.split_once('x')?;
        Some((w.parse().ok()?, h.parse().ok()?))
    }) {
        window.window.set_default_size(w, h);
    }

    if parts.len() == 3 {
        let weak = Rc::downgrade(window);
        let tried = Rc::new(Cell::new(false));
        window.connect_login_shown(move || {
            let Some(w) = weak.upgrade() else { return };
            if !tried.replace(true) {
                if std::env::var("RV_SMOKE_KIND").as_deref() == Ok("kchat") {
                    w.login.set_server_kind(rv_core::native::ServerKind::Kchat);
                }
                w.login.fill(&parts[0], &parts[1], &parts[2]);
                if let Ok(action) = std::env::var("RV_SMOKE_EMAIL_RECOVERY_FORM") {
                    let requested = Rc::new(Cell::new(false));
                    let mut polls = 0;
                    glib::timeout_add_local(Duration::from_millis(250), move || {
                        polls += 1;
                        if w.login.recovery_code().is_none() {
                            w.login.fill_recovery("");
                        }
                        if let Some(view) = w.login.recovery_email_view() {
                            if action == "request" && !requested.get() {
                                requested.set(w.login.request_recovery_email());
                            } else if action != "request" || view.accepted {
                                w.login.focus_recovery_email();
                                check(
                                    "recovery form keeps received code empty",
                                    w.login.code().is_empty() && w.login.recovery_code().as_deref() == Some(""),
                                    polls,
                                );
                                check(
                                    "recovery mail does not activate an account",
                                    crate::secrets::active().is_none(),
                                    polls,
                                );
                                return glib::ControlFlow::Break;
                            }
                        }
                        if polls >= 80 {
                            check("anonymous recovery form is available", false, polls);
                            return glib::ControlFlow::Break;
                        }
                        glib::ControlFlow::Continue
                    });
                    return;
                }
                let recovering = std::env::var_os("RV_SMOKE_RECOVERY_FILE").is_some();
                if let Ok(path) =
                    std::env::var("RV_SMOKE_RECOVERY_FILE").or_else(|_| std::env::var("RV_SMOKE_INVITATION_FILE"))
                {
                    let data: serde_json::Value =
                        serde_json::from_str(&std::fs::read_to_string(path).expect("pilot invitation file"))
                            .expect("pilot invitation JSON");
                    let token = data["token"].as_str().expect("pilot invitation token").to_owned();
                    let mut polls = 0;
                    glib::timeout_add_local(Duration::from_millis(250), move || {
                        polls += 1;
                        if if recovering { w.login.fill_recovery(&token) } else { w.login.fill_invitation(&token) } {
                            w.submit_login();
                            return glib::ControlFlow::Break;
                        }
                        if polls >= 40 {
                            check("account-code form offered by native discovery", false, polls);
                            return glib::ControlFlow::Break;
                        }
                        glib::ControlFlow::Continue
                    });
                } else {
                    glib::idle_add_local_once(move || w.submit_login());
                }
            }
        });
    }

    if let Some((user, password)) = std::env::var("RV_SMOKE_SECOND").ok().and_then(|s| {
        let (u, p) = s.split_once('|')?;
        Some((u.to_owned(), p.to_owned()))
    }) && !server.is_empty()
    {
        second_account(window, server, user, password);
    }

    let native = std::env::var("RV_SMOKE_NATIVE").as_deref() == Ok("1");
    if !room.is_empty() {
        let weak = Rc::downgrade(window);
        let opened = Rc::new(Cell::new(false));
        window.chat.connect_rooms_loaded(move || {
            let Some(w) = weak.upgrade() else { return };
            if opened.get() {
                return;
            }
            let Some(rid) = w.chat.room_named(&room) else { return };
            opened.set(true);
            w.chat.open_room(&rid);
            if std::env::var("RV_SMOKE_DEVICES").as_deref() == Ok("1") {
                let w = w.clone();
                glib::timeout_add_local_once(Duration::from_millis(1500), move || native_devices_checks(w));
            }
            if std::env::var("RV_SMOKE_COMPOSER").as_deref() == Ok("1") {
                let chat = w.chat.clone();
                glib::timeout_add_local_once(Duration::from_millis(2000), move || composer_checks(chat));
            }
            if let Ok(tag) = std::env::var("RV_SMOKE_ACTIONS")
                && !tag.is_empty()
            {
                let chat = w.chat.clone();
                glib::timeout_add_local_once(Duration::from_millis(3000), move || action_checks(chat, tag));
            }
            if let Ok(other) = std::env::var("RV_SMOKE_DRAFTS")
                && let Some(other) = w.chat.room_named(&other)
            {
                let chat = w.chat.clone();
                let back = rid.clone();
                glib::timeout_add_local_once(Duration::from_millis(2000), move || draft_checks(chat, back, other));
            }
            if let Ok(tag) = std::env::var("RV_SMOKE_COMMANDS")
                && !tag.is_empty()
            {
                let chat = w.chat.clone();
                glib::timeout_add_local_once(Duration::from_millis(3000), move || command_checks(chat, tag));
            }
            if let Ok(expected) = std::env::var("RV_SMOKE_JOIN_VOICE")
                && let Ok(expected) = expected.parse::<usize>()
            {
                let (chat, rid) = (w.chat.clone(), rid.clone());
                glib::timeout_add_local_once(Duration::from_millis(1500), move || {
                    chat.join_voice_now(&rid);
                    glib::timeout_add_local_once(Duration::from_millis(6000), move || {
                        let (connected, people, panel) = chat.voice_summary();
                        check("voice connected", connected, connected);
                        check("voice occupants", people == expected, people);
                        check("voice panel shown", panel, panel);
                        let video = std::env::var("RV_SMOKE_VIDEO").unwrap_or_default();
                        if video == "1" || video == "camera" {
                            let screen = video == "1";
                            chat.voice_video_on(screen);
                            glib::timeout_add_local_once(Duration::from_millis(5000), move || {
                                let (cameras, stage) = chat.voice_video_summary();
                                check("voice camera shown", cameras >= 1, cameras);
                                check("voice screen on stage", stage == screen, stage);
                            });
                        } else if video == "picker" || video == "menu" {
                            chat.voice_open(&video);
                        } else if video == "fullscreen" {
                            // Shares, then shows the stage full screen: a frame must reach it.
                            chat.voice_video_on(true);
                            glib::timeout_add_local_once(Duration::from_millis(5000), move || {
                                chat.voice_fullscreen();
                                glib::timeout_add_local_once(Duration::from_millis(3000), move || {
                                    let (open, framed) = chat.voice_fullscreen_summary();
                                    check("voice full screen open", open, open);
                                    check("voice full screen shows the screen", framed, framed);
                                });
                            });
                        } else if video == "declined" {
                            // A direct call the other side declines (RV_SMOKE_JOIN_VOICE in a DM): it hangs up.
                            glib::timeout_add_local_once(Duration::from_millis(12000), move || {
                                let (connected, ..) = chat.voice_summary();
                                check("voice hung up when declined", !connected, connected);
                            });
                        } else if video == "again" {
                            // Leave, then join again from the page's button.
                            chat.voice_press("leave");
                            glib::timeout_add_local_once(Duration::from_millis(3000), move || {
                                chat.voice_press("join");
                                glib::timeout_add_local_once(Duration::from_millis(6000), move || {
                                    let (connected, ..) = chat.voice_summary();
                                    check("voice joined again", connected, connected);
                                });
                            });
                        }
                    });
                });
            }
            if std::env::var("RV_SMOKE_FILES").as_deref() == Ok("1") {
                let chat = w.chat.clone();
                glib::timeout_add_local_once(Duration::from_millis(2000), move || file_checks(chat));
            }
            if let Ok(spec) = std::env::var("RV_SMOKE_UPLOAD")
                && let Some((path, caption)) = spec.split_once('|')
            {
                let item = crate::attach::Picked { path: path.into(), name: "stripes.png".into(), temporary: false };
                let (chat, caption) = (w.chat.clone(), caption.to_owned());
                glib::timeout_add_local_once(Duration::from_millis(1500), move || {
                    let composer = chat.composer_rc();
                    composer.stage(vec![item]);
                    composer.set_text(&caption);
                    println!("smoke: staged {:?}", composer.staged_names());
                    if std::env::var("RV_SMOKE_UPLOAD_HOLD").as_deref() != Ok("1") {
                        composer.submit_now();
                    }
                });
            }
            if let Ok(query) = std::env::var("RV_SMOKE_SPOTLIGHT")
                && !query.is_empty()
                && let Some(session) = w.chat.session()
            {
                let chat = w.chat.clone();
                glib::timeout_add_local_once(Duration::from_millis(1500), move || {
                    glib::spawn_future_local(async move {
                        let q = query.clone();
                        let found =
                            crate::on_tokio(async move { session.spotlight(&q).await }).await.unwrap_or_default();
                        let room = found
                            .into_iter()
                            .find(|f| matches!(f, rv_core::rooms::Found::Room { name, .. } if *name == query));
                        check("spotlight finds the channel", room.is_some(), &room);
                        if let Some(room) = room {
                            chat.go_to(room);
                        }
                    });
                });
            }
            if native
                && std::env::var("RV_SMOKE_DETAILS").as_deref() == Ok("room")
                && let Some(session) = w.chat.native_session()
            {
                let (chat, rid) = (w.chat.clone(), rid.clone());
                glib::timeout_add_local_once(Duration::from_millis(1500), move || {
                    glib::spawn_future_local(async move {
                        let info = crate::on_tokio(async move { session.room_info(&rid).await }).await;
                        check(
                            "native room info read",
                            info.as_ref().is_ok_and(|i| i.members.is_some()),
                            info.as_ref().map(|i| i.members),
                        );
                        chat.show_room_info();
                    });
                });
            }
            if let Ok(what) = std::env::var("RV_SMOKE_DETAILS")
                && !what.is_empty()
                && let Some(session) = w.chat.session()
            {
                let (chat, rid) = (w.chat.clone(), rid.clone());
                glib::timeout_add_local_once(Duration::from_millis(1500), move || {
                    details_checks(chat, session, rid, what)
                });
            }
            if let Ok(password) = std::env::var("RV_SMOKE_E2E")
                && !password.is_empty()
                && let Some(session) = w.chat.session()
            {
                glib::timeout_add_local_once(Duration::from_millis(1500), move || {
                    glib::spawn_future_local(async move {
                        let s = session.clone();
                        let wrong = crate::on_tokio(async move { s.e2e_unlock("not the password").await }).await;
                        check("wrong E2E password refused", wrong.is_err(), &wrong);
                        let s = session.clone();
                        let right = crate::on_tokio(async move { s.e2e_unlock(&password).await }).await;
                        check("E2E unlocked", right.is_ok(), &right);
                    });
                });
            }
            if std::env::var("RV_SMOKE_VOICE").as_deref() == Ok("1") {
                let chat = w.chat.clone();
                glib::timeout_add_local_once(Duration::from_millis(1500), move || {
                    let composer = chat.composer_rc();
                    composer.start_recording();
                    glib::timeout_add_local_once(Duration::from_millis(2000), move || {
                        println!("smoke: voice recording shown {}", composer.recording());
                        composer.stop_recording(true);
                    });
                });
            }
            if let Ok(other) = std::env::var("RV_SMOKE_NAV")
                && let Some(other) = w.chat.room_named(&other)
            {
                let (chat, first) = (w.chat.clone(), rid.clone());
                glib::timeout_add_local_once(Duration::from_millis(2500), move || nav_checks(chat, first, other));
            }
            if let Ok(tag) = std::env::var("RV_SMOKE_EDIT")
                && !tag.is_empty()
            {
                let chat = w.chat.clone();
                glib::timeout_add_local_once(Duration::from_millis(1500), move || edit_checks(chat, tag));
            }
            if let Ok(draft) = std::env::var("RV_SMOKE_DRAFT_TEXT")
                && !draft.is_empty()
            {
                let composer = w.chat.composer_rc();
                glib::timeout_add_local_once(Duration::from_millis(2000), move || {
                    composer.set_text(&draft.replace("\\n", "\n"))
                });
            }
            if let Ok(mode) = std::env::var("RV_SMOKE_UPDATE")
                && !mode.is_empty()
            {
                let chat = w.chat.clone();
                glib::timeout_add_local_once(Duration::from_millis(6000), move || {
                    update_checks(chat, mode == "install")
                });
            }
            if let Ok(code) = std::env::var("RV_SMOKE_REACT")
                && !code.is_empty()
            {
                let chat = w.chat.clone();
                glib::timeout_add_local_once(Duration::from_millis(4000), move || react_checks(chat, code));
            }
            if std::env::var("RV_SMOKE_PAGING").as_deref() == Ok("1") {
                let list = w.chat.room_list();
                glib::timeout_add_local_once(Duration::from_millis(4000), move || paging_checks(list));
            }
            if std::env::var("RV_SMOKE_JUMP").as_deref() == Ok("1") {
                let list = w.chat.room_list();
                glib::timeout_add_local_once(Duration::from_millis(4000), move || jump_checks(list));
            }
            if matches!(std::env::var("RV_SMOKE_FOLD").as_deref(), Ok("1" | "keep")) {
                let chat = w.chat.clone();
                glib::timeout_add_local_once(Duration::from_millis(2500), move || fold_checks(chat));
            }
            if std::env::var("RV_SMOKE_VIDEO").as_deref() == Ok("1") {
                glib::timeout_add_local_once(Duration::from_millis(5000), || {
                    let started = crate::video::play_last();
                    glib::timeout_add_local_once(Duration::from_millis(2000), move || {
                        let playing = crate::video::last_playing();
                        println!("smoke: video started={started} playing={playing:?}");
                        if playing != Some(true) {
                            FAILED.store(true, Ordering::SeqCst);
                        }
                    });
                });
            }
            if std::env::var("RV_SMOKE_PLAYER").as_deref() == Ok("1") {
                glib::timeout_add_local_once(Duration::from_millis(5000), || {
                    let started = crate::player::play_last();
                    println!("smoke: player started={started}");
                    if !started {
                        FAILED.store(true, Ordering::SeqCst);
                    }
                });
                if let Ok(other) = std::env::var("RV_SMOKE_PLAYER_LEAVE")
                    && let Some(other) = w.chat.room_named(&other)
                {
                    let chat = w.chat.clone();
                    glib::timeout_add_local_once(Duration::from_millis(9000), move || {
                        chat.scroll_list_to_top();
                        glib::timeout_add_local_once(Duration::from_millis(1500), || {
                            println!(
                                "smoke: players scrolled away={} on screen={}",
                                crate::cards::players_shown(),
                                crate::cards::players_mapped()
                            );
                        });
                    });
                    let chat = w.chat.clone();
                    glib::timeout_add_local_once(Duration::from_millis(11000), move || {
                        chat.scroll_list_to_bottom();
                    });
                    let chat = w.chat.clone();
                    glib::timeout_add_local_once(Duration::from_millis(14000), move || {
                        let (shown, mapped) = (crate::cards::players_shown(), crate::cards::players_mapped());
                        println!("smoke: players back={shown} on screen={mapped}");
                        if (shown, mapped) != (1, 1) {
                            FAILED.store(true, Ordering::SeqCst);
                        }
                        chat.open_room(&other);
                        glib::timeout_add_local_once(Duration::from_millis(2000), || {
                            let shown = crate::cards::players_shown();
                            println!("smoke: players after leaving={shown}");
                            if shown != 0 {
                                FAILED.store(true, Ordering::SeqCst);
                            }
                        });
                    });
                }
            }
            if std::env::var("RV_SMOKE_REENTER").as_deref() == Ok("1") {
                let chat = w.chat.clone();
                glib::timeout_add_local_once(Duration::from_millis(2500), move || {
                    chat.go_back();
                    let shown_after_back = chat.shows_room();
                    chat.tap_room(&rid);
                    let reopened = chat.shows_room();
                    println!("smoke: reenter back={shown_after_back} reopened={reopened}");
                    if shown_after_back || !reopened {
                        FAILED.store(true, Ordering::SeqCst);
                    }
                });
            }
            if !text.is_empty() {
                let text = text.clone();
                let chat = w.chat.clone();
                glib::timeout_add_local_once(Duration::from_millis(1500), move || chat.send_text(&text));
            }
        });
    }

    if shot.is_empty() {
        return;
    }
    let delay = std::env::var("RV_SMOKE_DELAY_MS").ok().and_then(|v| v.parse().ok()).unwrap_or(8000);
    let weak = Rc::downgrade(window);
    glib::timeout_add_local_once(Duration::from_millis(delay), move || {
        let Some(w) = weak.upgrade() else { return };
        println!("smoke: rooms {} messages {}", w.chat.room_count(), w.chat.message_count());
        println!("smoke: composer {:?}", w.chat.composer().text());
        println!(
            "smoke: typing {:?} presence {:?} new-marker {} new-pill {}",
            w.chat.typing_text(),
            w.chat.header_presence(),
            w.chat.has_new_marker(),
            w.chat.new_pill_shown()
        );
        let texts = w.chat.message_texts();
        if native {
            check("native session", w.chat.native_session().is_some(), texts.len());
            if let Some(session) = w.chat.native_session() {
                let status = session.status();
                println!(
                    "smoke: native connection {:?}, error {:?}, request {:?}",
                    status.connection, status.error, status.request_id
                );
            }
            if std::env::var("RV_SMOKE_RENDERING").as_deref() == Ok("1") {
                check(
                    "native source reaches existing message widgets",
                    texts
                        .iter()
                        .any(|t| t.contains("Un seul client") && t.contains("@desktop") && t.contains("Rocket.Chat")),
                    texts.len(),
                );
                check(
                    "native code and mention retain their visible text",
                    texts.iter().any(|t| t.contains("Bonjour @desktop") && t.contains("let texte = \"<>&\";")),
                    texts.len(),
                );
                let cached =
                    w.chat.native_session().unwrap().store.messages(&w.chat.current_rid().unwrap(), 10).unwrap();
                check(
                    "native canonical body is persisted",
                    cached.len() == 2 && cached.iter().all(|m| m.body.is_some()),
                    cached.len(),
                );
            }
            if std::env::var_os("RV_SMOKE_INVITATION_FILE").is_some()
                || std::env::var_os("RV_SMOKE_RECOVERY_FILE").is_some()
            {
                check(
                    "account-code form clears transient secrets",
                    w.login.invitation().is_none()
                        && w.login.recovery_code().is_none()
                        && w.login.password().is_empty(),
                    0,
                );
            }
            if w.chat.shows_room() {
                let root = w.chat.composer_rc().root.clone();
                let fits = root
                    .compute_bounds(&w.window)
                    .is_some_and(|r| r.x() >= 0.0 && r.x() + r.width() <= w.window.width() as f32);
                check("composer fits window", fits, root.width() as usize);
            }
        }
        for wanted in list("RV_SMOKE_EXPECT") {
            let found = texts.iter().filter(|t| t.contains(&wanted)).count();
            println!(
                "smoke: expect {wanted:?}: {}",
                if found == 1 { "ok".to_owned() } else { format!("FAILED ({found} found)") }
            );
            if found != 1 {
                FAILED.store(true, Ordering::SeqCst);
            }
        }
        for unwanted in list("RV_SMOKE_EXPECT_ABSENT") {
            let found = texts.iter().any(|t| t.contains(&unwanted));
            println!("smoke: absent {unwanted:?}: {}", if found { "FAILED" } else { "ok" });
            if found {
                FAILED.store(true, Ordering::SeqCst);
            }
        }
        let width = w.window.width();
        let height = w.window.height();
        if std::env::var_os("RV_SMOKE_SECURITY").is_some()
            && find_by_class(w.window.upcast_ref(), "native-security-codes")
                .and_downcast::<gtk::Label>()
                .is_some_and(|codes| !codes.text().is_empty())
        {
            check("private security bag closed before screenshot", false, 0);
            w.window.application().expect("application").quit();
            return;
        }
        let paintable = gtk::WidgetPaintable::new(Some(&w.window));
        let snapshot = gtk::Snapshot::new();
        paintable.snapshot(&snapshot, width as f64, height as f64);
        let saved = snapshot
            .to_node()
            .zip(w.window.renderer())
            .map(|(node, renderer)| renderer.render_texture(&node, None).save_to_png(&shot).is_ok());
        let icon =
            gtk::gdk::Display::default().is_some_and(|d| gtk::IconTheme::for_display(&d).has_icon(crate::APP_ID));
        println!("smoke: app icon found {icon}");
        println!("smoke: screenshot saved {}", saved.unwrap_or(false));
        if native && !saved.unwrap_or(false) {
            FAILED.store(true, Ordering::SeqCst);
        }
        w.window.application().expect("application").quit();
    });
}

/// Only the disposable pilot mounts this private code file. Never print its
/// contents; exercise the actual widgets, HTTP and Secret Service namespace.
fn factor_flow(window: &Rc<AppWindow>, path: &str) {
    let value: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(path).expect("pilot factor file")).expect("pilot factor JSON");
    let backup = value["codes"][0].as_str().expect("pilot backup code").to_owned();
    let weak = Rc::downgrade(window);
    let mut stage = 0;
    let mut polls = 0;
    glib::timeout_add_local(Duration::from_millis(250), move || {
        let Some(w) = weak.upgrade() else {
            return glib::ControlFlow::Break;
        };
        polls += 1;
        if polls > 52 {
            check("native factor flow completed", false, stage);
            return glib::ControlFlow::Break;
        }
        if w.login.is_busy() {
            return glib::ControlFlow::Continue;
        }
        match stage {
            0 if w.login.native_method().is_some() => {
                check("factor form clears transient password", w.login.password().is_empty(), 0);
                stage = 1;
                let w = w.clone();
                glib::spawn_future_local(async move {
                    let accounts = crate::on_tokio(crate::secrets::load_all()).await;
                    check("pre-auth proof excluded from active accounts", accounts.is_empty(), accounts.len());
                    check(
                        "backup method offered in existing form",
                        w.login.fill_factor("recovery_code", "INVALID-BACKUP"),
                        0,
                    );
                    w.submit_login();
                });
            }
            1 if w.login.has_error() && w.login.native_method().is_some() => {
                check("incorrect factor leaves account inactive", w.chat.native_session().is_none(), 0);
                check("backup field accepts retry", w.login.fill_factor("recovery_code", &backup), 0);
                w.submit_login();
                stage = 2;
            }
            2 if w.login.has_error() && w.login.native_method().is_some() => {
                check("lost factor ACK leaves account inactive", w.chat.native_session().is_none(), 0);
                check("durable factor permits blank retry", w.login.fill_factor("recovery_code", ""), 0);
                w.submit_login();
                stage = 3;
            }
            3 if w.chat.native_session().is_some() => {
                check(
                    "factor confirmation clears transient code",
                    w.login.code().is_empty() && w.login.password().is_empty(),
                    0,
                );
                let session = w.chat.native_session().unwrap();
                let info = session.info.clone();
                glib::spawn_future_local(async move {
                    let pending = crate::on_tokio(async move {
                        crate::secrets::authentication_vault().load(&info.base_url, &info.username).await
                    })
                    .await;
                    check("accepted proof cleared after credential commit", matches!(pending, Ok(None)), 0);
                });
                return glib::ControlFlow::Break;
            }
            _ => {}
        }
        glib::ControlFlow::Continue
    });
}

type Check = Box<dyn FnOnce(&Rc<crate::chat::ChatPage>)>;

/// Runs the steps one after another, a beat apart, so the view relayouts between them.
fn in_sequence(chat: std::rc::Rc<crate::chat::ChatPage>, mut steps: std::collections::VecDeque<Check>) {
    let Some(step) = steps.pop_front() else { return };
    step(&chat);
    glib::timeout_add_local_once(Duration::from_millis(40), move || in_sequence(chat, steps));
}

fn composer_state(label: &str, chat: &crate::chat::ChatPage, want_bar: bool, max_height: i32) {
    let (height, bar, offset) = chat.composer().scroll_state();
    let ok = bar == want_bar && height <= max_height && (want_bar || offset == 0.0);
    println!(
        "smoke: composer {label}: {height}px scrollbar={bar} offset={offset} {}",
        if ok { "ok" } else { "FAILED" }
    );
    if !ok {
        FAILED.store(true, Ordering::SeqCst);
    }
}

/// The composer: no window handle around it; typed text that wraps grows it
/// without scrolling; past 160 px it scrolls, with a scrollbar; back to one line.
fn composer_checks(chat: std::rc::Rc<crate::chat::ChatPage>) {
    let handle = chat.composer().in_window_handle();
    println!("smoke: composer in window handle: {handle}");
    if handle {
        FAILED.store(true, Ordering::SeqCst);
    }
    let mut steps: std::collections::VecDeque<Check> = std::collections::VecDeque::new();
    steps.push_back(Box::new(|c| c.composer().set_text("")));
    for i in 0..132 {
        let key = if i % 11 == 10 { " " } else { "a" };
        steps.push_back(Box::new(move |c| c.composer().type_text(key)));
    }
    for _ in 0..5 {
        steps.push_back(Box::new(|_| {}));
    }
    steps.push_back(Box::new(|c| composer_state("two lines typed", c, false, 44)));
    for _ in 0..12 {
        steps.push_back(Box::new(|c| c.composer().type_text("\nanother line")));
    }
    for _ in 0..5 {
        steps.push_back(Box::new(|_| {}));
    }
    steps.push_back(Box::new(|c| composer_state("overflowing", c, true, 170)));
    steps.push_back(Box::new(|c| c.composer().set_text("hi")));
    for _ in 0..5 {
        steps.push_back(Box::new(|_| {}));
    }
    steps.push_back(Box::new(|c| composer_state("one line", c, false, 40)));
    steps.push_back(Box::new(|c| c.composer().set_text(&"aaaaaaaaaa ".repeat(12))));
    in_sequence(chat, steps);
}

/// Plays the message actions the way clicks would, on the latest messages.
fn action_checks(chat: std::rc::Rc<crate::chat::ChatPage>, tag: String) {
    use crate::rows::RowEvent;
    let (Some(session), Some(rid)) = (chat.session(), chat.current_rid()) else { return };
    let rows = session.store.messages(&rid, 200);
    let theirs = rows.iter().rev().find(|r| r.author.as_deref() == Some("bob") && r.system_type.is_none()).cloned();
    let mine = rows.iter().rev().find(|r| r.author_id == session.info.user_id && r.system_type.is_none()).cloned();
    let root = rows.iter().rev().find(|r| r.thread_count > 0).cloned();
    println!(
        "smoke: actions on bob={:?} mine={:?} thread={:?}",
        theirs.as_ref().map(|r| &r.id),
        mine.as_ref().map(|r| &r.id),
        root.as_ref().map(|r| &r.id)
    );
    let Some(theirs) = theirs else { return FAILED.store(true, Ordering::SeqCst) };
    chat.play(RowEvent::React { id: theirs.id.clone(), shortcode: ":+1:".into(), add: true }, false);
    let (picker, target) = (chat.clone(), theirs.clone());
    glib::timeout_add_local_once(Duration::from_millis(4500), move || reaction_checks(picker, target));
    chat.start_quote(theirs.clone());
    let quoted = chat.clone();
    let reply = format!("{tag} reply");
    glib::timeout_add_local_once(Duration::from_millis(800), move || {
        quoted.composer().set_text(&reply);
        quoted.composer().submit_now();
    });
    if let Some(mine) = mine {
        let (s, rid, text) = (session.clone(), rid.clone(), format!("{tag} edited"));
        crate::runtime().spawn(async move {
            let _ = s.edit(&rid, &mine.id, &text).await;
        });
    }
    if let Some(root) = root {
        let (threaded, text) = (chat.clone(), format!("{tag} in thread"));
        glib::timeout_add_local_once(Duration::from_millis(1600), move || {
            threaded.open_thread_of(&root.id);
            glib::timeout_add_local_once(Duration::from_millis(1500), move || {
                if let Some(thread) = threaded.thread() {
                    thread.composer.set_text(&text);
                    thread.composer.submit_now();
                }
            });
        });
    }
    let menu = chat.clone();
    glib::timeout_add_local_once(Duration::from_millis(6500), move || {
        if let Some(thread) = menu.thread() {
            println!("smoke: thread shows {} message(s): {:?}", thread.list.len(), thread.list.texts().last());
        }
    });
}

/// The menu's quick reactions (my most used, then "+"), the picker reacting
/// with any emoji in one pick, and both reactions counted on the device.
fn reaction_checks(chat: Rc<crate::chat::ChatPage>, row: rv_core::store::MessageRow) {
    use crate::rows::RowEvent;
    let Some(session) = chat.session() else { return };
    let anchor: gtk::Widget = chat.widget().clone().upcast();
    let menu = |chat: &Rc<crate::chat::ChatPage>, anchor: &gtk::Widget, row: &rv_core::store::MessageRow| {
        let event =
            RowEvent::Menu { row: Box::new(row.clone()), anchor: anchor.clone(), x: 320.0, y: 240.0, link: None };
        chat.play(event, false);
    };
    menu(&chat, &anchor, &row);
    glib::timeout_add_local_once(Duration::from_millis(1200), move || {
        let quick = find_by_class(&anchor, "quick-reactions");
        let shown = quick.as_ref().map_or(0, |q| {
            std::iter::successors(q.first_child(), |w| w.next_sibling())
                .filter(|w| w.has_css_class("quick-reaction") && !w.has_css_class("more-reactions"))
                .count()
        });
        check("quick reactions: my five, then +", shown == rv_core::emoji_usage::QUICK_COUNT, shown);
        let Some(more) = find_by_class(&anchor, "more-reactions").and_downcast::<gtk::Button>() else {
            return check("more reactions button", false, ());
        };
        more.emit_clicked();
        glib::timeout_add_local_once(Duration::from_millis(800), move || {
            let Some(picker) = find_by_class(&anchor, "reaction-picker").and_downcast::<gtk::Popover>() else {
                return check("reaction picker opens", false, ());
            };
            fn search(widget: &gtk::Widget) -> Option<gtk::SearchEntry> {
                widget.clone().downcast::<gtk::SearchEntry>().ok().or_else(|| {
                    std::iter::successors(widget.first_child(), |w| w.next_sibling()).find_map(|c| search(&c))
                })
            }
            let Some(entry) = search(picker.upcast_ref()) else { return check("picker search", false, ()) };
            entry.set_text("rocket");
            glib::timeout_add_local_once(Duration::from_millis(1000), move || {
                fn rocket(widget: &gtk::Widget) -> Option<gtk::Button> {
                    if widget.has_css_class("picker-emoji") && widget.tooltip_text().as_deref() == Some(":rocket:") {
                        return widget.clone().downcast::<gtk::Button>().ok();
                    }
                    std::iter::successors(widget.first_child(), |w| w.next_sibling()).find_map(|c| rocket(&c))
                }
                let Some(button) = rocket(picker.upcast_ref()) else {
                    return check("picker finds :rocket:", false, ());
                };
                button.emit_clicked();
                check("one pick closes the reaction picker", !picker.is_visible(), ());
                glib::timeout_add_local_once(Duration::from_millis(2500), move || {
                    let rows = session.store.messages(&row.rid, 200);
                    let reacted = rows.iter().find(|r| r.id == row.id).is_some_and(|r| {
                        rv_core::actions::reactions(r.reactions.as_deref(), &session.info.username)
                            .iter()
                            .any(|r| r.mine && r.shortcode == ":rocket:")
                    });
                    check("picked emoji reacted", reacted, ());
                    let host = url::Url::parse(&session.info.base_url)
                        .ok()
                        .and_then(|u| u.host_str().map(str::to_owned))
                        .unwrap_or_default();
                    let file = rv_core::emoji_usage::EmojiUsage::path_for(
                        &glib::user_config_dir().join("rocket-vibe-rs"),
                        &format!("{host}-{}", session.info.user_id),
                    );
                    let saved = std::fs::read_to_string(&file).unwrap_or_default();
                    check(
                        "reactions counted on the device",
                        saved.lines().any(|l| l.starts_with("+1\t"))
                            && saved.lines().any(|l| l.starts_with("rocket\t")),
                        &saved,
                    );
                    let top = crate::reactions::usage(&session.info.base_url, &session.info.user_id)
                        .top(rv_core::emoji_usage::QUICK_COUNT);
                    check("used emoji lead the quick reactions", top.iter().any(|c| c == "rocket"), &top);
                    menu(&chat, &anchor, &row);
                    glib::timeout_add_local_once(Duration::from_millis(1000), move || {
                        let Ok(path) = std::env::var("RV_SMOKE_MENU_SHOT") else { return };
                        let Some(popover) = find_by_class(&anchor, "actions-menu") else { return };
                        let (width, height) = (popover.width(), popover.height());
                        let snapshot = gtk::Snapshot::new();
                        gtk::WidgetPaintable::new(Some(&popover)).snapshot(&snapshot, width as f64, height as f64);
                        let saved = snapshot
                            .to_node()
                            .zip(popover.native().and_then(|n| n.renderer()))
                            .map(|(node, renderer)| renderer.render_texture(&node, None).save_to_png(&path).is_ok());
                        println!("smoke: menu screenshot saved {saved:?}");
                    });
                });
            });
        });
    });
}

/// The subscription's unread count and alert as the server holds them.
async fn server_unread(session: &std::sync::Arc<rv_core::session::Session>, rid: &str) -> Option<(i64, bool)> {
    let (s, rid) = (session.clone(), rid.to_owned());
    crate::on_tokio(async move {
        let options = rv_core::rest::CallOptions::params([("roomId", rid.as_str())]);
        let answer = s.rest.get("subscriptions.getOne", options).await.ok()?;
        let sub = answer.get("subscription")?;
        Some((sub.get("unread")?.as_i64()?, sub.get("alert")?.as_bool()?))
    })
    .await
}

/// Waits up to `seconds` for the list to show the room unread (`unread`) or read.
async fn listed_as(chat: &crate::chat::ChatPage, rid: &str, unread: bool, seconds: u64) -> Option<(i64, bool)> {
    for _ in 0..seconds * 5 {
        let listed = chat.listed_unread(rid);
        if listed.is_some_and(|(n, alert)| (n > 0 || alert) == unread) {
            return listed;
        }
        glib::timeout_future(Duration::from_millis(200)).await;
    }
    chat.listed_unread(rid)
}

/// The room list's "Mark as unread" and "Mark as read", on the open room first.
async fn unread_checks(
    chat: std::rc::Rc<crate::chat::ChatPage>,
    session: std::sync::Arc<rv_core::session::Session>,
    rid: String,
) {
    let shows = |l: Option<(i64, bool)>, unread: bool| l.is_some_and(|(n, alert)| (n > 0 || alert) == unread);
    check("marking unread is offered", session.unread_marks_available(), session.unread_marks_available());
    chat.mark_room(&rid, false);
    let listed = listed_as(&chat, &rid, false, 5).await;
    check("marked read: the badge clears", shows(listed, false), listed);
    check("the open room stays open when marked read", chat.current_rid().as_deref() == Some(&rid), chat.current_rid());
    // Already read while open: the list says so before the call ends, let it end.
    glib::timeout_future(Duration::from_millis(2000)).await;
    let before = session.store.last_seen(&rid);

    chat.mark_room(&rid, true);
    check(
        "the open room is left when marked unread",
        chat.current_rid().is_none() && session.current_room().is_none() && chat.selected_room().is_none(),
        (chat.current_rid(), session.current_room(), chat.selected_room()),
    );
    let listed = listed_as(&chat, &rid, true, 5).await;
    check("marked unread: the badge shows", listed.is_some_and(|(n, alert)| n >= 1 && alert), listed);
    // The stream's copy, not only the local mark: `ls` moves back, before the last message.
    let mut seen = session.store.last_seen(&rid);
    for _ in 0..25 {
        if seen != before {
            break;
        }
        glib::timeout_future(Duration::from_millis(200)).await;
        seen = session.store.last_seen(&rid);
    }
    check(
        "the server's subscription arrived on the stream",
        seen.zip(before).is_some_and(|(seen, before)| seen < before),
        (before, seen),
    );
    // Past the read debounce, and back to the window: nothing reads it again.
    chat.window_activated();
    glib::timeout_future(Duration::from_millis(3000)).await;
    let listed = chat.listed_unread(&rid);
    let server = server_unread(&session, &rid).await;
    check("still unread a while later", shows(listed, true) && shows(server, true), (listed, server));

    chat.mark_room(&rid, false);
    let listed = listed_as(&chat, &rid, false, 5).await;
    let server = server_unread(&session, &rid).await;
    check("marked read from the list", shows(listed, false) && shows(server, false), (listed, server));

    chat.mark_room(&rid, true);
    let listed = listed_as(&chat, &rid, true, 5).await;
    check("marked unread again, not open", shows(listed, true), listed);
    chat.open_room(&rid);
    let listed = listed_as(&chat, &rid, false, 5).await;
    let server = server_unread(&session, &rid).await;
    check(
        "opened again, it reads itself",
        chat.current_rid().as_deref() == Some(&rid) && shows(listed, false) && shows(server, false),
        (listed, server),
    );
}

fn check(label: &str, ok: bool, detail: impl std::fmt::Debug) {
    println!("smoke: {label}: {detail:?} {}", if ok { "ok" } else { "FAILED" });
    if !ok {
        FAILED.store(true, Ordering::SeqCst);
    }
}

/// Completion, then a draft kept across a room switch.
fn draft_checks(chat: std::rc::Rc<crate::chat::ChatPage>, back: String, other: String) {
    let mut steps: std::collections::VecDeque<Check> = std::collections::VecDeque::new();
    steps.push_back(Box::new(|c| {
        c.composer().set_text("");
        c.composer().type_text("hi @bo");
    }));
    steps.push_back(Box::new(|c| {
        let offered = c.composer().offered();
        check("mention offered", offered.first().is_some_and(|o| o == "@bob"), &offered);
        c.composer().accept_first();
        check("mention inserted", c.composer().text() == "hi @bob ", c.composer().text());
        c.composer().type_text(":smil");
    }));
    steps.push_back(Box::new(|c| {
        let offered = c.composer().offered();
        check("emoji offered", !offered.is_empty(), &offered);
        c.composer().accept_first();
        let text = c.composer().text();
        check("emoji inserted", !text.contains(':') && text.len() > "hi @bob ".len(), &text);
        c.composer().type_text("draft kept");
    }));
    for _ in 0..15 {
        steps.push_back(Box::new(|_| {}));
    }
    steps.push_back(Box::new(move |c| {
        let kept = c.composer().text();
        c.open_room(&other);
        check("other room starts empty", c.composer().text().is_empty(), c.composer().text());
        c.open_room(&back);
        check("draft restored", c.composer().text() == kept, c.composer().text());
        c.composer().set_text("");
    }));
    in_sequence(chat, steps);
}

fn command_checks(chat: std::rc::Rc<crate::chat::ChatPage>, tag: String) {
    let mut steps: std::collections::VecDeque<Check> = std::collections::VecDeque::new();
    steps.push_back(Box::new(|c| {
        c.composer().set_text("");
        c.composer().type_text("/shr");
    }));
    steps.push_back(Box::new(|c| {
        let offered = c.composer().offered();
        check("command offered", offered.first().is_some_and(|o| o == "/shrug"), &offered);
        c.composer().accept_first();
        check("command inserted", c.composer().text() == "/shrug ", c.composer().text());
        c.composer().set_text("");
    }));
    let missing = format!("{tag}-missing");
    steps.push_back(Box::new(move |c| {
        c.composer().set_text(&format!("/join #{missing}"));
        c.composer().submit_now();
    }));
    for _ in 0..75 {
        steps.push_back(Box::new(|_| {}));
    }
    let answered = format!("{tag}-missing");
    steps.push_back(Box::new(move |c| {
        let note = c.composer().private_note();
        check("command answered", note.as_deref().is_some_and(|n| n.contains(&answered)), &note);
        check("command draft cleared", c.composer().text().is_empty(), c.composer().text());
        c.composer().set_text(&format!("/shrug {tag}"));
        c.composer().submit_now();
    }));
    in_sequence(chat, steps);
}

fn file_checks(chat: std::rc::Rc<crate::chat::ChatPage>) {
    let (Some(session), Some(rid)) = (chat.session(), chat.current_rid()) else { return };
    let files: Vec<_> = session
        .store
        .messages(&rid, 200)
        .into_iter()
        .map(|r| session.open_row(r))
        .flat_map(|r| rv_core::content::files(r.attachments.as_deref()))
        .collect();
    check("files attached", !files.is_empty(), files.len());
    glib::spawn_future_local(async move {
        for f in files {
            let path = crate::cards::local_copy(session.clone(), f.clone()).await;
            let size = path.as_ref().and_then(|p| std::fs::metadata(p).ok()).map(|m| m.len() as i64);
            check(&format!("file {}", f.title), size.is_some() && (f.size.is_none() || size == f.size), size);
        }
    });
}

fn details_checks(
    chat: std::rc::Rc<crate::chat::ChatPage>,
    session: std::sync::Arc<rv_core::session::Session>,
    rid: String,
    what: String,
) {
    glib::spawn_future_local(async move {
        if let Some(user) = what.strip_prefix("profile:") {
            let (s, u) = (session.clone(), user.to_owned());
            let p = crate::on_tokio(async move { s.profile(&u, false).await }).await;
            check("profile read", p.as_ref().is_ok_and(|p| p.username == user), p.as_ref().map(|p| &p.username));
            chat.show_profile(user, false);
        } else if what == "room" {
            let (s, r) = (session.clone(), rid.clone());
            let info = crate::on_tokio(async move { s.room_info(&r).await }).await;
            check("room info read", info.as_ref().is_ok_and(|i| i.members.is_some()), info.as_ref().map(|i| i.members));
            chat.show_room_info();
        } else if let Some(code) = what.strip_prefix("emoji:") {
            check("custom emoji known", session.custom_emoji(code).is_some(), session.custom_emoji(code));
            chat.composer().set_text("");
            chat.composer().type_text(&format!("see :{}", &code[..code.len().min(3)]));
            let offered = chat.composer().offered();
            check("custom emoji offered", offered.iter().any(|o| *o == format!(":{code}:")), &offered);
            chat.composer().set_text("");
        } else if what == "settings" {
            let s = session.clone();
            let round = crate::on_tokio(async move {
                let before = s.me().await?;
                s.set_status("away", "smoke test").await?;
                s.set_preference("desktopNotifications", serde_json::json!("mention")).await?;
                let after = s.me().await?;
                s.set_status(&before.status, &before.status_text).await?;
                s.set_preference("desktopNotifications", serde_json::json!(before.desktop_notifications)).await?;
                Ok::<_, rv_core::rest::RestError>(after)
            })
            .await;
            check(
                "status and preference saved",
                round.as_ref().is_ok_and(|m| {
                    m.status == "away" && m.status_text == "smoke test" && m.desktop_notifications == "mention"
                }),
                round.as_ref().map(|m| (m.status.clone(), m.desktop_notifications.clone())),
            );
            crate::settings::open(chat.widget(), session.clone(), None, || {});
            let root = chat.widget().root().map(|r| r.upcast::<gtk::Widget>());
            glib::spawn_future_local(async move {
                let admin = rv_core::admin::Admin::RocketChat(session);
                let expected = crate::on_tokio(async move { admin.is_admin().await }).await;
                glib::timeout_future(Duration::from_millis(3000)).await;
                let link = root.and_then(|r| find_by_class(&r, "settings-admin")).is_some_and(|w| w.is_visible());
                check(
                    "the settings link to the administration follows the admin right",
                    link == expected,
                    (link, expected),
                );
            });
        } else if let Some(expected) = what.strip_prefix("permissions:") {
            let (s, r) = (session.clone(), rid.clone());
            let granted = crate::on_tokio(async move { s.permissions(&r).await }).await;
            check("permissions", granted.as_ref().is_some_and(|g| g.join(",") == expected), &granted);
        } else if what == "marked" {
            let (s, r) = (session.clone(), rid.clone());
            let pinned = crate::on_tokio(async move { s.marked(&r, false).await }).await;
            check("pinned listed", pinned.as_ref().is_ok_and(|rows| !rows.is_empty()), pinned.map(|rows| rows.len()));
            crate::marked::open(chat.widget(), session, &rid, |_| {});
        } else if what == "unread" {
            unread_checks(chat, session, rid).await;
        } else if what == "threads" {
            let (s, r) = (session.clone(), rid.clone());
            let listed = crate::on_tokio(async move { s.threads(&r, false, 0, 50).await }).await;
            check(
                "threads listed",
                listed.as_ref().is_ok_and(|(rows, total)| !rows.is_empty() && *total as usize >= rows.len()),
                listed.as_ref().map(|(rows, total)| (rows.len(), *total)),
            );
            let Some(root) = listed.ok().and_then(|(rows, _)| rows.into_iter().next()) else { return };
            let me = session.info.user_id.clone();
            let was = root.followed_by(&me);
            let follows = |s: &std::sync::Arc<rv_core::session::Session>| {
                s.store.messages_by_id(std::slice::from_ref(&root.id)).first().is_some_and(|r| r.followed_by(&me))
            };
            for on in [!was, was] {
                let (s, id) = (session.clone(), root.id.clone());
                let done = crate::on_tokio(async move { s.follow_thread(&id, on).await }).await;
                check(
                    if on { "thread followed" } else { "thread unfollowed" },
                    done.is_ok() && follows(&session) == on,
                    &done,
                );
                let (s, r) = (session.clone(), rid.clone());
                let mine = crate::on_tokio(async move { s.threads(&r, true, 0, 50).await }).await;
                let listed = mine.as_ref().is_ok_and(|(rows, _)| rows.iter().any(|t| t.id == root.id));
                check("the following tab agrees", listed == on, mine.map(|(rows, _)| rows.len()));
            }
            crate::threads::open(chat.widget(), session, &rid, |_| {});
            chat.open_thread_of(&root.id);
            glib::timeout_future(Duration::from_millis(3000)).await;
            let bell = chat.thread().is_some_and(|t| t.follow.is_visible());
            check("the thread shows its bell", bell, bell);
        } else if let Some(id) = what.strip_prefix("jump:") {
            chat.jump_to(id);
            let (chat, id) = (chat.clone(), id.to_owned());
            glib::timeout_add_local_once(Duration::from_millis(6000), move || {
                let list = chat.room_list();
                check("jumped to an old message", list.row(&id).is_some(), list.len());
                if !list.is_detached() {
                    return;
                }
                let before = list.len();
                list.scroll_to_bottom();
                glib::timeout_add_local_once(Duration::from_millis(4000), move || {
                    let list = chat.room_list();
                    check("read forward from it", list.len() > before, (before, list.len()));
                    list.jump();
                    glib::timeout_add_local_once(Duration::from_millis(1500), move || {
                        let list = chat.room_list();
                        check("back to the latest", !list.is_detached() && list.is_pinned(), list.len());
                    });
                });
            });
        } else if let Some(text) = what.strip_prefix("search:") {
            let (s, r, q) = (session.clone(), rid.clone(), text.to_owned());
            let hits = crate::on_tokio(async move { s.search(&r, &q).await }).await.unwrap_or_default();
            check("search finds", hits.iter().any(|m| m.text.as_deref().is_some_and(|t| t.contains(text))), hits.len());
            let target = std::rc::Rc::downgrade(&chat);
            crate::details::search(chat.widget(), session, &rid, move |id, _| {
                if let Some(chat) = target.upgrade() {
                    chat.jump_to(&id);
                }
            });
            if let Some(hit) = hits.iter().find(|m| m.thread_id.is_none()) {
                chat.jump_to(&hit.id);
                let (chat, id) = (chat.clone(), hit.id.clone());
                glib::timeout_add_local_once(Duration::from_millis(6000), move || {
                    let list = chat.room_list();
                    check("jumped to a search hit", list.row(&id).is_some(), list.len());
                });
            }
        }
    });
}

const NOTIFICATIONS_XML: &str = r#"<node><interface name="org.freedesktop.Notifications">
  <method name="GetCapabilities"><arg type="as" direction="out"/></method>
  <method name="GetServerInformation"><arg type="s" direction="out"/><arg type="s" direction="out"/>
    <arg type="s" direction="out"/><arg type="s" direction="out"/></method>
  <method name="Notify"><arg type="s"/><arg type="u"/><arg type="s"/><arg type="s"/><arg type="s"/>
    <arg type="as"/><arg type="a{sv}"/><arg type="i"/><arg type="u" direction="out"/></method>
  <method name="CloseNotification"><arg type="u"/></method>
</interface></node>"#;

/// Owns `org.freedesktop.Notifications` on the session bus, prints each
/// notification, and replies inline to the first one.
fn fake_notification_server(reply: String) {
    use gtk::gio;
    let Ok(connection) = gio::bus_get_sync(gio::BusType::Session, None::<&gio::Cancellable>) else {
        println!("smoke: no session bus");
        return FAILED.store(true, Ordering::SeqCst);
    };
    let info = gio::DBusNodeInfo::for_xml(NOTIFICATIONS_XML).expect("introspection");
    let interface = info.lookup_interface("org.freedesktop.Notifications").expect("interface");
    let replied = Cell::new(false);
    let registration = connection
        .register_object("/org/freedesktop/Notifications", &interface)
        .method_call(move |connection, _, _, _, method, parameters, invocation| match method {
            "GetCapabilities" => {
                let plain = std::env::var("RV_SMOKE_NOTIFY").as_deref() == Ok("-");
                let caps = if plain { vec!["body", "actions"] } else { vec!["body", "actions", "inline-reply"] };
                invocation.return_value(Some(&(caps,).to_variant()))
            }
            "GetServerInformation" => {
                invocation.return_value(Some(&("smoke-notifications", "rocket-vibe", "1.0", "1.2").to_variant()))
            }
            "Notify" => {
                let summary = parameters.child_value(3).get::<String>().unwrap_or_default();
                let body = parameters.child_value(4).get::<String>().unwrap_or_default();
                let actions = parameters.child_value(5).get::<Vec<String>>().unwrap_or_default();
                println!(
                    "smoke: notification {summary:?} {body:?} actions={actions:?} inline-reply={}",
                    actions.iter().any(|a| a == "inline-reply")
                );
                invocation.return_value(Some(&(7u32,).to_variant()));
                if !replied.replace(true) {
                    let (connection, reply) = (connection.clone(), reply.clone());
                    glib::timeout_add_local_once(Duration::from_millis(300), move || {
                        let plain = reply == "-";
                        if !plain {
                            let _ = connection.emit_signal(
                                None,
                                "/org/freedesktop/Notifications",
                                "org.freedesktop.Notifications",
                                "NotificationReplied",
                                Some(&(7u32, reply).to_variant()),
                            );
                        }
                        glib::timeout_add_local_once(Duration::from_millis(800), move || {
                            let _ = connection.emit_signal(
                                None,
                                "/org/freedesktop/Notifications",
                                "org.freedesktop.Notifications",
                                "ActionInvoked",
                                Some(&(7u32, if plain { "reply" } else { "default" }).to_variant()),
                            );
                            glib::timeout_add_local_once(Duration::from_millis(1200), || {
                                let Some(w) = SMOKE_WINDOW.with_borrow(std::rc::Weak::upgrade) else { return };
                                let (rid, revealed) = (w.chat.current_rid(), w.chat.room_list().holds_reveal());
                                println!("smoke: notification click opened {rid:?} revealed={revealed}");
                                if rid.is_none() || !revealed {
                                    FAILED.store(true, Ordering::SeqCst);
                                }
                            });
                        });
                    });
                }
            }
            _ => invocation.return_value(None),
        })
        .build();
    if registration.is_err() {
        println!("smoke: could not serve notifications");
        return FAILED.store(true, Ordering::SeqCst);
    }
    let badge = connection.subscribe_to_signal(
        None,
        Some("com.canonical.Unity.LauncherEntry"),
        Some("Update"),
        None,
        None,
        gio::DBusSignalFlags::NONE,
        |signal| {
            let properties = glib::VariantDict::new(Some(&signal.parameters.child_value(1)));
            let count = properties.lookup::<i64>("count").ok().flatten();
            println!("smoke: badge {count:?}");
        },
    );
    std::mem::forget(badge);
    let _ = connection.call_sync(
        Some("org.freedesktop.DBus"),
        "/org/freedesktop/DBus",
        "org.freedesktop.DBus",
        "RequestName",
        Some(&("org.freedesktop.Notifications", 4u32).to_variant()),
        None,
        gio::DBusCallFlags::NONE,
        2000,
        None::<&gio::Cancellable>,
    );
}

/// First account loaded → add the second → it loads → back to the first.
fn second_account(window: &Rc<AppWindow>, server: String, user: String, password: String) {
    let step = Rc::new(Cell::new(0u8));
    let first: Rc<std::cell::RefCell<Option<rv_core::session::SessionInfo>>> = Rc::default();
    let weak = Rc::downgrade(window);
    window.chat.connect_rooms_loaded(move || {
        let Some(w) = weak.upgrade() else { return };
        let Some(session) = w.chat.session() else { return };
        match step.get() {
            0 => {
                step.set(1);
                first.replace(Some(session.info.clone()));
                let (w, server, user, password) = (w.clone(), server.clone(), user.clone(), password.clone());
                glib::timeout_add_local_once(Duration::from_millis(1000), move || {
                    w.add_account();
                    w.login.fill(&server, &user, &password);
                    w.submit_login();
                });
            }
            1 if session.info.username == user => {
                step.set(2);
                check("second account signed in", true, &session.info.username);
                let (w, first) = (w.clone(), first.borrow().clone());
                glib::timeout_add_local_once(Duration::from_millis(1000), move || {
                    if let Some(first) = first {
                        w.switch_to(first);
                    }
                });
            }
            2 if Some(&session.info.username) == first.borrow().as_ref().map(|f| &f.username) => {
                step.set(3);
                check("switched back", w.chat.room_count() > 0, &session.info.username);
            }
            _ => {}
        }
    });
}

fn nav_checks(chat: Rc<crate::chat::ChatPage>, first: String, other: String) {
    chat.open_room(&other);
    let narrow = chat.widget().is_collapsed();
    if narrow {
        chat.navigate_back();
        let listed = !chat.shows_room() && chat.offers_way_back();
        chat.navigate_forward();
        let back_in = chat.shows_room() && chat.current_rid().as_deref() == Some(other.as_str());
        println!("smoke: nav narrow listed={listed} back_in={back_in}");
        if !listed || !back_in {
            FAILED.store(true, Ordering::SeqCst);
        }
        return;
    }
    chat.navigate_back();
    let back = chat.current_rid().as_deref() == Some(first.as_str());
    chat.navigate_forward();
    let forward = chat.current_rid().as_deref() == Some(other.as_str());
    println!("smoke: nav back={back} forward={forward}");
    if !back || !forward {
        FAILED.store(true, Ordering::SeqCst);
    }
}

fn edit_checks(chat: Rc<crate::chat::ChatPage>, tag: String) {
    chat.send_text(&format!("{tag} before"));
    let save_after = std::env::var("RV_SMOKE_EDIT_SAVE_MS").ok().and_then(|v| v.parse().ok()).unwrap_or(3000);
    glib::timeout_add_local_once(Duration::from_millis(2500), move || {
        chat.edit_last_mine();
        glib::timeout_add_local_once(Duration::from_millis(1000), move || {
            let list = chat.room_list();
            let editing = list.editing().and_then(|id| list.row(&id)).and_then(|r| r.text);
            println!("smoke: edit editing={editing:?}");
            if editing != Some(format!("{tag} before")) {
                FAILED.store(true, Ordering::SeqCst);
                return;
            }
            list.set_edit_text(&format!("{tag} after"));
            glib::timeout_add_local_once(Duration::from_millis(save_after), move || {
                chat.play(crate::rows::RowEvent::SaveEdit, false);
                if chat.native_session().is_some() {
                    native_reaction_checks(chat, format!("{tag} after"));
                }
            });
        });
    });
}

fn native_reaction_checks(chat: Rc<crate::chat::ChatPage>, text: String) {
    glib::spawn_future_local(async move {
        let Some(session) = chat.native_session() else { return };
        let Some(rid) = chat.current_rid() else { return };
        let mut id = None;
        for _ in 0..100 {
            id = session
                .store
                .messages(&rid, 100)
                .ok()
                .and_then(|rows| rows.into_iter().find(|r| r.text == text && r.edited).map(|r| r.id));
            if id.is_some() {
                break;
            }
            glib::timeout_future(Duration::from_millis(20)).await;
        }
        let Some(id) = id else {
            check("reaction edited target", false, 0);
            return;
        };
        for (shortcode, add) in [(":+1:", true), (":thumbsup:", false)] {
            chat.play(crate::rows::RowEvent::React { id: id.clone(), shortcode: shortcode.into(), add }, false);
            let mut rendered = false;
            for _ in 0..100 {
                let row = chat.room_list().row(&id);
                let reactions = rv_core::actions::reactions(
                    row.as_ref().and_then(|r| r.reactions.as_deref()),
                    &session.info.username,
                );
                rendered =
                    row.is_some() && if add { reactions.len() == 1 && reactions[0].mine } else { reactions.is_empty() };
                if rendered {
                    break;
                }
                glib::timeout_future(Duration::from_millis(20)).await;
            }
            check(
                if add { "native GTK reaction chip" } else { "native GTK reaction removal" },
                rendered,
                usize::from(rendered),
            );
        }
        for present in [true, false] {
            let (s, room, target) = (session.clone(), rid.clone(), id.clone());
            let result = crate::on_tokio(async move {
                s.set_mark(&room, &target, present, true).await?;
                s.marked(&room, true).await
            })
            .await;
            let listed = result.is_ok_and(|messages| messages.iter().any(|m| m.id == id) == present);
            check("native GTK private star list", listed, usize::from(listed));
            let mut rendered = false;
            for _ in 0..100 {
                let row = chat.room_list().row(&id);
                rendered = row.is_some_and(|r| {
                    r.starred.as_deref().is_some_and(|uids| uids.split(',').any(|u| u == session.info.user_id))
                        == present
                });
                if rendered {
                    break;
                }
                glib::timeout_future(Duration::from_millis(20)).await;
            }
            check("native GTK private star projection", rendered, usize::from(rendered));
        }
    });
}

fn react_checks(chat: Rc<crate::chat::ChatPage>, code: String) {
    let (Some(session), Some(rid)) = (chat.session(), chat.current_rid()) else { return };
    let rows = session.store.messages(&rid, 200);
    let Some(theirs) =
        rows.iter().rev().find(|r| r.author_id != session.info.user_id && r.system_type.is_none()).cloned()
    else {
        return FAILED.store(true, Ordering::SeqCst);
    };
    let list = chat.room_list();
    let id = theirs.id.clone();
    let y0 = list.row_y(&id);
    let had = theirs.reactions.clone();
    chat.play(crate::rows::RowEvent::React { id: id.clone(), shortcode: code, add: true }, false);
    let stats = Rc::new(Cell::new((0u32, 0u32, 0.0f32, false)));
    let started = std::time::Instant::now();
    let watched = list.root.clone();
    watched.add_tick_callback(move |_, _| {
        let (frames, gaps, drift, changed) = stats.get();
        let y = list.row_y(&id);
        let changed = changed || list.row(&id).is_some_and(|r| r.reactions != had);
        let drift = match (y0, y) {
            (Some(a), Some(b)) => drift.max((b - a).abs()),
            _ => drift,
        };
        let gaps = gaps + u32::from(y.is_none());
        stats.set((frames + 1, gaps, drift, changed));
        if started.elapsed() < Duration::from_millis(3000) {
            return glib::ControlFlow::Continue;
        }
        println!("smoke: react changed={changed} frames={frames} gaps={gaps} drift={drift:.0}");
        if !changed || gaps > 0 || drift > 40.0 {
            FAILED.store(true, Ordering::SeqCst);
        }
        glib::ControlFlow::Break
    });
}

fn paging_checks(list: Rc<crate::message_list::MessageList>) {
    let (top, before) = (list.oldest_id(), list.len());
    list.scroll_to_top();
    glib::timeout_add_local_once(Duration::from_millis(4000), move || {
        let grew = list.len() > before;
        let kept = top.as_deref().is_some_and(|id| list.on_screen(id));
        println!("smoke: paging grew={grew} kept={kept}");
        if !grew || !kept {
            FAILED.store(true, Ordering::SeqCst);
        }
    });
}

fn jump_checks(list: Rc<crate::message_list::MessageList>) {
    list.scroll_to_top();
    let click_after = std::env::var("RV_SMOKE_JUMP_CLICK_MS").ok().and_then(|v| v.parse().ok()).unwrap_or(1500);
    glib::timeout_add_local_once(Duration::from_millis(500), move || {
        let shown = list.jump_shown();
        println!("smoke: jump shown={shown}");
        if !shown {
            FAILED.store(true, Ordering::SeqCst);
            return;
        }
        glib::timeout_add_local_once(Duration::from_millis(click_after), move || {
            list.jump();
            glib::timeout_add_local_once(Duration::from_millis(800), move || {
                let back = list.is_pinned() && !list.jump_shown();
                println!("smoke: jump back={back}");
                if !back {
                    FAILED.store(true, Ordering::SeqCst);
                }
            });
        });
    });
}

fn fold_checks(chat: Rc<crate::chat::ChatPage>) {
    let before = chat.listed_rows();
    chat.toggle_section(rv_core::rooms::Section::Channels);
    let folded = chat.listed_rows();
    if std::env::var("RV_SMOKE_FOLD").as_deref() == Ok("keep") {
        return;
    }
    chat.toggle_section(rv_core::rooms::Section::Channels);
    let back = chat.listed_rows();
    println!("smoke: fold before={before} folded={folded} back={back}");
    if folded >= before || back != before {
        FAILED.store(true, Ordering::SeqCst);
    }
}

/// `RV_SMOKE_GALLERY=1`: a window of sample messages and a composer, no
/// server needed, so CI can screenshot how text, emoji and times line up
/// with each system's fonts.
pub fn gallery(app: &adw::Application) -> bool {
    if std::env::var("RV_SMOKE_GALLERY").as_deref() != Ok("1") {
        return false;
    }
    let now = chrono::Local::now().timestamp_millis();
    let row = |id: &str, author: &str, text: &str, ts: i64| rv_core::store::MessageRow {
        id: id.into(),
        rid: "gallery".into(),
        ts,
        text: Some(text.into()),
        author: Some(author.into()),
        author_id: author.into(),
        ..Default::default()
    };
    let display = |row, show_header, show_day, gutter_time| crate::rows::Display {
        row,
        show_header,
        show_day,
        gutter_time,
        new_marker: false,
    };
    let samples = [
        display(row("1", "alice", "Emoji inline 😄 hello 🎉 world 🚀 and a 👍 end", now - 120_000), true, true, false),
        display(
            row("2", "alice", "Line with 🇫🇷 flags 🇬🇧 and ❤️ hearts, then *bold* text", now - 60_000),
            false,
            false,
            true,
        ),
        display(row("3", "bob", "😀", now), true, false, false),
        display(row("4", "bob", "Mixed: café, naïve, 日本語, emoji 👩‍💻 at the end 🙂", now), false, false, false),
        display(
            rv_core::store::MessageRow {
                system_type: Some("videoconf".into()),
                call_id: Some("gallery-call".into()),
                text: None,
                ..row("5", "bob", "", now)
            },
            false,
            false,
            false,
        ),
    ];
    let column = gtk::Box::builder().orientation(gtk::Orientation::Vertical).margin_top(12).build();
    for d in &samples {
        column.append(&crate::rows::message_widget(d, "alice", None, None, std::rc::Rc::new(|_| {})));
    }
    if let Some((provider, id)) = std::env::var("RV_SMOKE_PLAYER").ok().and_then(|p| {
        let (provider, id) = p.split_once(':')?;
        Some((provider.to_owned(), id.to_owned()))
    }) {
        let frame = crate::widgets::media_frame(480, 270, &["preview-image", "player-frame"]);
        frame.set_margin_start(60);
        column.append(&frame);
        glib::timeout_add_local_once(Duration::from_millis(1500), move || {
            let provider = match provider.as_str() {
                "Dailymotion" => "Dailymotion",
                "Vimeo" => "Vimeo",
                _ => "YouTube",
            };
            let _ = crate::player::start(&frame, provider, &id);
        });
    }
    let composer = crate::composer::Composer::new();
    composer.set_text("Draft 😊 with emoji");
    let content = gtk::Box::builder().orientation(gtk::Orientation::Vertical).build();
    content.append(&gtk::ScrolledWindow::builder().child(&column).vexpand(true).build());
    content.append(&composer.root);
    let window = adw::ApplicationWindow::builder()
        .application(app)
        .title("rocket-vibe gallery")
        .default_width(900)
        .default_height(600)
        .content(&content)
        .build();
    window.present();
    if std::env::var("RV_SMOKE_IME").is_ok() {
        layout_changes(composer.clone());
    }
    std::mem::forget(composer);
    rv_native::init(crate::APP_ID, "rocket-vibe", Box::new(|event| println!("smoke: native event {event:?}")));
    crate::widgets::badge_follows(&window);
    glib::timeout_add_local_once(Duration::from_millis(2000), || {
        rv_native::badge(3, false);
        glib::timeout_add_local_once(Duration::from_millis(1500), || {
            println!("smoke: native toasts delivered {:?}", rv_native::delivered());
        });
    });
    rv_native::show(&rv_native::Toast {
        room: "gallery",
        message: "1",
        title: "bob",
        body: "A native notification 🎉",
        activation_link: None,
        reply: Some(rv_native::ReplyLabels { placeholder: "Reply", send: "Send" }),
    });
    println!("smoke: native notifications available {}", rv_native::available());
    if let Ok(url) = std::env::var("RV_SMOKE_CALL") {
        let anchor = window.clone();
        glib::timeout_add_local_once(Duration::from_millis(1500), move || {
            crate::call_window::open(&anchor, &url, "smoke", |text| println!("smoke: call toast {text}"));
            println!("smoke: call window asked for {url}");
        });
    }
    if let Some(times) = std::env::var("RV_SMOKE_LOG_FLOOD").ok().and_then(|s| s.parse::<u64>().ok()) {
        for _ in 0..times {
            glib::g_critical!("rv-smoke", "the same critical, again");
        }
        glib::g_warning!("rv-smoke", "a different warning");
        println!("smoke: logged {times} criticals");
    }
    if let Some(seconds) = std::env::var("RV_SMOKE_SOAK").ok().and_then(|s| s.parse::<u32>().ok()) {
        soak(column, samples.to_vec(), seconds);
    }
    if let Ok(files) = std::env::var("RV_SMOKE_MEDIA") {
        media(files.split('|').filter(|f| !f.is_empty()).map(str::to_owned).collect());
    }
    true
}

/// `RV_SMOKE_IME`: what a keyboard layout change does to a focused field.
fn layout_changes(composer: std::rc::Rc<crate::composer::Composer>) {
    glib::timeout_add_local_once(Duration::from_millis(2000), move || {
        composer.grab_focus();
        for round in 1..=3u64 {
            let composer = composer.clone();
            glib::timeout_add_local_once(Duration::from_millis(700 * round), move || {
                rv_native::input_language_changed();
                if round == 3 {
                    glib::timeout_add_local_once(Duration::from_millis(1500), move || {
                        composer.set_text("typed after three layout changes");
                        println!("smoke: input language changed 3 times, composer {:?}", composer.text());
                    });
                }
            });
        }
    });
}

/// Whether the smoke run leaves the input method to the system.
#[cfg(windows)]
pub fn ime_unpinned() -> bool {
    std::env::var("RV_SMOKE_IME").as_deref() == Ok("unpinned")
}

/// `RV_SMOKE_MEDIA`: each file through GTK's media stream, as the cards play
/// them, muted: it has to be ready to play, with no error. CI machines have
/// no sound card, so how far it got is only reported.
fn media(files: Vec<String>) {
    for file in files {
        let stream = crate::gst_stream::for_file(std::path::Path::new(&file));
        stream.set_muted(true);
        stream.play();
        glib::timeout_add_local_once(Duration::from_millis(4000), move || {
            let played = stream.timestamp();
            let ok = stream.error().is_none() && stream.is_prepared();
            println!(
                "smoke: media {file} {} (played {} ms, error {:?})",
                if ok { "ok" } else { "FAILED" },
                played / 1000,
                stream.error().map(|e| e.to_string())
            );
            if !ok {
                FAILED.store(true, Ordering::SeqCst);
            }
        });
    }
}

/// `RV_SMOKE_SOAK=<seconds>` with the gallery: for that long, rebuild the
/// message rows, post toasts and change the badge several times a second,
/// then print that it survived: the platform paths a random crash could hide in.
fn soak(column: gtk::Box, samples: Vec<crate::rows::Display>, seconds: u32) {
    let rounds = std::rc::Rc::new(std::cell::Cell::new(0u32));
    let started = std::time::Instant::now();
    glib::timeout_add_local(Duration::from_millis(150), move || {
        let round = rounds.get() + 1;
        rounds.set(round);
        while let Some(child) = column.first_child() {
            column.remove(&child);
        }
        for d in &samples {
            column.append(&crate::rows::message_widget(d, "alice", None, None, std::rc::Rc::new(|_| {})));
        }
        rv_native::badge(i64::from(round % 12), round.is_multiple_of(3));
        if round.is_multiple_of(5) {
            let body = format!("Soak round {round} 🎉");
            rv_native::show(&rv_native::Toast {
                room: if round.is_multiple_of(2) { "soak-a" } else { "soak-b" },
                message: "1",
                title: "bob",
                body: &body,
                activation_link: None,
                reply: Some(rv_native::ReplyLabels { placeholder: "Reply", send: "Send" }),
            });
        }
        if round.is_multiple_of(7) {
            rv_native::withdraw("soak-a");
        }
        if started.elapsed().as_secs() >= u64::from(seconds) {
            println!("smoke: soak survived {round} rounds in {seconds} s");
            return glib::ControlFlow::Break;
        }
        glib::ControlFlow::Continue
    });
}

fn native_devices_checks(window: Rc<AppWindow>) {
    let Some(session) = window.chat.native_session() else {
        check("native devices provider", false, 0);
        return;
    };
    let settings = crate::settings::open_native(window.chat.widget(), session.clone(), None, || {});
    glib::spawn_future_local(async move {
        let root = window.window.upcast_ref::<gtk::Widget>();
        let category = find_by_class(root, "sidebar-category-devices");
        check("native device settings entry", category.is_some(), usize::from(category.is_some()));
        if category.is_none() {
            return;
        }
        settings.select("devices");
        let mut entry = None;
        for _ in 0..100 {
            entry = find_by_class(root, "native-device-current-name").and_downcast::<adw::EntryRow>();
            if entry.is_some() {
                break;
            }
            glib::timeout_future(Duration::from_millis(25)).await;
        }
        check("native current device entry", entry.is_some(), usize::from(entry.is_some()));
        let Some(entry) = entry else { return };
        let mut ancestor = entry.parent();
        while let Some(widget) = ancestor {
            if let Some(row) = widget.downcast_ref::<adw::ExpanderRow>() {
                row.set_expanded(true);
                break;
            }
            ancestor = widget.parent();
        }
        entry.set_text("GTK pilot device");
        entry.emit_by_name::<()>("apply", &[]);
        let mut saved = false;
        for _ in 0..100 {
            let s = session.clone();
            saved = crate::on_tokio(async move { s.device_sessions().await })
                .await
                .is_ok_and(|devices| devices.iter().any(|d| d.current && d.label == "GTK pilot device"));
            if saved && entry.is_sensitive() {
                break;
            }
            glib::timeout_future(Duration::from_millis(25)).await;
        }
        check("native GTK device name saved", saved && entry.is_sensitive(), usize::from(saved));
        glib::timeout_future(Duration::from_millis(300)).await;
        let fits = find_by_class(root, "native-devices-dialog").is_some_and(|dialog| {
            entry
                .compute_bounds(&dialog)
                .is_some_and(|bounds| bounds.y() >= 0.0 && bounds.y() + bounds.height() <= dialog.height() as f32)
        });
        check("native device editor fits dialog", fits, usize::from(fits));
    });
}

fn find_by_class(root: &gtk::Widget, class: &str) -> Option<gtk::Widget> {
    if root.has_css_class(class) {
        return Some(root.clone());
    }
    let mut child = root.first_child();
    while let Some(c) = child {
        if let Some(found) = find_by_class(&c, class) {
            return Some(found);
        }
        child = c.next_sibling();
    }
    None
}

fn update_checks(chat: Rc<crate::chat::ChatPage>, install: bool) {
    let Some(card) = chat.update_notice() else {
        println!("smoke: update notice shown=false");
        FAILED.store(true, Ordering::SeqCst);
        return;
    };
    let title = find_by_class(&card, "update-title").and_downcast::<gtk::Label>().map(|l| l.label());
    println!("smoke: update notice shown=true title={title:?}");
    if !install {
        return;
    }
    let Some(button) = find_by_class(&card, "update-install").and_downcast::<gtk::Button>() else {
        FAILED.store(true, Ordering::SeqCst);
        return;
    };
    button.emit_clicked();
    let waited = Rc::new(Cell::new(0u32));
    glib::timeout_add_local(Duration::from_millis(500), move || {
        let label = find_by_class(&card, "update-title").and_downcast::<gtk::Label>().map(|l| l.label().to_string());
        let done = label.as_deref() == Some(crate::i18n::t("update.installed"));
        let failed = label.as_deref() == Some(crate::i18n::t("update.failed"));
        waited.set(waited.get() + 1);
        if done || failed || waited.get() > 90 {
            let restartable = crate::updater::can_relaunch();
            println!("smoke: update installed={done} label={label:?} restartable={restartable}");
            if !done || !restartable {
                FAILED.store(true, Ordering::SeqCst);
            }
            return glib::ControlFlow::Break;
        }
        glib::ControlFlow::Continue
    });
}
