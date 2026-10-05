//! YouTube, Dailymotion and Vimeo videos played in their card. Linux puts a
//! WebKitGTK view in the card; Windows and macOS cannot hold a native view
//! among GTK widgets, so their engine (rv-native) is laid over the card on
//! every frame and cut to the scrolled list around it.

use std::cell::RefCell;
use std::rc::Rc;

#[cfg(any(windows, target_os = "macos"))]
use adw::prelude::*;
#[cfg(any(windows, target_os = "macos"))]
use gtk::glib;

thread_local! {
    static LAST: RefCell<Option<Rc<dyn Fn() -> bool>>> = const { RefCell::new(None) };
}

/// Remembers how to start the video card built last, for the smoke run.
pub fn set_last(start: Rc<dyn Fn() -> bool>) {
    LAST.set(Some(start));
}

/// Starts the video card built last, as a click would.
pub fn play_last() -> bool {
    LAST.with_borrow(Clone::clone).is_some_and(|start| start())
}

/// Plays the video in `frame`, over whatever it shows, and gives what stops
/// it; none when it cannot be played here and should open in the browser instead.
pub fn start(frame: &gtk::Overlay, provider: &str, id: &str) -> Option<Rc<dyn Fn()>> {
    let html = rv_core::player::page(provider, id)?;
    let close = attach(frame, &rv_core::player::page_url(provider, id), &html);
    println!("player: {provider} {id} started {}", close.is_some());
    close
}

#[cfg(target_os = "linux")]
fn attach(frame: &gtk::Overlay, _url: &str, html: &str) -> Option<Rc<dyn Fn()>> {
    use webkit6::prelude::*;

    thread_local! {
        static SESSION: webkit6::NetworkSession = webkit6::NetworkSession::new_ephemeral();
    }
    let policies = webkit6::WebsitePolicies::builder().autoplay(webkit6::AutoplayPolicy::Allow).build();
    let web = SESSION
        .with(|session| webkit6::WebView::builder().network_session(session).website_policies(&policies).build());
    if let Some(settings) = WebViewExt::settings(&web) {
        settings.set_media_playback_requires_user_gesture(false);
        settings.set_enable_developer_extras(false);
        if crate::gst_stream::video_on_cpu() {
            settings.set_hardware_acceleration_policy(webkit6::HardwareAccelerationPolicy::Never);
        }
    }
    web.set_background_color(&gtk::gdk::RGBA::BLACK);
    web.connect_enter_fullscreen(|_| true);
    web.connect_decide_policy(|web, decision, kind| {
        let Some(action) =
            decision.downcast_ref::<webkit6::NavigationPolicyDecision>().and_then(|d| d.navigation_action())
        else {
            return false;
        };
        let target = action.request().and_then(|r| r.uri()).map(|u| u.to_string()).unwrap_or_default();
        let go = match kind {
            webkit6::PolicyDecisionType::NewWindowAction => rv_core::player::Navigation::Browser,
            _ => {
                let ours = target == "about:blank" || rv_core::call::same_origin(&target, rv_core::player::ORIGIN);
                let clicked = action.navigation_type() == webkit6::NavigationType::LinkClicked;
                rv_core::player::navigation(&target, ours, clicked)
            }
        };
        if go == rv_core::player::Navigation::Allow {
            return false;
        }
        decision.ignore();
        println!("player: left for the browser {target}");
        if go == rv_core::player::Navigation::Browser && rv_core::call::origin(&target).is_some() {
            crate::cards::open_uri(web, &target);
        }
        true
    });
    web.connect_load_changed(|web, event| {
        if event == webkit6::LoadEvent::Finished {
            println!("player: loaded {}", web.uri().unwrap_or_default());
        }
    });
    web.load_html(html, Some(&format!("{}/", rv_core::player::ORIGIN)));
    frame.add_overlay(&web);
    let web = web.downgrade();
    Some(Rc::new(move || {
        if let Some(web) = web.upgrade() {
            web.load_uri("about:blank");
            println!("player: closed");
        }
    }))
}

#[cfg(any(windows, target_os = "macos"))]
fn attach(frame: &gtk::Overlay, url: &str, html: &str) -> Option<Rc<dyn Fn()>> {
    let root = frame.root()?;
    let decide: rv_native::Decide =
        |target, main_frame, clicked| match rv_core::player::navigation(target, main_frame, clicked) {
            rv_core::player::Navigation::Allow => rv_native::Go::Allow,
            rv_core::player::Navigation::Browser => rv_native::Go::Browser,
            rv_core::player::Navigation::Block => rv_native::Go::Block,
        };
    let player = match rv_native::player(window_handle(&root), url, html, decide) {
        Ok(player) => player,
        Err(e) => {
            eprintln!("Player not made: {e}");
            return None;
        }
    };
    let holder = gtk::Box::builder().css_classes(["player-holder"]).build();
    let player = Rc::new(RefCell::new(Some(player)));
    // Laid over the card on every frame while on screen, the card possibly moved
    // to another row built for the same message.
    let tick: Rc<RefCell<Option<gtk::TickCallbackId>>> = Rc::default();
    let (kept, t) = (player.clone(), tick.clone());
    holder.connect_map(move |holder| {
        let kept = kept.clone();
        t.replace(Some(holder.add_tick_callback(move |holder, _| {
            if let Some(player) = kept.borrow().as_ref() {
                place(holder, player);
            }
            glib::ControlFlow::Continue
        })));
    });
    let kept = player.clone();
    holder.connect_unmap(move |_| {
        if let Some(id) = tick.take() {
            id.remove();
        }
        if let Some(player) = kept.borrow().as_ref() {
            player.hide();
        }
    });
    let kept = player.clone();
    holder.connect_destroy(move |_| {
        kept.replace(None);
    });
    frame.add_overlay(&holder);
    Some(Rc::new(move || {
        player.replace(None);
    }))
}

#[cfg(windows)]
fn window_handle(root: &gtk::Root) -> isize {
    root.surface().and_downcast::<gdk4_win32::Win32Surface>().map_or(0, |s| s.handle().0 as isize)
}

#[cfg(target_os = "macos")]
fn window_handle(_root: &gtk::Root) -> isize {
    0
}

/// Lays the player over `holder`, cut to the list that scrolls it; hidden
/// while it is off screen or a dialog covers the window.
#[cfg(any(windows, target_os = "macos"))]
fn place(holder: &gtk::Box, player: &rv_native::Player) {
    let Some(root) = holder.root() else { return player.hide() };
    let covered = root.downcast_ref::<adw::ApplicationWindow>().is_some_and(|w| w.visible_dialog().is_some());
    let bounds = holder.compute_bounds(&root);
    let (Some(bounds), true, false) = (bounds, holder.is_mapped(), covered) else { return player.hide() };
    let (dx, dy) = root.surface_transform();
    let rect = |b: gtk::graphene::Rect| rv_native::Rect {
        x: b.x() as f64 + dx,
        y: b.y() as f64 + dy,
        width: b.width() as f64,
        height: b.height() as f64,
    };
    let card = rect(bounds);
    let clip = holder
        .ancestor(gtk::ScrolledWindow::static_type())
        .and_then(|scroller| scroller.compute_bounds(&root))
        .map_or(card, rect);
    let scale = root.surface().map_or(1.0, |s| s.scale());
    player.place(card, clip, scale);
}
