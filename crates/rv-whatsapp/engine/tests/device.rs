//! The device as rv-core drives it, without reaching WhatsApp.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use rv_whatsapp_engine::{Device, OpenError, Sink};
use serde_json::Value;

#[derive(Default)]
struct Frames(Mutex<Vec<Value>>);

impl Sink for Frames {
    fn frame(&self, frame: String) {
        self.0
            .lock()
            .unwrap()
            .push(serde_json::from_str(&frame).unwrap());
    }
}

impl Frames {
    fn take(&self) -> Vec<Value> {
        std::mem::take(&mut self.0.lock().unwrap())
    }
}

fn state() -> PathBuf {
    let name: String = (0..8).map(|i| format!("{:02x}", rand_byte(i))).collect();
    std::env::temp_dir()
        .join(format!("rv-device-test-{name}"))
        .join("state")
}

fn rand_byte(i: u8) -> u8 {
    use std::hash::{BuildHasher, RandomState};
    RandomState::new().hash_one(i) as u8
}

fn open(path: &Path, key: &[u8]) -> (Result<Device, OpenError>, Arc<Frames>) {
    let frames = Arc::new(Frames::default());
    (
        Device::open(path, key, Arc::clone(&frames) as Arc<dyn Sink>),
        frames,
    )
}

#[test]
fn a_new_device_loads_empty_and_refuses_what_needs_whatsapp() {
    let path = state();
    let (device, frames) = open(&path, &[3; 32]);
    let mut device = device.unwrap();
    let opened = frames.take();
    let types: Vec<&str> = opened.iter().map(|f| f["type"].as_str().unwrap()).collect();
    assert_eq!(types, ["names", "replayed", "status"]);
    assert_eq!(opened[2]["state"], "loaded");

    assert!(device.handle("not json"));
    assert!(device.handle(r#"{"type":"unknown"}"#));
    assert!(device.handle(r#"{"type":"react","id":"a@s.whatsapp.net:X","text":"👍"}"#));
    let errors: Vec<String> = frames
        .take()
        .iter()
        .map(|f| f["code"].as_str().unwrap().to_owned())
        .collect();
    assert_eq!(
        errors,
        ["invalid_command", "invalid_command", "action_failed"]
    );

    assert!(
        device.handle(r#"{"type":"send","id":"ABCDEF0123","chat":"a@s.whatsapp.net","text":"hi"}"#)
    );
    let refused = (0..50)
        .find_map(|_| {
            std::thread::sleep(std::time::Duration::from_millis(20));
            frames.take().into_iter().find(|f| f["type"] == "error")
        })
        .expect("a refusal");
    assert_eq!(
        (refused["code"].as_str(), refused["id"].as_str()),
        (Some("not_connected"), Some("ABCDEF0123"))
    );

    assert!(device.handle(r#"{"type":"replay"}"#));
    assert_eq!(
        frames.take().first().map(|f| f["type"].clone()),
        Some(Value::from("reload"))
    );
    assert!(!device.handle(r#"{"type":"stop"}"#));
    device.close();
    assert!(path.exists(), "the state is sealed on close");
}

#[test]
fn a_state_opens_once_and_only_with_its_key() {
    let path = state();
    let (first, _) = open(&path, &[5; 32]);
    let mut first = first.unwrap();
    assert!(matches!(open(&path, &[5; 32]).0, Err(OpenError::Busy)));
    first.close();
    assert!(matches!(
        open(&path, &[6; 32]).0,
        Err(OpenError::Storage(_))
    ));
    let (again, frames) = open(&path, &[5; 32]);
    again.unwrap().close();
    assert!(frames.take().iter().any(|f| f["state"] == "loaded"));
}

#[test]
fn the_go_helpers_state_is_set_aside_for_a_new_link() {
    let path = state();
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(&path, b"RVWA1 sealed sqlite").unwrap();
    let (device, _) = open(&path, &[7; 32]);
    device.unwrap().close();
    assert!(std::fs::read(&path).unwrap().starts_with(b"RVWA2"));
}
