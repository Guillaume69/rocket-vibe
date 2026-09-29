//! The emoji picker: search, categories, a grid; picking inserts at the
//! cursor and leaves the picker open for the next one. The server's own
//! emoji have a tab of their own and come first in a search.

use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;

use gtk::glib;
use gtk::prelude::*;
use rv_core::emoji;

use crate::i18n::t;

const TABS: [(&str, &str); 8] = [
    ("people", "😀"),
    ("nature", "🐻"),
    ("food", "🍔"),
    ("activity", "⚽"),
    ("travel", "🚗"),
    ("objects", "💡"),
    ("symbols", "❤️"),
    ("flags", "🏳️"),
];

thread_local! {
    static DRAWABLE: RefCell<HashMap<&'static str, bool>> = RefCell::default();
}

/// Whether this machine's fonts draw the glyph as one emoji: not as a box,
/// nor as the pieces of a sequence they do not know.
fn drawable(widget: &impl IsA<gtk::Widget>, glyph: &'static str) -> bool {
    if let Some(known) = DRAWABLE.with_borrow(|d| d.get(glyph).copied()) {
        return known;
    }
    let measure = |text: &str| {
        let layout = widget.create_pango_layout(Some(text));
        (layout.unknown_glyphs_count(), layout.pixel_size().0)
    };
    let (_, reference) = measure("😀");
    let (unknown, width) = measure(glyph);
    let ok = unknown == 0 && width * 2 <= reference * 3;
    DRAWABLE.with_borrow_mut(|d| d.insert(glyph, ok));
    ok
}

/// The server's emoji, by name.
pub type CustomSource = Rc<dyn Fn() -> Vec<String>>;

fn clear(grid: &gtk::FlowBox) {
    while let Some(child) = grid.first_child() {
        grid.remove(&child);
    }
}

fn custom_image(code: &str) -> Option<gtk::Widget> {
    let image = crate::markdown_view::custom_emoji(code)?;
    image.set_size_request(28, 28);
    image.set_tooltip_text(None);
    Some(image)
}

fn add_custom(grid: &gtk::FlowBox, codes: &[String], pick: &Rc<dyn Fn(&str)>) {
    for code in codes {
        let Some(image) = custom_image(code) else { continue };
        let button = gtk::Button::builder()
            .child(&image)
            .tooltip_text(format!(":{code}:"))
            .css_classes(["picker-emoji"])
            .build();
        let (pick, text) = (pick.clone(), format!(":{code}: "));
        button.connect_clicked(move |_| pick(&text));
        grid.insert(&button, -1);
    }
}

fn add_unicode(grid: &gtk::FlowBox, codes: &[&'static str], pick: &Rc<dyn Fn(&str)>) {
    for code in codes {
        let Some(glyph) = emoji::unicode(code) else { continue };
        if !drawable(grid, glyph) {
            continue;
        }
        let button =
            gtk::Button::builder().label(glyph).tooltip_text(format!(":{code}:")).css_classes(["picker-emoji"]).build();
        let pick = pick.clone();
        button.connect_clicked(move |_| pick(glyph));
        grid.insert(&button, -1);
    }
}

/// The 😊 button opening the picker; `pick` receives the chosen glyph, or a
/// server emoji's `:code:`.
pub fn button(pick: impl Fn(&str) + 'static, custom: CustomSource) -> gtk::MenuButton {
    let pick: Rc<dyn Fn(&str)> = Rc::new(pick);
    let search = gtk::SearchEntry::builder().placeholder_text(":").build();
    let grid = gtk::FlowBox::builder()
        .selection_mode(gtk::SelectionMode::None)
        .max_children_per_line(9)
        .min_children_per_line(9)
        .homogeneous(true)
        .valign(gtk::Align::Start)
        .build();
    let scroll = gtk::ScrolledWindow::builder()
        .hscrollbar_policy(gtk::PolicyType::Never)
        .min_content_height(280)
        .min_content_width(360)
        .child(&grid)
        .build();
    let tabs = gtk::Box::builder().spacing(2).homogeneous(true).build();
    let server_tab = gtk::Button::builder()
        .tooltip_text(t("emoji.server"))
        .css_classes(["flat", "picker-tab"])
        .visible(false)
        .build();
    server_tab.connect_clicked(glib::clone!(
        #[weak]
        grid,
        #[weak]
        search,
        #[strong]
        pick,
        #[strong]
        custom,
        move |_| {
            search.set_text("");
            clear(&grid);
            add_custom(&grid, &custom(), &pick);
        }
    ));
    tabs.append(&server_tab);
    for (category, glyph) in TABS {
        let tab =
            gtk::Button::builder().label(glyph).tooltip_text(category).css_classes(["flat", "picker-tab"]).build();
        let (grid, pick, search) = (grid.clone(), pick.clone(), search.clone());
        tab.connect_clicked(move |_| {
            search.set_text("");
            clear(&grid);
            add_unicode(&grid, emoji::category(category), &pick);
        });
        tabs.append(&tab);
    }
    search.connect_search_changed(glib::clone!(
        #[weak]
        grid,
        #[strong]
        pick,
        #[strong]
        custom,
        move |entry| {
            let query = entry.text().trim_matches(':').to_lowercase();
            clear(&grid);
            if query.is_empty() {
                add_unicode(&grid, emoji::category("people"), &pick);
                return;
            }
            let own: Vec<String> = custom().into_iter().filter(|code| code.to_lowercase().contains(&query)).collect();
            add_custom(&grid, &own, &pick);
            let hits: Vec<&'static str> = emoji::complete(&query, 180).into_iter().map(|(code, _)| code).collect();
            add_unicode(&grid, &hits, &pick);
        }
    ));
    let column = gtk::Box::builder().orientation(gtk::Orientation::Vertical).spacing(6).build();
    column.append(&search);
    column.append(&tabs);
    column.append(&scroll);
    let popover = gtk::Popover::builder().child(&column).css_classes(["emoji-picker"]).build();
    let filled = std::cell::Cell::new(false);
    popover.connect_show(move |_| {
        let icon = custom().first().and_then(|code| custom_image(code));
        server_tab.set_child(icon.as_ref());
        server_tab.set_visible(icon.is_some());
        if !filled.replace(true) {
            add_unicode(&grid, emoji::category("people"), &pick);
        }
    });
    gtk::MenuButton::builder()
        .icon_name("face-smile-symbolic")
        .popover(&popover)
        .css_classes(["flat", "emoji-button"])
        .valign(gtk::Align::End)
        .build()
}
