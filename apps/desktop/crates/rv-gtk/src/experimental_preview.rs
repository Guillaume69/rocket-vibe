//! The discoverability gate of experimental integrations, kept on the device,
//! and the Teams preview it reveals. Slack and WhatsApp sit behind the same
//! gate as server kinds of the login page.
use adw::prelude::*;
use gtk::glib;
use std::rc::Rc;

fn file() -> std::path::PathBuf {
    glib::user_config_dir().join("rocket-vibe-rs").join("experimental-providers")
}

pub fn enabled() -> bool {
    file().exists()
}

pub(super) fn set_enabled(value: bool) -> std::io::Result<()> {
    let file = file();
    if value {
        std::fs::create_dir_all(file.parent().expect("config dir"))?;
        std::fs::write(file, "")
    } else if file.exists() {
        std::fs::remove_file(file)
    } else {
        Ok(())
    }
}

pub struct Preview {
    pub root: gtk::Box,
    teams: Rc<crate::teams_preview::Preview>,
}

impl Preview {
    pub fn new() -> Rc<Self> {
        let teams = crate::teams_preview::Preview::new();
        let root = gtk::Box::builder().orientation(gtk::Orientation::Vertical).spacing(10).visible(enabled()).build();
        root.append(&teams.root);
        let this = Rc::new(Self { root, teams });
        let root = this.root.clone();
        this.teams.root.connect_visible_notify(move |child| {
            if !child.property::<bool>("visible") {
                root.set_visible(false);
            }
        });
        this
    }

    pub fn unlock(&self) {
        // Shown even when the device refuses the setting: the gate is
        // discoverability, and this session asked for it.
        let _ = set_enabled(true);
        self.root.set_visible(true);
        self.teams.root.set_visible(true);
    }
}
