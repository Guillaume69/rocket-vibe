//! What a WhatsApp message carries for the client, read from its protobuf:
//! text, attachment, quote and link preview. Pure, no client.

use whatsapp_rust::Jid;
use whatsapp_rust::download::MediaType;
use whatsapp_rust::waproto::{codec, whatsapp as wa};

/// A chat the engine accepts: a person (number or LID) or a group, no device.
pub fn valid_chat(value: &str) -> Option<Jid> {
    let jid: Jid = value.parse().ok()?;
    let server = jid.server.as_str();
    let known = matches!(server, "s.whatsapp.net" | "g.us" | "lid");
    (known && !jid.user.is_empty() && jid.device == 0 && jid.agent == 0).then_some(jid)
}

pub fn is_group(jid: &str) -> bool {
    jid.ends_with("@g.us")
}

pub fn text_of(m: &wa::Message) -> &str {
    match m.conversation.as_deref() {
        Some(text) if !text.is_empty() => text,
        _ => m
            .extended_text_message
            .as_option()
            .and_then(|x| x.text.as_deref())
            .unwrap_or_default(),
    }
}

/// A link's preview, made by the sender's app (WhatsApp recipients never
/// fetch the page). `media` holds the extended text when the sender also
/// uploaded a large thumbnail.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Link {
    pub url: String,
    pub title: String,
    pub description: String,
    pub thumb: Vec<u8>,
    pub media: Vec<u8>,
}

pub fn link_of(m: &wa::Message) -> Link {
    let Some(x) = m.extended_text_message.as_option() else {
        return Link::default();
    };
    let url = x.matched_text.clone().unwrap_or_default();
    let thumb = x.jpeg_thumbnail.clone().unwrap_or_default();
    let uploaded = x
        .thumbnail_direct_path
        .as_deref()
        .is_some_and(|p| !p.is_empty());
    let title = x.title.clone().unwrap_or_default();
    if url.is_empty() || (title.is_empty() && thumb.is_empty() && !uploaded) {
        return Link::default();
    }
    let url = if url.contains("://") {
        url
    } else {
        format!("https://{url}")
    };
    let media = if uploaded {
        wrapped(build(|x: &mut wa::Message| {
            x.extended_text_message = m.extended_text_message.clone()
        }))
    } else {
        Vec::new()
    };
    Link {
        url,
        title,
        description: x.description.clone().unwrap_or_default(),
        thumb,
        media,
    }
}

/// The attachment of a message: what the timeline shows before any download
/// and the message it is fetched with.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Attachment {
    pub kind: &'static str,
    pub mime: String,
    pub file_name: String,
    pub size: i64,
    pub width: i64,
    pub height: i64,
    pub seconds: i64,
    pub thumb: Vec<u8>,
    pub media: Vec<u8>,
}

/// A protobuf built field by field (their structs are non-exhaustive).
pub fn build<T: Default>(set: impl FnOnce(&mut T)) -> T {
    let mut value = T::default();
    set(&mut value);
    value
}

fn wrapped(m: wa::Message) -> Vec<u8> {
    codec::message_to_vec(&m)
}

/// The attachment of a message and its caption; none for text and for what
/// this client does not show.
pub fn attachment_of(m: &wa::Message) -> Option<(Attachment, String)> {
    if let Some(x) = m.image_message.as_option() {
        let media = wrapped(build(|x: &mut wa::Message| {
            x.image_message = m.image_message.clone()
        }));
        let a = Attachment {
            kind: "image",
            mime: x.mimetype.clone().unwrap_or_default(),
            size: x.file_length.unwrap_or_default() as i64,
            width: x.width.unwrap_or_default().into(),
            height: x.height.unwrap_or_default().into(),
            thumb: x.jpeg_thumbnail.clone().unwrap_or_default(),
            media,
            ..Attachment::default()
        };
        return Some((a, x.caption.clone().unwrap_or_default()));
    }
    if let Some(x) = m.video_message.as_option() {
        let media = wrapped(build(|x: &mut wa::Message| {
            x.video_message = m.video_message.clone()
        }));
        let a = Attachment {
            kind: if x.gif_playback == Some(true) {
                "gif"
            } else {
                "video"
            },
            mime: x.mimetype.clone().unwrap_or_default(),
            size: x.file_length.unwrap_or_default() as i64,
            width: x.width.unwrap_or_default().into(),
            height: x.height.unwrap_or_default().into(),
            seconds: x.seconds.unwrap_or_default().into(),
            thumb: x.jpeg_thumbnail.clone().unwrap_or_default(),
            media,
            ..Attachment::default()
        };
        return Some((a, x.caption.clone().unwrap_or_default()));
    }
    if let Some(x) = m.audio_message.as_option() {
        let media = wrapped(build(|x: &mut wa::Message| {
            x.audio_message = m.audio_message.clone()
        }));
        let a = Attachment {
            kind: if x.ptt == Some(true) {
                "voice"
            } else {
                "audio"
            },
            mime: x.mimetype.clone().unwrap_or_default(),
            size: x.file_length.unwrap_or_default() as i64,
            seconds: x.seconds.unwrap_or_default().into(),
            media,
            ..Attachment::default()
        };
        return Some((a, String::new()));
    }
    if let Some(x) = m.document_message.as_option() {
        let media = wrapped(build(|x: &mut wa::Message| {
            x.document_message = m.document_message.clone()
        }));
        let name = x
            .file_name
            .clone()
            .filter(|n| !n.is_empty())
            .or_else(|| x.title.clone())
            .unwrap_or_default();
        let a = Attachment {
            kind: "document",
            mime: x.mimetype.clone().unwrap_or_default(),
            file_name: name,
            size: x.file_length.unwrap_or_default() as i64,
            thumb: x.jpeg_thumbnail.clone().unwrap_or_default(),
            media,
            ..Attachment::default()
        };
        return Some((a, x.caption.clone().unwrap_or_default()));
    }
    if let Some(x) = m.sticker_message.as_option() {
        let media = wrapped(build(|x: &mut wa::Message| {
            x.sticker_message = m.sticker_message.clone()
        }));
        let a = Attachment {
            kind: "sticker",
            mime: x.mimetype.clone().unwrap_or_default(),
            size: x.file_length.unwrap_or_default() as i64,
            width: x.width.unwrap_or_default().into(),
            height: x.height.unwrap_or_default().into(),
            thumb: x.png_thumbnail.clone().unwrap_or_default(),
            media,
            ..Attachment::default()
        };
        return Some((a, String::new()));
    }
    None
}

/// The context (quoted message) of whichever kind of message carries one.
pub fn context_of(m: &wa::Message) -> Option<&wa::ContextInfo> {
    [
        m.extended_text_message
            .as_option()
            .and_then(|x| x.context_info.as_option()),
        m.image_message
            .as_option()
            .and_then(|x| x.context_info.as_option()),
        m.video_message
            .as_option()
            .and_then(|x| x.context_info.as_option()),
        m.audio_message
            .as_option()
            .and_then(|x| x.context_info.as_option()),
        m.document_message
            .as_option()
            .and_then(|x| x.context_info.as_option()),
        m.sticker_message
            .as_option()
            .and_then(|x| x.context_info.as_option()),
    ]
    .into_iter()
    .flatten()
    .next()
}

/// What WhatsApp sends most, named as people expect.
fn extension_of(mime: &str) -> &'static str {
    match mime.split(';').next().unwrap_or_default().trim() {
        "image/jpeg" => ".jpg",
        "image/png" => ".png",
        "image/webp" => ".webp",
        "image/gif" => ".gif",
        "video/mp4" => ".mp4",
        "audio/ogg" => ".ogg",
        "audio/mpeg" => ".mp3",
        "audio/mp4" => ".m4a",
        "application/pdf" => ".pdf",
        "text/plain" => ".txt",
        "application/zip" => ".zip",
        _ => "",
    }
}

/// The file name an attachment is kept under: the message id, made safe, and
/// an extension from its name or type.
pub fn media_file(id: &str, kind: &str, mime: &str, name: &str) -> String {
    let safe: String = id
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
        .collect();
    let from_name = std::path::Path::new(name)
        .extension()
        .and_then(|e| e.to_str())
        .filter(|e| !e.is_empty() && e.len() < 8)
        .map(|e| format!(".{e}"));
    let ext = from_name.unwrap_or_else(|| {
        let ext = extension_of(mime);
        let ext = if ext.is_empty() {
            match kind {
                "image" => ".jpg",
                "video" | "gif" => ".mp4",
                "voice" | "audio" => ".ogg",
                "sticker" => ".webp",
                _ => "",
            }
        } else {
            ext
        };
        ext.to_owned()
    });
    safe + &ext
}

/// What an outgoing file is sent as, from its type: a voice note only when the
/// app recorded it (Ogg/Opus), a video only as MP4, anything else a document.
pub fn outgoing_kind(mime: &str, voice: bool) -> (&'static str, MediaType) {
    let base = mime.split(';').next().unwrap_or_default().trim();
    match base {
        "audio/ogg" if voice => ("voice", MediaType::Audio),
        "image/jpeg" | "image/png" | "image/webp" => ("image", MediaType::Image),
        "video/mp4" => ("video", MediaType::Video),
        _ if base.starts_with("audio/") => ("audio", MediaType::Audio),
        _ => ("document", MediaType::Document),
    }
}

/// An Ogg stream's length: the last page's granule position at Opus's 48 kHz.
pub fn ogg_seconds(data: &[u8]) -> i64 {
    let Some(last) = data.windows(4).rposition(|w| w == b"OggS") else {
        return 0;
    };
    let Some(granule) = data.get(last + 6..last + 14) else {
        return 0;
    };
    let granule = u64::from_le_bytes(granule.try_into().expect("8 bytes"));
    if granule == u64::MAX {
        0
    } else {
        (granule / 48_000) as i64
    }
}

/// The first web link of a text, as typed: WhatsApp's matchedText.
pub fn first_link(text: &str) -> Option<&str> {
    const LEAD: &[char] = &['(', '[', '{', '\'', '*', '_', '~'];
    const TRAIL: &[char] = &['.', ',', ';', ':', '!', '?', ']', '}', '\'', '*', '_', '~'];
    for token in text.split(|c: char| c.is_whitespace() || "<>\"".contains(c)) {
        let mut token = token.trim_start_matches(LEAD).trim_end_matches(TRAIL);
        // A closing parenthesis ends the link unless the link opened one.
        while token.ends_with(')') && token.matches('(').count() < token.matches(')').count() {
            token = token[..token.len() - 1].trim_end_matches(TRAIL);
        }
        let lower = token.to_ascii_lowercase();
        if !lower.starts_with("https://")
            && !lower.starts_with("http://")
            && !lower.starts_with("www.")
        {
            continue;
        }
        let full = with_scheme(token);
        let host = full
            .split("://")
            .nth(1)
            .unwrap_or_default()
            .split(['/', '?', '#'])
            .next()
            .unwrap_or_default();
        let host = host.rsplit('@').next().unwrap_or_default();
        let host = host.split(':').next().unwrap_or_default();
        if host.contains('.') {
            return Some(token);
        }
    }
    None
}

pub fn with_scheme(link: &str) -> String {
    if link.contains("://") {
        link.to_owned()
    } else {
        format!("https://{link}")
    }
}

/// The digits of a phone number as typed (+33 6 12 34 56 78), when it is one.
pub fn phone_digits(query: &str) -> Option<String> {
    let mut digits = String::new();
    for c in query.chars() {
        match c {
            '0'..='9' => digits.push(c),
            '+' | ' ' | '-' | '.' | '(' | ')' => {}
            _ => return None,
        }
    }
    (6..=15).contains(&digits.len()).then_some(digits)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_first_link_is_taken_as_typed() {
        for (text, want) in [
            ("see https://example.org/a.", Some("https://example.org/a")),
            ("(www.example.org/x) and more", Some("www.example.org/x")),
            (
                "https://en.wikipedia.org/wiki/Go_(game), ok",
                Some("https://en.wikipedia.org/wiki/Go_(game)"),
            ),
            ("no link here, or a file.txt", None),
            ("http://localhost:8080 is no page", None),
            (
                "two: https://a.example.com https://b.example",
                Some("https://a.example.com"),
            ),
        ] {
            assert_eq!(first_link(text), want, "{text}");
        }
    }

    #[test]
    fn chats_are_people_or_groups_without_a_device() {
        assert!(valid_chat("33612345678@s.whatsapp.net").is_some());
        assert!(valid_chat("120363000000000000@g.us").is_some());
        assert!(valid_chat("123456789@lid").is_some());
        assert!(valid_chat("33612345678:3@s.whatsapp.net").is_none());
        assert!(valid_chat("status@broadcast").is_none());
        assert!(valid_chat("nonsense").is_none());
    }

    #[test]
    fn files_are_named_from_their_id_and_type() {
        assert_eq!(
            media_file("a@s.whatsapp.net:AB", "image", "image/jpeg", ""),
            "a_s_whatsapp_net_AB.jpg"
        );
        assert_eq!(
            media_file(
                "x:1",
                "document",
                "application/octet-stream",
                "report.final.docx"
            ),
            "x_1.docx"
        );
        assert_eq!(media_file("x:1", "voice", "", ""), "x_1.ogg");
        assert_eq!(media_file("x:1", "document", "", "noext"), "x_1");
    }

    #[test]
    fn outgoing_files_and_voice_notes() {
        assert_eq!(outgoing_kind("audio/ogg; codecs=opus", true).0, "voice");
        assert_eq!(outgoing_kind("audio/ogg", false).0, "audio");
        assert_eq!(outgoing_kind("video/quicktime", false).0, "document");
        assert_eq!(outgoing_kind("image/png", false).0, "image");
        let mut ogg = b"OggS\0\0".to_vec();
        ogg.extend_from_slice(&(48_000u64 * 7).to_le_bytes());
        assert_eq!(ogg_seconds(&ogg), 7);
    }

    #[test]
    fn phone_numbers_as_typed() {
        assert_eq!(
            phone_digits("+33 6 12-34.56 (78)").as_deref(),
            Some("33612345678")
        );
        assert_eq!(phone_digits("12345"), None);
        assert_eq!(phone_digits("alice"), None);
    }

    #[test]
    fn an_attachment_keeps_what_fetches_it() {
        let image = build(|x: &mut wa::message::ImageMessage| {
            x.mimetype = Some("image/jpeg".into());
            x.caption = Some("look".into());
            x.width = Some(4);
        });
        let m = build(|x: &mut wa::Message| {
            x.image_message = whatsapp_rust::buffa::MessageField::some(image)
        });
        let (a, caption) = attachment_of(&m).unwrap();
        assert_eq!((a.kind, caption.as_str(), a.width), ("image", "look", 4));
        let back = codec::message_decode(&a.media).unwrap();
        assert_eq!(
            back.image_message.as_option().unwrap().caption.as_deref(),
            Some("look")
        );
        assert!(
            attachment_of(&build(
                |x: &mut wa::Message| x.conversation = Some("hi".into())
            ))
            .is_none()
        );
    }

    #[test]
    fn a_link_needs_something_to_show() {
        let bare = build(|x: &mut wa::message::ExtendedTextMessage| {
            x.matched_text = Some("www.a.org".into())
        });
        let m = build(|x: &mut wa::Message| {
            x.extended_text_message = whatsapp_rust::buffa::MessageField::some(bare.clone())
        });
        assert_eq!(link_of(&m), Link::default());
        let mut titled = bare;
        titled.title = Some("A".into());
        let m = build(|x: &mut wa::Message| {
            x.extended_text_message = whatsapp_rust::buffa::MessageField::some(titled)
        });
        let link = link_of(&m);
        assert_eq!(
            (
                link.url.as_str(),
                link.title.as_str(),
                link.media.is_empty()
            ),
            ("https://www.a.org", "A", true)
        );
    }
}
