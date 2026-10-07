//! rv-core's server administration for Swift: one `ServerAdmin` per open
//! account, for both providers, with the dashboard, the users, the rooms and
//! the moderation of reports, plus the Report every member uses. Records
//! carry the photo as a path `Chat::media`/`MediaStore` read, and the shown
//! name rv-core computes ("Deleted user" for a deleted account). A refusal is
//! `RvError::Local` whose message is the server's code (`self_administration`,
//! `last_administrator`, `revision_conflict`...).

use std::sync::Arc;

use rv_core::admin::{self, Admin};
use rv_core::media::{AvatarTarget, avatar_path};

use crate::model::{Presence, RvError};
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
    pub reported_messages: u64,
    pub reported_users: u64,
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
    pub text: String,
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
    pub count: u64,
    pub latest_at: String,
    pub reports: Option<Vec<AdminReport>>,
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

fn refused(error: admin::AdminError) -> RvError {
    RvError::Local { message: error.code }
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
        text: m.text,
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
        text: m.text.clone(),
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
    /// route, RocketVibe's profile photo by id.
    fn photo(&self, username: &str, version: Option<&str>) -> Option<String> {
        match &self.admin {
            Admin::RocketChat(_) => (!username.is_empty()).then(|| avatar_path(AvatarTarget::User(username), version)),
            Admin::Native(_) => version.filter(|id| !id.is_empty()).map(|id| format!("rv-avatar:{id}")),
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
    pub async fn overview(&self) -> Result<AdminOverview, RvError> {
        let a = self.admin.clone();
        on_tokio(async move { a.overview().await }).await.map(overview).map_err(refused)
    }
    /// The newest published server version; None when unknown.
    pub async fn latest_version(&self) -> Option<String> {
        let a = self.admin.clone();
        on_tokio(async move { a.latest_version().await }).await
    }
    /// The first page with `after` None; `query` filters (empty: everyone).
    pub async fn users(&self, after: Option<String>, query: String) -> Result<AdminUserPage, RvError> {
        let a = self.admin.clone();
        let page = on_tokio(async move { a.users(after.as_deref(), &query).await }).await.map_err(refused)?;
        Ok(AdminUserPage { items: page.items.into_iter().map(|u| self.user(u)).collect(), next: page.next })
    }
    /// The account as it now is.
    pub async fn set_admin(&self, user: AdminUser, admin: bool) -> Result<AdminUser, RvError> {
        let a = self.admin.clone();
        let done = on_tokio(async move { a.set_admin(&core_user(&user), admin).await }).await.map_err(refused)?;
        Ok(self.user(done))
    }
    pub async fn set_active(&self, user: AdminUser, active: bool) -> Result<AdminUser, RvError> {
        let a = self.admin.clone();
        let done = on_tokio(async move { a.set_active(&core_user(&user), active).await }).await.map_err(refused)?;
        Ok(self.user(done))
    }
    pub async fn delete_user(&self, user: AdminUser) -> Result<(), RvError> {
        let a = self.admin.clone();
        on_tokio(async move { a.delete_user(&core_user(&user)).await }).await.map_err(refused)
    }
    pub async fn rooms(&self, after: Option<String>, query: String) -> Result<AdminRoomPage, RvError> {
        let a = self.admin.clone();
        let page = on_tokio(async move { a.rooms(after.as_deref(), &query).await }).await.map_err(refused)?;
        Ok(AdminRoomPage { items: page.items.into_iter().map(room).collect(), next: page.next })
    }
    pub async fn reported_messages(&self, after: Option<String>) -> Result<AdminReportedMessagePage, RvError> {
        let a = self.admin.clone();
        let page = on_tokio(async move { a.reported_messages(after.as_deref()).await }).await.map_err(refused)?;
        Ok(AdminReportedMessagePage { items: page.items.into_iter().map(reported_message).collect(), next: page.next })
    }
    /// Who reported the message and why, newest first.
    pub async fn message_reports(&self, item: AdminReportedMessage) -> Result<Vec<AdminReport>, RvError> {
        let a = self.admin.clone();
        let all =
            on_tokio(async move { a.message_reports(&core_reported_message(&item)).await }).await.map_err(refused)?;
        Ok(all.iter().map(report).collect())
    }
    pub async fn dismiss_message_reports(&self, item: AdminReportedMessage) -> Result<(), RvError> {
        let a = self.admin.clone();
        on_tokio(async move { a.dismiss_message_reports(&core_reported_message(&item)).await }).await.map_err(refused)
    }
    /// Deletes the reported message, which also closes its reports.
    pub async fn delete_reported_message(&self, item: AdminReportedMessage) -> Result<(), RvError> {
        let a = self.admin.clone();
        on_tokio(async move { a.delete_reported_message(&core_reported_message(&item)).await }).await.map_err(refused)
    }
    pub async fn deactivate_author(&self, item: AdminReportedMessage) -> Result<(), RvError> {
        let a = self.admin.clone();
        on_tokio(async move { a.deactivate_author(&core_reported_message(&item)).await }).await.map_err(refused)
    }
    pub async fn reported_users(&self, after: Option<String>) -> Result<AdminReportedUserPage, RvError> {
        let a = self.admin.clone();
        let page = on_tokio(async move { a.reported_users(after.as_deref()).await }).await.map_err(refused)?;
        Ok(AdminReportedUserPage {
            items: page.items.into_iter().map(|r| self.reported_user(r)).collect(),
            next: page.next,
        })
    }
    pub async fn user_reports(&self, item: AdminReportedUser) -> Result<Vec<AdminReport>, RvError> {
        let a = self.admin.clone();
        let all = on_tokio(async move { a.user_reports(&core_reported_user(&item)).await }).await.map_err(refused)?;
        Ok(all.iter().map(report).collect())
    }
    pub async fn dismiss_user_reports(&self, item: AdminReportedUser) -> Result<(), RvError> {
        let a = self.admin.clone();
        on_tokio(async move { a.dismiss_user_reports(&core_reported_user(&item)).await }).await.map_err(refused)
    }
    /// Reports a message to the administrators; any member may.
    pub async fn report_message(&self, message_id: String, reason: String) -> Result<(), RvError> {
        let a = self.admin.clone();
        on_tokio(async move { a.report_message(&message_id, &reason).await }).await.map_err(refused)
    }
    /// Reports an account, never my own.
    pub async fn report_user(&self, user_id: String, reason: String) -> Result<(), RvError> {
        let a = self.admin.clone();
        on_tokio(async move { a.report_user(&user_id, &reason).await }).await.map_err(refused)
    }
}

/// A report's reason as the servers take it (trimmed, 1 to 1,000
/// characters); None when it would be refused.
#[uniffi::export]
pub fn report_reason(text: String) -> Option<String> {
    admin::valid_reason(&text)
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
            text: "hi".into(),
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
    }
}
