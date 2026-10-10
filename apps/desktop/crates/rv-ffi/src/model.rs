//! What Swift reads: rv-core's rows with their JSON already parsed.

use rv_core::content::{self, FileKind, LinkPreview};
use rv_core::markdown;
use rv_core::media::{self, AvatarTarget};
use rv_core::rest::RestError;
use rv_core::rooms::Section;
use rv_core::store::{MessageRow, RoomRow};
use rv_core::timeline::Display;

use crate::markup::{self, BodyBlock};

#[derive(Debug, thiserror::Error, uniffi::Error)]
pub enum RvError {
    /// `status` 0: no answer at all. `two_factor`: the method the server asks a code for.
    #[error("{message}")]
    Server {
        status: u16,
        message: String,
        error: Option<String>,
        two_factor: Option<TwoFactor>,
        request_id: Option<String>,
        retry_after: Option<u64>,
    },
    #[error("{message}")]
    Local { message: String },
}

/// One more page of history: whether there may be more still, and how many
/// messages the room then shows (None: keep the current count).
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct OlderPage {
    pub more: bool,
    pub limit: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct TwoFactor {
    pub method: String,
    pub methods: Vec<String>,
    pub code_generated: bool,
}

/// The kind of server the user says is at an address (`ServerKind`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum ServerChoice {
    Auto,
    RocketChat,
    RocketVibe,
    Mattermost,
    Kchat,
}

impl From<ServerChoice> for rv_core::native::ServerKind {
    fn from(choice: ServerChoice) -> Self {
        match choice {
            ServerChoice::Auto => Self::Auto,
            ServerChoice::RocketChat => Self::RocketChat,
            ServerChoice::RocketVibe => Self::RocketVibe,
            ServerChoice::Mattermost => Self::Mattermost,
            ServerChoice::Kchat => Self::Kchat,
        }
    }
}

impl From<RestError> for RvError {
    fn from(e: RestError) -> Self {
        RvError::Server {
            status: e.status,
            message: e.message,
            error: e.error,
            request_id: e.request_id,
            retry_after: e.retry_after,
            two_factor: e.two_factor.map(|c| TwoFactor {
                method: c.method,
                methods: c.methods,
                code_generated: c.code_generated,
            }),
        }
    }
}

impl RvError {
    pub fn local(message: impl ToString) -> Self {
        RvError::Local { message: message.to_string() }
    }
}

/// One kChat team server of an Infomaniak account.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct KchatServer {
    pub name: String,
    pub url: String,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct Account {
    pub genre: String,
    pub key: String,
    pub base_url: String,
    pub user_id: String,
    pub username: String,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct ServerProfile {
    pub genre: String,
    pub base_url: String,
    pub version: String,
    pub password_login: bool,
    pub two_factor: bool,
    pub e2e: bool,
    pub oauth: Vec<String>,
    pub account_invitations: bool,
    pub account_recovery: bool,
    pub email_recovery: bool,
    pub instance_id: Option<String>,
    pub data_epoch: Option<String>,
}

impl From<rv_core::server::ServerProfile> for ServerProfile {
    fn from(p: rv_core::server::ServerProfile) -> Self {
        ServerProfile {
            genre: p.genre,
            base_url: p.base_url,
            version: p.version,
            password_login: p.password_login,
            two_factor: p.two_factor,
            e2e: p.e2e,
            oauth: p.oauth,
            account_invitations: p.account_invitations,
            account_recovery: p.account_recovery,
            email_recovery: p.email_recovery,
            instance_id: p.native_identity.as_ref().map(|i| i.instance_id.clone()),
            data_epoch: p.native_identity.map(|i| i.data_epoch),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum RoomSection {
    Unread,
    Favorites,
    /// A sidebar category of my own (Mattermost): its name is the group's `title`.
    Group,
    Channels,
    Direct,
}

impl From<&Section> for RoomSection {
    fn from(s: &Section) -> Self {
        match s {
            Section::Unread => RoomSection::Unread,
            Section::Favorites => RoomSection::Favorites,
            Section::Group { .. } => RoomSection::Group,
            Section::Channels => RoomSection::Channels,
            Section::Direct => RoomSection::Direct,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum Presence {
    Online,
    Away,
    Busy,
    Offline,
}

impl From<rv_core::live::Presence> for Presence {
    fn from(p: rv_core::live::Presence) -> Self {
        match p {
            rv_core::live::Presence::Online => Presence::Online,
            rv_core::live::Presence::Away => Presence::Away,
            rv_core::live::Presence::Busy => Presence::Busy,
            rv_core::live::Presence::Offline => Presence::Offline,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Enum)]
pub enum RoomPreview {
    Empty,
    Text {
        text: String,
    },
    /// `author` did `kind` (a system message type), with `param`.
    System {
        author: String,
        kind: String,
        param: String,
    },
    Encrypted,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct Room {
    pub rid: String,
    pub kind: String,
    pub name: String,
    pub slug: Option<String>,
    pub preview: RoomPreview,
    pub last_ts: i64,
    pub unread: i64,
    pub mentions: i64,
    pub alert: bool,
    pub favorite: bool,
    pub encrypted: bool,
    pub read_only: bool,
    pub avatar: Option<String>,
    pub presence: Option<Presence>,
    /// A voice channel (RocketVibe): selecting it joins its voice session.
    pub voice: bool,
}

/// How people are named (`username`, `nickname_full_name`, `full_name`) and
/// how many direct conversations the list keeps; `name_locked` when the
/// server imposes its format.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct SidebarSettings {
    pub name_format: String,
    pub name_locked: bool,
    pub dm_limit: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct RoomGroup {
    pub section: RoomSection,
    /// What the folded-sections file stores, unique per section.
    pub key: String,
    /// The category's own name, for a `Group`.
    pub title: Option<String>,
    pub rooms: Vec<Room>,
}

impl RoomGroup {
    pub fn new(section: &Section, rooms: Vec<Room>) -> Self {
        let title = match section {
            Section::Group { name, .. } => Some(name.clone()),
            _ => None,
        };
        RoomGroup { section: section.into(), key: section.key(), title, rooms }
    }
}

/// The quick switcher (Cmd+K): the rooms of `rooms` matching `query`, in
/// `rv_core::rooms::switcher_matches`'s order (name start, word start,
/// anywhere; latest activity first).
#[uniffi::export]
pub fn switcher_matches(rooms: Vec<Room>, query: String) -> Vec<Room> {
    let rows: Vec<RoomRow> = rooms
        .iter()
        .map(|r| RoomRow {
            rid: r.rid.clone(),
            name: r.name.clone(),
            slug: r.slug.clone(),
            last_ts: r.last_ts,
            ..Default::default()
        })
        .collect();
    let order = rv_core::rooms::switcher_matches(&rows, &query);
    order.iter().filter_map(|m| rooms.iter().find(|r| r.rid == m.rid).cloned()).collect()
}

pub fn room(r: RoomRow, clear_last: Option<String>, presence: Option<Presence>) -> Room {
    let system = r.last_type.as_deref().filter(|kind| *kind != "e2e");
    let preview = match (&r.last_message, r.encrypted) {
        _ if let Some(text) = clear_last => RoomPreview::Text { text: rv_core::emoji::replace_shortcodes(&text) },
        _ if let Some(kind) = system => RoomPreview::System {
            author: r.last_author.clone().unwrap_or_default(),
            kind: kind.to_owned(),
            param: r.last_message.clone().unwrap_or_default(),
        },
        // A quote previews by its own words; a forward (no words) says it is one.
        (Some(m), _) => RoomPreview::Text {
            text: match rv_core::actions::preview_words(m) {
                Some(words) => rv_core::emoji::replace_shortcodes(words),
                None => rv_core::i18n::t("rooms.quoted_message").to_owned(),
            },
        },
        (None, true) => RoomPreview::Encrypted,
        (None, false) => RoomPreview::Empty,
    };
    Room {
        avatar: media::room_avatar_path(&r),
        rid: r.rid,
        kind: r.kind,
        name: r.name,
        slug: r.slug,
        preview,
        last_ts: r.last_ts,
        unread: r.unread,
        mentions: r.mentions,
        alert: r.alert,
        favorite: r.favorite,
        encrypted: r.encrypted,
        read_only: r.read_only,
        voice: r.voice,
        presence,
    }
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct ImageItem {
    /// A server path or URL, for `Chat::media`.
    pub source: String,
    pub width: Option<i64>,
    pub height: Option<i64>,
    pub title: Option<String>,
    pub description: Option<String>,
}

impl From<media::ImageAttachment> for ImageItem {
    fn from(i: media::ImageAttachment) -> Self {
        ImageItem { source: i.source, width: i.width, height: i.height, title: i.title, description: i.description }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum FileType {
    Audio,
    Video,
    Other,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct FileItem {
    pub kind: FileType,
    pub url: String,
    pub title: String,
    pub size: Option<String>,
    pub mime: Option<String>,
    pub description: Option<String>,
}

impl From<content::FileAttachment> for FileItem {
    fn from(f: content::FileAttachment) -> Self {
        Self {
            kind: match f.kind {
                FileKind::Audio => FileType::Audio,
                FileKind::Video => FileType::Video,
                FileKind::Other => FileType::Other,
            },
            url: f.url,
            title: f.title,
            size: f.size.map(content::human_size),
            mime: f.mime,
            description: f.description,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct Quote {
    pub unavailable: bool,
    pub link: String,
    pub author: Option<String>,
    pub body: Vec<BodyBlock>,
    pub images: Vec<ImageItem>,
    pub files: Vec<FileItem>,
    /// What the quoted message quoted in turn.
    pub quotes: Vec<Quote>,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, uniffi::Record)]
pub struct Card {
    pub url: String,
    pub title: Option<String>,
    pub description: Option<String>,
    pub image: Option<String>,
    pub site: Option<String>,
    /// A video (YouTube and the like): the card plays it.
    pub video: bool,
    /// The video's player page, loaded at `player_origin()`: the card plays it in place.
    pub player: Option<String>,
    pub integration: bool,
    pub color: Option<String>,
    pub fields: Vec<CardField>,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct CardField {
    pub title: String,
    pub value: String,
    pub short: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct Reaction {
    pub shortcode: String,
    /// None for a server emoji, drawn from `Chat::custom_emoji`.
    pub glyph: Option<String>,
    pub count: u32,
    pub mine: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum Delivery {
    Sent,
    Pending,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct MessageItem {
    pub id: String,
    pub rid: String,
    pub ts: i64,
    pub author: String,
    pub author_id: String,
    pub avatar: String,
    pub mine: bool,
    pub show_header: bool,
    pub show_day: bool,
    pub gutter_time: bool,
    pub new_marker: bool,
    /// A system message type (`uj`, `videoconf`…) with its parameter in `param`.
    pub system: Option<String>,
    pub param: String,
    pub call_id: Option<String>,
    /// An encrypted message the unlocked keys cannot read (yet).
    pub locked: bool,
    pub body: Vec<BodyBlock>,
    /// The words as typed (decrypted if need be): for copy, edit and quote.
    pub text: Option<String>,
    pub quotes: Vec<Quote>,
    pub images: Vec<ImageItem>,
    pub files: Vec<FileItem>,
    pub cards: Vec<Card>,
    pub reactions: Vec<Reaction>,
    pub edited: bool,
    pub delivery: Delivery,
    pub thread_count: i64,
    pub thread_id: Option<String>,
    pub pinned: bool,
    pub starred: bool,
    /// Written by a bot account (RocketVibe): a "BOT" badge beside the name.
    pub author_bot: bool,
    /// A form a workflow asks (RocketVibe, RFC 0004): its card and who may answer.
    pub form: Option<crate::native_workflows::FormItem>,
    /// The name the header shows: the username, or on Mattermost the name
    /// under the account's name format with the custom status emoji.
    pub author_label: String,
    /// A `discussion-created` message's discussion, drawn as a card
    /// (Rocket.Chat); its name is `param`.
    pub discussion: Option<DiscussionCard>,
}

/// A discussion born in the room: its rid, how many messages it holds, when
/// the last one came.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct DiscussionCard {
    pub rid: String,
    pub count: i64,
    pub last: Option<i64>,
}

pub fn quote(q: content::Quote, me: &str) -> Quote {
    let ctx = markdown::Context { me };
    Quote {
        unavailable: q.unavailable,
        link: q.link,
        author: q.author,
        body: markup::blocks(markdown::render(q.md.as_deref(), Some(&q.text), &ctx)),
        images: q.images.into_iter().map(ImageItem::from).collect(),
        files: q.files.into_iter().map(FileItem::from).collect(),
        quotes: q.quotes.into_iter().map(|inner| quote(inner, me)).collect(),
    }
}

/// `d.row` as `Session::open_row` left it: an encrypted message opened when
/// the keys read it, its text None when they do not.
pub fn message(d: Display, me_id: &str, me: &str) -> MessageItem {
    let row: MessageRow = d.row;
    let ctx = markdown::Context { me };
    let encrypted = row.system_type.as_deref() == Some("e2e");
    let is_call = row.system_type.as_deref() == Some("videoconf");
    let system = row.system_type.clone().filter(|k| k != "e2e");
    let form = rv_core::native::workflows::row_form(&row);
    let (body, text, locked) = if system.is_some() {
        (Vec::new(), None, false)
    } else if encrypted {
        match &row.text {
            Some(t) => (markup::blocks(markdown::render(None, Some(t), &ctx)), Some(t.clone()), false),
            None => (Vec::new(), None, true),
        }
    } else if form.as_ref().is_some_and(|f| rv_core::native::workflows::text_is_form_title(row.text.as_deref(), f)) {
        // A form step's text is its title, which the card shows already;
        // the text stays for copy and quote.
        (Vec::new(), row.text.clone(), false)
    } else {
        (markup::blocks(markdown::render(row.md.as_deref(), row.text.as_deref(), &ctx)), row.text.clone(), false)
    };
    let attachments = row.attachments.as_deref();
    let mut cards: Vec<Card> = content::video_links(row.text.as_deref().unwrap_or_default(), row.urls.as_deref(), 3)
        .into_iter()
        .map(|v| Card {
            url: v.url,
            title: v.title,
            description: None,
            image: v.thumbnail,
            site: Some(v.provider.to_owned()),
            video: true,
            player: rv_core::player::page(v.provider, &v.id),
            ..Default::default()
        })
        .collect();
    cards.extend(content::link_previews(row.urls.as_deref(), 3).into_iter().map(|p| match p {
        LinkPreview::Image { url } => Card { image: Some(url.clone()), url, ..Default::default() },
        LinkPreview::Card { url, title, description, image, site } => {
            Card { url, title, description, image, site, ..Default::default() }
        }
    }));
    cards.extend(content::cards(attachments).into_iter().map(|c| Card {
        url: c.link.unwrap_or_default(),
        title: c.title,
        description: c.text,
        site: c.author,
        color: c.color,
        integration: true,
        fields: c.fields.into_iter().map(|(title, value, short)| CardField { title, value, short }).collect(),
        ..Default::default()
    }));
    let author = row.author.clone().unwrap_or_default();
    MessageItem {
        avatar: media::avatar_path(AvatarTarget::User(&author), None),
        mine: row.author_id == me_id,
        show_header: d.show_header,
        show_day: d.show_day,
        gutter_time: d.gutter_time,
        new_marker: d.new_marker,
        param: if system.is_some() { row.text.clone().unwrap_or_default() } else { String::new() },
        system,
        call_id: row.call_id.clone().filter(|_| is_call),
        locked,
        body,
        text,
        quotes: content::quotes(attachments).into_iter().map(|q| quote(q, me)).collect(),
        images: media::image_attachments(attachments).into_iter().map(ImageItem::from).collect(),
        files: content::files(attachments).into_iter().map(FileItem::from).collect(),
        cards,
        reactions: rv_core::actions::reactions(row.reactions.as_deref(), me)
            .into_iter()
            .map(|r| Reaction {
                glyph: rv_core::emoji::unicode(&r.shortcode).map(str::to_owned),
                shortcode: r.shortcode,
                count: r.count as u32,
                mine: r.mine,
            })
            .collect(),
        edited: row.edited,
        delivery: match row.outbox_status.as_deref() {
            Some("pending") => Delivery::Pending,
            Some("failed") => Delivery::Failed,
            _ => Delivery::Sent,
        },
        thread_count: row.thread_count,
        pinned: row.pinned,
        starred: row.starred_by(me_id),
        author_bot: row.author_bot,
        form: form.map(|form| crate::native_workflows::form_item(form, me_id)),
        author_label: author.clone(),
        discussion: row
            .discussion_id
            .clone()
            .filter(|_| row.system_type.as_deref() == Some("discussion-created"))
            .map(|rid| DiscussionCard { rid, count: row.discussion_count, last: row.discussion_last }),
        id: row.id,
        rid: row.rid,
        ts: row.ts,
        author,
        author_id: row.author_id,
        thread_id: row.thread_id,
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn provider_error_retains_native_diagnostics_in_the_exported_error() {
        let error = RestError {
            status: 429,
            message: "service busy".into(),
            error: Some("service_busy".into()),
            error_type: None,
            understood: true,
            two_factor: None,
            request_id: Some("request-fixture".into()),
            retry_after: Some(12),
            details: None,
        };
        match RvError::from(error) {
            RvError::Server { status, request_id, retry_after, two_factor, .. } => {
                assert_eq!(status, 429);
                assert_eq!(request_id.as_deref(), Some("request-fixture"));
                assert_eq!(retry_after, Some(12));
                assert!(two_factor.is_none());
            }
            _ => panic!("native error lost its server envelope"),
        }
    }
    use super::*;

    fn display(row: MessageRow) -> Display {
        Display { row, show_header: true, show_day: false, gutter_time: false, new_marker: false }
    }

    #[test]
    fn a_discussion_created_message_carries_its_card() {
        let row = MessageRow {
            system_type: Some("discussion-created".into()),
            text: Some("Plans".into()),
            discussion_id: Some("d1".into()),
            discussion_count: 2,
            discussion_last: Some(9),
            ..Default::default()
        };
        let m = message(display(row.clone()), "U1", "me");
        assert_eq!(m.discussion, Some(DiscussionCard { rid: "d1".into(), count: 2, last: Some(9) }));
        assert_eq!((m.system.as_deref(), m.param.as_str()), (Some("discussion-created"), "Plans"));
        let plain = message(display(MessageRow { system_type: None, ..row }), "U1", "me");
        assert_eq!(plain.discussion, None);
    }

    #[test]
    fn a_form_message_shows_its_title_once() {
        let form = r#"{"title":"Standup","fields":[{"id":"today","label":"Today","kind":"text","required":true}],"expires_at":"2099-01-01T00:00:00+00:00"}"#;
        let asked = MessageRow {
            text: Some("Standup".into()),
            form: Some(form.into()),
            author_id: "bot".into(),
            ..Default::default()
        };
        let m = message(display(asked.clone()), "U1", "me");
        assert!(m.body.is_empty(), "the card says the title");
        assert_eq!((m.text.as_deref(), m.form.map(|f| f.can_answer)), (Some("Standup"), Some(true)));
        let other = message(display(MessageRow { text: Some("Answer this".into()), ..asked }), "U1", "me");
        assert!(!other.body.is_empty());
    }

    #[test]
    fn a_message_with_its_json_parsed() {
        let row = MessageRow {
            id: "m1".into(),
            rid: "r1".into(),
            author: Some("bob".into()),
            author_id: "U2".into(),
            text: Some("look".into()),
            attachments: Some(
                r#"[{"title":"cat.png","title_link":"/file-upload/1/cat.png","image_url":"/file-upload/1/t.png","image_dimensions":{"width":4,"height":3}},
                    {"title":"a.pdf","title_link":"/file-upload/2/a.pdf","size":2048,"type":"application/pdf"}]"#
                    .into(),
            ),
            reactions: Some(r#"{":+1:":{"usernames":["me","bob"]},":party:":{"usernames":["bob"]}}"#.into()),
            outbox_status: Some("failed".into()),
            ..Default::default()
        };
        let m = message(display(row), "U1", "me");
        assert_eq!((m.author.as_str(), m.mine, m.delivery), ("bob", false, Delivery::Failed));
        assert_eq!(m.avatar, "/avatar/bob");
        assert_eq!(m.images.len(), 1);
        assert_eq!(m.images[0].source, "/file-upload/1/cat.png");
        assert_eq!(m.files.len(), 1);
        assert_eq!(m.files[0].size.as_deref(), Some("2.0 KB"));
        assert_eq!(
            m.reactions[0],
            Reaction { shortcode: ":+1:".into(), glyph: Some("👍".into()), count: 2, mine: true }
        );
        assert_eq!(m.reactions[1].glyph, None);
        assert!(matches!(&m.body[0], BodyBlock::Paragraph { runs } if runs[0].text == "look"));
    }

    #[test]
    fn integration_cards_reach_existing_swift_cards_with_full_fields() {
        let row=MessageRow{attachments:Some(serde_json::json!([{"native_card":true,"author_name":"CI","title":"Build &amp; ready","title_link":"https://example.org/build","text":"Details","color":"#1177aa","fields":[{"title":"Commit","value":"abcdef","short":true}]}]).to_string()),..Default::default()};
        let m = message(display(row), "alice-id", "alice");
        assert_eq!(m.cards.len(), 1);
        let card = &m.cards[0];
        assert!(card.integration);
        assert_eq!(card.title.as_deref(), Some("Build &amp; ready"));
        assert_eq!(card.site.as_deref(), Some("CI"));
        assert_eq!(card.fields[0].value, "abcdef");
        assert!(card.fields[0].short);
    }

    #[test]
    fn system_and_encrypted_messages_carry_no_body() {
        let joined = MessageRow { system_type: Some("uj".into()), text: Some("bob".into()), ..Default::default() };
        let m = message(display(joined), "U1", "me");
        assert_eq!((m.system.as_deref(), m.param.as_str()), (Some("uj"), "bob"));
        assert!(m.body.is_empty() && !m.locked);

        let sealed = MessageRow { system_type: Some("e2e".into()), ..Default::default() };
        let locked = message(display(sealed.clone()), "U1", "me");
        assert!(locked.locked && locked.system.is_none() && locked.text.is_none());
        let open = message(display(MessageRow { text: Some("secret".into()), ..sealed }), "U1", "me");
        assert!(!open.locked);
        assert_eq!(open.text.as_deref(), Some("secret"));
    }

    #[test]
    fn room_previews() {
        let base = RoomRow {
            rid: "r".into(),
            kind: "c".into(),
            name: "general".into(),
            last_message: None,
            last_ts: 0,
            unread: 0,
            mentions: 0,
            alert: false,
            favorite: false,
            encrypted: false,
            read_only: false,
            dm_other_uid: None,
            avatar_etag: None,
            slug: None,
            last_type: None,
            last_author: None,
            last_encrypted: None,
            voice: false,
            ..Default::default()
        };
        let quoted = RoomRow { last_message: Some("[ ](https://x/?msg=1) hi :smile:".into()), ..base.clone() };
        assert_eq!(room(quoted, None, None).preview, RoomPreview::Text { text: "hi 😄".into() });
        let forwarded = RoomRow { last_message: Some("[ ](https://x/?msg=1)".into()), ..base.clone() };
        let quoted_label = rv_core::i18n::t("rooms.quoted_message").to_owned();
        assert_eq!(room(forwarded, None, None).preview, RoomPreview::Text { text: quoted_label });
        let joined = RoomRow {
            last_type: Some("uj".into()),
            last_author: Some("bob".into()),
            last_message: None,
            ..base.clone()
        };
        assert_eq!(
            room(joined, None, None).preview,
            RoomPreview::System { author: "bob".into(), kind: "uj".into(), param: String::new() }
        );
        let sealed = RoomRow { encrypted: true, ..base.clone() };
        let r = room(sealed.clone(), None, None);
        assert_eq!((r.preview, r.avatar), (RoomPreview::Encrypted, None));
        assert_eq!(room(sealed, Some("clear".into()), None).preview, RoomPreview::Text { text: "clear".into() });
        assert_eq!(room(base, None, None).avatar.as_deref(), Some("/avatar/room/r"));
    }
}
