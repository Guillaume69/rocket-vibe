//! Slack canvases for Android: the desktop's engine (`rv-canvas`) behind two
//! pure calls, the app doing the HTTP. Hermes has no WebAssembly, so the
//! Automerge documents a save writes are made here.

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use jni::JNIEnv;
use jni::objects::{JClass, JString};
use jni::sys::{jlong, jstring};
use serde_json::json;

/// A `load-data` answer (base64) as `{markdown, version, thread, document, title}`.
pub fn read(load: &str) -> Option<String> {
    let canvas = rv_canvas::Canvas::from_load_data(&STANDARD.decode(load).ok()?).ok()?;
    Some(
        json!({
            "markdown": rv_canvas::to_markdown(&canvas),
            "version": canvas.version.to_string(),
            "thread": canvas.thread,
            "document": canvas.document,
            "title": canvas.title,
        })
        .to_string(),
    )
}

/// The save of `markdown` over a `load-data` answer: `{data, changed}`, `data`
/// the base64 `data_binary` (empty when nothing changed).
pub fn plan(
    load: &str,
    markdown: &str,
    session: &str,
    suffix: &str,
    now_secs: i64,
) -> Option<String> {
    let canvas = rv_canvas::Canvas::from_load_data(&STANDARD.decode(load).ok()?).ok()?;
    let session = rv_canvas::Session {
        id: session.to_owned(),
        suffix: suffix.to_owned(),
        now_secs,
    };
    let edit = rv_canvas::plan(&canvas, markdown, &session);
    Some(json!({"data": STANDARD.encode(&edit.data), "changed": edit.changed}).to_string())
}

fn text(env: &mut JNIEnv, value: &JString) -> Option<String> {
    if value.is_null() {
        return None;
    }
    env.get_string(value).ok().map(Into::into)
}

fn answer(env: &JNIEnv, value: Option<String>) -> jstring {
    value
        .and_then(|v| env.new_string(v).ok())
        .map_or(std::ptr::null_mut(), |s| s.into_raw())
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_com_rocketvibe_voice_Canvas_read(
    mut env: JNIEnv,
    _class: JClass,
    load: JString,
) -> jstring {
    let value = text(&mut env, &load).and_then(|load| read(&load));
    answer(&env, value)
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_com_rocketvibe_voice_Canvas_plan(
    mut env: JNIEnv,
    _class: JClass,
    load: JString,
    markdown: JString,
    session: JString,
    suffix: JString,
    now_secs: jlong,
) -> jstring {
    let args = (
        text(&mut env, &load),
        text(&mut env, &markdown),
        text(&mut env, &session),
        text(&mut env, &suffix),
    );
    let value = match args {
        (Some(load), Some(markdown), Some(session), Some(suffix)) => {
            plan(&load, &markdown, &session, &suffix, now_secs)
        }
        _ => None,
    };
    answer(&env, value)
}

#[cfg(test)]
mod tests {
    use super::*;
    use rv_canvas::wire::Message;

    fn load() -> String {
        let text = |t: &str| Message::default().with_message(1, &Message::default().with_str(1, t));
        let data = Message::default()
            .with_message(3, &Message::default().with_str(1, "TH").with_int(2, 1))
            .with_message(6, &Message::default().with_str(1, "DOC").with_int(48, 4000))
            .with_message(
                7,
                &Message::default()
                    .with_str(1, "s1")
                    .with_int(2, 1000)
                    .with_str(8, "aab")
                    .with_message(12, &text("Hello")),
            );
        STANDARD.encode(
            Message::default()
                .with_message(2, &Message::default().with_message(2, &data))
                .encode(),
        )
    }

    #[test]
    fn a_canvas_reads_and_plans_through_the_bridge() {
        let shown: serde_json::Value = serde_json::from_str(&read(&load()).unwrap()).unwrap();
        assert_eq!(shown["markdown"], "Hello\n");
        assert_eq!(
            (shown["version"].as_str(), shown["thread"].as_str()),
            (Some("4000"), Some("TH"))
        );
        let same: serde_json::Value =
            serde_json::from_str(&plan(&load(), "Hello\n", "0123456789ab", "cdef0123", 1).unwrap())
                .unwrap();
        assert_eq!(same["changed"], 0);
        let edited: serde_json::Value = serde_json::from_str(
            &plan(&load(), "Hello there\n", "0123456789ab", "cdef0123", 1).unwrap(),
        )
        .unwrap();
        assert_eq!(edited["changed"], 1);
        assert!(!edited["data"].as_str().unwrap().is_empty());
        assert!(read("not base64").is_none());
    }
}
