//! The discoverability gate of experimental integrations, kept on the device:
//! WhatsApp, Slack and Teams are server kinds of the login page behind it, and
//! the panel it reveals hides them again.
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
}

impl Preview {
    pub fn new() -> Rc<Self> {
        let root = gtk::Box::builder().orientation(gtk::Orientation::Vertical).spacing(10).visible(enabled()).build();
        let hide = gtk::Button::with_label(crate::i18n::t("slack.hide"));
        let status = gtk::Label::builder().wrap(true).xalign(0.0).visible(false).build();
        root.append(&hide);
        root.append(&status);
        let shown = root.clone();
        hide.connect_clicked(move |_| match set_enabled(false) {
            Ok(()) => shown.set_visible(false),
            Err(_) => {
                status.set_label(crate::i18n::t("slack.unlockFailed"));
                status.set_visible(true);
            }
        });
        Rc::new(Self { root })
    }

    pub fn unlock(&self) {
        // Shown even when the device refuses the setting: the gate is
        // discoverability, and this session asked for it.
        let _ = set_enabled(true);
        self.root.set_visible(true);
    }
}
