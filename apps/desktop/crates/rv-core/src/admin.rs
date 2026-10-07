//! Server administration for both providers, in one model both desktop UIs
//! draw: the dashboard's overview, users, rooms, and the moderation of
//! members' reports. Rocket.Chat is read over REST (`rc`), RocketVibe through
//! `NativeSession`. Reports themselves are open to every member.
//!
//! Admin rights never open a private conversation: a RocketVibe admin reads
//! a message only through an open report, which its reporter disclosed.

use std::sync::Arc;

use serde_json::{Value, json};

use crate::native::NativeSession;
use crate::rest::{CallOptions, RestClient, RestError};
use crate::session::Session;

/// The longest report reason both servers take.
pub const REASON_MAX: usize = 1000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Product {
    RocketChat,
    RocketVibe,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Presence {
    Online,
    Away,
    Busy,
    #[default]
    Offline,
}

impl Presence {
    fn parse(text: &str) -> Self {
        match text {
            "online" => Self::Online,
            "away" => Self::Away,
            "busy" => Self::Busy,
            _ => Self::Offline,
        }
    }
    /// `online`, `away`, `busy`, `offline`: the `presence.*` i18n keys.
    pub fn key(self) -> &'static str {
        match self {
            Self::Online => "online",
            Self::Away => "away",
            Self::Busy => "busy",
            Self::Offline => "offline",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct UserCounts {
    pub total: u64,
    pub active: u64,
    pub deactivated: u64,
    pub admins: Option<u64>,
    pub online: u64,
    pub away: u64,
    pub busy: u64,
    pub offline: u64,
}

/// Rooms, or messages, by type. Discussions are Rocket.Chat's, encrypted
/// ones RocketVibe's (also counted under their type).
#[derive(Debug, Clone, PartialEq, Default)]
pub struct KindCounts {
    pub total: u64,
    pub public: u64,
    pub private: u64,
    pub direct: u64,
    pub discussions: Option<u64>,
    pub encrypted: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct UploadCounts {
    pub count: u64,
    pub bytes: u64,
}

/// What is waiting in moderation. Rocket.Chat counts the authors of reported
/// messages, RocketVibe the messages.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct ReportCounts {
    pub messages: u64,
    pub users: u64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Overview {
    pub product: Product,
    pub version: String,
    pub uptime_seconds: Option<u64>,
    /// `MongoDB 8.0.32 (wiredTiger)`, `PostgreSQL 18.1`.
    pub database: String,
    pub migration: Option<String>,
    /// `Node v22.22.3`; none on RocketVibe.
    pub runtime: Option<String>,
    pub instance_id: Option<String>,
    pub users: UserCounts,
    pub rooms: KindCounts,
    pub messages: KindCounts,
    pub uploads: UploadCounts,
    pub reports: ReportCounts,
}

/// An account as a list shows it.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct AdminUser {
    pub id: String,
    pub username: String,
    pub name: String,
    /// The photo's version: Rocket.Chat's `avatarETag`, RocketVibe's avatar file id.
    pub avatar: Option<String>,
    pub admin: bool,
    pub active: bool,
    /// A bot or app account (Rocket.Chat).
    pub bot: bool,
    pub status: Presence,
    pub created_at: Option<String>,
    pub last_seen_at: Option<String>,
    /// RocketVibe's account revision, expected back by every change.
    pub revision: Option<String>,
}

/// An author, a reporter or a direct conversation's member.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct UserLite {
    pub id: String,
    pub username: String,
    pub name: String,
    /// A deleted account, shown as "Deleted user".
    pub deleted: bool,
}

impl UserLite {
    /// Its display name, else its username; "Deleted user" for a deleted account.
    pub fn shown(&self) -> String {
        if self.deleted {
            crate::i18n::t("user.deleted").to_owned()
        } else if self.name.is_empty() {
            self.username.clone()
        } else {
            self.name.clone()
        }
    }
}

impl From<&rv_protocol::User> for UserLite {
    fn from(user: &rv_protocol::User) -> Self {
        UserLite {
            id: user.id.clone(),
            username: user.username.clone(),
            name: user.display_name.clone(),
            deleted: user.deleted,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum RoomType {
    #[default]
    Public,
    Private,
    Direct,
    Discussion,
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct AdminRoom {
    pub id: String,
    pub kind: RoomType,
    /// A direct conversation's members, joined: `alice, bob`.
    pub name: String,
    pub topic: Option<String>,
    pub members: u64,
    pub messages: u64,
    pub created_at: Option<String>,
    pub last_message_at: Option<String>,
    pub read_only: bool,
    pub encrypted: bool,
    pub direct_members: Vec<UserLite>,
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct Report {
    pub reporter: UserLite,
    pub reason: String,
    pub at: String,
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct ReportRoom {
    pub id: String,
    pub name: String,
    pub kind: RoomType,
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct ReportedMessage {
    pub message_id: String,
    pub room: ReportRoom,
    pub author: UserLite,
    pub text: String,
    pub created_at: String,
    pub deleted: bool,
    pub count: u64,
    pub latest_at: String,
    /// Already known (RocketVibe sends them with the list); otherwise read
    /// with `Admin::message_reports` when the item opens.
    pub reports: Option<Vec<Report>>,
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct ReportedUser {
    pub user: AdminUser,
    pub count: u64,
    pub latest_at: String,
    pub reports: Option<Vec<Report>>,
}

/// One page of a list; `next` asks for the following one.
#[derive(Debug, Clone, PartialEq)]
pub struct Page<T> {
    pub items: Vec<T>,
    pub next: Option<String>,
}

/// A refusal or a failure: the server's code (`self_administration`,
/// `last_administrator`, `revision_conflict`, `error-action-not-allowed`...),
/// `connection_failed` without an answer.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{code}")]
pub struct AdminError {
    pub code: String,
}

impl AdminError {
    fn new(code: &str) -> Self {
        AdminError { code: code.to_owned() }
    }
}

impl From<RestError> for AdminError {
    fn from(error: RestError) -> Self {
        let code = error.error_type.clone().or_else(|| error.error.clone().filter(|e| !e.contains(' ')));
        AdminError {
            code: code.unwrap_or_else(|| (if error.status == 0 { "connection_failed" } else { "failed" }).into()),
        }
    }
}

impl From<crate::native::Error> for AdminError {
    fn from(error: crate::native::Error) -> Self {
        AdminError { code: error.code().to_owned() }
    }
}

/// A report's reason as both servers take it: trimmed, 1 to 1,000 characters.
pub fn valid_reason(text: &str) -> Option<String> {
    let text = text.trim();
    (!text.is_empty() && text.chars().count() <= REASON_MAX).then(|| text.to_owned())
}

/// Whether `latest` is a newer version than `current` (`8.8.1` over `8.5.1`).
pub fn update_available(current: &str, latest: &str) -> bool {
    crate::update::is_newer(latest, current)
}

/// The newest published server version: Rocket.Chat's latest GitHub release,
/// or the newest `server-v` tag of RocketVibe's repository. None when unknown.
pub async fn latest_version(product: Product) -> Option<String> {
    match product {
        Product::RocketChat => {
            let url = "https://api.github.com/repos/RocketChat/Rocket.Chat/releases/latest";
            let release = crate::update::github_json(url).await.ok()?;
            let tag = release["tag_name"].as_str()?.trim_start_matches(['v', 'V']);
            crate::update::parse_version(tag).map(|_| tag.to_owned())
        }
        Product::RocketVibe => {
            let url = format!("https://api.github.com/repos/{}/releases?per_page=50", crate::update::REPO);
            latest_server_tag(&crate::update::github_json(&url).await.ok()?)
        }
    }
}

/// The newest `server-vX.Y.Z` of a GitHub release list, drafts and
/// pre-releases aside.
pub fn latest_server_tag(releases: &Value) -> Option<String> {
    releases
        .as_array()?
        .iter()
        .filter(|r| r["draft"].as_bool() != Some(true) && r["prerelease"].as_bool() != Some(true))
        .filter_map(|r| r["tag_name"].as_str()?.strip_prefix("server-v"))
        .filter_map(|v| crate::update::parse_version(v).map(|parsed| (parsed, v)))
        .max_by_key(|(parsed, _)| *parsed)
        .map(|(_, v)| v.to_owned())
}

/// The administration of the account a UI has open.
#[derive(Clone)]
pub enum Admin {
    RocketChat(Arc<Session>),
    Native(Arc<NativeSession>),
}

impl Admin {
    pub fn product(&self) -> Product {
        match self {
            Self::RocketChat(_) => Product::RocketChat,
            Self::Native(_) => Product::RocketVibe,
        }
    }

    /// My account's id: the lists offer no action on it.
    pub fn my_id(&self) -> &str {
        match self {
            Self::RocketChat(s) => &s.info.user_id,
            Self::Native(s) => &s.info.user_id,
        }
    }

    /// Whether this account administers the server: Rocket.Chat's `admin`
    /// role; RocketVibe's account permissions, on a server offering the
    /// administration. False when it could not be asked.
    pub async fn is_admin(&self) -> bool {
        match self {
            Self::RocketChat(s) => s.roles().await.is_some_and(|roles| rc::is_admin(&roles)),
            Self::Native(s) => s.administrator().await.unwrap_or(false),
        }
    }

    /// Whether members can report messages and accounts here.
    pub fn reports_supported(&self) -> bool {
        match self {
            Self::RocketChat(_) => true,
            Self::Native(s) => s.reports_supported(),
        }
    }

    pub async fn overview(&self) -> Result<Overview, AdminError> {
        match self {
            Self::RocketChat(s) => Ok(rc::overview(&s.rest).await?),
            Self::Native(s) => Ok(native_overview(&s.admin_overview().await?, chrono::Utc::now())),
        }
    }

    pub async fn latest_version(&self) -> Option<String> {
        latest_version(self.product()).await
    }

    /// Accounts, the first page with `after` None; `query` filters on
    /// username or name (empty: everyone).
    pub async fn users(&self, after: Option<&str>, query: &str) -> Result<Page<AdminUser>, AdminError> {
        match self {
            Self::RocketChat(s) => Ok(rc::users(&s.rest, offset(after), query).await?),
            Self::Native(s) => {
                let page = s.admin_users(after, Some(query.trim())).await?;
                Ok(Page { items: page.items.iter().map(native_user).collect(), next: page.next })
            }
        }
    }

    fn not_me(&self, user: &str) -> Result<(), AdminError> {
        if user == self.my_id() { Err(AdminError::new("self_administration")) } else { Ok(()) }
    }

    /// Gives or removes the admin right; the account as it now is.
    pub async fn set_admin(&self, user: &AdminUser, admin: bool) -> Result<AdminUser, AdminError> {
        self.not_me(&user.id)?;
        match self {
            Self::RocketChat(s) => {
                rc::set_admin(&s.rest, &user.username, admin).await?;
                Ok(AdminUser { admin, ..user.clone() })
            }
            Self::Native(s) => {
                let revision = user.revision.as_deref().unwrap_or_default();
                Ok(native_user(&s.update_admin_user(&user.id, revision, Some(admin), None).await?))
            }
        }
    }

    /// Activates or deactivates an account; the account as it now is.
    pub async fn set_active(&self, user: &AdminUser, active: bool) -> Result<AdminUser, AdminError> {
        self.not_me(&user.id)?;
        match self {
            Self::RocketChat(s) => {
                rc::set_active(&s.rest, &user.id, active).await?;
                Ok(AdminUser { active, ..user.clone() })
            }
            Self::Native(s) => {
                let revision = user.revision.as_deref().unwrap_or_default();
                Ok(native_user(&s.update_admin_user(&user.id, revision, None, Some(!active)).await?))
            }
        }
    }

    /// Deletes an account. Rocket.Chat handles its messages by its own
    /// "Message erasure" setting; RocketVibe keeps them, by a deleted user.
    pub async fn delete_user(&self, user: &AdminUser) -> Result<(), AdminError> {
        self.not_me(&user.id)?;
        match self {
            Self::RocketChat(s) => Ok(rc::delete_user(&s.rest, &user.id).await?),
            Self::Native(s) => Ok(s.delete_admin_user(&user.id, user.revision.as_deref().unwrap_or_default()).await?),
        }
    }

    pub async fn rooms(&self, after: Option<&str>, query: &str) -> Result<Page<AdminRoom>, AdminError> {
        match self {
            Self::RocketChat(s) => Ok(rc::rooms(&s.rest, offset(after), query).await?),
            Self::Native(s) => {
                let page = s.admin_rooms(after, Some(query.trim())).await?;
                Ok(Page { items: page.items.iter().map(native_room).collect(), next: page.next })
            }
        }
    }

    pub async fn reported_messages(&self, after: Option<&str>) -> Result<Page<ReportedMessage>, AdminError> {
        match self {
            Self::RocketChat(s) => Ok(rc::reported_messages(&s.rest, offset(after)).await?),
            Self::Native(s) => {
                let page = s.admin_reported_messages(after).await?;
                Ok(Page { items: page.items.iter().map(native_reported_message).collect(), next: page.next })
            }
        }
    }

    /// Who reported the message and why, newest first.
    pub async fn message_reports(&self, item: &ReportedMessage) -> Result<Vec<Report>, AdminError> {
        match (&item.reports, self) {
            (Some(reports), _) => Ok(reports.clone()),
            (None, Self::RocketChat(s)) => Ok(rc::message_reports(&s.rest, &item.message_id).await?),
            (None, Self::Native(_)) => Ok(Vec::new()),
        }
    }

    pub async fn dismiss_message_reports(&self, item: &ReportedMessage) -> Result<(), AdminError> {
        match self {
            Self::RocketChat(s) => Ok(rc::dismiss_message(&s.rest, &item.message_id).await?),
            Self::Native(s) => Ok(s.dismiss_message_reports(&item.message_id).await?),
        }
    }

    /// Deletes the reported message, which also closes its reports.
    pub async fn delete_reported_message(&self, item: &ReportedMessage) -> Result<(), AdminError> {
        match self {
            Self::RocketChat(s) => {
                rc::delete_message(&s.rest, &item.room.id, &item.message_id).await?;
                Ok(rc::dismiss_message(&s.rest, &item.message_id).await?)
            }
            Self::Native(s) => Ok(s.delete_reported_message(&item.message_id).await?),
        }
    }

    /// Deactivates the reported message's author.
    pub async fn deactivate_author(&self, item: &ReportedMessage) -> Result<(), AdminError> {
        self.not_me(&item.author.id)?;
        match self {
            Self::RocketChat(s) => Ok(rc::set_active(&s.rest, &item.author.id, false).await?),
            Self::Native(_) => {
                // The change needs the account's revision, which only the users list carries.
                let page = self.users(None, &item.author.username).await?;
                let user =
                    page.items.into_iter().find(|u| u.id == item.author.id).ok_or(AdminError::new("not_found"))?;
                self.set_active(&user, false).await.map(|_| ())
            }
        }
    }

    pub async fn reported_users(&self, after: Option<&str>) -> Result<Page<ReportedUser>, AdminError> {
        match self {
            Self::RocketChat(s) => Ok(rc::reported_users(&s.rest, offset(after)).await?),
            Self::Native(s) => {
                let page = s.admin_reported_users(after).await?;
                let items = page
                    .items
                    .iter()
                    .map(|r| ReportedUser {
                        user: native_user(&r.user),
                        count: r.report_count,
                        latest_at: r.latest_report_at.clone(),
                        reports: Some(r.reports.iter().map(native_report).collect()),
                    })
                    .collect();
                Ok(Page { items, next: page.next })
            }
        }
    }

    pub async fn user_reports(&self, item: &ReportedUser) -> Result<Vec<Report>, AdminError> {
        match (&item.reports, self) {
            (Some(reports), _) => Ok(reports.clone()),
            (None, Self::RocketChat(s)) => Ok(rc::user_reports(&s.rest, &item.user.id).await?),
            (None, Self::Native(_)) => Ok(Vec::new()),
        }
    }

    pub async fn dismiss_user_reports(&self, item: &ReportedUser) -> Result<(), AdminError> {
        match self {
            Self::RocketChat(s) => Ok(rc::dismiss_user(&s.rest, &item.user.id).await?),
            Self::Native(s) => Ok(s.dismiss_user_reports(&item.user.id).await?),
        }
    }

    /// Reports a message to the administrators, for any member.
    pub async fn report_message(&self, message_id: &str, reason: &str) -> Result<(), AdminError> {
        let reason = valid_reason(reason).ok_or(AdminError::new("invalid_reason"))?;
        match self {
            Self::RocketChat(s) => Ok(rc::report_message(&s.rest, message_id, &reason).await?),
            Self::Native(s) => Ok(s.report_message(message_id, &reason).await?),
        }
    }

    /// Reports an account to the administrators, never my own.
    pub async fn report_user(&self, user_id: &str, reason: &str) -> Result<(), AdminError> {
        if user_id == self.my_id() {
            return Err(AdminError::new("self_report"));
        }
        let reason = valid_reason(reason).ok_or(AdminError::new("invalid_reason"))?;
        match self {
            Self::RocketChat(s) => Ok(rc::report_user(&s.rest, user_id, &reason).await?),
            Self::Native(s) => Ok(s.report_user(user_id, &reason).await?),
        }
    }
}

fn offset(after: Option<&str>) -> u64 {
    after.and_then(|a| a.parse().ok()).unwrap_or(0)
}

fn presence(status: rv_protocol::live::PresenceStatus) -> Presence {
    use rv_protocol::live::PresenceStatus as P;
    match status {
        P::Online => Presence::Online,
        P::Away => Presence::Away,
        P::Busy => Presence::Busy,
        P::Offline => Presence::Offline,
    }
}

fn room_type(kind: &rv_protocol::RoomKind) -> RoomType {
    match kind {
        rv_protocol::RoomKind::Public => RoomType::Public,
        rv_protocol::RoomKind::Private => RoomType::Private,
        rv_protocol::RoomKind::Direct => RoomType::Direct,
    }
}

pub(crate) fn native_overview(o: &rv_protocol::admin::AdminOverview, now: chrono::DateTime<chrono::Utc>) -> Overview {
    let started = chrono::DateTime::parse_from_rfc3339(&o.started_at).ok();
    Overview {
        product: Product::RocketVibe,
        version: o.server_version.clone(),
        uptime_seconds: started.and_then(|s| u64::try_from((now - s.with_timezone(&chrono::Utc)).num_seconds()).ok()),
        database: format!("PostgreSQL {}", o.postgres_version),
        migration: o.migration_version.clone(),
        runtime: None,
        instance_id: Some(o.instance_id.clone()),
        users: UserCounts {
            total: o.users.total,
            active: o.users.active,
            deactivated: o.users.deactivated,
            admins: Some(o.users.admins),
            online: o.users.online,
            away: o.users.away,
            busy: o.users.busy,
            offline: o.users.offline,
        },
        rooms: KindCounts {
            total: o.rooms.total,
            public: o.rooms.public,
            private: o.rooms.private,
            direct: o.rooms.direct,
            discussions: None,
            encrypted: Some(o.rooms.encrypted),
        },
        messages: KindCounts {
            total: o.messages.total,
            public: o.messages.public,
            private: o.messages.private,
            direct: o.messages.direct,
            discussions: None,
            encrypted: Some(o.messages.encrypted),
        },
        uploads: UploadCounts { count: o.uploads.count, bytes: o.uploads.bytes },
        reports: ReportCounts { messages: o.reports.messages, users: o.reports.users },
    }
}

fn native_user(u: &rv_protocol::admin::AdminUser) -> AdminUser {
    AdminUser {
        id: u.id.clone(),
        username: u.username.clone(),
        name: u.display_name.clone(),
        avatar: u.avatar_file_id.clone(),
        admin: u.admin,
        active: !u.disabled,
        bot: false,
        status: presence(u.status),
        created_at: u.created_at.clone(),
        last_seen_at: u.last_seen_at.clone(),
        revision: Some(u.revision.clone()),
    }
}

fn native_room(r: &rv_protocol::admin::AdminRoom) -> AdminRoom {
    let direct_members: Vec<UserLite> = r.direct_members.iter().map(UserLite::from).collect();
    let name = if direct_members.is_empty() {
        r.name.clone()
    } else {
        direct_members.iter().map(UserLite::shown).collect::<Vec<_>>().join(", ")
    };
    AdminRoom {
        id: r.id.clone(),
        kind: room_type(&r.kind),
        name,
        topic: r.topic.clone(),
        members: r.member_count,
        messages: r.message_count,
        created_at: r.created_at.clone(),
        last_message_at: r.last_message_at.clone(),
        read_only: r.read_only,
        encrypted: r.encrypted,
        direct_members,
    }
}

fn native_report(r: &rv_protocol::admin::AdminReport) -> Report {
    Report { reporter: UserLite::from(&r.reporter), reason: r.reason.clone(), at: r.created_at.clone() }
}

fn native_reported_message(m: &rv_protocol::admin::AdminReportedMessage) -> ReportedMessage {
    ReportedMessage {
        message_id: m.message_id.clone(),
        room: ReportRoom { id: m.room_id.clone(), name: m.room_name.clone(), kind: room_type(&m.room_kind) },
        author: UserLite::from(&m.author),
        text: m.text.clone(),
        created_at: m.created_at.clone(),
        deleted: m.deleted,
        count: m.report_count,
        latest_at: m.latest_report_at.clone(),
        reports: Some(m.reports.iter().map(native_report).collect()),
    }
}

/// Rocket.Chat's administration over REST (all probed on 8.5.1).
pub mod rc {
    use super::*;

    const PAGE: u64 = 50;

    fn text(v: &Value, key: &str) -> String {
        v.get(key).and_then(Value::as_str).unwrap_or_default().to_owned()
    }
    fn count(v: &Value, key: &str) -> u64 {
        v.get(key).and_then(Value::as_u64).unwrap_or(0)
    }
    fn date(v: &Value, key: &str) -> Option<String> {
        v.get(key).and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_owned)
    }
    fn next(response: &Value, offset: u64, shown: usize) -> Option<String> {
        let after = offset + shown as u64;
        (shown > 0 && after < count(response, "total")).then(|| after.to_string())
    }
    fn room_type(t: &str, discussion: bool) -> RoomType {
        match t {
            _ if discussion => RoomType::Discussion,
            "p" => RoomType::Private,
            "d" => RoomType::Direct,
            _ => RoomType::Public,
        }
    }
    fn lite(v: &Value) -> UserLite {
        UserLite { id: text(v, "_id"), username: text(v, "username"), name: text(v, "name"), deleted: false }
    }

    pub fn is_admin(roles: &[String]) -> bool {
        roles.iter().any(|r| r == "admin")
    }

    /// `statistics?refresh=true` (a cached snapshot otherwise), the admin
    /// count and the open reports. `moderation.reportsByUsers` groups by
    /// author, so the open message reports are the sum of their counts over
    /// the first 100 authors, as on mobile.
    pub async fn overview(rest: &RestClient) -> Result<Overview, RestError> {
        let (stats, admins, messages, users) = tokio::try_join!(
            rest.get("statistics", CallOptions::params([("refresh", "true")])),
            rest.get("roles.getUsersInRole", CallOptions::params([("role", "admin"), ("count", "1")])),
            rest.get("moderation.reportsByUsers", CallOptions::params([("count", "100")])),
            rest.get("moderation.userReports", CallOptions::params([("count", "1")])),
        )?;
        let reported =
            messages.get("reports").and_then(Value::as_array).into_iter().flatten().map(|a| count(a, "count")).sum();
        Ok(parse_overview(&stats, count(&admins, "total"), reported, count(&users, "total")))
    }

    pub fn parse_overview(s: &Value, admins: u64, reported_messages: u64, reported_users: u64) -> Overview {
        let mongo = text(s, "mongoVersion");
        let engine = text(s, "mongoStorageEngine");
        let database = match (mongo.is_empty(), engine.is_empty()) {
            (false, false) => format!("MongoDB {mongo} ({engine})"),
            (false, true) => format!("MongoDB {mongo}"),
            _ => "MongoDB".to_owned(),
        };
        let node = s.pointer("/process/nodeVersion").and_then(Value::as_str).unwrap_or_default();
        Overview {
            product: Product::RocketChat,
            version: text(s, "version"),
            uptime_seconds: s.pointer("/process/uptime").and_then(Value::as_f64).map(|u| u as u64),
            database,
            migration: s.pointer("/migration/version").map(|v| v.to_string().trim_matches('"').to_owned()),
            runtime: (!node.is_empty()).then(|| format!("Node {node}")),
            instance_id: date(s, "uniqueId"),
            users: UserCounts {
                total: count(s, "totalUsers"),
                active: count(s, "activeUsers"),
                deactivated: count(s, "nonActiveUsers"),
                admins: Some(admins),
                online: count(s, "onlineUsers"),
                away: count(s, "awayUsers"),
                busy: count(s, "busyUsers"),
                offline: count(s, "offlineUsers"),
            },
            rooms: KindCounts {
                total: count(s, "totalRooms"),
                public: count(s, "totalChannels"),
                private: count(s, "totalPrivateGroups"),
                direct: count(s, "totalDirect"),
                discussions: Some(count(s, "totalDiscussions")),
                encrypted: None,
            },
            messages: KindCounts {
                total: count(s, "totalMessages"),
                public: count(s, "totalChannelMessages"),
                private: count(s, "totalPrivateGroupMessages"),
                direct: count(s, "totalDirectMessages"),
                discussions: Some(count(s, "totalDiscussionsMessages")),
                encrypted: None,
            },
            uploads: UploadCounts { count: count(s, "uploadsTotal"), bytes: count(s, "uploadsTotalSize") },
            reports: ReportCounts { messages: reported_messages, users: reported_users },
        }
    }

    fn user(u: &Value) -> AdminUser {
        let roles: Vec<String> = u
            .get("roles")
            .and_then(Value::as_array)
            .map(|r| r.iter().filter_map(Value::as_str).map(str::to_owned).collect())
            .unwrap_or_default();
        let kind = text(u, "type");
        AdminUser {
            id: text(u, "_id"),
            username: text(u, "username"),
            name: text(u, "name"),
            avatar: date(u, "avatarETag"),
            admin: is_admin(&roles),
            active: u.get("active").and_then(Value::as_bool).unwrap_or(true),
            bot: kind == "bot" || kind == "app",
            status: Presence::parse(&text(u, "status")),
            created_at: date(u, "createdAt"),
            last_seen_at: date(u, "lastLogin"),
            revision: None,
        }
    }

    /// `users.listByStatus`, which searches (`users.list` refuses a filter).
    pub async fn users(rest: &RestClient, offset: u64, query: &str) -> Result<Page<AdminUser>, RestError> {
        let mut params = vec![("count".to_owned(), PAGE.to_string()), ("offset".to_owned(), offset.to_string())];
        if !query.trim().is_empty() {
            params.push(("searchTerm".to_owned(), query.trim().to_owned()));
        }
        let response = rest.get("users.listByStatus", CallOptions::params(params)).await?;
        let items: Vec<AdminUser> =
            response.get("users").and_then(Value::as_array).into_iter().flatten().map(user).collect();
        let next = next(&response, offset, items.len());
        Ok(Page { items, next })
    }

    pub async fn set_admin(rest: &RestClient, username: &str, admin: bool) -> Result<(), RestError> {
        let path = if admin { "roles.addUserToRole" } else { "roles.removeUserFromRole" };
        rest.post(path, CallOptions::body(json!({"roleId": "admin", "username": username}))).await.map(|_| ())
    }

    pub async fn set_active(rest: &RestClient, user_id: &str, active: bool) -> Result<(), RestError> {
        let body = json!({"userId": user_id, "activeStatus": active, "confirmRelinquish": true});
        rest.post("users.setActiveStatus", CallOptions::body(body)).await.map(|_| ())
    }

    pub async fn delete_user(rest: &RestClient, user_id: &str) -> Result<(), RestError> {
        let body = json!({"userId": user_id, "confirmRelinquish": true});
        rest.post("users.delete", CallOptions::body(body)).await.map(|_| ())
    }

    fn room(r: &Value) -> AdminRoom {
        let t = text(r, "t");
        let usernames: Vec<String> = r
            .get("usernames")
            .and_then(Value::as_array)
            .map(|u| u.iter().filter_map(Value::as_str).map(str::to_owned).collect())
            .unwrap_or_default();
        let name = if t == "d" && !usernames.is_empty() {
            usernames.join(", ")
        } else {
            Some(text(r, "fname")).filter(|n| !n.is_empty()).unwrap_or_else(|| text(r, "name"))
        };
        AdminRoom {
            id: text(r, "_id"),
            kind: room_type(&t, r.get("prid").and_then(Value::as_str).is_some()),
            name,
            topic: date(r, "topic"),
            members: count(r, "usersCount"),
            messages: count(r, "msgs"),
            created_at: date(r, "ts"),
            last_message_at: r.pointer("/lm").and_then(Value::as_str).map(str::to_owned),
            read_only: r.get("ro").and_then(Value::as_bool).unwrap_or(false),
            encrypted: r.get("encrypted").and_then(Value::as_bool).unwrap_or(false),
            direct_members: usernames
                .iter()
                .map(|u| UserLite { username: u.clone(), name: u.clone(), ..Default::default() })
                .collect(),
        }
    }

    /// `rooms.adminRooms`, every type; `query` filters on the name.
    pub async fn rooms(rest: &RestClient, offset: u64, query: &str) -> Result<Page<AdminRoom>, RestError> {
        let mut params = vec![("count".to_owned(), PAGE.to_string()), ("offset".to_owned(), offset.to_string())];
        if !query.trim().is_empty() {
            params.push(("filter".to_owned(), query.trim().to_owned()));
        }
        let response = rest.get("rooms.adminRooms", CallOptions::params(params)).await?;
        let items: Vec<AdminRoom> =
            response.get("rooms").and_then(Value::as_array).into_iter().flatten().map(room).collect();
        let next = next(&response, offset, items.len());
        Ok(Page { items, next })
    }

    /// `moderation.reportsByUsers` lists authors; each one's reported
    /// messages come from `moderation.user.reportedMessages`, one item per
    /// message with its report count. Admins bypass the rate limit.
    pub async fn reported_messages(rest: &RestClient, offset: u64) -> Result<Page<ReportedMessage>, RestError> {
        let params = [("count", PAGE.to_string()), ("offset", offset.to_string())];
        let response = rest.get("moderation.reportsByUsers", CallOptions::params(params)).await?;
        let authors: Vec<Value> = response.get("reports").and_then(Value::as_array).cloned().unwrap_or_default();
        let mut items: Vec<ReportedMessage> = Vec::new();
        for author in &authors {
            let user = text(author, "userId");
            let params = [("userId", user.as_str()), ("count", "100")];
            let detail = rest.get("moderation.user.reportedMessages", CallOptions::params(params)).await?;
            let mut who = UserLite {
                id: user.clone(),
                username: text(author, "username"),
                name: text(author, "name"),
                deleted: author.get("isUserDeleted").and_then(Value::as_bool).unwrap_or(false),
            };
            if who.deleted {
                who.name.clear();
            }
            let mut mine: Vec<ReportedMessage> = Vec::new();
            for report in detail.get("messages").and_then(Value::as_array).into_iter().flatten() {
                let message = report.get("message").cloned().unwrap_or(Value::Null);
                let id = text(&message, "_id");
                let at = text(report, "ts");
                if let Some(known) = mine.iter_mut().find(|m| m.message_id == id) {
                    known.count += 1;
                    if at > known.latest_at {
                        known.latest_at = at;
                    }
                    continue;
                }
                let room = report.get("room").cloned().unwrap_or(Value::Null);
                mine.push(ReportedMessage {
                    message_id: id,
                    room: ReportRoom {
                        id: text(&room, "_id"),
                        name: Some(text(&room, "fname"))
                            .filter(|n| !n.is_empty())
                            .unwrap_or_else(|| text(&room, "name")),
                        kind: room_type(&text(&room, "t"), false),
                    },
                    author: who.clone(),
                    text: text(&message, "msg"),
                    created_at: text(&message, "ts"),
                    deleted: false,
                    count: 1,
                    latest_at: at,
                    reports: None,
                });
            }
            items.extend(mine);
        }
        items.sort_by(|a, b| b.latest_at.cmp(&a.latest_at));
        Ok(Page { next: next(&response, offset, authors.len()), items })
    }

    fn report(r: &Value) -> Report {
        Report {
            reporter: lite(r.get("reportedBy").unwrap_or(&Value::Null)),
            reason: text(r, "description"),
            at: text(r, "ts"),
        }
    }

    pub async fn message_reports(rest: &RestClient, message_id: &str) -> Result<Vec<Report>, RestError> {
        let params = [("msgId", message_id), ("count", "50")];
        let response = rest.get("moderation.reports", CallOptions::params(params)).await?;
        let mut reports: Vec<Report> =
            response.get("reports").and_then(Value::as_array).into_iter().flatten().map(report).collect();
        reports.sort_by(|a, b| b.at.cmp(&a.at));
        Ok(reports)
    }

    pub async fn reported_users(rest: &RestClient, offset: u64) -> Result<Page<ReportedUser>, RestError> {
        let params = [("count", PAGE.to_string()), ("offset", offset.to_string())];
        let response = rest.get("moderation.userReports", CallOptions::params(params)).await?;
        let items: Vec<ReportedUser> = response
            .get("reports")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .map(|r| ReportedUser {
                user: user(r.get("reportedUser").unwrap_or(&Value::Null)),
                count: count(r, "count"),
                latest_at: text(r, "ts"),
                reports: None,
            })
            .collect();
        let next = next(&response, offset, items.len());
        Ok(Page { items, next })
    }

    pub async fn user_reports(rest: &RestClient, user_id: &str) -> Result<Vec<Report>, RestError> {
        let params = [("userId", user_id), ("count", "50")];
        let response = rest.get("moderation.user.reportsByUserId", CallOptions::params(params)).await?;
        let mut reports: Vec<Report> =
            response.get("reports").and_then(Value::as_array).into_iter().flatten().map(report).collect();
        reports.sort_by(|a, b| b.at.cmp(&a.at));
        Ok(reports)
    }

    pub async fn dismiss_message(rest: &RestClient, message_id: &str) -> Result<(), RestError> {
        rest.post("moderation.dismissReports", CallOptions::body(json!({"msgId": message_id}))).await.map(|_| ())
    }

    pub async fn delete_message(rest: &RestClient, rid: &str, message_id: &str) -> Result<(), RestError> {
        crate::actions::delete(rest, rid, message_id).await
    }

    pub async fn dismiss_user(rest: &RestClient, user_id: &str) -> Result<(), RestError> {
        rest.post("moderation.dismissUserReports", CallOptions::body(json!({"userId": user_id}))).await.map(|_| ())
    }

    pub async fn report_message(rest: &RestClient, message_id: &str, reason: &str) -> Result<(), RestError> {
        let body = json!({"messageId": message_id, "description": reason});
        rest.post("chat.reportMessage", CallOptions::body(body)).await.map(|_| ())
    }

    pub async fn report_user(rest: &RestClient, user_id: &str, reason: &str) -> Result<(), RestError> {
        let body = json!({"userId": user_id, "description": reason});
        rest.post("moderation.reportUser", CallOptions::body(body)).await.map(|_| ())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> Value {
        serde_json::from_str(include_str!("../../../../../docs/protocol/v1.fixture.json")).unwrap()
    }

    #[test]
    fn native_overview_maps_the_contract_and_counts_uptime() {
        let overview: rv_protocol::admin::AdminOverview =
            serde_json::from_value(fixture()["administration"]["overview"].clone()).unwrap();
        let now = chrono::DateTime::parse_from_rfc3339("2026-10-07T09:00:00+00:00").unwrap().to_utc();
        let o = native_overview(&overview, now);
        assert_eq!((o.product, o.version.as_str(), o.uptime_seconds), (Product::RocketVibe, "0.1.0", Some(3600)));
        assert_eq!(o.database, "PostgreSQL 18.1");
        assert_eq!((o.users.admins, o.rooms.encrypted, o.rooms.discussions), (Some(2), Some(1), None));
        assert_eq!((o.uploads.bytes, o.reports.messages), (48211904, 1));
    }

    #[test]
    fn deleted_people_read_as_deleted_users() {
        let rooms: rv_protocol::admin::AdminRoomPage =
            serde_json::from_value(fixture()["administration"]["room_page"].clone()).unwrap();
        let direct = native_room(&rooms.items[1]);
        assert_eq!(
            (direct.kind, direct.name.as_str()),
            (RoomType::Direct, format!("Bob, {}", crate::i18n::t("user.deleted")).as_str())
        );
        let reported: rv_protocol::admin::AdminReportedMessagePage =
            serde_json::from_value(fixture()["administration"]["reported_messages"].clone()).unwrap();
        let item = native_reported_message(&reported.items[0]);
        assert!(item.author.deleted);
        assert_eq!(item.author.shown(), crate::i18n::t("user.deleted"));
        assert_eq!(item.reports.as_ref().map(Vec::len), Some(2));
    }

    #[test]
    fn reasons_and_versions() {
        assert_eq!(valid_reason("  spam \n").as_deref(), Some("spam"));
        assert!(valid_reason("   ").is_none());
        assert!(valid_reason(&"é".repeat(REASON_MAX)).is_some() && valid_reason(&"é".repeat(REASON_MAX + 1)).is_none());
        assert!(update_available("8.5.1", "8.8.1") && !update_available("8.5.1", "8.5.1"));
        let releases = json!([
            {"tag_name": "desktop-v0.9.0"},
            {"tag_name": "server-v0.2.0", "prerelease": true},
            {"tag_name": "server-v0.1.3"},
            {"tag_name": "server-v0.1.10"}
        ]);
        assert_eq!(latest_server_tag(&releases).as_deref(), Some("0.1.10"));
        assert_eq!(latest_server_tag(&json!([{"tag_name": "desktop-v1.0.0"}])), None);
    }

    #[test]
    fn rocket_chat_statistics() {
        let stats = json!({"version": "8.5.1", "uniqueId": "u1", "mongoVersion": "8.0.32", "mongoStorageEngine": "wiredTiger",
            "process": {"uptime": 79996.09, "nodeVersion": "v22.22.3"}, "migration": {"version": 330},
            "totalUsers": 4, "activeUsers": 3, "nonActiveUsers": 1, "onlineUsers": 1, "offlineUsers": 3,
            "totalRooms": 4, "totalChannels": 2, "totalPrivateGroups": 1, "totalDirect": 1, "totalDiscussions": 0,
            "totalMessages": 54, "uploadsTotal": 3, "uploadsTotalSize": 2048});
        let o = rc::parse_overview(&stats, 1, 2, 3);
        assert_eq!(o.database, "MongoDB 8.0.32 (wiredTiger)");
        assert_eq!((o.runtime.as_deref(), o.migration.as_deref()), (Some("Node v22.22.3"), Some("330")));
        assert_eq!((o.uptime_seconds, o.users.deactivated, o.users.admins), (Some(79996), 1, Some(1)));
        assert_eq!((o.reports.messages, o.reports.users, o.uploads.count), (2, 3, 3));
    }
}
