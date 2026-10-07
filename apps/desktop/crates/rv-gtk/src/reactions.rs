//! The quick reactions of the message menus: the emoji I react with most on
//! this account (rv-core's `EmojiUsage`), then "+" opening the picker to react
//! with any other one.

use std::rc::Rc;
use std::sync::Arc;

use gtk::glib;
use gtk::prelude::*;
use rv_core::emoji_usage::{self, EmojiUsage, QUICK_COUNT};

use crate::emoji_picker::{self, CustomSource, Pick};
use crate::i18n::t;

/// Reacts with a code (no colons): `true` adds, `false` withdraws.
pub type React = Rc<dyn Fn(String, bool)>;

/// The counts of one account (`<host>-<user id>`), shared with every other
/// user of the file (rv-core keeps one per account).
pub fn usage(base_url: &str, user_id: &str) -> Arc<EmojiUsage> {
    EmojiUsage::for_account(&glib::user_config_dir().join("rocket-vibe-rs"), base_url, user_id)
}

/// One more use of `code` on that account: every reaction I add counts.
pub fn record(base_url: &str, user_id: &str, code: &str) {
    usage(base_url, user_id).record(code);
}

fn custom_image(code: &str) -> Option<gtk::Widget> {
    let image = crate::markdown_view::custom_emoji(code)?;
    image.set_size_request(24, 24);
    image.set_tooltip_text(None);
    Some(image)
}

/// What a server takes as a reaction: Rocket.Chat only standard emoji it has
/// a name for (`rv_core::emoji::rc_reaction`), RocketVibe any standard one.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Server {
    RocketChat,
    RocketVibe,
}

impl Server {
    fn takes(self, code: &str) -> bool {
        self == Server::RocketVibe || rv_core::emoji::rc_reaction(code).is_some()
    }
}

/// The row on top of a menu: my most used emoji (`mine` outlined, a click
/// withdraws them), then "+". Without `custom`, standard emoji only.
pub fn row(
    menu: &gtk::Popover,
    usage: &EmojiUsage,
    mine: &[String],
    custom: Option<CustomSource>,
    server: Server,
    react: React,
) -> gtk::Box {
    let quick = gtk::Box::builder().spacing(4).margin_bottom(4).css_classes(["quick-reactions"]).build();
    let custom_names: Vec<String> = custom.as_ref().map(|names| names()).unwrap_or_default();
    let codes = usage.top_filtered(QUICK_COUNT, |code| match rv_core::emoji::unicode(code) {
        Some(_) => server.takes(code),
        None => custom_names.iter().any(|name| name == code),
    });
    let shown = codes.into_iter().filter_map(|code| {
        let glyph = rv_core::emoji::unicode(&code);
        let image = if glyph.is_none() { custom_image(&code) } else { None };
        (glyph.is_some() || image.is_some()).then_some((code, glyph, image))
    });
    for (code, glyph, image) in shown {
        // Withdrawing names my reaction as the server keyed it (maybe an alias).
        let withdraw = mine.iter().find(|m| emoji_usage::same(m, &code)).map(|m| emoji_usage::normalize(m).to_owned());
        let is_mine = withdraw.is_some();
        let button = gtk::Button::builder()
            .tooltip_text(format!(":{code}:"))
            .css_classes(if is_mine { vec!["quick-reaction", "mine"] } else { vec!["quick-reaction"] })
            .build();
        match (glyph, image) {
            (Some(glyph), _) => button.set_label(glyph),
            (None, Some(image)) => button.set_child(Some(&image)),
            (None, None) => continue,
        }
        let (menu, react) = (menu.clone(), react.clone());
        button.connect_clicked(move |_| {
            menu.popdown();
            match &withdraw {
                Some(own) => react(own.clone(), false),
                None => react(code.clone(), true),
            }
        });
        quick.append(&button);
    }
    let more = gtk::Button::builder()
        .icon_name("list-add-symbolic")
        .tooltip_text(t("actions.react_more"))
        .css_classes(["quick-reaction", "more-reactions"])
        .build();
    let menu = menu.clone();
    more.connect_clicked(move |_| {
        let Some(anchor) = menu.parent() else { return };
        let (_, rect) = menu.pointing_to();
        menu.popdown();
        let react = react.clone();
        let picker = emoji_picker::popover(
            move |chosen| match chosen {
                Pick::Standard(code, _) => react(emoji_usage::canonical(code), true),
                Pick::Custom(name) => react(name, true),
            },
            custom.clone(),
            true,
            Some(Rc::new(move |code: &str| server.takes(code))),
        );
        picker.add_css_class("reaction-picker");
        picker.set_parent(&anchor);
        picker.set_pointing_to(Some(&rect));
        picker.connect_closed(|p| {
            let p = p.clone();
            glib::idle_add_local_once(move || p.unparent());
        });
        picker.popup();
    });
    quick.append(&more);
    quick
}
