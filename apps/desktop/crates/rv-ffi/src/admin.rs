//! rv-core's server administration for Swift: one `ServerAdmin` per open
//! account, for both providers, with the dashboard, the users, the rooms, the
//! moderation of reports and the custom emoji, plus the Report every member uses. Records
//! carry the photo as a path `Chat::media`/`MediaStore` read, and the shown
//! name rv-core computes ("Deleted user" for a deleted account). A refusal is
//! `AdminFailure::Refused` with the server's code (`self_administration`,
//! `last_administrator`, `user-last-owner`, `moderation_bulk_only`...), the
//! rooms a last owner leaves behind and the count a bulk delete would take.

use std::sync::Arc;

use rv_core::admin::{self, Admin};
use rv_core::media::{AvatarTarget, avatar_path};

use crate::model::Presence;
use crate::native::NativeChat;
use crate::{Chat, on_tokio};

#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum AdminProduct {
    RocketChat,
    RocketVibe,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum AdminRoomKind {
    Public,
    Private,
    Direct,
    Discussion,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct AdminUserCounts {
    pub total: u64,
    pub active: u64,
    pub deactivated: u64,
    pub admins: Option<u64>,
    pub online: u64,
    pub away: u64,
    pub busy: u64,
    pub offline: u64,
}

/// Rooms or messages by type: discussions are Rocket.Chat's, encrypted ones RocketVibe's.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct AdminKindCounts {
    pub total: u64,
    pub public: u64,
    pub private: u64,
    pub direct: u64,
    pub discussions: Option<u64>,
    pub encrypted: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct AdminOverview {
    pub product: AdminProduct,
    pub version: String,
    pub uptime_seconds: Option<u64>,
    pub database: String,
    pub migration: Option<String>,
    pub runtime: Option<String>,
    pub instance_id: Option<String>,
    pub users: AdminUserCounts,
    pub rooms: AdminKindCounts,
    pub messages: AdminKindCounts,
    pub uploads_count: u64,
    pub uploads_bytes: u64,
    /// Open reports; None when the server refused to say (show "–").
    pub reported_messages: Option<u64>,
    pub reported_users: Option<u64>,
    /// Rocket.Chat's statistics snapshot date (RFC 3339); None when live.
    pub as_of: Option<String>,
}

/// An account as the lists show it; handed back as is to act on it.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct AdminUser {
    pub id: String,
    pub username: String,
    pub name: String,
    /// The photo to draw, None for the initials.
    pub avatar: Option<String>,
    /// The photo's version as the server gave it.
    pub avatar_version: Option<String>,
    pub admin: bool,
    pub active: bool,
    pub bot: bool,
    pub status: Presence,
    pub created_at: Option<String>,
    pub last_seen_at: Option<String>,
    pub revision: Option<String>,
}

/// An author or a reporter; `shown` is the name to print.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct AdminUserLite {
    pub id: String,
    pub username: String,
    pub name: String,
    pub deleted: bool,
    pub shown: String,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct AdminRoom {
    pub id: String,
    pub kind: AdminRoomKind,
    /// A direct conversation's members, joined.
    pub name: String,
    pub topic: Option<String>,
    pub members: u64,
    pub messages: u64,
    pub created_at: Option<String>,
    pub last_message_at: Option<String>,
    pub read_only: bool,
    pub encrypted: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct AdminReport {
    pub reporter: AdminUserLite,
    pub reason: String,
    pub at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct AdminReportedMessage {
    pub message_id: String,
    pub room_id: String,
    pub room_name: String,
    pub room_kind: AdminRoomKind,
    pub author: AdminUserLite,
    /// The author's account revision (RocketVibe), to deactivate them.
    pub author_revision: Option<String>,
    pub text: String,
    /// From an encrypted Rocket.Chat room: `text` is empty, show "Encrypted message".
    pub encrypted: bool,
    pub created_at: String,
    pub deleted: bool,
    pub count: u64,
    pub latest_at: String,
    /// Known with the list (RocketVibe), else read by `message_reports`.
    pub reports: Option<Vec<AdminReport>>,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct AdminReportedUser {
    pub user: AdminUser,
    /// Whether the account is active; None until its page read it (Rocket.Chat).
    pub active: Option<bool>,
    pub count: u64,
    pub latest_at: String,
    pub reports: Option<Vec<AdminReport>>,
}

/// A reported account's page: the reasons, and whether it is active.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct AdminReportedUserDetails {
    pub reports: Vec<AdminReport>,
    pub active: Option<bool>,
}

/// The rooms a Rocket.Chat account is the last owner of: deleted (they are
/// its only member) or handed to another member.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct AdminLastOwner {
    pub removed: Vec<String>,
    pub transferred: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error, uniffi::Error)]
pub enum AdminFailure {
    /// `code` is the server's (`admin_error_key` gives the text). With
    /// `user-last-owner`, `last_owner` lists the rooms; with
    /// `moderation_bulk_only`, `count` is the author's reported messages.
    #[error("{code}")]
    Refused { code: String, last_owner: Option<AdminLastOwner>, count: Option<u64> },
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct AdminUserPage {
    pub items: Vec<AdminUser>,
    pub next: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct AdminRoomPage {
    pub items: Vec<AdminRoom>,
    pub next: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct AdminReportedMessagePage {
    pub items: Vec<AdminReportedMessage>,
    pub next: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct AdminReportedUserPage {
    pub items: Vec<AdminReportedUser>,
    pub next: Option<String>,
}

/// A custom emoji of the server; `image` is the path `Media.customEmoji`
/// would give for its name.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct AdminEmoji {
    pub id: String,
    pub name: String,
    pub aliases: Vec<String>,
    pub revision: String,
    pub image: String,
}

fn emoji(e: admin::AdminEmoji) -> AdminEmoji {
    AdminEmoji { id: e.id, name: e.name, aliases: e.aliases, revision: e.revision, image: e.image }
}

fn core_emoji(e: &AdminEmoji) -> admin::AdminEmoji {
    admin::AdminEmoji {
        id: e.id.clone(),
        name: e.name.clone(),
        aliases: e.aliases.clone(),
        revision: e.revision.clone(),
        image: e.image.clone(),
    }
}

fn refused(error: admin::AdminError) -> AdminFailure {
    AdminFailure::Refused {
        code: error.code,
        last_owner: error.last_owner.map(|o| AdminLastOwner { removed: o.removed, transferred: o.transferred }),
        count: error.count,
    }
}

fn presence(p: admin::Presence) -> Presence {
    match p {
        admin::Presence::Online => Presence::Online,
        admin::Presence::Away => Presence::Away,
        admin::Presence::Busy => Presence::Busy,
        admin::Presence::Offline => Presence::Offline,
    }
}

fn core_presence(p: Presence) -> admin::Presence {
    match p {
        Presence::Online => admin::Presence::Online,
        Presence::Away => admin::Presence::Away,
        Presence::Busy => admin::Presence::Busy,
        Presence::Offline => admin::Presence::Offline,
    }
}

fn kind(k: admin::RoomType) -> AdminRoomKind {
    match k {
        admin::RoomType::Public => AdminRoomKind::Public,
        admin::RoomType::Private => AdminRoomKind::Private,
        admin::RoomType::Direct => AdminRoomKind::Direct,
        admin::RoomType::Discussion => AdminRoomKind::Discussion,
    }
}

fn core_kind(k: AdminRoomKind) -> admin::RoomType {
    match k {
        AdminRoomKind::Public => admin::RoomType::Public,
        AdminRoomKind::Private => admin::RoomType::Private,
        AdminRoomKind::Direct => admin::RoomType::Direct,
        AdminRoomKind::Discussion => admin::RoomType::Discussion,
    }
}

fn counts(c: &admin::KindCounts) -> AdminKindCounts {
    AdminKindCounts {
        total: c.total,
        public: c.public,
        private: c.private,
        direct: c.direct,
        discussions: c.discussions,
        encrypted: c.encrypted,
    }
}

fn lite(u: &admin::UserLite) -> AdminUserLite {
    AdminUserLite {
        id: u.id.clone(),
        username: u.username.clone(),
        name: u.name.clone(),
        deleted: u.deleted,
        shown: u.shown(),
    }
}

fn core_lite(u: &AdminUserLite) -> admin::UserLite {
    admin::UserLite { id: u.id.clone(), username: u.username.clone(), name: u.name.clone(), deleted: u.deleted }
}

fn report(r: &admin::Report) -> AdminReport {
    AdminReport { reporter: lite(&r.reporter), reason: r.reason.clone(), at: r.at.clone() }
}

fn core_report(r: &AdminReport) -> admin::Report {
    admin::Report { reporter: core_lite(&r.reporter), reason: r.reason.clone(), at: r.at.clone() }
}

fn overview(o: admin::Overview) -> AdminOverview {
    AdminOverview {
        product: match o.product {
            admin::Product::RocketChat => AdminProduct::RocketChat,
            admin::Product::RocketVibe => AdminProduct::RocketVibe,
        },
        version: o.version,
        uptime_seconds: o.uptime_seconds,
        database: o.database,
        migration: o.migration,
        runtime: o.runtime,
        instance_id: o.instance_id,
        users: AdminUserCounts {
            total: o.users.total,
            active: o.users.active,
            deactivated: o.users.deactivated,
            admins: o.users.admins,
            online: o.users.online,
            away: o.users.away,
            busy: o.users.busy,
            offline: o.users.offline,
        },
        rooms: counts(&o.rooms),
        messages: counts(&o.messages),
        uploads_count: o.uploads.count,
        uploads_bytes: o.uploads.bytes,
        reported_messages: o.reports.messages,
        reported_users: o.reports.users,
        as_of: o.as_of,
    }
}

fn room(r: admin::AdminRoom) -> AdminRoom {
    AdminRoom {
        id: r.id,
        kind: kind(r.kind),
        name: r.name,
        topic: r.topic,
        members: r.members,
        messages: r.messages,
        created_at: r.created_at,
        last_message_at: r.last_message_at,
        read_only: r.read_only,
        encrypted: r.encrypted,
    }
}

fn reported_message(m: admin::ReportedMessage) -> AdminReportedMessage {
    AdminReportedMessage {
        message_id: m.message_id,
        room_id: m.room.id,
        room_name: m.room.name,
        room_kind: kind(m.room.kind),
        author: lite(&m.author),
        author_revision: m.author_revision,
        text: m.text,
        encrypted: m.encrypted,
        created_at: m.created_at,
        deleted: m.deleted,
        count: m.count,
        latest_at: m.latest_at,
        reports: m.reports.map(|all| all.iter().map(report).collect()),
    }
}

fn core_reported_message(m: &AdminReportedMessage) -> admin::ReportedMessage {
    admin::ReportedMessage {
        message_id: m.message_id.clone(),
        room: admin::ReportRoom { id: m.room_id.clone(), name: m.room_name.clone(), kind: core_kind(m.room_kind) },
        author: core_lite(&m.author),
        author_revision: m.author_revision.clone(),
        text: m.text.clone(),
        encrypted: m.encrypted,
        created_at: m.created_at.clone(),
        deleted: m.deleted,
        count: m.count,
        latest_at: m.latest_at.clone(),
        reports: m.reports.as_ref().map(|all| all.iter().map(core_report).collect()),
    }
}

/// The administration of one open account.
#[derive(uniffi::Object)]
pub struct ServerAdmin {
    admin: Admin,
}

impl ServerAdmin {
    /// A photo as the app's media store reads it: Rocket.Chat's avatar
    /// route, RocketVibe's profile photo by id. None (the initials) when the
    /// account has no photo: a version is the mark of one (D10).
    fn photo(&self, username: &str, version: Option<&str>) -> Option<String> {
        let version = version.filter(|v| !v.is_empty());
        match &self.admin {
            Admin::RocketChat(_) => {
                version.filter(|_| !username.is_empty()).map(|v| avatar_path(AvatarTarget::User(username), Some(v)))
            }
            Admin::Native(_) => version.map(|id| format!("rv-avatar:{id}")),
        }
    }

    fn user(&self, u: admin::AdminUser) -> AdminUser {
        AdminUser {
            avatar: self.photo(&u.username, u.avatar.as_deref()),
            avatar_version: u.avatar,
            id: u.id,
            username: u.username,
            name: u.name,
            admin: u.admin,
            active: u.active,
            bot: u.bot,
            status: presence(u.status),
            created_at: u.created_at,
            last_seen_at: u.last_seen_at,
            revision: u.revision,
        }
    }

    fn reported_user(&self, r: admin::ReportedUser) -> AdminReportedUser {
        AdminReportedUser {
            user: self.user(r.user),
            active: r.active,
            count: r.count,
            latest_at: r.latest_at,
            reports: r.reports.map(|all| all.iter().map(report).collect()),
        }
    }
}

fn core_user(u: &AdminUser) -> admin::AdminUser {
    admin::AdminUser {
        id: u.id.clone(),
        username: u.username.clone(),
        name: u.name.clone(),
        avatar: u.avatar_version.clone(),
        admin: u.admin,
        active: u.active,
        bot: u.bot,
        status: core_presence(u.status),
        created_at: u.created_at.clone(),
        last_seen_at: u.last_seen_at.clone(),
        revision: u.revision.clone(),
    }
}

fn core_reported_user(r: &AdminReportedUser) -> admin::ReportedUser {
    admin::ReportedUser {
        user: core_user(&r.user),
        active: r.active,
        count: r.count,
        latest_at: r.latest_at.clone(),
        reports: r.reports.as_ref().map(|all| all.iter().map(core_report).collect()),
    }
}

#[uniffi::export]
impl Chat {
    /// This account's server administration (open to an administrator) and reports.
    pub fn admin(&self) -> Arc<ServerAdmin> {
        Arc::new(ServerAdmin { admin: Admin::RocketChat(self.session.clone()) })
    }
}

#[uniffi::export]
impl NativeChat {
    pub fn admin(&self) -> Arc<ServerAdmin> {
        Arc::new(ServerAdmin { admin: Admin::Native(self.session.clone()) })
    }
    /// Whether members can report messages and accounts on this server.
    pub fn reports_supported(&self) -> bool {
        self.session.reports_supported()
    }
}

#[uniffi::export]
impl ServerAdmin {
    pub fn product(&self) -> AdminProduct {
        match self.admin.product() {
            admin::Product::RocketChat => AdminProduct::RocketChat,
            admin::Product::RocketVibe => AdminProduct::RocketVibe,
        }
    }
    /// My account: the lists offer no action on it.
    pub fn my_id(&self) -> String {
        self.admin.my_id().to_owned()
    }
    /// False when it could not be asked.
    pub async fn is_admin(&self) -> bool {
        let a = self.admin.clone();
        on_tokio(async move { a.is_admin().await }).await
    }
    pub fn reports_supported(&self) -> bool {
        self.admin.reports_supported()
    }
    /// Rocket.Chat: its cached statistics unless `refresh` (a full count on
    /// the server: the refresh button only, never on opening).
    pub async fn overview(&self, refresh: bool) -> Result<AdminOverview, AdminFailure> {
        let a = self.admin.clone();
        on_tokio(async move { a.overview(refresh).await }).await.map(overview).map_err(refused)
    }
    /// The newest published server version; None when unknown.
    pub async fn latest_version(&self) -> Option<String> {
        let a = self.admin.clone();
        on_tokio(async move { a.latest_version().await }).await
    }
    /// The first page with `after` None; `query` filters (empty: everyone).
    pub async fn users(&self, after: Option<String>, query: String) -> Result<AdminUserPage, AdminFailure> {
        let a = self.admin.clone();
        let page = on_tokio(async move { a.users(after.as_deref(), &query).await }).await.map_err(refused)?;
        Ok(AdminUserPage { items: page.items.into_iter().map(|u| self.user(u)).collect(), next: page.next })
    }
    /// The account as it now is.
    pub async fn set_admin(&self, user: AdminUser, admin: bool) -> Result<AdminUser, AdminFailure> {
        let a = self.admin.clone();
        let done = on_tokio(async move { a.set_admin(&core_user(&user), admin).await }).await.map_err(refused)?;
        Ok(self.user(done))
    }
    /// `relinquish` false first: Rocket.Chat refuses `user-last-owner` with
    /// the rooms concerned, and agrees once asked again with `relinquish`.
    pub async fn set_active(&self, user: AdminUser, active: bool, relinquish: bool) -> Result<AdminUser, AdminFailure> {
        let a = self.admin.clone();
        let done = on_tokio(async move { a.set_active(&core_user(&user), active, relinquish).await })
            .await
            .map_err(refused)?;
        Ok(self.user(done))
    }
    pub async fn delete_user(&self, user: AdminUser, relinquish: bool) -> Result<(), AdminFailure> {
        let a = self.admin.clone();
        on_tokio(async move { a.delete_user(&core_user(&user), relinquish).await }).await.map_err(refused)
    }
    pub async fn rooms(&self, after: Option<String>, query: String) -> Result<AdminRoomPage, AdminFailure> {
        let a = self.admin.clone();
        let page = on_tokio(async move { a.rooms(after.as_deref(), &query).await }).await.map_err(refused)?;
        Ok(AdminRoomPage { items: page.items.into_iter().map(room).collect(), next: page.next })
    }
    pub async fn reported_messages(&self, after: Option<String>) -> Result<AdminReportedMessagePage, AdminFailure> {
        let a = self.admin.clone();
        let page = on_tokio(async move { a.reported_messages(after.as_deref()).await }).await.map_err(refused)?;
        Ok(AdminReportedMessagePage { items: page.items.into_iter().map(reported_message).collect(), next: page.next })
    }
    /// Who reported the message and why, newest first.
    pub async fn message_reports(&self, item: AdminReportedMessage) -> Result<Vec<AdminReport>, AdminFailure> {
        let a = self.admin.clone();
        let all =
            on_tokio(async move { a.message_reports(&core_reported_message(&item)).await }).await.map_err(refused)?;
        Ok(all.iter().map(report).collect())
    }
    pub async fn dismiss_message_reports(&self, item: AdminReportedMessage) -> Result<(), AdminFailure> {
        let a = self.admin.clone();
        on_tokio(async move { a.dismiss_message_reports(&core_reported_message(&item)).await }).await.map_err(refused)
    }
    /// Deletes the reported message, which also closes its reports.
    pub async fn delete_reported_message(&self, item: AdminReportedMessage) -> Result<(), AdminFailure> {
        let a = self.admin.clone();
        on_tokio(async move { a.delete_reported_message(&core_reported_message(&item)).await }).await.map_err(refused)
    }
    /// Rocket.Chat answers `moderation_bulk_only` (with `count`) when it can
    /// only delete this author's reported messages together.
    pub async fn delete_author_reported_messages(&self, item: AdminReportedMessage) -> Result<(), AdminFailure> {
        let a = self.admin.clone();
        on_tokio(async move { a.delete_author_reported_messages(&core_reported_message(&item)).await })
            .await
            .map_err(refused)
    }
    pub async fn deactivate_author(&self, item: AdminReportedMessage, relinquish: bool) -> Result<(), AdminFailure> {
        let a = self.admin.clone();
        on_tokio(async move { a.deactivate_author(&core_reported_message(&item), relinquish).await })
            .await
            .map_err(refused)
    }
    pub async fn reported_users(&self, after: Option<String>) -> Result<AdminReportedUserPage, AdminFailure> {
        let a = self.admin.clone();
        let page = on_tokio(async move { a.reported_users(after.as_deref()).await }).await.map_err(refused)?;
        Ok(AdminReportedUserPage {
            items: page.items.into_iter().map(|r| self.reported_user(r)).collect(),
            next: page.next,
        })
    }
    /// The reasons, and whether the account is active (Rocket.Chat says it here).
    pub async fn user_reports(&self, item: AdminReportedUser) -> Result<AdminReportedUserDetails, AdminFailure> {
        let a = self.admin.clone();
        let found = on_tokio(async move { a.user_reports(&core_reported_user(&item)).await }).await.map_err(refused)?;
        Ok(AdminReportedUserDetails { reports: found.reports.iter().map(report).collect(), active: found.active })
    }
    pub async fn dismiss_user_reports(&self, item: AdminReportedUser) -> Result<(), AdminFailure> {
        let a = self.admin.clone();
        on_tokio(async move { a.dismiss_user_reports(&core_reported_user(&item)).await }).await.map_err(refused)
    }
    /// Whether every account may create bots (administrators always may);
    /// None where the server has no bots, Rocket.Chat included.
    pub async fn user_bots(&self) -> Result<Option<bool>, AdminFailure> {
        let a = self.admin.clone();
        on_tokio(async move { a.user_bots().await }).await.map_err(refused)
    }
    /// The setting as the server now has it.
    pub async fn set_user_bots(&self, on: bool) -> Result<bool, AdminFailure> {
        let a = self.admin.clone();
        on_tokio(async move { a.set_user_bots(on).await }).await.map_err(refused)
    }
    /// The server's icon can be changed from here.
    pub fn icon_supported(&self) -> bool {
        self.admin.icon_supported()
    }
    /// The server's icon as the rails show it, `None` without one.
    pub async fn icon(&self) -> Option<Vec<u8>> {
        let info = self.admin.info().clone();
        on_tokio(async move { rv_core::server_icon::fetch(&info).await }).await
    }
    /// Sets the server's icon from a square PNG of `icon_side()` pixels, or
    /// removes it with `None`.
    pub async fn set_icon(&self, png: Option<Vec<u8>>) -> Result<(), AdminFailure> {
        let a = self.admin.clone();
        on_tokio(async move { a.set_icon(png).await }).await.map_err(refused)
    }
    /// The server lets this administrator add and remove custom emoji.
    pub fn emoji_supported(&self) -> bool {
        self.admin.emoji_supported()
    }
    /// The server's custom emoji by name; also refreshes the pickers' index.
    pub async fn emojis(&self) -> Result<Vec<AdminEmoji>, AdminFailure> {
        let a = self.admin.clone();
        let list = on_tokio(async move { a.emojis().await }).await.map_err(refused)?;
        Ok(list.into_iter().map(emoji).collect())
    }
    /// Adds a custom emoji from a PNG, JPEG or GIF file; `aliases` is
    /// comma-separated. Refusals: `invalid_emoji_name`, `emoji_name_reserved`,
    /// `emoji_name_taken`, `emoji_image_too_large`, the server's codes.
    pub async fn create_emoji(&self, name: String, aliases: String, file: String) -> Result<(), AdminFailure> {
        let a = self.admin.clone();
        on_tokio(async move {
            let path = std::path::PathBuf::from(&file);
            let bytes = tokio::fs::read(&path).await.map_err(|_| admin::AdminError::new("failed"))?;
            let file_name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
            let mime = match path.extension().and_then(|e| e.to_str()).map(str::to_ascii_lowercase).as_deref() {
                Some("gif") => "image/gif",
                Some("jpg" | "jpeg") => "image/jpeg",
                _ => "image/png",
            };
            a.create_emoji(&name, &aliases, &file_name, mime, bytes).await
        })
        .await
        .map_err(refused)
    }
    pub async fn delete_emoji(&self, item: AdminEmoji) -> Result<(), AdminFailure> {
        let a = self.admin.clone();
        on_tokio(async move { a.delete_emoji(&core_emoji(&item)).await }).await.map_err(refused)
    }
    /// Reports a message to the administrators; any member may.
    pub async fn report_message(&self, message_id: String, reason: String) -> Result<(), AdminFailure> {
        let a = self.admin.clone();
        on_tokio(async move { a.report_message(&message_id, &reason).await }).await.map_err(refused)
    }
    /// Reports an account, never my own.
    pub async fn report_user(&self, user_id: String, reason: String) -> Result<(), AdminFailure> {
        let a = self.admin.clone();
        on_tokio(async move { a.report_user(&user_id, &reason).await }).await.map_err(refused)
    }
}

/// The side of the square PNG `ServerAdmin::set_icon` takes (Rocket.Chat
/// refuses any other).
#[uniffi::export]
pub fn icon_side() -> u32 {
    rv_core::server_icon::RC_SIDE
}

/// A report's reason as the servers take it (trimmed, 1 to 1,000
/// characters); None when it would be refused.
#[uniffi::export]
pub fn report_reason(text: String) -> Option<String> {
    admin::valid_reason(&text)
}

/// The i18n key of the text for a refusal's code, as the GTK app shows it.
#[uniffi::export]
pub fn admin_error_key(code: String) -> String {
    admin::error_key(&code).to_owned()
}

/// The longest reason a report takes.
#[uniffi::export]
pub fn report_reason_max() -> u32 {
    admin::REASON_MAX as u32
}

/// Whether `latest` is newer than `current` (`8.8.1` over `8.5.1`).
#[uniffi::export]
pub fn server_update_available(current: String, latest: String) -> bool {
    admin::update_available(&current, &latest)
}

/// A username the RocketVibe server reserves for deleted accounts: shown as
/// "Deleted user". Rocket.Chat has no such reservation.
#[uniffi::export]
pub fn deleted_username(username: String) -> bool {
    rv_core::native::deleted_username(&username)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn records_round_trip_to_the_core_model() {
        let item = AdminReportedMessage {
            message_id: "m1".into(),
            room_id: "r1".into(),
            room_name: "general".into(),
            room_kind: AdminRoomKind::Discussion,
            author: AdminUserLite {
                id: "u1".into(),
                username: "deleted-u1".into(),
                name: String::new(),
                deleted: true,
                shown: String::new(),
            },
            author_revision: Some("3".into()),
            text: "hi".into(),
            encrypted: true,
            created_at: "2026-10-07T09:00:00Z".into(),
            deleted: false,
            count: 2,
            latest_at: "2026-10-07T10:00:00Z".into(),
            reports: Some(vec![]),
        };
        let back = reported_message(core_reported_message(&item));
        assert_eq!(back.author.shown, rv_core::i18n::t("user.deleted"));
        assert_eq!(
            AdminReportedMessage { author: AdminUserLite { shown: String::new(), ..back.author.clone() }, ..back },
            item
        );
        let user = AdminUser {
            id: "u2".into(),
            username: "bob".into(),
            name: "Bob".into(),
            avatar: None,
            avatar_version: Some("etag".into()),
            admin: true,
            active: false,
            bot: false,
            status: Presence::Away,
            created_at: None,
            last_seen_at: Some("2026-10-07T09:00:00Z".into()),
            revision: Some("7".into()),
        };
        let core = core_user(&user);
        assert_eq!(
            (core.avatar.as_deref(), core.status, core.revision.as_deref()),
            (Some("etag"), admin::Presence::Away, Some("7"))
        );
    }

    #[test]
    fn reasons_and_versions() {
        assert_eq!(report_reason("  spam  ".into()).as_deref(), Some("spam"));
        assert_eq!(report_reason("   ".into()), None);
        assert_eq!(report_reason("x".repeat(1001)), None);
        assert_eq!(report_reason_max(), 1000);
        assert!(server_update_available("8.5.1".into(), "8.8.1".into()));
        assert!(!server_update_available("8.8.1".into(), "8.8.1".into()));
        assert!(deleted_username("deleted-abc".into()) && !deleted_username("alice".into()));
        assert_eq!(admin_error_key("error-admin-required".into()), "admin.error_last_admin");
        assert_eq!(admin_error_key("not_found".into()), "admin.error_not_found");
    }

    #[test]
    fn a_last_owner_refusal_keeps_its_rooms() {
        let error = admin::AdminError {
            code: "user-last-owner".into(),
            last_owner: Some(admin::LastOwner { removed: vec!["solo".into()], transferred: vec!["team".into()] }),
            count: None,
        };
        let AdminFailure::Refused { code, last_owner, count } = refused(error);
        assert_eq!(code, "user-last-owner");
        assert_eq!(last_owner, Some(AdminLastOwner { removed: vec!["solo".into()], transferred: vec!["team".into()] }));
        assert_eq!(count, None);
    }
}
