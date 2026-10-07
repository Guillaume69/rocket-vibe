//! A large dialog with clickable categories on the left and the chosen one's
//! page on the right, for the settings and the server administration. About
//! 85 % of the window, capped near 1100 x 800; a single pane under a narrow
//! width. Escape, the close button and a click on the dimmed backdrop close it.

use std::cell::{Cell, RefCell};
use std::rc::Rc;

use adw::prelude::*;
use gtk::glib;

const MAX_SIZE: (i32, i32) = (1100, 800);
const MIN_SIZE: (i32, i32) = (360, 360);
/// Below this width the sidebar and the page share one pane.
const COLLAPSE_BELOW: f64 = 640.0;

type Build = Box<dyn FnOnce(&Host) -> adw::PreferencesPage>;

struct Entry {
    id: String,
    title: String,
    page: Option<adw::NavigationPage>,
    build: Option<Build>,
}

/// The dialog being built: categories added in order, the first one shown
/// unless another is selected before `present`.
#[derive(Clone)]
pub struct SidebarDialog {
    dialog: adw::Dialog,
    list: gtk::ListBox,
    footer: gtk::Box,
    entries: Rc<RefCell<Vec<Entry>>>,
    host: Host,
}

/// What a category's page may ask of the dialog holding it. It holds the
/// dialog weakly: a page keeping one does not keep the dialog alive.
#[derive(Clone)]
pub struct Host {
    dialog: glib::WeakRef<adw::Dialog>,
    split: glib::WeakRef<adw::NavigationSplitView>,
    list: glib::WeakRef<gtk::ListBox>,
    navigation: glib::WeakRef<adw::NavigationView>,
    toasts: glib::WeakRef<adw::ToastOverlay>,
    closed: Rc<Cell<bool>>,
}

impl SidebarDialog {
    /// `class` names the dialog for the theme and the smoke tests.
    pub fn new(title: &str, class: &str) -> Self {
        let list = gtk::ListBox::builder()
            .selection_mode(gtk::SelectionMode::Single)
            .css_classes(["navigation-sidebar", "sidebar-categories"])
            .build();
        let footer = gtk::Box::builder()
            .orientation(gtk::Orientation::Vertical)
            .spacing(2)
            .margin_start(6)
            .margin_end(6)
            .margin_top(6)
            .margin_bottom(6)
            .css_classes(["sidebar-footer"])
            .build();
        let scroller =
            gtk::ScrolledWindow::builder().hscrollbar_policy(gtk::PolicyType::Never).vexpand(true).child(&list).build();
        let side = adw::ToolbarView::new();
        side.add_top_bar(&adw::HeaderBar::new());
        side.set_content(Some(&scroller));
        side.add_bottom_bar(&footer);
        let sidebar = adw::NavigationPage::builder().title(title).tag("sidebar").child(&side).build();
        let navigation = adw::NavigationView::new();
        let toasts = adw::ToastOverlay::new();
        toasts.set_child(Some(&navigation));
        let content = adw::NavigationPage::builder().title(title).tag("content").child(&toasts).build();
        let split = adw::NavigationSplitView::builder()
            .sidebar(&sidebar)
            .content(&content)
            .min_sidebar_width(220.0)
            .max_sidebar_width(280.0)
            .build();
        // A breakpoint needs the smallest size the dialog still works at.
        let dialog = adw::Dialog::builder()
            .title(title)
            .child(&split)
            .width_request(MIN_SIZE.0)
            .height_request(MIN_SIZE.1)
            .css_classes([class, "sidebar-dialog"])
            .build();
        let narrow = adw::Breakpoint::new(adw::BreakpointCondition::new_length(
            adw::BreakpointConditionLengthType::MaxWidth,
            COLLAPSE_BELOW,
            adw::LengthUnit::Sp,
        ));
        narrow.add_setter(&split, "collapsed", Some(&true.to_value()));
        dialog.add_breakpoint(narrow);
        let closed = Rc::new(Cell::new(false));
        let flag = closed.clone();
        dialog.connect_closed(move |_| flag.set(true));
        let host = Host {
            dialog: dialog.downgrade(),
            split: split.downgrade(),
            list: list.downgrade(),
            navigation: navigation.downgrade(),
            toasts: toasts.downgrade(),
            closed,
        };
        let entries: Rc<RefCell<Vec<Entry>>> = Rc::default();
        let (shown, h, page_title) = (entries.clone(), host.clone(), content.downgrade());
        list.connect_row_selected(move |_, row| {
            let Some(row) = row else { return };
            let id = row.widget_name();
            let Some((title, page)) = page_of(&shown, &h, &id) else { return };
            if let Some(content) = page_title.upgrade() {
                content.set_title(&title);
            }
            if let Some(navigation) = h.navigation.upgrade() {
                navigation.replace(&[page]);
            }
        });
        let h = host.clone();
        list.connect_row_activated(move |_, _| {
            if let Some(split) = h.split.upgrade() {
                split.set_show_content(true);
            }
        });
        Self { dialog, list, footer, entries, host }
    }

    pub fn host(&self) -> Host {
        self.host.clone()
    }

    pub fn dialog(&self) -> &adw::Dialog {
        &self.dialog
    }

    /// A category whose page is built now.
    pub fn add(&self, id: &str, icon: &str, title: &str, page: &adw::PreferencesPage) {
        self.append(id, icon, title, Some(wrap(title, id, page)), None);
    }

    /// A category whose page is not a preferences page (the administration's
    /// dashboard of cards); `content` scrolls by itself.
    pub fn add_content(&self, id: &str, icon: &str, title: &str, content: &impl IsA<gtk::Widget>) {
        self.append(id, icon, title, Some(wrap(title, id, content)), None);
    }

    /// A category whose page is built the first time it is shown, for pages
    /// that start work (a request, a key store) as they open.
    pub fn add_lazy(
        &self,
        id: &str,
        icon: &str,
        title: &str,
        build: impl FnOnce(&Host) -> adw::PreferencesPage + 'static,
    ) {
        self.append(id, icon, title, None, Some(Box::new(build)));
    }

    fn append(&self, id: &str, icon: &str, title: &str, page: Option<adw::NavigationPage>, build: Option<Build>) {
        let content = gtk::Box::builder().spacing(12).margin_top(8).margin_bottom(8).margin_start(6).build();
        content.append(&gtk::Image::from_icon_name(icon));
        content.append(&gtk::Label::builder().label(title).xalign(0.0).hexpand(true).build());
        content.append(
            &gtk::Label::builder().css_classes(["sidebar-badge"]).valign(gtk::Align::Center).visible(false).build(),
        );
        let row = gtk::ListBoxRow::builder()
            .name(id)
            .child(&content)
            .css_classes(["sidebar-category", &format!("sidebar-category-{id}")])
            .build();
        self.list.append(&row);
        self.entries.borrow_mut().push(Entry { id: id.to_owned(), title: title.to_owned(), page, build });
    }

    /// A button under the categories: a link elsewhere, or Sign out with
    /// `destructive`.
    pub fn add_footer(
        &self,
        title: &str,
        icon: &str,
        destructive: bool,
        activate: impl Fn(&Host) + 'static,
    ) -> gtk::Button {
        let content = gtk::Box::builder().spacing(12).margin_start(6).build();
        content.append(&gtk::Image::from_icon_name(icon));
        content.append(&gtk::Label::builder().label(title).xalign(0.0).hexpand(true).build());
        let button = gtk::Button::builder().child(&content).css_classes(["flat", "sidebar-footer-button"]).build();
        if destructive {
            button.add_css_class("destructive-action");
        }
        let host = self.host.clone();
        button.connect_clicked(move |_| activate(&host));
        self.footer.append(&button);
        button
    }

    /// Shows a category, as a click on it would.
    pub fn select(&self, id: &str) {
        self.host.select(id);
    }

    /// Sized from the window `parent` is in, then shown on the first
    /// category unless one was selected.
    pub fn present(&self, parent: &impl IsA<gtk::Widget>) {
        let window = parent.as_ref().root().map(|root| (root.width(), root.height())).filter(|(w, h)| *w > 0 && *h > 0);
        let (width, height) = window.unwrap_or(MAX_SIZE);
        let fit = |size: i32, min: i32, max: i32| ((f64::from(size) * 0.85) as i32).clamp(min, max);
        self.dialog.set_content_width(fit(width, MIN_SIZE.0, MAX_SIZE.0));
        self.dialog.set_content_height(fit(height, MIN_SIZE.1, MAX_SIZE.1));
        if self.list.selected_row().is_none() {
            self.list.select_row(self.list.row_at_index(0).as_ref());
        }
        crate::widgets::present(&self.dialog, Some(parent));
    }
}

impl Host {
    pub fn toast(&self, text: &str) {
        if let Some(toasts) = self.toasts.upgrade() {
            toasts.add_toast(adw::Toast::new(text));
        }
    }

    /// Opens a subpage (Edit profile...) over the category, with a back button.
    pub fn push(&self, title: &str, content: &impl IsA<gtk::Widget>) -> adw::NavigationPage {
        let page = wrap(title, "", content);
        if let Some(navigation) = self.navigation.upgrade() {
            navigation.push(&page);
        }
        page
    }

    /// Back from a subpage to its category.
    pub fn pop(&self) {
        if let Some(navigation) = self.navigation.upgrade() {
            navigation.pop();
        }
    }

    /// Back from `page` only if it is still the one shown: an action that
    /// ends after the user moved on leaves their page alone.
    pub fn pop_if(&self, page: &adw::NavigationPage) {
        if let Some(navigation) = self.navigation.upgrade()
            && navigation.visible_page().as_ref() == Some(page)
        {
            navigation.pop();
        }
    }

    fn row(&self, id: &str) -> Option<gtk::ListBoxRow> {
        let list = self.list.upgrade()?;
        std::iter::successors(list.first_child(), |w| w.next_sibling())
            .filter_map(|w| w.downcast::<gtk::ListBoxRow>().ok())
            .find(|row| row.widget_name() == id)
    }

    /// Shows another category (the security page asking for a reauthentication).
    pub fn select(&self, id: &str) {
        let Some(list) = self.list.upgrade() else { return };
        if let Some(row) = self.row(id) {
            list.select_row(Some(&row));
            if let Some(split) = self.split.upgrade() {
                split.set_show_content(true);
            }
        }
    }

    /// A count beside a category; `None` hides it.
    pub fn set_badge(&self, id: &str, text: Option<&str>) {
        let badge = self
            .row(id)
            .and_then(|row| row.child())
            .and_then(|content| content.last_child())
            .and_downcast::<gtk::Label>();
        if let Some(badge) = badge {
            badge.set_label(text.unwrap_or_default());
            badge.set_visible(text.is_some());
        }
    }

    pub fn close(&self) {
        if let Some(dialog) = self.dialog.upgrade() {
            dialog.close();
        }
    }

    /// The dialog, as the parent of an alert or for the clipboard; `None`
    /// once it is gone.
    pub fn widget(&self) -> Option<gtk::Widget> {
        self.dialog.upgrade().filter(|_| !self.closed.get()).map(|d| d.upcast())
    }

    pub fn alive(&self) -> bool {
        self.widget().is_some()
    }

    pub fn connect_closed(&self, closed: impl Fn() + 'static) {
        if let Some(dialog) = self.dialog.upgrade() {
            dialog.connect_closed(move |_| closed());
        }
    }
}

/// The category's page, built on its first showing. The builder runs with no
/// borrow held: it may select another category.
fn page_of(entries: &Rc<RefCell<Vec<Entry>>>, host: &Host, id: &str) -> Option<(String, adw::NavigationPage)> {
    let (title, build) = {
        let mut all = entries.borrow_mut();
        let entry = all.iter_mut().find(|e| e.id == id)?;
        if let Some(page) = &entry.page {
            return Some((entry.title.clone(), page.clone()));
        }
        (entry.title.clone(), entry.build.take()?)
    };
    let page = wrap(&title, id, &build(host));
    if let Some(entry) = entries.borrow_mut().iter_mut().find(|e| e.id == id) {
        entry.page = Some(page.clone());
    }
    Some((title, page))
}

fn wrap(title: &str, tag: &str, content: &impl IsA<gtk::Widget>) -> adw::NavigationPage {
    let view = adw::ToolbarView::new();
    view.add_top_bar(&adw::HeaderBar::new());
    view.set_content(Some(content));
    let page = adw::NavigationPage::builder().title(title).child(&view).build();
    if !tag.is_empty() {
        page.set_tag(Some(tag));
    }
    page
}

#[cfg(test)]
mod tests {
    use super::*;

    fn settle(ms: u64) {
        let context = glib::MainContext::default();
        let deadline = std::time::Instant::now() + std::time::Duration::from_millis(ms);
        while std::time::Instant::now() < deadline {
            while context.pending() {
                context.iteration(false);
            }
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
    }

    fn back_buttons(root: &gtk::Widget) -> usize {
        let own = usize::from(root.has_css_class("back") && root.is_mapped());
        own + std::iter::successors(root.first_child(), |w| w.next_sibling()).map(|c| back_buttons(&c)).sum::<usize>()
    }

    fn snapshot(dialog: &adw::Dialog, variable: &str) {
        if let Some(path) = std::env::var_os(variable) {
            let snapshot = gtk::Snapshot::new();
            gtk::WidgetPaintable::new(Some(dialog)).snapshot(&snapshot, dialog.width() as f64, dialog.height() as f64);
            let renderer = dialog.native().unwrap().renderer().unwrap();
            renderer.render_texture(snapshot.to_node().unwrap(), None).save_to_png(path).unwrap();
        }
    }

    fn page(text: &str) -> adw::PreferencesPage {
        let page = adw::PreferencesPage::new();
        let group = adw::PreferencesGroup::new();
        group.add(&adw::ActionRow::builder().title(text).build());
        page.add(&group);
        page
    }

    #[test]
    #[ignore = "requires a GTK display; run under Xvfb"]
    fn categories_subpages_and_narrow_windows() {
        adw::init().unwrap();
        let built = Rc::new(Cell::new(0));
        let window = adw::Window::builder().default_width(1280).default_height(900).build();
        window.set_content(Some(&gtk::Box::new(gtk::Orientation::Vertical, 0)));
        window.present();
        settle(200);
        let sidebar = SidebarDialog::new("Settings", "sidebar-test");
        sidebar.add("first", "avatar-default-symbolic", "First", &page("one"));
        let counter = built.clone();
        sidebar.add_lazy("second", "emblem-system-symbolic", "Second", move |_| {
            counter.set(counter.get() + 1);
            page("two")
        });
        let footer = Rc::new(Cell::new(false));
        let pressed = footer.clone();
        let button = sidebar.add_footer("Sign out", "system-log-out-symbolic", true, move |_| pressed.set(true));
        sidebar.present(&window);
        settle(400);
        let dialog = sidebar.dialog().clone();
        assert!(dialog.is_mapped());
        let expected = ((f64::from(window.width()) * 0.85) as i32).clamp(MIN_SIZE.0, MAX_SIZE.0);
        assert_eq!(dialog.content_width(), expected, "85 % of the window, capped");
        assert_eq!(built.get(), 0, "a lazy category waits for its first showing");
        let host = sidebar.host();
        let navigation = host.navigation.upgrade().unwrap();
        assert_eq!(navigation.visible_page().and_then(|p| p.tag()).as_deref(), Some("first"));
        sidebar.select("second");
        settle(100);
        assert_eq!(built.get(), 1);
        assert_eq!(navigation.visible_page().and_then(|p| p.tag()).as_deref(), Some("second"));
        sidebar.select("first");
        sidebar.select("second");
        assert_eq!(built.get(), 1, "built once");
        host.push("Sub", &page("three"));
        settle(400);
        assert_eq!(navigation.navigation_stack().n_items(), 2);
        assert_eq!(back_buttons(dialog.upcast_ref()), 1, "a subpage goes back to its category");
        snapshot(&dialog, "RV_SIDEBAR_SHOT");
        host.pop();
        settle(400);
        assert_eq!(navigation.navigation_stack().n_items(), 1);
        assert_eq!(back_buttons(dialog.upcast_ref()), 0, "wide: no back button on a category");
        button.emit_clicked();
        assert!(footer.get());

        host.close();
        settle(300);
        assert!(!host.alive());

        let narrow = adw::Window::builder().default_width(480).default_height(760).build();
        narrow.set_content(Some(&gtk::Box::new(gtk::Orientation::Vertical, 0)));
        narrow.present();
        settle(200);
        let sidebar = SidebarDialog::new("Settings", "sidebar-test");
        sidebar.add("first", "avatar-default-symbolic", "First", &page("one"));
        sidebar.add("second", "emblem-system-symbolic", "Second", &page("two"));
        sidebar.present(&narrow);
        settle(600);
        let (dialog, host) = (sidebar.dialog().clone(), sidebar.host());
        let split = host.split.upgrade().unwrap();
        assert!(split.is_collapsed(), "narrow: one pane");
        assert!(!split.shows_content(), "narrow: the list first");
        sidebar.select("second");
        settle(400);
        assert_eq!(back_buttons(dialog.upcast_ref()), 1, "narrow: a category goes back to the list");
        snapshot(&dialog, "RV_SIDEBAR_NARROW_SHOT");
        host.push("Sub", &page("three"));
        settle(400);
        assert_eq!(back_buttons(dialog.upcast_ref()), 1, "narrow subpage: one back button");
        narrow.close();
        window.close();
    }

    fn dimming(root: &gtk::Widget) -> Option<gtk::Widget> {
        if root.css_name() == "dimming" {
            return Some(root.clone());
        }
        std::iter::successors(root.first_child(), |w| w.next_sibling()).find_map(|c| dimming(&c))
    }

    #[test]
    #[ignore = "requires a GTK display; run under Xvfb"]
    fn an_alert_over_the_dialog_closes_alone_on_its_backdrop_with_its_close_response() {
        adw::init().unwrap();
        let window = adw::Window::builder().default_width(1280).default_height(900).build();
        window.set_content(Some(&gtk::Box::new(gtk::Orientation::Vertical, 0)));
        window.present();
        settle(200);
        let sidebar = SidebarDialog::new("Settings", "sidebar-test");
        sidebar.add("first", "avatar-default-symbolic", "First", &page("one"));
        sidebar.present(&window);
        settle(300);
        let entry = gtk::Entry::new();
        let alert = adw::AlertDialog::builder()
            .heading("Delete?")
            .extra_child(&entry)
            .default_response("delete")
            .close_response("cancel")
            .build();
        alert.add_responses(&[("cancel", "Cancel"), ("delete", "Delete")]);
        let answers: Rc<RefCell<Vec<String>>> = Rc::default();
        let log = answers.clone();
        alert.connect_response(None, move |_, response| log.borrow_mut().push(response.to_owned()));
        crate::widgets::present(&alert, sidebar.host().widget().as_ref());
        settle(400);
        assert!(alert.is_mapped() && alert.has_css_class("alert"));
        let backdrop = dimming(alert.upcast_ref()).expect("the alert's own backdrop");
        let click = (0..backdrop.observe_controllers().n_items())
            .filter_map(|i| backdrop.observe_controllers().item(i).and_downcast::<gtk::GestureClick>())
            .find(|c| c.button() == 0 && c.propagation_phase() == gtk::PropagationPhase::Capture)
            .expect("a click handler on the backdrop");
        assert!(!entry.is_ancestor(&backdrop), "a click inside the alert never reaches the backdrop");
        click.emit_by_name::<()>("released", &[&1i32, &5f64, &5f64]);
        settle(400);
        assert_eq!(*answers.borrow(), ["cancel"], "the close response, never Delete");
        assert!(sidebar.host().alive(), "the dialog under it stays open");
        window.close();
    }
}
