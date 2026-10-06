//! The voice sounds (`assets/sounds`), embedded and played through GStreamer's
//! playbin: one-shot cues, and the ringtone or the ringback in a loop.

use std::cell::Cell;
use std::path::PathBuf;
use std::rc::Rc;
use std::time::Duration;

use gstreamer as gst;
use gstreamer::prelude::*;
use gtk::glib;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Sound {
    Ringtone,
    Ringback,
    Join,
    Leave,
    Mute,
    Unmute,
    Missed,
}

impl Sound {
    fn file(self) -> (&'static str, &'static [u8]) {
        match self {
            Self::Ringtone => ("ringtone.ogg", include_bytes!("../../../../../assets/sounds/ringtone.ogg")),
            Self::Ringback => ("ringback.ogg", include_bytes!("../../../../../assets/sounds/ringback.ogg")),
            Self::Join => ("cue-join.ogg", include_bytes!("../../../../../assets/sounds/cue-join.ogg")),
            Self::Leave => ("cue-leave.ogg", include_bytes!("../../../../../assets/sounds/cue-leave.ogg")),
            Self::Mute => ("cue-mute.ogg", include_bytes!("../../../../../assets/sounds/cue-mute.ogg")),
            Self::Unmute => ("cue-unmute.ogg", include_bytes!("../../../../../assets/sounds/cue-unmute.ogg")),
            Self::Missed => ("cue-missed.ogg", include_bytes!("../../../../../assets/sounds/cue-missed.ogg")),
        }
    }
}

/// playbin reads a file: the sound is written once to the cache, again when it changed.
fn path(sound: Sound) -> Option<PathBuf> {
    let (name, bytes) = sound.file();
    let dir = glib::user_cache_dir().join("rocket-vibe-rs").join("sounds");
    let path = dir.join(name);
    if std::fs::read(&path).is_ok_and(|b| b == bytes) {
        return Some(path);
    }
    std::fs::create_dir_all(&dir).ok()?;
    std::fs::write(&path, bytes).ok()?;
    Some(path)
}

/// A looping sound: it stops when dropped.
pub struct Player {
    stopped: Rc<Cell<bool>>,
}

impl Drop for Player {
    fn drop(&mut self) {
        self.stopped.set(true);
    }
}

fn start(sound: Sound, looped: bool) -> Option<Rc<Cell<bool>>> {
    gst::init().ok()?;
    let uri = glib::filename_to_uri(path(sound)?, None).ok()?;
    let playbin = gst::ElementFactory::make("playbin").build().ok()?;
    playbin.set_property("uri", uri.as_str());
    let bus = playbin.bus()?;
    playbin.set_state(gst::State::Playing).ok()?;
    let stopped = Rc::new(Cell::new(false));
    let flag = stopped.clone();
    // Polled rather than watched: the closure owns the pipeline, which ends with it.
    glib::timeout_add_local(Duration::from_millis(100), move || {
        let mut ended = flag.get();
        while !ended && let Some(message) = bus.pop_filtered(&[gst::MessageType::Eos, gst::MessageType::Error]) {
            match message.view() {
                gst::MessageView::Eos(_) if looped => {
                    let _ = playbin.seek_simple(gst::SeekFlags::FLUSH, gst::ClockTime::ZERO);
                }
                _ => ended = true,
            }
        }
        if ended {
            let _ = playbin.set_state(gst::State::Null);
            return glib::ControlFlow::Break;
        }
        glib::ControlFlow::Continue
    });
    Some(stopped)
}

/// Once, to its end. Without an audio device it stays silent.
pub fn play(sound: Sound) {
    start(sound, false);
}

/// Over and over until the player is dropped.
pub fn looped(sound: Sound) -> Option<Player> {
    start(sound, true).map(|stopped| Player { stopped })
}
