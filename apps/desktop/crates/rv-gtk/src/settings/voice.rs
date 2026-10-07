//! The "Voice" group: which microphone and speakers the `rv-voice` sidecar
//! opens, the noise remover, and (Windows and Linux, whose sidecar captures a
//! screen's sound) whether that sound carries the call's voices. The choices
//! are this machine's, kept in the config dir like the language
//! (`rv_core::voice_prefs`, which the SwiftUI app reads too), and handed to
//! each native session's voice controller; so are the listening choices made
//! in a call (volumes, people muted here) and a share's last quality.

use std::sync::Arc;

use adw::prelude::*;
use gtk::glib;
use rv_core::native::NativeSession;
use rv_core::voice::{Device, ScreenQuality};
use rv_core::voice_prefs::VoicePrefs;

use crate::i18n::t;
use crate::{on_tokio, runtime};

/// The voice choices in the config dir.
fn prefs() -> VoicePrefs {
    VoicePrefs::new(glib::user_config_dir().join("rocket-vibe-rs"))
}

/// Keeps a session's listening choices for the next run.
pub fn save_listening(session: &NativeSession) {
    prefs().save_listening(session.voice());
}

pub fn share_quality() -> ScreenQuality {
    prefs().share_quality()
}

pub fn save_share_quality(quality: ScreenQuality) {
    prefs().set_share_quality(quality);
}

/// Hands the saved choices to a session's controller: its next connections
/// use them.
pub fn apply(session: &Arc<NativeSession>) {
    let session = session.clone();
    // The share-call choice and the listening ones apply at once, the devices
    // as the controller takes them.
    session.voice().set_share_call(prefs().share_call());
    if let Some(listening) = prefs().listening() {
        session.voice().restore_listening(listening);
    }
    runtime().spawn(async move { prefs().apply(session.voice()).await });
}

/// Device names as shown: the system default first, then each device, two
/// devices of the same name told apart by a number.
fn labels(devices: &[Device]) -> Vec<String> {
    let mut labels = vec![t("voice_settings.default").to_owned()];
    for (index, device) in devices.iter().enumerate() {
        let before = devices[..index].iter().filter(|d| d.name == device.name).count();
        labels.push(if before == 0 { device.name.clone() } else { format!("{} ({})", device.name, before + 1) });
    }
    labels
}

/// A device's position in `labels`; a saved device missing now (unplugged)
/// shows the default without forgetting the choice.
fn chosen(session: &NativeSession, devices: &[Device], input: bool) -> u32 {
    let (selected_input, selected_output) = session.voice().selected_devices();
    let chosen =
        if input { selected_input } else { selected_output }.or_else(|| prefs().device(input)).unwrap_or_default();
    devices.iter().position(|d| d.id == chosen).map_or(0, |i| i as u32 + 1)
}

/// The device at `position` of `labels` chosen: saved, and handed to the controller.
fn choose(session: &Arc<NativeSession>, devices: &[Device], input: bool, position: u32) {
    let id = match position {
        0 => String::new(),
        n => match devices.get(n as usize - 1) {
            Some(device) => device.id.clone(),
            None => return,
        },
    };
    prefs().set_device(input, &id);
    let session = session.clone();
    runtime().spawn(async move {
        if input {
            session.voice().select_input(&id).await;
        } else {
            session.voice().select_output(&id).await;
        }
    });
}

/// The microphones or the speakers once the sidecar listed them; `fill` gets
/// the labels and the current choice.
fn listed(session: &Arc<NativeSession>, fill: impl FnOnce(Option<(Vec<Device>, Vec<Device>)>) + 'static) {
    let lister = session.clone();
    glib::spawn_future_local(async move {
        match on_tokio(async move { lister.voice().devices().await }).await {
            Ok(devices) => fill(Some(devices)),
            Err(error) => {
                eprintln!("voice: devices not listed: {}", error.code());
                fill(None);
            }
        }
    });
}

/// A dropdown of the microphones (`input`) or the speakers, for the call's menu.
pub fn device_dropdown(session: &Arc<NativeSession>, input: bool) -> gtk::DropDown {
    let dropdown = gtk::DropDown::from_strings(&[t("voice_settings.loading")]);
    dropdown.set_sensitive(false);
    let (weak, session) = (dropdown.downgrade(), session.clone());
    listed(&session.clone(), move |devices| {
        let Some(dropdown) = weak.upgrade() else { return };
        let Some((inputs, outputs)) = devices else {
            dropdown.set_model(Some(&gtk::StringList::new(&[t("voice_settings.failed")])));
            return;
        };
        let devices = if input { inputs } else { outputs };
        let labels = labels(&devices);
        dropdown.set_model(Some(&gtk::StringList::new(&labels.iter().map(String::as_str).collect::<Vec<_>>())));
        dropdown.set_selected(chosen(&session, &devices, input));
        dropdown.set_sensitive(true);
        dropdown.connect_selected_notify(move |d| choose(&session, &devices, input, d.selected()));
    });
    dropdown
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
    let noise = adw::SwitchRow::builder()
        .title(t("voice_settings.noise"))
        .subtitle(t("voice_settings.noise_hint"))
        .active(session.voice().listening().noise_suppression)
        .build();
    let noisy = session.clone();
    noise.connect_active_notify(move |row| {
        let (session, on) = (noisy.clone(), row.is_active());
        runtime().spawn(async move {
            session.voice().set_noise_suppression(on).await;
            save_listening(&session);
        });
    });
    group.add(&noise);
    if cfg!(any(windows, target_os = "linux")) {
        let share_call = adw::SwitchRow::builder()
            .title(t("voice_settings.share_call"))
            .subtitle(t("voice_settings.share_call_hint"))
            .active(session.voice().share_call())
            .build();
        let voice = session.voice().clone();
        share_call.connect_active_notify(move |row| {
            prefs().set_share_call(row.is_active());
            voice.set_share_call(row.is_active());
        });
        group.add(&share_call);
    }
    let weak = (input.downgrade(), output.downgrade());
    listed(&session.clone(), move |devices| {
        let (Some(input), Some(output)) = (weak.0.upgrade(), weak.1.upgrade()) else { return };
        match devices {
            Some((inputs, outputs)) => {
                fill(&input, inputs, true, session.clone());
                fill(&output, outputs, false, session);
            }
            None => {
                input.set_subtitle(t("voice_settings.failed"));
                output.set_subtitle(t("voice_settings.failed"));
            }
        }
    });
    group
}

fn fill(row: &adw::ComboRow, devices: Vec<Device>, input: bool, session: Arc<NativeSession>) {
    let labels = labels(&devices);
    row.set_model(Some(&gtk::StringList::new(&labels.iter().map(String::as_str).collect::<Vec<_>>())));
    row.set_selected(chosen(&session, &devices, input));
    row.set_subtitle("");
    row.set_sensitive(true);
    row.connect_selected_notify(move |row| choose(&session, &devices, input, row.selected()));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn devices_of_one_name_are_told_apart() {
        let device = |id: &str, name: &str| Device { id: id.into(), name: name.into(), default: false };
        let devices = [device("a", "Screen"), device("b", "Screen"), device("c", "Headset")];
        assert_eq!(labels(&devices)[1..], ["Screen", "Screen (2)", "Headset"]);
    }
}
