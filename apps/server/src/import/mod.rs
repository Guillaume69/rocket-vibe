//! The Rocket.Chat import (docs/protocol/IMPORT.md): phases that each commit
//! their rows, their `import_ids` mapping and their cursor together, so a
//! rerun resumes where the last one stopped and duplicates nothing.
pub mod map;
mod source;

use chrono::{DateTime, Utc};
use mongodb::bson::{Bson, Document};
use rv_protocol::{User, parity::RoomRole};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::{Postgres, Transaction};
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;

use crate::{App, auth::random_token};
use source::{Fields, Source};

#[derive(Debug)]
pub struct ImportError(pub String);
impl ImportError {
    pub fn new(message: &str) -> Self {
        Self(message.to_owned())
    }
}
impl std::fmt::Display for ImportError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}
impl std::error::Error for ImportError {}
macro_rules! from {
    ($($t:ty),*) => { $(impl From<$t> for ImportError { fn from(e: $t) -> Self { Self(format!("{e}")) } })* };
}
from!(
    mongodb::error::Error,
    sqlx::Error,
    std::io::Error,
    serde_json::Error
);
impl From<crate::error::Error> for ImportError {
    fn from(e: crate::error::Error) -> Self {
        Self(e.code.to_owned())
    }
}
type Result<T> = std::result::Result<T, ImportError>;

pub struct Options {
    pub mongo_url: String,
    pub files_dir: Option<PathBuf>,
}

const PHASES: [&str; 6] = ["emojis", "users", "rooms", "messages", "members", "publish"];
const BATCH: i64 = 500;
const MAX_TEXT: usize = 32_768;
const MAX_FILE: usize = 104_857_600;

/// Runs (or resumes) the import, then returns its report.
pub async fn rocketchat(app: &App, options: Options) -> Result<Value> {
    let source = Source::connect(&options.mongo_url, options.files_dir).await?;
    let origin = redacted(&options.mongo_url);
    let mut phase = start(app, &origin).await?;
    let mut run = Run {
        app,
        source: &source,
    };
    while let Some(current) = PHASES.iter().position(|p| *p == phase) {
        match phase.as_str() {
            "emojis" => run.emojis().await?,
            "users" => run.users().await?,
            "rooms" => run.rooms().await?,
            "messages" => run.messages().await?,
            "members" => run.members().await?,
            _ => run.publish().await?,
        }
        phase = PHASES
            .get(current + 1)
            .copied()
            .unwrap_or("done")
            .to_owned();
        sqlx::query("UPDATE import_state SET phase=$1,cursor=NULL,finished_at=CASE WHEN $1='done' THEN clock_timestamp() END")
            .bind(&phase)
            .execute(&app.pool)
            .await?;
    }
    report(app, &origin, source.version().await).await
}

/// The source without its credentials, as it is kept and reported.
fn redacted(url: &str) -> String {
    match url::Url::parse(url) {
        Ok(mut parsed) => {
            let _ = parsed.set_username("");
            let _ = parsed.set_password(None);
            parsed.to_string()
        }
        Err(_) => "mongodb".into(),
    }
}

/// The phase to resume, or the first one on an instance still empty.
async fn start(app: &App, origin: &str) -> Result<String> {
    let state: Option<(String, String)> = sqlx::query_as("SELECT source,phase FROM import_state")
        .fetch_optional(&app.pool)
        .await?;
    if let Some((source, phase)) = state {
        if source != origin {
            return Err(ImportError(format!(
                "this instance was imported from {source}"
            )));
        }
        return Ok(phase);
    }
    let used: bool =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM rooms) OR EXISTS(SELECT 1 FROM messages)")
            .fetch_one(&app.pool)
            .await?;
    if used {
        return Err(ImportError::new(
            "the instance already holds rooms or messages: an import goes into an empty instance",
        ));
    }
    sqlx::query("INSERT INTO import_state(source,phase) VALUES($1,$2)")
        .bind(origin)
        .bind(PHASES[0])
        .execute(&app.pool)
        .await?;
    Ok(PHASES[0].into())
}

struct Run<'a> {
    app: &'a App,
    source: &'a Source,
}

async fn mapped<'e>(
    executor: impl sqlx::PgExecutor<'e>,
    kind: &str,
    source: &str,
) -> Result<Option<String>> {
    Ok(
        sqlx::query_scalar("SELECT native_id FROM import_ids WHERE kind=$1 AND source_id=$2")
            .bind(kind)
            .bind(source)
            .fetch_optional(executor)
            .await?,
    )
}
async fn remember(
    tx: &mut Transaction<'_, Postgres>,
    kind: &str,
    source: &str,
    native: &str,
) -> Result<()> {
    sqlx::query(
        "INSERT INTO import_ids(kind,source_id,native_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
    )
    .bind(kind)
    .bind(source)
    .bind(native)
    .execute(&mut **tx)
    .await?;
    Ok(())
}
async fn omit<'e>(
    executor: impl sqlx::PgExecutor<'e>,
    kind: &str,
    source: &str,
    reason: &str,
    detail: &str,
) -> Result<()> {
    sqlx::query("INSERT INTO import_omissions(kind,source_id,reason,detail) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING")
        .bind(kind)
        .bind(source)
        .bind(reason)
        .bind(detail)
        .execute(executor)
        .await?;
    Ok(())
}

/// A fresh native id when the source's is not one, or is taken.
async fn native_id(
    tx: &mut Transaction<'_, Postgres>,
    table: &str,
    source: &str,
) -> Result<String> {
    if let Some(id) = map::id(source) {
        let taken: bool =
            sqlx::query_scalar(&format!("SELECT EXISTS(SELECT 1 FROM {table} WHERE id=$1)"))
                .bind(id)
                .fetch_one(&mut **tx)
                .await?;
        if !taken {
            return Ok(id.to_owned());
        }
    }
    Ok(random_token()[..24].to_owned())
}

impl Run<'_> {
    async fn emojis(&mut self) -> Result<()> {
        for emoji in self.source.all("rocketchat_custom_emoji").await? {
            let (Some(id), Some(name)) = (emoji.text("_id"), emoji.text("name")) else {
                continue;
            };
            if mapped(&self.app.pool, "emoji", id).await?.is_some() {
                continue;
            }
            let name = name.to_lowercase();
            // An alias a standard emoji already answers to stays with it.
            let (aliases, dropped): (Vec<String>, Vec<String>) = emoji
                .strings("aliases")
                .iter()
                .map(|a| a.to_lowercase())
                .filter(|a| *a != name)
                .take(8)
                .partition(|a| {
                    rv_protocol::custom_emojis::shortcode(a) == Some(a.as_str())
                        && rv_protocol::emojis::canonical(a).is_none()
                });
            if !dropped.is_empty() {
                omit(
                    &self.app.pool,
                    "emoji",
                    id,
                    "alias_dropped",
                    &dropped.join(", "),
                )
                .await?;
            }
            let file = format!(
                "{}.{}",
                emoji.text("name").unwrap_or_default(),
                emoji.text("extension").unwrap_or("png")
            );
            let bytes = match self.source.emoji(&file).await {
                Ok(bytes) => bytes,
                Err(e) => {
                    omit(&self.app.pool, "emoji", id, "file_missing", &e.0).await?;
                    continue;
                }
            };
            let operation = format!("import-emoji-{}", map::id(id).unwrap_or("x"));
            match crate::custom_emojis::put(self.app, &operation, &name, aliases, None, bytes).await
            {
                Ok(_) => {
                    let mut tx = self.app.pool.begin().await?;
                    remember(&mut tx, "emoji", id, &name).await?;
                    tx.commit().await?;
                }
                Err(e) => omit(&self.app.pool, "emoji", id, "rejected", e.code).await?,
            }
        }
        Ok(())
    }

    async fn users(&mut self) -> Result<()> {
        let mut users = self.source.all("users").await?;
        users.sort_by_key(|u| u.time("createdAt"));
        let mut taken: HashSet<String> =
            sqlx::query_scalar::<_, String>("SELECT lower(username) FROM users")
                .fetch_all(&self.app.pool)
                .await?
                .into_iter()
                .collect();
        let avatars: HashMap<String, Document> = self
            .source
            .all("rocketchat_avatars")
            .await?
            .into_iter()
            .filter_map(|a| Some((a.text("userId")?.to_owned(), a)))
            .collect();
        // One unusable native hash for every imported account: its legacy
        // hash, or a recovery code, is the way in.
        let placeholder = tokio::task::spawn_blocking(|| {
            use argon2::{Argon2, PasswordHasher, password_hash::SaltString};
            Argon2::default()
                .hash_password(
                    random_token().as_bytes(),
                    &SaltString::generate(&mut rand_core::OsRng),
                )
                .map(|h| h.to_string())
        })
        .await
        .map_err(|_| ImportError::new("password hashing failed"))?
        .map_err(|_| ImportError::new("password hashing failed"))?;
        for user in users {
            let (Some(source_id), Some(source_name)) = (user.text("_id"), user.text("username"))
            else {
                if let Some(id) = user.text("_id") {
                    omit(&self.app.pool, "user", id, "no_username", "").await?;
                }
                continue;
            };
            if mapped(&self.app.pool, "user", source_id).await?.is_some() {
                continue;
            }
            let mut tx = self.app.pool.begin().await?;
            let id = native_id(&mut tx, "users", source_id).await?;
            let username = map::username(source_name, &mut taken);
            let display = map::display_name(user.text("name"), &username);
            let human = user.text("type").is_none_or(|t| t == "user") && source_id != "rocket.cat";
            let disabled = !user.flag("active") || !human;
            let legacy = user
                .sub("services")
                .and_then(|s| s.sub("password"))
                .and_then(|p| p.text("bcrypt"));
            sqlx::query("INSERT INTO users(id,username,display_name,password_hash,admin,disabled,legacy_password) VALUES($1,$2,$3,$4,$5,$6,$7)")
                .bind(&id).bind(&username).bind(&display).bind(&placeholder)
                .bind(user.strings("roles").contains(&"admin")).bind(disabled).bind(legacy)
                .execute(&mut *tx).await?;
            remember(&mut tx, "user", source_id, &id).await?;
            remember(&mut tx, "username", source_name, &id).await?;
            if username != source_name {
                omit(
                    &mut *tx,
                    "user",
                    source_id,
                    "renamed",
                    &format!("{source_name} → {username}"),
                )
                .await?;
            }
            if legacy.is_none() && !disabled {
                omit(&mut *tx, "user", source_id, "no_password", &username).await?;
            }
            // An authenticator app the user set up; Rocket.Chat turns e-mail
            // codes on for everyone by default, which says nothing.
            let services = user.sub("services");
            if services
                .and_then(|s| s.sub("totp"))
                .is_some_and(|t| t.flag("enabled"))
            {
                omit(
                    &mut *tx,
                    "user",
                    source_id,
                    "second_factor_dropped",
                    &username,
                )
                .await?;
            }
            tx.commit().await?;
            if let Some(avatar) = avatars.get(source_id) {
                self.avatar(source_id, &id, avatar).await?;
            }
        }
        Ok(())
    }

    async fn avatar(&mut self, source_id: &str, user: &str, avatar: &Document) -> Result<()> {
        let (Some(file), Some(store), Some(objects)) = (
            avatar.text("_id"),
            avatar.text("store"),
            self.app.objects.as_ref(),
        ) else {
            return Ok(());
        };
        let png = match self.source.bytes(store, file).await {
            Ok(bytes) => {
                crate::profiles::decode_avatar(avatar.text("type").unwrap_or("image/png"), &bytes)
            }
            Err(e) => {
                omit(&self.app.pool, "avatar", source_id, "file_missing", &e.0).await?;
                return Ok(());
            }
        };
        let Ok(png) = png else {
            omit(&self.app.pool, "avatar", source_id, "invalid_image", "").await?;
            return Ok(());
        };
        let object = objects.put(png).await?;
        sqlx::query("UPDATE users SET avatar_file_id=$2 WHERE id=$1")
            .bind(user)
            .bind(object)
            .execute(&self.app.pool)
            .await?;
        Ok(())
    }

    async fn rooms(&mut self) -> Result<()> {
        for room in self.source.all("rocketchat_room").await? {
            let Some(rid) = room.text("_id") else {
                continue;
            };
            if mapped(&self.app.pool, "room", rid).await?.is_some()
                || mapped(&self.app.pool, "skipped_room", rid).await?.is_some()
            {
                continue;
            }
            let label = room
                .text("fname")
                .or(room.text("name"))
                .unwrap_or(rid)
                .to_owned();
            let uids = room.strings("uids");
            let encrypted = room.flag("encrypted");
            let mut tx = self.app.pool.begin().await?;
            let kind = match map::room_kind(room.text("t").unwrap_or(""), encrypted, &uids) {
                Ok(kind) => kind,
                Err(reason) => {
                    omit(&mut *tx, "room", rid, reason, &label).await?;
                    remember(&mut tx, "skipped_room", rid, reason).await?;
                    tx.commit().await?;
                    continue;
                }
            };
            let mut people = Vec::new();
            for uid in uids.iter().collect::<std::collections::BTreeSet<_>>() {
                let native: Option<(String, String)> = sqlx::query_as(
                    "SELECT u.id,u.username FROM import_ids i JOIN users u ON u.id=i.native_id WHERE i.kind='user' AND i.source_id=$1",
                )
                .bind(uid)
                .fetch_optional(&mut *tx)
                .await?;
                people.extend(native);
            }
            people.sort();
            let (name, kind, pair) = match kind {
                map::RoomKind::Direct if people.len() == 2 => (
                    format!("{} / {}", people[0].1, people[1].1),
                    "direct",
                    Some(format!("{}:{}", people[0].0, people[1].0)),
                ),
                map::RoomKind::Direct => {
                    omit(&mut *tx, "room", rid, "direct_member_missing", &label).await?;
                    remember(&mut tx, "skipped_room", rid, "direct_member_missing").await?;
                    tx.commit().await?;
                    continue;
                }
                map::RoomKind::Private if room.text("t") == Some("d") => {
                    omit(&mut *tx, "room", rid, "group_direct_as_private", &label).await?;
                    let names: Vec<_> = people.iter().map(|p| p.1.as_str()).collect();
                    (map::room_name(&names.join(", ")), "private", None)
                }
                map::RoomKind::Private => (map::room_name(&label), "private", None),
                map::RoomKind::Public => (map::room_name(&label), "public", None),
            };
            if room.text("prid").is_some() {
                omit(&mut *tx, "room", rid, "discussion_unlinked", &label).await?;
            }
            let field = |key: &str, max: usize| map::truncate(room.text(key).unwrap_or(""), max);
            let (topic, cut_topic) = field("topic", 1024);
            let (description, cut_description) = field("description", 4096);
            let (announcement, cut_announcement) = field("announcement", 4096);
            if cut_topic || cut_description || cut_announcement {
                omit(&mut *tx, "room", rid, "settings_truncated", &label).await?;
            }
            let id = native_id(&mut tx, "rooms", rid).await?;
            sqlx::query("INSERT INTO rooms(id,name,kind,direct_pair,read_only,topic,description,announcement) VALUES($1,$2,$3,$4,$5,$6,$7,$8)")
                .bind(&id).bind(&name).bind(kind).bind(pair)
                .bind(room.flag("ro") || room.flag("archived"))
                .bind(topic).bind(description).bind(announcement)
                .execute(&mut *tx).await?;
            remember(&mut tx, "room", rid, &id).await?;
            tx.commit().await?;
        }
        Ok(())
    }

    /// Every message in time order, in batches that each take consecutive positions.
    async fn messages(&mut self) -> Result<()> {
        let users: HashMap<String, User> = sqlx::query_as::<_, (String, String, String, String)>(
            "SELECT i.source_id,u.id,u.username,u.display_name FROM import_ids i JOIN users u ON u.id=i.native_id WHERE i.kind='username'",
        )
        .fetch_all(&self.app.pool)
        .await?
        .into_iter()
        .map(|(source, id, username, display_name)| (source, User { id, username, display_name }))
        .collect();
        let custom: HashSet<String> =
            sqlx::query_scalar("SELECT native_id FROM import_ids WHERE kind='emoji'")
                .fetch_all(&self.app.pool)
                .await?
                .into_iter()
                .collect();
        let epoch: String = sqlx::query_scalar("SELECT data_epoch FROM instance")
            .fetch_one(&self.app.pool)
            .await?;
        loop {
            let cursor: Option<Value> = sqlx::query_scalar("SELECT cursor FROM import_state")
                .fetch_one(&self.app.pool)
                .await?;
            let after = cursor.and_then(|c| {
                Some((
                    DateTime::parse_from_rfc3339(c.get("ts")?.as_str()?)
                        .ok()?
                        .with_timezone(&Utc),
                    c.get("id")?.as_str()?.to_owned(),
                ))
            });
            let batch = self.source.messages_after(after, BATCH).await?;
            let Some(last) = batch.last() else {
                return Ok(());
            };
            let next = json!({"ts": last.time("ts").unwrap_or_default().to_rfc3339(), "id": last.text("_id").unwrap_or("")});
            let mut tx = self.app.pool.begin().await?;
            // Positions for the whole batch, in time order; unused ones leave a gap.
            let top: i64 =
                sqlx::query_scalar("UPDATE instance SET position=position+$1 RETURNING position")
                    .bind(batch.len() as i64)
                    .fetch_one(&mut *tx)
                    .await?;
            let mut position = top - batch.len() as i64;
            for message in &batch {
                position += 1;
                self.message(&mut tx, message, position, &users, &custom, &epoch)
                    .await?;
            }
            sqlx::query("UPDATE import_state SET cursor=$1")
                .bind(next)
                .execute(&mut *tx)
                .await?;
            tx.commit().await?;
        }
    }

    async fn message(
        &mut self,
        tx: &mut Transaction<'_, Postgres>,
        m: &Document,
        position: i64,
        users: &HashMap<String, User>,
        custom: &HashSet<String>,
        epoch: &str,
    ) -> Result<()> {
        let Some(source_id) = m.text("_id") else {
            return Ok(());
        };
        if mapped(&mut **tx, "message", source_id).await?.is_some() {
            return Ok(());
        }
        let Some(room) = (match m.text("rid") {
            Some(rid) => mapped(&mut **tx, "room", rid).await?,
            None => None,
        }) else {
            return omit(
                &mut **tx,
                "message",
                source_id,
                "room_skipped",
                m.text("rid").unwrap_or(""),
            )
            .await;
        };
        let author = match m.sub("u").and_then(|u| u.text("_id")) {
            Some(uid) => mapped(&mut **tx, "user", uid).await?,
            None => None,
        };
        let Some(author) = author else {
            return omit(&mut **tx, "message", source_id, "author_missing", "").await;
        };
        let created = m.time("ts").unwrap_or_else(Utc::now);
        let id = native_id(tx, "messages", source_id).await?;
        let (mut text, mut system, mut quotes, mut reply_to, mut files) = (
            String::new(),
            None,
            Vec::<Value>::new(),
            None::<String>,
            Vec::<Value>::new(),
        );
        if let Some(t) = m.text("t") {
            let resolve = |name: &str| users.get(name).cloned();
            match map::system(t, m.text("msg").unwrap_or(""), m.text("role"), resolve) {
                Some(kind) => system = Some(serde_json::to_value(kind)?),
                None => {
                    return omit(&mut **tx, "message", source_id, &format!("system_{t}"), "").await;
                }
            }
        } else {
            let source_text = m.text("msg").unwrap_or("");
            let (targets, rest) = map::quotes(source_text);
            let mut resolved = Vec::new();
            for target in &targets {
                let found: Option<(String, i64)> = sqlx::query_as(
                    "SELECT m.room_id,m.revision FROM import_ids i JOIN messages m ON m.id=i.native_id WHERE i.kind='message' AND i.source_id=$1 AND m.system IS NULL AND NOT m.deleted",
                )
                .bind(target)
                .fetch_optional(&mut **tx)
                .await?;
                if let (Some((room_id, revision)), Some(native)) =
                    (found, mapped(&mut **tx, "message", target).await?)
                {
                    resolved.push(json!({"room_id": room_id, "message_id": native, "revision": revision.to_string()}));
                }
            }
            if !targets.is_empty() && resolved.len() == targets.len() {
                quotes = resolved;
                text = rest.to_owned();
            } else {
                if !targets.is_empty() {
                    omit(&mut **tx, "message", source_id, "quote_target_missing", "").await?;
                }
                text = source_text.to_owned();
            }
            let (cut, truncated) = map::truncate(&text, MAX_TEXT);
            if truncated {
                omit(&mut **tx, "message", source_id, "text_truncated", "").await?;
            }
            text = cut;
            if let Some(tmid) = m.text("tmid") {
                let root: Option<String> = sqlx::query_scalar(
                    "SELECT m.id FROM import_ids i JOIN messages m ON m.id=i.native_id WHERE i.kind='message' AND i.source_id=$1 AND m.room_id=$2 AND m.reply_to IS NULL AND m.system IS NULL AND NOT m.deleted",
                )
                .bind(tmid)
                .bind(&room)
                .fetch_optional(&mut **tx)
                .await?;
                match root {
                    Some(root) => reply_to = Some(root),
                    None => {
                        omit(&mut **tx, "message", source_id, "thread_root_missing", tmid).await?
                    }
                }
            }
            let mut ids: Vec<&str> = m
                .get_array("files")
                .map(|f| {
                    f.iter()
                        .filter_map(|d| d.as_document()?.text("_id"))
                        .collect()
                })
                .unwrap_or_default();
            if ids.is_empty()
                && let Some(single) = m.sub("file").and_then(|f| f.text("_id"))
            {
                ids.push(single);
            }
            for file in ids {
                if let Some(descriptor) =
                    self.file(tx, file, &room, &author, created, epoch).await?
                {
                    files.push(descriptor);
                }
            }
            let extra = m
                .get_array("attachments")
                .map(|a| {
                    a.iter()
                        .filter_map(Bson::as_document)
                        .filter(|d| {
                            d.text("type") != Some("file") && d.text("message_link").is_none()
                        })
                        .count()
                })
                .unwrap_or(0);
            if extra > 0 {
                omit(
                    &mut **tx,
                    "message",
                    source_id,
                    "attachment_dropped",
                    &extra.to_string(),
                )
                .await?;
            }
            if text.trim().is_empty() && quotes.is_empty() && files.is_empty() {
                return omit(&mut **tx, "message", source_id, "empty_message", "").await;
            }
        }
        sqlx::query("INSERT INTO messages(id,room_id,author_id,operation_id,text,created_at,position,revision,edited_at,pinned,reply_to,quote_references,files,system) VALUES($1,$2,$3,$1,$4,$5,$6,$6,$7,$8,$9,$10,$11,$12)")
            .bind(&id).bind(&room).bind(&author).bind(&text).bind(created).bind(position)
            .bind(if system.is_none() { m.time("editedAt") } else { None })
            .bind(system.is_none() && m.flag("pinned"))
            .bind(&reply_to).bind(Value::Array(quotes)).bind(Value::Array(files)).bind(&system)
            .execute(&mut **tx).await?;
        sqlx::query("UPDATE uploads SET message_id=$1,state='completed' WHERE message_id IS NULL AND operation_id LIKE 'import-%' AND id IN (SELECT jsonb_array_elements(files)->>'id' FROM messages WHERE id=$1)")
            .bind(&id)
            .execute(&mut **tx)
            .await?;
        remember(tx, "message", source_id, &id).await?;
        if system.is_none() {
            if let Ok(reactions) = m.get_document("reactions") {
                for (code, entry) in reactions {
                    let Some(emoji) = map::reaction(code, custom) else {
                        omit(&mut **tx, "reaction", source_id, "unknown_emoji", code).await?;
                        continue;
                    };
                    let names = entry
                        .as_document()
                        .map(|e| e.strings("usernames"))
                        .unwrap_or_default();
                    for name in names {
                        if let Some(user) = users.get(name) {
                            sqlx::query("INSERT INTO message_reactions(message_id,user_id,emoji) VALUES($1,$2,$3) ON CONFLICT DO NOTHING")
                                .bind(&id).bind(&user.id).bind(&emoji).execute(&mut **tx).await?;
                        }
                    }
                }
            }
            if let Ok(stars) = m.get_array("starred") {
                for star in stars.iter().filter_map(|s| s.as_document()?.text("_id")) {
                    if let Some(user) = mapped(&mut **tx, "user", star).await? {
                        sqlx::query("INSERT INTO message_stars(message_id,user_id,present,revision) VALUES($1,$2,true,$3) ON CONFLICT DO NOTHING")
                            .bind(&id).bind(user).bind(position).execute(&mut **tx).await?;
                    }
                }
            }
        }
        Ok(())
    }

    /// A message's file as an upload its message completes; `None`
    /// (reported) when its bytes cannot be had.
    async fn file(
        &mut self,
        tx: &mut Transaction<'_, Postgres>,
        source_id: &str,
        room: &str,
        author: &str,
        created: DateTime<Utc>,
        epoch: &str,
    ) -> Result<Option<Value>> {
        let Some(objects) = self.app.objects.as_ref() else {
            omit(&mut **tx, "file", source_id, "no_object_store", "").await?;
            return Ok(None);
        };
        let Some(upload) = self.source.upload(source_id).await? else {
            omit(&mut **tx, "file", source_id, "upload_missing", "").await?;
            return Ok(None);
        };
        let bytes = match self
            .source
            .bytes(upload.text("store").unwrap_or(""), source_id)
            .await
        {
            Ok(bytes) => bytes,
            Err(e) => {
                omit(&mut **tx, "file", source_id, "file_missing", &e.0).await?;
                return Ok(None);
            }
        };
        if bytes.is_empty() || bytes.len() > MAX_FILE {
            omit(
                &mut **tx,
                "file",
                source_id,
                "file_size",
                &bytes.len().to_string(),
            )
            .await?;
            return Ok(None);
        }
        let sha256: String = Sha256::digest(&bytes)
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();
        let size = bytes.len() as i64;
        let object = objects.put(bytes).await?;
        let id = native_id(tx, "uploads", source_id).await?;
        let media_type = upload
            .text("type")
            .filter(|t| t.len() <= 255 && t.contains('/'))
            .unwrap_or("application/octet-stream");
        let (filename, _) = map::truncate(upload.text("name").unwrap_or("file"), 255);
        sqlx::query("INSERT INTO uploads(id,user_id,operation_id,fingerprint,room_id,membership_version,data_epoch,bytes,sha256,media_type,filename,state,object_id,created_at) VALUES($1,$2,$3,$4,$5,'import',$6,$7,$8,$9,$10,'ready',$11,$12)")
            .bind(&id).bind(author).bind(format!("import-{id}")).bind(&sha256).bind(room).bind(epoch)
            .bind(size).bind(&sha256).bind(media_type).bind(&filename).bind(object).bind(created)
            .execute(&mut **tx).await?;
        remember(tx, "file", source_id, &id).await?;
        Ok(Some(
            json!({"id": id, "room_id": room, "bytes": size.to_string(), "sha256": sha256, "media_type": media_type, "filename": filename, "encrypted": false}),
        ))
    }

    /// Members after the history (their read state starts at its end), then
    /// each one's read position and favorite, and the mentions of the room.
    async fn members(&mut self) -> Result<()> {
        let mut subscriptions: HashMap<String, Vec<Document>> = HashMap::new();
        for sub in self.source.all("rocketchat_subscription").await? {
            if let Some(rid) = sub.text("rid") {
                subscriptions.entry(rid.to_owned()).or_default().push(sub);
            }
        }
        let rooms: Vec<(String, String)> =
            sqlx::query_as("SELECT source_id,native_id FROM import_ids WHERE kind='room'")
                .fetch_all(&self.app.pool)
                .await?;
        let creators: HashMap<String, String> = self
            .source
            .all("rocketchat_room")
            .await?
            .into_iter()
            .filter_map(|r| {
                Some((
                    r.text("_id")?.to_owned(),
                    r.sub("u")?.text("_id")?.to_owned(),
                ))
            })
            .collect();
        for (rid, room) in rooms {
            if mapped(&self.app.pool, "members", &rid).await?.is_some() {
                continue;
            }
            let mut tx = self.app.pool.begin().await?;
            let kind: String = sqlx::query_scalar("SELECT kind FROM rooms WHERE id=$1")
                .bind(&room)
                .fetch_one(&mut *tx)
                .await?;
            let mut members: Vec<(String, RoomRole, &Document)> = Vec::new();
            for sub in subscriptions
                .get(&rid)
                .map(Vec::as_slice)
                .unwrap_or_default()
            {
                let Some(uid) = sub.sub("u").and_then(|u| u.text("_id")) else {
                    continue;
                };
                let Some(user) = mapped(&mut *tx, "user", uid).await? else {
                    continue;
                };
                let role = if kind == "direct" {
                    RoomRole::Member
                } else {
                    map::role(&sub.strings("roles"))
                };
                if !members.iter().any(|(u, ..)| *u == user) {
                    members.push((user, role, sub));
                }
            }
            if members.is_empty() {
                omit(&mut *tx, "room", &rid, "no_members", "").await?;
            } else if kind != "direct" && !members.iter().any(|(_, r, _)| *r == RoomRole::Owner) {
                let creator = match creators.get(&rid) {
                    Some(uid) => mapped(&mut *tx, "user", uid).await?,
                    None => None,
                };
                let admins: Vec<String> =
                    sqlx::query_scalar("SELECT id FROM users WHERE admin AND id=ANY($1)")
                        .bind(members.iter().map(|(u, ..)| u.clone()).collect::<Vec<_>>())
                        .fetch_all(&mut *tx)
                        .await?;
                let pick = creator
                    .filter(|c| members.iter().any(|(u, ..)| u == c))
                    .or_else(|| admins.first().cloned())
                    .unwrap_or_else(|| members[0].0.clone());
                if let Some(member) = members.iter_mut().find(|(u, ..)| *u == pick) {
                    member.1 = RoomRole::Owner;
                }
                omit(&mut *tx, "room", &rid, "owner_assigned", &pick).await?;
            }
            for (user, role, sub) in &members {
                let role = match role {
                    RoomRole::Owner => "owner",
                    RoomRole::Moderator => "moderator",
                    RoomRole::Member => "member",
                };
                sqlx::query("INSERT INTO members(room_id,user_id,role) VALUES($1,$2,$3) ON CONFLICT DO NOTHING")
                    .bind(&room).bind(user).bind(role).execute(&mut *tx).await?;
                // Read up to the last message seen, unless nothing was left unread.
                let caught_up = sub.number("unread") == 0 && !sub.flag("alert");
                if !caught_up {
                    let seen: i64 = sqlx::query_scalar("SELECT COALESCE(MAX(position),0) FROM messages WHERE room_id=$1 AND created_at<=$2")
                        .bind(&room)
                        .bind(sub.time("ls").unwrap_or(DateTime::UNIX_EPOCH))
                        .fetch_one(&mut *tx)
                        .await?;
                    sqlx::query("UPDATE room_read_states SET root_position=$3,reply_position=$3 WHERE room_id=$1 AND user_id=$2")
                        .bind(&room).bind(user).bind(seen).execute(&mut *tx).await?;
                }
                if sub.flag("f") {
                    sqlx::query(
                        "UPDATE room_read_states SET favorite=true WHERE room_id=$1 AND user_id=$2",
                    )
                    .bind(&room)
                    .bind(user)
                    .execute(&mut *tx)
                    .await?;
                }
            }
            let messages: Vec<(String, String, String)> = sqlx::query_as(
                "SELECT id,author_id,text FROM messages WHERE room_id=$1 AND system IS NULL AND text<>''",
            )
            .bind(&room)
            .fetch_all(&mut *tx)
            .await?;
            for (id, author, text) in messages {
                crate::mentions::capture(&mut tx, &id, &room, &author, &text).await?;
            }
            remember(&mut tx, "members", &rid, &room).await?;
            tx.commit().await?;
        }
        Ok(())
    }

    /// Each room once, oldest activity first, so the room list sorts by
    /// recency; then the snapshots clients may hold start over.
    async fn publish(&mut self) -> Result<()> {
        let rooms: Vec<String> = sqlx::query_scalar(
            "SELECT r.id FROM rooms r JOIN import_ids i ON i.native_id=r.id AND i.kind='room' WHERE r.revision=0 ORDER BY (SELECT COALESCE(MAX(position),0) FROM messages m WHERE m.room_id=r.id), r.id",
        )
        .fetch_all(&self.app.pool)
        .await?;
        for room in rooms {
            let mut tx = self.app.pool.begin().await?;
            crate::room_details::publish(&mut tx, &room).await?;
            tx.commit().await?;
        }
        sqlx::query("DELETE FROM snapshot_heads")
            .execute(&self.app.pool)
            .await?;
        Ok(())
    }
}

/// What was imported, and every omission grouped by reason with examples.
async fn report(app: &App, origin: &str, version: Option<String>) -> Result<Value> {
    let counts: Vec<(String, i64)> =
        sqlx::query_as("SELECT kind,COUNT(*) FROM import_ids WHERE kind IN ('user','room','message','file','emoji') GROUP BY kind")
            .fetch_all(&app.pool)
            .await?;
    let imported: serde_json::Map<String, Value> =
        counts.into_iter().map(|(k, n)| (k, json!(n))).collect();
    let marks: (i64, i64, i64) = sqlx::query_as(
        "SELECT (SELECT COUNT(*) FROM message_reactions),(SELECT COUNT(*) FROM message_stars WHERE present),(SELECT COUNT(*) FROM messages WHERE pinned)",
    )
    .fetch_one(&app.pool)
    .await?;
    let omissions: Vec<(String, String, i64, Vec<String>)> = sqlx::query_as(
        "SELECT kind,reason,COUNT(*),(array_agg(CASE WHEN detail='' THEN source_id ELSE source_id||' ('||detail||')' END ORDER BY source_id))[1:5] FROM import_omissions GROUP BY kind,reason ORDER BY kind,reason",
    )
    .fetch_all(&app.pool)
    .await?;
    let state: (String, Option<DateTime<Utc>>) =
        sqlx::query_as("SELECT phase,finished_at FROM import_state")
            .fetch_one(&app.pool)
            .await?;
    let report = json!({
        "source": origin,
        "rocketchat_version": version,
        "phase": state.0,
        "finished_at": state.1,
        "imported": imported,
        "reactions": marks.0,
        "stars": marks.1,
        "pins": marks.2,
        "omissions": omissions.into_iter().map(|(kind, reason, count, examples)| json!({"kind": kind, "reason": reason, "count": count, "examples": examples})).collect::<Vec<_>>(),
    });
    sqlx::query("INSERT INTO import_reports(report) VALUES($1)")
        .bind(&report)
        .execute(&app.pool)
        .await?;
    Ok(report)
}
