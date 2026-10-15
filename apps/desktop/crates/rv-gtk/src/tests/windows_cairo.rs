use super::*;
use gtk::gdk::prelude::PaintableExt;
use gtk::gsk;
use rv_core::{
    native::{Identity, store::NativeStore},
    session::SessionInfo,
    voice::Participant,
};
use std::time::{Duration, Instant};

#[allow(clippy::duplicate_mod)]
#[path = "../../../rv-core/tests/common/mod.rs"]
mod http;

fn until(stage: &str, check: impl Fn() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(8);
    while !check() {
        assert!(Instant::now() < deadline, "Windows Cairo rendering timed out at {stage}");
        while glib::MainContext::default().iteration(false) {}
        std::thread::sleep(Duration::from_millis(10));
    }
}

fn settle() {
    let deadline = Instant::now() + Duration::from_millis(200);
    while Instant::now() < deadline {
        while glib::MainContext::default().iteration(false) {}
        std::thread::sleep(Duration::from_millis(5));
    }
}

#[derive(Default)]
struct Shadows {
    positive_blur: usize,
    green_halo: usize,
    pink_feedback: usize,
}

fn visit(node: &gsk::RenderNode, result: &mut Shadows) {
    let bounds = node.bounds();
    for value in [bounds.x(), bounds.y(), bounds.width(), bounds.height()] {
        assert!(value.is_finite(), "render node has finite geometry");
    }
    if let Some(shadow) = node.downcast_ref::<gsk::OutsetShadowNode>() {
        result.positive_blur += usize::from(shadow.blur_radius() > 0.0);
        let color = shadow.color();
        if shadow.blur_radius() == 0.0 && shadow.spread() > 0.0 {
            result.green_halo += usize::from(color.green() > 0.7 && color.red() < 0.3);
            result.pink_feedback += usize::from(color.red() > 0.9 && color.green() < 0.5);
        }
    } else if let Some(shadow) = node.downcast_ref::<gsk::InsetShadowNode>() {
        result.positive_blur += usize::from(shadow.blur_radius() > 0.0);
    } else if let Some(blur) = node.downcast_ref::<gsk::BlurNode>() {
        result.positive_blur += usize::from(blur.radius() > 0.0);
        visit(&blur.child(), result);
    } else if let Some(shadow) = node.downcast_ref::<gsk::ShadowNode>() {
        for index in 0..shadow.n_shadows() {
            result.positive_blur += usize::from(shadow.shadow(index).radius() > 0.0);
        }
        visit(&shadow.child(), result);
    } else if let Some(container) = node.downcast_ref::<gsk::ContainerNode>() {
        for index in 0..container.n_children() {
            visit(&container.child(index), result);
        }
    } else if let Some(transform) = node.downcast_ref::<gsk::TransformNode>() {
        visit(&transform.child(), result);
    } else if let Some(clip) = node.downcast_ref::<gsk::ClipNode>() {
        visit(&clip.child(), result);
    } else if let Some(clip) = node.downcast_ref::<gsk::RoundedClipNode>() {
        visit(&clip.child(), result);
    } else if let Some(opacity) = node.downcast_ref::<gsk::OpacityNode>() {
        visit(&opacity.child(), result);
    } else if let Some(debug) = node.downcast_ref::<gsk::DebugNode>() {
        visit(&debug.child(), result);
    } else if let Some(blend) = node.downcast_ref::<gsk::BlendNode>() {
        visit(&blend.bottom_child(), result);
        visit(&blend.top_child(), result);
    } else if let Some(fade) = node.downcast_ref::<gsk::CrossFadeNode>() {
        visit(&fade.start_child(), result);
        visit(&fade.end_child(), result);
    } else if let Some(matrix) = node.downcast_ref::<gsk::ColorMatrixNode>() {
        visit(&matrix.child(), result);
    } else if let Some(repeat) = node.downcast_ref::<gsk::RepeatNode>() {
        visit(&repeat.child(), result);
    }
}

fn shadows(widget: &impl IsA<gtk::Widget>) -> Shadows {
    let widget = widget.as_ref();
    assert!(widget.is_mapped() && widget.width() > 0 && widget.height() > 0);
    // A newly observed GtkWidgetPaintable can start with an empty current
    // image even when its widget is mapped. Keep it alive through a real
    // redraw and its high-priority image-update idle before inspecting GSK.
    let paintable = gtk::WidgetPaintable::new(Some(widget));
    widget.queue_draw();
    let node = RefCell::new(None);
    until("actual mapped GTK paintable frame", || {
        let snapshot = gtk::Snapshot::new();
        paintable.snapshot(&snapshot, widget.width() as f64, widget.height() as f64);
        node.replace(snapshot.to_node());
        node.borrow().is_some()
    });
    let node = node.into_inner().expect("actual mapped GTK snapshot");
    let mut result = Shadows::default();
    visit(&node, &mut result);
    result
}

#[test]
#[ignore = "requires a GTK display with GSK_RENDERER=cairo; run under Xvfb"]
fn windows_cairo_voice_to_room_keeps_zero_blur_speaking_and_button_feedback() {
    gtk::init().unwrap();
    adw::init().unwrap();
    crate::style::load();
    let executor = tokio::runtime::Runtime::new().unwrap();
    let _entered = executor.enter();
    let fixture: serde_json::Value =
        serde_json::from_str(include_str!("../../../../../../docs/protocol/v1.fixture.json")).unwrap();
    let mut other = fixture["room"].clone();
    other["id"] = serde_json::json!("ordinary-room");
    other["name"] = serde_json::json!("Ordinary room");
    let mut initial = fixture["snapshot"].clone();
    initial["rooms"] = serde_json::json!([fixture["room"].clone(), other]);
    initial["messages"] = serde_json::json!([]);
    let server = executor.block_on(http::FakeHttp::start(move |request| match request.path() {
        "/.well-known/vibez" => http::respond(200, &fixture["discovery"].to_string()),
        "/api/v1/me" => http::respond(200, &fixture["session"]["user"].to_string()),
        "/api/v1/sync/changes" => {
            http::respond(200, r#"{"protocol_version":1,"changes":[],"cursor":"fixture","has_more":false}"#)
        }
        "/api/v1/sync/ticket" => http::respond(200, &fixture["socket_ticket"].to_string()),
        "/api/v1/sync/socket" => http::Response { websocket: true, ..Default::default() },
        _ => http::respond(404, r#"{"code":"not_found","request_id":"fixture"}"#),
    }));
    let path = std::env::temp_dir().join(format!("gtk-cairo-shadow-{}.sqlite", std::process::id()));
    let identity = Identity { instance_id: "fixture-instance".into(), data_epoch: "fixture-epoch".into() };
    let store = NativeStore::open(&path, identity.clone()).unwrap();
    store.snapshot(&serde_json::from_value(initial).unwrap()).unwrap();
    drop(store);
    let session = NativeSession::start(
        SessionInfo {
            base_url: server.url.to_string(),
            user_id: "alice-id".into(),
            username: "alice".into(),
            auth_token: "fixture-token".into(),
            native: Some(identity),
            mattermost: None,
            slack: None,
        },
        &path,
    )
    .unwrap();
    until("native session online", || session.status().connection == Connection::Online);
    let page = ChatPage::new();
    let window = gtk::Window::builder().default_width(1000).default_height(760).build();
    crate::style::watch_window(&window);
    window.set_child(Some(page.root()));
    window.present();
    page.set_native_session(session.clone());
    page.open_native_room("room-id");
    let renderer = window.renderer().expect("realized native renderer");
    assert!(renderer.is::<gsk::CairoRenderer>(), "run this rendering regression with GSK_RENDERER=cairo");
    assert!(!crate::style::needs_windows_cairo_shadows(false, &renderer));
    assert!(!crate::style::needs_windows_cairo_shadows(true, &gsk::GLRenderer::new().upcast()));
    assert!(!crate::style::apply_windows_cairo_shadows(&window, false));
    assert!(!window.has_css_class("windows-cairo-shadows"));

    // Render the actual voice page from a connected, speaking participant
    // snapshot. Transport is independently exercised by the real-SFU smoke;
    // this display regression isolates the failing GSK/Cairo render path.
    let snapshot = Snapshot {
        room: Some("room-id".into()),
        state: ConnectionState::Connected,
        can_publish: true,
        participants: vec![Participant {
            identity: "alice-id".into(),
            local: true,
            muted: false,
            deafened: false,
            speaking: true,
            level: 0.5,
            camera: false,
            screen: false,
        }],
        ..Default::default()
    };
    page.voice.shown.replace(Some("room-id".into()));
    page.render_voice_page(&session, &snapshot);
    page.voice.light(&snapshot);
    page.content_stack.set_visible_child_name("voice");
    until("mapped voice card", || page.voice.cards.is_mapped() && page.voice.cards.width() > 0);
    settle();
    assert!(shadows(&page.voice.cards).positive_blur > 0, "normal renderer retains its original speaking glow");
    assert!(crate::style::apply_windows_cairo_shadows(&window, true));
    settle();
    let protected = shadows(&page.voice.cards);
    assert_eq!(protected.positive_blur, 0, "protected speaking card must not allocate a blur mask");
    assert!(protected.green_halo > 0, "the speaking feedback remains green");

    for _ in 0..3 {
        // Actual native navigation changes the visible GtkStack page and
        // focuses the real composer; the voice view is retained, not torn down.
        page.open_native_room("ordinary-room");
        until("mapped ordinary composer", || page.composer.root.is_mapped());
        settle();
        assert_eq!(page.current_rid().as_deref(), Some("ordinary-room"));
        assert_eq!(page.voice.shown.borrow().as_deref(), Some("room-id"));
        let ordinary = shadows(&page.composer.root);
        assert_eq!(ordinary.positive_blur, 0, "protected send button must not allocate a blur mask");
        assert!(ordinary.pink_feedback > 0, "send feedback remains pink");
        page.content_stack.set_visible_child_name("voice");
        until("voice restored", || page.voice.cards.is_mapped());
        assert_eq!(shadows(&page.voice.cards).positive_blur, 0);
    }
    // The profile is scoped: removing it restores the original renderer's
    // speaking glow rather than silently changing every platform's theme.
    assert!(!crate::style::apply_windows_cairo_shadows(&window, false));
    settle();
    assert!(shadows(&page.voice.cards).positive_blur > 0);
    page.set_session(None);
    gtk::prelude::GtkWindowExt::set_focus(&window, None::<&gtk::Widget>);
    window.close();
    drop(window);
    drop(page);
    session.shutdown();
    until("native session holders released", || Arc::strong_count(&session) == 1);
    executor.block_on(http::close_native(session));
    let _ = std::fs::remove_file(path);
}
