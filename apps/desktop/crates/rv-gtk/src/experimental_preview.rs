//! One discoverability gate and a native provider switcher.
use adw::prelude::*;
use std::rc::Rc;
pub struct Preview {
    pub root: gtk::Box,
    pub stack: gtk::Stack,
    slack: Rc<crate::slack_preview::Preview>,
    _teams: Rc<crate::teams_preview::Preview>,
}
impl Preview {
    pub fn new() -> Rc<Self> {
        let slack = crate::slack_preview::Preview::new();
        let teams = crate::teams_preview::Preview::new();
        slack.root.set_visible(true);
        let stack = gtk::Stack::new();
        stack.add_titled(&slack.root, Some("slack"), "Slack");
        stack.add_titled(&teams.root, Some("teams"), "Teams");
        let switcher = gtk::StackSwitcher::builder().stack(&stack).halign(gtk::Align::Center).build();
        let root = gtk::Box::builder()
            .orientation(gtk::Orientation::Vertical)
            .spacing(10)
            .visible(crate::slack_preview::enabled())
            .build();
        root.append(&switcher);
        root.append(&stack);
        let this = Rc::new(Self { root, stack, slack, _teams: teams });
        for child in [&this.slack.root, &this._teams.root] {
            let root = this.root.clone();
            child.connect_visible_notify(move |child| {
                if !child.property::<bool>("visible") {
                    root.set_visible(false);
                }
            });
        }
        this
    }
    pub fn unlock(&self) {
        self.root.set_visible(true);
        self.slack.unlock();
        self._teams.root.set_visible(true);
    }
}
