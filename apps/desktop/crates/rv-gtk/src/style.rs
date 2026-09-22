//! The Android app's palette on top of libadwaita's dark style.

use gtk::gdk;

const CSS: &str = r#"
:root {
  --accent-bg-color: #FF5FA2;
  --accent-fg-color: #0B0913;
  --accent-color: #FF7AB4;
  --window-bg-color: #0C0B16;
  --window-fg-color: #F3F0FF;
  --view-bg-color: #0C0B16;
  --view-fg-color: #E7E3F5;
  --headerbar-bg-color: #141227;
  --headerbar-fg-color: #F3F0FF;
  --sidebar-bg-color: #141227;
  --sidebar-fg-color: #F3F0FF;
  --card-bg-color: #171529;
  --popover-bg-color: #171529;
  --dialog-bg-color: #171529;
  --destructive-color: #FF7A8A;
  --error-color: #FF7A8A;
}
.brand { color: #FF5FA2; font-weight: 800; font-size: 28pt; }
.room-name { font-weight: 600; }
.room-name.unread { font-weight: 800; }
.room-time.unread { color: #FF5FA2; }
.badge { background: #1E1B33; border-radius: 10px; padding: 0 7px; font-size: 9pt; font-weight: 800; min-height: 20px; }
.badge.mention { background: #FF5FA2; color: #0B0913; }
.author { font-weight: 800; }
.author.mine { color: #FF5FA2; }
.system-message { font-style: italic; color: #8F89AB; }
.message-body { color: #E7E3F5; }
.message-body.pending { opacity: 0.55; }
.message-body.failed { color: #FF7A8A; }
.replies { color: #A78BFA; }
.composer { background: #171529; border-radius: 12px; padding: 8px 10px; }
.composer textview, .composer text { background: transparent; }
.status-dot { border-radius: 5px; min-width: 10px; min-height: 10px; }
.status-dot.online { background: #3ED67F; }
.status-dot.connecting { background: #FFC24B; }
.status-dot.offline { background: #5A5573; }
"#;

pub fn load() {
    adw::StyleManager::default().set_color_scheme(adw::ColorScheme::ForceDark);
    let provider = gtk::CssProvider::new();
    provider.load_from_string(CSS);
    gtk::style_context_add_provider_for_display(
        &gdk::Display::default().expect("display"),
        &provider,
        gtk::STYLE_PROVIDER_PRIORITY_APPLICATION,
    );
}
