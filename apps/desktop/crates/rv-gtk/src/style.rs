//! "Nuit Étoilée", the Android app's theme, on top of libadwaita's dark style.

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
  --headerbar-bg-color: #0C0B16;
  --headerbar-fg-color: #F3F0FF;
  --headerbar-shade-color: #1E1B33;
  --sidebar-bg-color: #0F0E1C;
  --sidebar-fg-color: #F3F0FF;
  --card-bg-color: #171529;
  --popover-bg-color: #171529;
  --dialog-bg-color: #171529;
  --destructive-color: #FF7A8A;
  --error-color: #FF7A8A;
}

window, label, entry, textview, button { font-family: "Nunito"; }

.brand { font-family: "Baloo 2"; font-weight: 800; }
.brand-hero { font-size: 32px; }
.brand-header { font-size: 23px; }
.unicorn-hero { font-size: 46px; }
.unicorn-header { font-size: 21px; }
.slogan { color: #8F89AB; font-size: 13px; }
.rainbow-bar { min-width: 26px; min-height: 5px; border-radius: 3px; }
.rainbow-pink { background: #FF5FA2; }
.rainbow-yellow { background: #FFD34E; }
.rainbow-cyan { background: #34E1D0; }
.rainbow-violet { background: #A78BFA; }
.shield { font-size: 34px; }
.step-title { font-family: "Baloo 2"; font-weight: 700; font-size: 21px; }
.step-intro { color: #8F89AB; font-size: 13px; }
.back-link { color: #F3F0FF; font-family: "Baloo 2"; font-weight: 700; font-size: 17px; }
.back-link .chevron { color: #A78BFA; font-size: 26px; }
.login-error { color: #FF7A8A; font-weight: 700; font-size: 14px; }

.pill-caption { color: #8F89AB; font-weight: 700; font-size: 12.5px; margin-left: 4px; }
entry.pill-entry {
  background: #171529;
  color: #F3F0FF;
  border: 1.5px solid #2C2946;
  border-radius: 16px;
  min-height: 24px;
  padding: 11px 15px;
  font-weight: 600;
  font-size: 15px;
  outline: none;
  box-shadow: none;
  transition: border-color 150ms, box-shadow 150ms;
}
entry.pill-entry:focus-within { border-color: #34E1D0; box-shadow: 0 0 0 3px rgba(52, 225, 208, 0.14); }
entry.pill-entry.code { font-family: "Baloo 2"; font-weight: 700; font-size: 26px; letter-spacing: 8px; }

button.cta {
  background-image: linear-gradient(90deg, #FF5FA2, #A78BFA);
  color: #0B0913;
  border-radius: 16px;
  min-height: 52px;
  font-family: "Baloo 2";
  font-weight: 700;
  font-size: 16px;
  box-shadow: 0 10px 24px -6px rgba(255, 95, 162, 0.6);
  transition: opacity 150ms, box-shadow 150ms;
}
button.cta:hover { box-shadow: 0 12px 28px -6px rgba(255, 95, 162, 0.8); }
button.cta:active, button.cta:disabled { opacity: 0.75; }

.tile { border-radius: 15px; }
.tile-room { border-radius: 15px; }
.tile-message { border-radius: 12px; }
.tile-header { border-radius: 10px; }
.tile-profile { border-radius: 28px; }
.tile-profile .tile-glyph { font-size: 38px; }
.details { padding: 4px 22px 22px 22px; }
.details-name { font-family: "Baloo 2"; font-size: 24px; font-weight: 800; }
.details-sub { color: #8F89AB; }
.details-section { font-size: 11.5px; font-weight: 800; color: #8F89AB; margin-top: 8px; }
.role-chip { background: #2C2946; border-radius: 999px; padding: 2px 10px; font-size: 12px; font-weight: 700; }
.search-hit { padding: 8px 6px; }
.tile-glyph { color: #FFFFFF; font-family: "Baloo 2"; font-weight: 800; }
.tile-room .tile-glyph { font-size: 17.6px; }
.tile-message .tile-glyph { font-size: 13.6px; }
.tile-header .tile-glyph { font-size: 12px; }
.tile-g0 { background-image: linear-gradient(135deg, #FF5FA2, #A78BFA); }
.tile-g1 { background-image: linear-gradient(135deg, #A78BFA, #5CC8FF); }
.tile-g2 { background-image: linear-gradient(135deg, #5CC8FF, #34E1D0); }
.tile-g3 { background-image: linear-gradient(135deg, #FFD34E, #FF9BD0); }
.tile-g4 { background-image: linear-gradient(135deg, #FF5FA2, #FF9BD0); }
.tile-g5 { background-image: linear-gradient(135deg, #34E1D0, #A78BFA); }
.tile-g6 { background-image: linear-gradient(135deg, #FFD34E, #FF5FA2); }
.tile-neutral { background-image: linear-gradient(135deg, #8F89AB, #5A5573); }

.badge { border-radius: 11px; min-width: 22px; min-height: 22px; padding: 0 7px; font-weight: 800; font-size: 12px; }
.badge-unread { background: #FFD34E; color: #0B0913; }
.badge-mention { background: #FF5FA2; color: #0B0913; }

.comet {
  min-height: 3px;
  background-image: linear-gradient(90deg, rgba(255, 95, 162, 0), #FF5FA2, #A78BFA, #34E1D0, rgba(52, 225, 208, 0));
  background-size: 30% 3px;
  background-repeat: no-repeat;
  background-position: -50% 0;
  opacity: 0;
  transition: opacity 400ms;
}
.comet.active { opacity: 1; animation: comet-sweep 1.4s linear infinite; }
@keyframes comet-sweep {
  from { background-position: -50% 0; }
  to { background-position: 150% 0; }
}

.rooms { background: transparent; }
.rooms > row { border-radius: 18px; margin: 1px 8px; padding: 0; }
.rooms > row:hover { background: rgba(30, 27, 51, 0.6); }
.rooms > row:selected { background: #1E1B33; }
.room-name { font-weight: 700; font-size: 15px; color: #C9C3E0; }
.room-name.unread { font-weight: 800; color: #F3F0FF; }
.room-preview { font-size: 12.5px; color: #8F89AB; }
.room-preview.unread { color: #C9C3E0; }
.room-preview.encrypted { font-style: italic; }
.room-time { font-size: 11px; color: #6E6890; }
.room-time.unread { color: #FFD34E; font-weight: 700; }
.account { border-top: 1px solid #1E1B33; padding: 10px 14px; }
.account-name { font-weight: 800; font-size: 13.5px; }
.account-host { color: #6E6890; font-size: 11.5px; }
.attach-dialog { padding: 6px 18px 18px 18px; }
.attach-thumb { background: #171529; border-radius: 10px; }
button.attach-button { min-width: 28px; min-height: 24px; padding: 0 2px; color: #8F89AB; }
.upload-strip { margin: 0 16px 4px 16px; }
.upload-row { background: #171529; border: 1px solid #2C2946; border-radius: 12px; padding: 6px 10px; }
.upload-row.failed { border-color: #FF7A8A; }
.upload-row progressbar trough { min-height: 4px; border-radius: 2px; background: #2C2946; }
.upload-row progressbar progress { min-height: 4px; border-radius: 2px; background: linear-gradient(90deg, #FF5FA2, #A78BFA); }
.section-header { margin: 12px 14px 2px 10px; }
.section-title { font-size: 11.5px; font-weight: 800; color: #8F89AB; letter-spacing: 0.6px; }
.section-chevron { color: #6E6890; -gtk-icon-size: 12px; }
.section-count { font-size: 11px; font-weight: 800; color: #6E6890; margin-left: 4px; }
.section-header:hover .section-title { color: #C9C3E0; }
.spotlight { padding: 6px 14px 14px 14px; }
.spotlight-row { padding: 6px 4px; }
.probe { font-size: 12.5px; color: #3ED67F; }
.probe.bad { color: #FF7A8A; }
button.known-server { background: #171529; border: 1px solid #2C2946; border-radius: 999px; padding: 2px 12px; min-height: 26px; font-size: 12.5px; }
.e2e-banner { background: #171529; border: 1px solid #2C2946; border-radius: 12px; padding: 8px 12px; margin: 8px 16px 0 16px; }
textview.inline-images, textview.inline-images text { background: transparent; color: #E7E3F5; }
.custom-emoji { min-width: 22px; min-height: 22px; }
.record-bar { background: #171529; border: 2px solid #FF5FA2; border-radius: 999px; padding: 6px 8px 6px 16px; }
.record-dot { background: #FF5F6D; border-radius: 999px; min-width: 10px; min-height: 10px; }
.record-time { font-weight: 800; font-feature-settings: "tnum"; }
.new-marker { color: #FF5FA2; font-weight: 800; font-size: 12px; }
.new-line { background: #FF5FA2; min-height: 1px; opacity: 0.6; }
.typing { color: #A78BFA; font-size: 12px; font-style: italic; margin: 0 22px 2px 22px; }
.presence { border-radius: 999px; min-width: 9px; min-height: 9px; }
.presence-badge { min-width: 12px; min-height: 12px; border: 2px solid #0D0B1A; }
.presence.online { background: #3ED67F; }
.presence.away { background: #FFC24B; }
.presence.busy { background: #FF5F6D; }
.presence.offline { background: #5A5573; }
.room-subtitle { font-size: 11.5px; color: #8F89AB; }
.status-dot { border-radius: 5px; min-width: 10px; min-height: 10px; }
.status-dot.online { background: #3ED67F; }
.status-dot.connecting { background: #FFC24B; }
.status-dot.offline { background: #5A5573; }
.room-title { font-family: "Baloo 2"; font-weight: 700; font-size: 17px; }
.empty-title { font-family: "Baloo 2"; font-weight: 800; font-size: 22px; }
.empty-hint { color: #8F89AB; }

.author { font-weight: 800; font-size: 13.5px; color: #F3F0FF; }
.author.mine { color: #FF5FA2; }
.message-time { color: #6E6890; font-size: 10.5px; }
.gutter-time { color: #6E6890; font-size: 9px; }
.message-body { color: #E7E3F5; font-size: 14px; }
.message-body.pending { opacity: 0.55; }
.message-body link, .message-body a { color: #5CC8FF; }
.md-h1, .md-h2, .md-h3, .md-h4 { font-family: "Baloo 2"; font-weight: 700; color: #F3F0FF; }
.md-h1 { font-size: 20px; }
.md-h2 { font-size: 18px; }
.md-h3 { font-size: 16px; }
.md-h4 { font-size: 15px; }
.md-quote { border-left: 3px solid #2C2946; padding-left: 10px; margin: 2px 0; }
.md-code { background: #171529; border-radius: 8px; padding: 8px 10px; margin: 2px 0; }
.md-code-text { font-family: monospace; font-size: 13px; color: #E7E3F5; }
.md-big-emoji { font-size: 36px; }
.message-body.failed { color: #FF7A8A; }
.message-note { color: #6E6890; font-size: 11px; }
.system-message { font-style: italic; color: #8F89AB; font-size: 13px; }
.thread-chip { border: 1px solid #A78BFA; border-radius: 999px; padding: 4px 11px; color: #A78BFA; font-weight: 700; font-size: 12px; }
button.retry { color: #FF7A8A; font-weight: 700; font-size: 12px; padding: 0 4px; min-height: 0; }
.quote-card { border-left: 3px solid #A78BFA; background: #171529; border-radius: 4px 10px 10px 4px; padding: 6px 10px; margin: 3px 0; }
.quote-card .quote-card { background: #1E1B33; }
.quote-author { font-weight: 800; font-size: 12.5px; color: #A78BFA; }
.file-card, .link-card, .call-card { background: #171529; border: 1px solid #2C2946; border-radius: 12px; padding: 10px 12px; margin-top: 4px; }
.file-icon { font-size: 26px; }
.file-title { font-weight: 700; }
.file-detail, .link-site { font-size: 12px; color: #8F89AB; }
button.file-action, button.call-join { background: linear-gradient(135deg, #FF5FA2, #A78BFA); color: #0D0B1A; font-weight: 800; border-radius: 999px; padding: 2px 14px; min-height: 28px; }
.link-title { font-weight: 800; color: #E7E3F5; }
.link-description { font-size: 13px; color: #BDB7D6; }
.preview-image { background: #0D0B1A; border-radius: 10px; }
.call-title { font-weight: 800; }
.video-frame { background: #000000; border-radius: 12px; }
.video-bar { background: linear-gradient(0deg, rgba(0, 0, 0, 0.75), rgba(0, 0, 0, 0)); padding: 18px 8px 4px 8px; color: #FFFFFF; }
.video-bar button { color: #FFFFFF; }
.image-attachment { background: #171529; border-radius: 10px; }
.message .row-more { opacity: 0; min-height: 24px; min-width: 28px; padding: 0; color: #8F89AB; transition: opacity 120ms; }
.message:hover .row-more { opacity: 1; }
button.reaction { background: #171529; border: 1px solid #2C2946; border-radius: 999px; padding: 2px 9px; min-height: 0; font-size: 12.5px; }
button.reaction.mine { border-color: #FF5FA2; background: rgba(255, 95, 162, 0.12); }
button.thread-chip { background: transparent; min-height: 0; }
.actions-menu contents { padding: 8px; background: #171529; border-radius: 14px; }
button.quick-reaction { font-size: 20px; min-width: 40px; min-height: 40px; padding: 0; border-radius: 999px; background: transparent; }
button.quick-reaction.mine { background: rgba(255, 95, 162, 0.18); box-shadow: inset 0 0 0 1.5px #FF5FA2; }
button.menu-action { padding: 6px 10px; min-height: 0; }
button.menu-action.destructive { color: #FF7A8A; }
.edit-field textview, .edit-field text { background: transparent; color: #F3F0FF; font-size: 14px; }
.edit-field { background: #171529; border: 1.5px solid #34E1D0; border-radius: 12px; padding: 8px 10px; }
button.edit-button { min-height: 0; padding: 3px 12px; font-weight: 700; font-size: 12.5px; border-radius: 999px; }
button.edit-button.save { background: linear-gradient(135deg, #FF5FA2, #A78BFA); color: #0D0B1A; }
.reply-bar { background: #171529; border-left: 3px solid #A78BFA; border-radius: 10px; padding: 6px 10px; }
.reply-title { color: #A78BFA; font-weight: 700; font-size: 12.5px; }
.reply-preview { color: #8F89AB; font-size: 12.5px; }
.completion { background: #171529; border-radius: 12px; padding: 4px; }
.completion row { border-radius: 8px; padding: 4px 10px; }
.completion row:selected { background: #2C2946; }
.completion-item { font-size: 14px; }
menubutton.emoji-button > button { min-width: 28px; min-height: 24px; padding: 0 2px; color: #8F89AB; background: transparent; }
button.picker-emoji { font-size: 22px; min-width: 36px; min-height: 36px; padding: 0; background: transparent; border-radius: 8px; }
button.picker-emoji:hover { background: #2C2946; }
button.picker-tab { font-size: 18px; min-height: 30px; padding: 0; }
.day-line { background: #2C2946; min-height: 1px; border-radius: 1px; }
.day-label { color: #8F89AB; font-weight: 600; font-size: 11.5px; }

.composer-pill {
  background: #171529;
  border: 1.5px solid #2C2946;
  border-radius: 22px;
  padding: 10px 16px;
  min-height: 20px;
  transition: border-color 150ms, box-shadow 150ms;
}
.composer-pill:focus-within { border-color: #34E1D0; box-shadow: 0 0 0 3px rgba(52, 225, 208, 0.14); }
.composer-pill scrolledwindow, .composer-pill textview, .composer-pill text { background: transparent; color: #F3F0FF; font-size: 14.5px; min-height: 0; }
.composer-placeholder { color: #6E6890; font-size: 14.5px; }
button.jump-latest { background: #2C2946; color: #F3F0FF; min-width: 40px; min-height: 40px; box-shadow: 0 6px 16px -6px rgba(0, 0, 0, 0.8); }
button.jump-latest:hover { background: #3A3660; }
button.send {
  background-image: linear-gradient(135deg, #FF5FA2, #A78BFA);
  color: #0B0913;
  border-radius: 999px;
  min-width: 44px;
  min-height: 44px;
  padding: 0;
  box-shadow: 0 6px 16px -6px rgba(255, 95, 162, 0.7);
}
"#;

pub fn load() {
    crate::fonts::register();
    adw::StyleManager::default().set_color_scheme(adw::ColorScheme::ForceDark);
    let provider = gtk::CssProvider::new();
    provider.load_from_string(CSS);
    gtk::style_context_add_provider_for_display(
        &gdk::Display::default().expect("display"),
        &provider,
        gtk::STYLE_PROVIDER_PRIORITY_APPLICATION,
    );
}
