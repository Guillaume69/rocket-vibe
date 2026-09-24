//! Voice messages: the microphone to Ogg/Opus through GStreamer, which
//! Rocket.Chat's web and mobile clients both play.

use std::path::PathBuf;
use std::time::{Duration, Instant};

use gstreamer as gst;
use gstreamer::prelude::*;

pub struct Recorder {
    pipeline: gst::Pipeline,
    path: PathBuf,
    started: Instant,
}

/// The microphone, unless `RV_AUDIO_SOURCE` names another source (a test tone).
fn source() -> String {
    std::env::var("RV_AUDIO_SOURCE").unwrap_or_else(|_| "autoaudiosrc".to_owned())
}

impl Recorder {
    pub fn start() -> Result<Self, String> {
        gst::init().map_err(|e| e.to_string())?;
        let dir = gtk::glib::user_cache_dir().join("rocket-vibe-rs").join("outgoing");
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let path = dir.join(format!("voice-{:08x}.ogg", gtk::glib::random_int()));
        let description = format!(
            "{} ! audioconvert ! audioresample ! opusenc bitrate=32000 ! oggmux ! filesink name=sink",
            source()
        );
        let pipeline = gst::parse::launch(&description)
            .map_err(|e| e.to_string())?
            .downcast::<gst::Pipeline>()
            .map_err(|_| "not a pipeline".to_owned())?;
        let sink = pipeline.by_name("sink").ok_or("no sink")?;
        sink.set_property("location", path.to_string_lossy().as_ref());
        pipeline.set_state(gst::State::Playing).map_err(|e| e.to_string())?;
        Ok(Recorder { pipeline, path, started: Instant::now() })
    }

    pub fn elapsed(&self) -> Duration {
        self.started.elapsed()
    }

    /// Ends the file properly (end of stream through the muxer) and hands it over.
    pub fn finish(self) -> Option<PathBuf> {
        self.pipeline.send_event(gst::event::Eos::new());
        if let Some(bus) = self.pipeline.bus() {
            let _ = bus
                .timed_pop_filtered(gst::ClockTime::from_seconds(3), &[gst::MessageType::Eos, gst::MessageType::Error]);
        }
        let _ = self.pipeline.set_state(gst::State::Null);
        let written = std::fs::metadata(&self.path).is_ok_and(|m| m.len() > 0);
        written.then(|| self.path.clone())
    }

    pub fn cancel(self) {
        let _ = self.pipeline.set_state(gst::State::Null);
        let _ = std::fs::remove_file(&self.path);
    }

    /// An error the pipeline reported since it started (no microphone, say).
    pub fn failure(&self) -> Option<String> {
        let bus = self.pipeline.bus()?;
        let message = bus.pop_filtered(&[gst::MessageType::Error])?;
        match message.view() {
            gst::MessageView::Error(e) => Some(e.error().to_string()),
            _ => None,
        }
    }
}
