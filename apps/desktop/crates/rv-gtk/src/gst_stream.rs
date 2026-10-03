//! Audio and video where GTK has no media backend (Homebrew's GTK is built
//! without one): GStreamer's playbin behind a `gtk::MediaStream`, its video
//! frames drawn as textures, so pictures and media controls use it as they
//! use GTK's own.

use std::cell::{Cell, OnceCell, RefCell};
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use gstreamer as gst;
use gstreamer::prelude::{ElementExt as _, ElementExtManual as _, ObjectExt as _};
use gstreamer_app as gst_app;
use gstreamer_video as gst_video;
use gstreamer_video::prelude::VideoFrameExt as _;
use gtk::gdk;
use gtk::glib;
use gtk::prelude::*;
use gtk::subclass::prelude::*;

mod imp {
    use super::*;

    #[derive(Default)]
    pub struct GstStream {
        pub playbin: OnceCell<gst::Element>,
        pub frame: RefCell<Option<gdk::Texture>>,
        pub incoming: Arc<Mutex<Option<gdk::Texture>>>,
        pub watch: RefCell<Option<gst::bus::BusWatchGuard>>,
        pub ticker: RefCell<Option<glib::SourceId>>,
        pub prepared: Cell<bool>,
    }

    #[glib::object_subclass]
    impl ObjectSubclass for GstStream {
        const NAME: &'static str = "RvGstStream";
        type Type = super::GstStream;
        type ParentType = gtk::MediaStream;
        type Interfaces = (gdk::Paintable,);
    }

    impl ObjectImpl for GstStream {
        fn dispose(&self) {
            self.stop_ticker();
            self.watch.replace(None);
            if let Some(playbin) = self.playbin.get() {
                let _ = playbin.set_state(gst::State::Null);
            }
        }
    }

    impl MediaStreamImpl for GstStream {
        fn play(&self) -> bool {
            let Some(playbin) = self.playbin.get() else { return false };
            if self.obj().is_ended() {
                let _ = playbin.seek_simple(gst::SeekFlags::FLUSH | gst::SeekFlags::KEY_UNIT, gst::ClockTime::ZERO);
            }
            if playbin.set_state(gst::State::Playing).is_err() {
                return false;
            }
            self.start_ticker();
            true
        }

        fn pause(&self) {
            self.stop_ticker();
            if let Some(playbin) = self.playbin.get() {
                let _ = playbin.set_state(gst::State::Paused);
            }
        }

        fn seek(&self, timestamp: i64) {
            let Some(playbin) = self.playbin.get() else { return };
            let to = gst::ClockTime::from_useconds(timestamp.max(0) as u64);
            if playbin.seek_simple(gst::SeekFlags::FLUSH | gst::SeekFlags::ACCURATE, to).is_ok() {
                self.obj().seek_success();
                self.obj().update(timestamp);
            } else {
                self.obj().seek_failed();
            }
        }

        fn update_audio(&self, muted: bool, volume: f64) {
            if let Some(playbin) = self.playbin.get() {
                playbin.set_property("mute", muted);
                playbin.set_property("volume", volume);
            }
        }
    }

    impl PaintableImpl for GstStream {
        fn current_image(&self) -> gdk::Paintable {
            match self.frame.borrow().as_ref() {
                Some(texture) => texture.clone().upcast::<gdk::Paintable>(),
                None => gdk::Paintable::new_empty(0, 0),
            }
        }

        fn intrinsic_width(&self) -> i32 {
            self.frame.borrow().as_ref().map_or(0, |t| t.width())
        }

        fn intrinsic_height(&self) -> i32 {
            self.frame.borrow().as_ref().map_or(0, |t| t.height())
        }

        fn intrinsic_aspect_ratio(&self) -> f64 {
            self.frame.borrow().as_ref().map_or(0.0, |t| t.width() as f64 / t.height().max(1) as f64)
        }

        fn snapshot(&self, snapshot: &gdk::Snapshot, width: f64, height: f64) {
            if let Some(texture) = self.frame.borrow().as_ref() {
                texture.snapshot(snapshot, width, height);
            }
        }
    }

    impl GstStream {
        fn start_ticker(&self) {
            if self.ticker.borrow().is_some() {
                return;
            }
            let weak = self.obj().downgrade();
            let id = glib::timeout_add_local(Duration::from_millis(100), move || {
                let Some(stream) = weak.upgrade() else { return glib::ControlFlow::Break };
                if let Some(at) = stream.imp().playbin.get().and_then(|p| p.query_position::<gst::ClockTime>()) {
                    stream.update(at.useconds() as i64);
                }
                glib::ControlFlow::Continue
            });
            self.ticker.replace(Some(id));
        }

        pub fn stop_ticker(&self) {
            if let Some(id) = self.ticker.take() {
                id.remove();
            }
        }

        pub fn show_frame(&self) {
            let Some(texture) = self.incoming.lock().unwrap().take() else { return };
            let resized = self
                .frame
                .borrow()
                .as_ref()
                .is_none_or(|t| t.width() != texture.width() || t.height() != texture.height());
            self.frame.replace(Some(texture));
            if resized {
                self.obj().invalidate_size();
            }
            self.obj().invalidate_contents();
        }

        pub fn on_message(&self, message: &gst::Message) {
            let Some(playbin) = self.playbin.get() else { return };
            let stream = self.obj();
            match message.view() {
                gst::MessageView::AsyncDone(_) if !self.prepared.get() => {
                    self.prepared.set(true);
                    let has_audio = playbin.property::<i32>("n-audio") > 0;
                    let has_video = playbin.property::<i32>("n-video") > 0;
                    let mut seeking = gst::query::Seeking::new(gst::Format::Time);
                    let seekable = playbin.query(&mut seeking) && seeking.result().0;
                    let duration = playbin.query_duration::<gst::ClockTime>().map_or(0, |d| d.useconds() as i64);
                    stream.stream_prepared(has_audio, has_video, seekable, duration);
                }
                gst::MessageView::Eos(_) => {
                    self.stop_ticker();
                    let _ = playbin.set_state(gst::State::Paused);
                    stream.stream_ended();
                }
                gst::MessageView::Error(error) => {
                    self.stop_ticker();
                    let _ = playbin.set_state(gst::State::Null);
                    if stream.error().is_none() {
                        stream.set_error(glib::Error::new(glib::FileError::Failed, &error.error().to_string()));
                    }
                }
                _ => {}
            }
        }
    }
}

glib::wrapper! {
    pub struct GstStream(ObjectSubclass<imp::GstStream>) @extends gtk::MediaStream,
        @implements gdk::Paintable;
}

impl GstStream {
    fn for_file(path: &Path) -> Result<Self, String> {
        gst::init().map_err(|e| e.to_string())?;
        let stream: Self = glib::Object::new();
        let uri = glib::filename_to_uri(path, None).map_err(|e| e.to_string())?;
        let playbin = gst::ElementFactory::make("playbin").build().map_err(|e| e.to_string())?;
        playbin.set_property("uri", uri.as_str());
        let sink = gst_app::AppSink::builder()
            .caps(&gst_video::VideoCapsBuilder::new().format(gst_video::VideoFormat::Rgba).build())
            .build();
        let incoming = stream.imp().incoming.clone();
        let target = glib::SendWeakRef::from(stream.downgrade());
        sink.set_callbacks(
            gst_app::AppSinkCallbacks::builder()
                .new_preroll({
                    let (incoming, target) = (incoming.clone(), target.clone());
                    move |sink| {
                        let sample = sink.pull_preroll().map_err(|_| gst::FlowError::Eos)?;
                        hand_over(&sample, &incoming, &target);
                        Ok(gst::FlowSuccess::Ok)
                    }
                })
                .new_sample(move |sink| {
                    let sample = sink.pull_sample().map_err(|_| gst::FlowError::Eos)?;
                    hand_over(&sample, &incoming, &target);
                    Ok(gst::FlowSuccess::Ok)
                })
                .build(),
        );
        playbin.set_property("video-sink", &sink);
        let bus = playbin.bus().ok_or("playbin without a bus")?;
        let weak = stream.downgrade();
        let watch = bus
            .add_watch_local(move |_, message| {
                if let Some(stream) = weak.upgrade() {
                    stream.imp().on_message(message);
                }
                gst::glib::ControlFlow::Continue
            })
            .map_err(|e| e.to_string())?;
        stream.imp().watch.replace(Some(watch));
        let _ = stream.imp().playbin.set(playbin.clone());
        playbin.set_state(gst::State::Paused).map_err(|e| e.to_string())?;
        Ok(stream)
    }
}

/// A decoded frame, as a texture for the main thread to draw.
fn hand_over(sample: &gst::Sample, incoming: &Arc<Mutex<Option<gdk::Texture>>>, target: &glib::SendWeakRef<GstStream>) {
    let (Some(caps), Some(buffer)) = (sample.caps(), sample.buffer()) else { return };
    let Ok(info) = gst_video::VideoInfo::from_caps(caps) else { return };
    let Ok(frame) = gst_video::VideoFrameRef::from_buffer_ref_readable(buffer, &info) else { return };
    let Ok(data) = frame.plane_data(0) else { return };
    let bytes = glib::Bytes::from(data);
    let texture = gdk::MemoryTexture::new(
        info.width() as i32,
        info.height() as i32,
        gdk::MemoryFormat::R8g8b8a8,
        &bytes,
        frame.plane_stride()[0] as usize,
    );
    *incoming.lock().unwrap() = Some(texture.upcast());
    let target = target.clone();
    glib::MainContext::default().invoke(move || {
        if let Some(stream) = target.upgrade() {
            stream.imp().show_frame();
        }
    });
}

/// Video drawn from CPU frames, not the GPU's: under NVIDIA's own driver,
/// whose GL driver crashed in GTK's renderer while drawing the GPU frames of
/// GTK's media backend, and under which WebKit's GPU path drew its video
/// black. `RV_SOFTWARE_VIDEO=1` asks for it anywhere.
pub fn video_on_cpu() -> bool {
    std::env::var("RV_SOFTWARE_VIDEO").as_deref() == Ok("1")
        || (cfg!(target_os = "linux") && Path::new("/proc/driver/nvidia/version").exists())
}

thread_local! {
    static GTK_HAS_MEDIA: bool = std::env::var("RV_MEDIA_BACKEND").as_deref() != Ok("gstreamer")
        && !video_on_cpu()
        && gtk::MediaFile::new().type_().name() != "GtkNoMediaFile";
}

/// The file as a media stream: GTK's own where it has a backend, else ours.
pub fn for_file(path: &Path) -> gtk::MediaStream {
    if GTK_HAS_MEDIA.with(|has| *has) {
        return gtk::MediaFile::for_filename(path).upcast();
    }
    match GstStream::for_file(path) {
        Ok(stream) => stream.upcast(),
        Err(e) => {
            let failed = gtk::MediaFile::new();
            failed.set_error(glib::Error::new(glib::FileError::Failed, &e));
            failed.upcast()
        }
    }
}
