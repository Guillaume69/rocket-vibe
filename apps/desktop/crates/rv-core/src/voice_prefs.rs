//! The voice choices this machine keeps, in the config dir the desktop apps
//! share (GTK's `rocket-vibe-rs`, which rv-ffi resolves the same way): the
//! microphone and the speakers, whether a screen's sound carries the call, the
//! listening choices (each person's volume and mute here, volumes, the noise
//! remover) and a share's last quality. One file per choice, so an older app
//! reads what it knows.
use crate::voice::{Listening, ScreenQuality, VoiceController};
use std::path::PathBuf;

const INPUT: &str = "voice-input";
const OUTPUT: &str = "voice-output";
/// "1": a screen's sound carries the call's voices too.
const SHARE_CALL: &str = "voice-share-call";
/// `Listening`, as JSON.
const LISTENING: &str = "voice-listening.json";
/// The last share's lines and frames a second: "1080 30".
const SHARE_QUALITY: &str = "voice-share-quality";

#[derive(Debug, Clone)]
pub struct VoicePrefs {
    dir: PathBuf,
}

impl VoicePrefs {
    pub fn new(dir: impl Into<PathBuf>) -> Self {
        Self { dir: dir.into() }
    }

    fn read(&self, name: &str) -> Option<String> {
        std::fs::read_to_string(self.dir.join(name)).ok()
    }

    fn write(&self, name: &str, value: &str) {
        let _ = std::fs::create_dir_all(&self.dir);
        let _ = std::fs::write(self.dir.join(name), value);
    }

    /// The chosen microphone (`input`) or speakers: a device id, empty for the
    /// system default; None when never chosen.
    pub fn device(&self, input: bool) -> Option<String> {
        self.read(if input { INPUT } else { OUTPUT })
    }

    pub fn set_device(&self, input: bool, id: &str) {
        self.write(if input { INPUT } else { OUTPUT }, id);
    }

    pub fn share_call(&self) -> bool {
        self.read(SHARE_CALL).as_deref() == Some("1")
    }

    pub fn set_share_call(&self, on: bool) {
        self.write(SHARE_CALL, if on { "1" } else { "0" });
    }

    pub fn listening(&self) -> Option<Listening> {
        serde_json::from_str(&self.read(LISTENING)?).ok()
    }

    /// Keeps a controller's listening choices for the next run.
    pub fn save_listening(&self, voice: &VoiceController) {
        if let Ok(json) = serde_json::to_string(&voice.listening()) {
            self.write(LISTENING, &json);
        }
    }

    pub fn share_quality(&self) -> ScreenQuality {
        self.read(SHARE_QUALITY)
            .and_then(|s| {
                let (height, fps) = s.trim().split_once(' ')?;
                Some(ScreenQuality { height: height.parse().ok()?, fps: fps.parse().ok()? })
            })
            .unwrap_or(ScreenQuality::DEFAULT)
    }

    pub fn set_share_quality(&self, quality: ScreenQuality) {
        self.write(SHARE_QUALITY, &format!("{} {}", quality.height, quality.fps));
    }

    /// Hands the saved choices to a session's controller: its next connections use them.
    pub async fn apply(&self, voice: &VoiceController) {
        voice.set_share_call(self.share_call());
        if let Some(listening) = self.listening() {
            voice.restore_listening(listening);
        }
        if let Some(id) = self.device(true) {
            voice.select_input(&id).await;
        }
        if let Some(id) = self.device(false) {
            voice.select_output(&id).await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::voice::PersonVolume;

    #[tokio::test]
    async fn choices_are_kept_and_given_back() {
        let dir = tempfile::tempdir().unwrap();
        let prefs = VoicePrefs::new(dir.path().join("rocket-vibe-rs"));
        assert_eq!(prefs.device(true), None);
        assert!(!prefs.share_call());
        assert_eq!(prefs.share_quality(), ScreenQuality::DEFAULT);
        prefs.set_device(true, "mic-1");
        prefs.set_device(false, "");
        prefs.set_share_call(true);
        prefs.set_share_quality(ScreenQuality { height: 720, fps: 30 });
        let voice = VoiceController::new();
        voice.set_person_volume("bob", PersonVolume { volume: 0.5, muted: true }).await;
        voice.set_noise_suppression(false).await;
        prefs.save_listening(&voice);

        let again = VoicePrefs::new(dir.path().join("rocket-vibe-rs"));
        assert_eq!((again.device(true).as_deref(), again.device(false).as_deref()), (Some("mic-1"), Some("")));
        assert!(again.share_call());
        assert_eq!(again.share_quality(), ScreenQuality { height: 720, fps: 30 });
        let fresh = VoiceController::new();
        again.apply(&fresh).await;
        assert!(fresh.share_call());
        assert_eq!(fresh.listening(), voice.listening());
        assert_eq!(fresh.selected_devices(), (Some("mic-1".into()), Some(String::new())));
    }
}
