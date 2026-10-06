//! The "Voice" group: which microphone and speakers the `rv-voice` sidecar
//! opens. The choice is this machine's, kept in the config dir like the
//! language, and handed to each native session's voice controller.

use std::path::PathBuf;
use std::sync::Arc;

use adw::prelude::*;
use gtk::glib;
use rv_core::native::NativeSession;
use rv_core::voice::Device;

use crate::i18n::t;
use crate::{on_tokio, runtime};

const INPUT: &str = "voice-input";
const OUTPUT: &str = "voice-output";

fn file(name: &str) -> PathBuf {
    glib::user_config_dir().join("rocket-vibe-rs").join(name)
}

/// A device id from the sidecar's list, empty for the system default; None
/// when never chosen.
fn saved(name: &str) -> Option<String> {
    std::fs::read_to_string(file(name)).ok()
}

fn save(name: &str, id: &str) {
    let file = file(name);
    if let Some(dir) = file.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let _ = std::fs::write(file, id);
}

/// Hands the saved devices to a session's controller: its next connections
/// open them.
pub fn apply(session: &Arc<NativeSession>) {
    let (input, output) = (saved(INPUT), saved(OUTPUT));
    if input.is_none() && output.is_none() {
        return;
    }
    let session = session.clone();
    runtime().spawn(async move {
        if let Some(id) = input {
            session.voice().select_input(&id).await;
        }
        if let Some(id) = output {
            session.voice().select_output(&id).await;
        }
    });
}

/// Input and output dropdowns, filled once the sidecar listed the devices.
pub fn group(session: Arc<NativeSession>) -> adw::PreferencesGroup {
    let group = adw::PreferencesGroup::builder().title(t("voice_settings.title")).build();
    let row = |key: &str| {
        adw::ComboRow::builder().title(t(key)).subtitle(t("voice_settings.loading")).sensitive(false).build()
    };
    let (input, output) = (row("voice_settings.input"), row("voice_settings.output"));
    input.add_css_class("voice-input-device");
    output.add_css_class("voice-output-device");
    group.add(&input);
    group.add(&output);
    let lister = session.clone();
    glib::spawn_future_local(glib::clone!(
        #[weak]
        input,
        #[weak]
        output,
        async move {
            match on_tokio(async move { lister.voice().devices().await }).await {
                Ok((inputs, outputs)) => {
                    fill(&input, inputs, true, session.clone());
                    fill(&output, outputs, false, session);
                }
                Err(error) => {
                    eprintln!("voice: devices not listed: {}", error.code());
                    input.set_subtitle(t("voice_settings.failed"));
                    output.set_subtitle(t("voice_settings.failed"));
                }
            }
        }
    ));
    group
}

/// The system default first, then each device; a saved device missing now
/// (unplugged) shows the default without forgetting the choice.
fn fill(row: &adw::ComboRow, devices: Vec<Device>, input: bool, session: Arc<NativeSession>) {
    let name = if input { INPUT } else { OUTPUT };
    let (selected_input, selected_output) = session.voice().selected_devices();
    let chosen = if input { selected_input } else { selected_output }.or_else(|| saved(name)).unwrap_or_default();
    let ids: Vec<String> = std::iter::once(String::new()).chain(devices.iter().map(|d| d.id.clone())).collect();
    let mut labels = vec![t("voice_settings.default")];
    labels.extend(devices.iter().map(|d| d.name.as_str()));
    row.set_model(Some(&gtk::StringList::new(&labels)));
    row.set_selected(ids.iter().position(|id| *id == chosen).unwrap_or(0) as u32);
    row.set_subtitle("");
    row.set_sensitive(true);
    row.connect_selected_notify(move |row| {
        let Some(id) = ids.get(row.selected() as usize).cloned() else { return };
        save(name, &id);
        let session = session.clone();
        runtime().spawn(async move {
            if input {
                session.voice().select_input(&id).await;
            } else {
                session.voice().select_output(&id).await;
            }
        });
    });
}
