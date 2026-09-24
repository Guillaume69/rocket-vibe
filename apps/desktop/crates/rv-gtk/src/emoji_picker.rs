//! The emoji picker: search, categories, a grid; picking inserts at the
//! cursor and leaves the picker open for the next one.

use std::rc::Rc;

use gtk::glib;
use gtk::prelude::*;
use rv_core::emoji;

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

fn fill(grid: &gtk::FlowBox, codes: &[&'static str], pick: &Rc<dyn Fn(&str)>) {
    while let Some(child) = grid.first_child() {
        grid.remove(&child);
    }
    for code in codes {
        let Some(glyph) = emoji::unicode(code) else { continue };
        let button =
            gtk::Button::builder().label(glyph).tooltip_text(format!(":{code}:")).css_classes(["picker-emoji"]).build();
        let pick = pick.clone();
        button.connect_clicked(move |_| pick(glyph));
        grid.insert(&button, -1);
    }
}

/// The 😊 button opening the picker; `pick` receives the chosen glyph.
pub fn button(pick: impl Fn(&str) + 'static) -> gtk::MenuButton {
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
    for (category, glyph) in TABS {
        let tab =
            gtk::Button::builder().label(glyph).tooltip_text(category).css_classes(["flat", "picker-tab"]).build();
        let (grid, pick, search) = (grid.clone(), pick.clone(), search.clone());
        tab.connect_clicked(move |_| {
            search.set_text("");
            fill(&grid, emoji::category(category), &pick);
        });
        tabs.append(&tab);
    }
    search.connect_search_changed(glib::clone!(
        #[weak]
        grid,
        #[strong]
        pick,
        move |entry| {
            let query = entry.text();
            if query.is_empty() {
                fill(&grid, emoji::category("people"), &pick);
            } else {
                let hits: Vec<&'static str> = emoji::complete(&query, 180).into_iter().map(|(code, _)| code).collect();
                fill(&grid, &hits, &pick);
            }
        }
    ));
    let column = gtk::Box::builder().orientation(gtk::Orientation::Vertical).spacing(6).build();
    column.append(&search);
    column.append(&tabs);
    column.append(&scroll);
    let popover = gtk::Popover::builder().child(&column).css_classes(["emoji-picker"]).build();
    let filled = std::cell::Cell::new(false);
    popover.connect_show(move |_| {
        if !filled.replace(true) {
            fill(&grid, emoji::category("people"), &pick);
        }
    });
    gtk::MenuButton::builder()
        .child(&gtk::Label::new(Some("😊")))
        .popover(&popover)
        .css_classes(["flat", "emoji-button"])
        .valign(gtk::Align::End)
        .build()
}
