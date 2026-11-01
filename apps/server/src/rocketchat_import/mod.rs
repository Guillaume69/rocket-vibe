//! `vibez import rocketchat`: a Rocket.Chat server's people, rooms, messages,
//! custom emoji, files and avatars, read from its MongoDB and written into
//! this instance. Every imported document is recorded in `rc_import_ids` (or
//! keeps a stable id), so a second pass skips it and a stopped one resumes.

mod assets;
mod messages;
mod rooms;
pub mod source;
pub mod text;
mod users;

use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;

use mongodb::bson::doc;
use serde::Serialize;
use sqlx::{Postgres, Transaction};

use crate::App;
use source::Source;

pub type ImportResult<T> = Result<T, Box<dyn std::error::Error + Send + Sync>>;

pub struct Options {
    pub mongo_url: String,
    pub database: String,
    pub uploads_dir: Option<PathBuf>,
    pub dry_run: bool,
}

#[derive(Default, Serialize)]
pub struct Report {
    pub dry_run: bool,
    /// What was created on this pass.
    pub imported: BTreeMap<&'static str, u64>,
    /// Already imported by an earlier pass.
    pub already: BTreeMap<&'static str, u64>,
    /// Left out, by reason.
    pub skipped: BTreeMap<String, u64>,
    /// In the Rocket.Chat database (dry run).
    pub found: BTreeMap<&'static str, u64>,
    /// Rocket.Chat usernames Vibez does not allow, and what they became.
    pub renamed: BTreeMap<String, String>,
}

impl Report {
    fn add(&mut self, what: &'static str) {
        *self.imported.entry(what).or_default() += 1;
    }
    fn again(&mut self, what: &'static str) {
        *self.already.entry(what).or_default() += 1;
    }
    fn skip(&mut self, why: impl Into<String>) {
        *self.skipped.entry(why.into()).or_default() += 1;
    }
}

/// One person as this import knows them.
#[derive(Clone)]
struct Person {
    id: String,
    username: String,
}

pub(crate) struct Import<'a> {
    app: &'a App,
    source: Source,
    report: Report,
    /// Rocket.Chat user id → Vibez account.
    people: HashMap<String, Person>,
    /// Rocket.Chat username → Rocket.Chat user id.
    usernames: HashMap<String, String>,
    /// Rocket.Chat username → Vibez username, where they differ.
    renamed: HashMap<String, String>,
    /// Rocket.Chat custom emoji code (name or alias) → Vibez emoji name.
    emoji: HashMap<String, String>,
    data_epoch: String,
}

pub async fn run(app: &App, options: Options) -> ImportResult<Report> {
    let source =
        Source::connect(&options.mongo_url, &options.database, options.uploads_dir).await?;
    if options.dry_run {
        return survey(app, &source).await;
    }
    let data_epoch = sqlx::query_scalar("SELECT data_epoch FROM instance WHERE singleton")
        .fetch_one(&app.pool)
        .await?;
    let mut import = Import {
        app,
        source,
        report: Report::default(),
        people: HashMap::new(),
        usernames: HashMap::new(),
        renamed: HashMap::new(),
        emoji: HashMap::new(),
        data_epoch,
    };
    progress("people");
    import.users().await?;
    progress("custom emoji");
    import.emojis().await?;
    progress("avatars");
    import.avatars().await?;
    progress("rooms");
    import.rooms().await?;
    progress("done");
    import.report.renamed = import.renamed.clone().into_iter().collect();
    Ok(import.report)
}

/// Counts only: nothing is written (the database is still migrated, as by
/// every subcommand).
async fn survey(app: &App, source: &Source) -> ImportResult<Report> {
    let mut report = Report {
        dry_run: true,
        ..Report::default()
    };
    let shown = doc! {"_hidden": {"$ne": true}};
    report
        .found
        .insert("users", source.count("users", doc! {}).await?);
    report
        .found
        .insert("rooms", source.count("rocketchat_room", doc! {}).await?);
    report.found.insert(
        "memberships",
        source.count("rocketchat_subscription", doc! {}).await?,
    );
    report.found.insert(
        "messages",
        source.count("rocketchat_message", shown.clone()).await?,
    );
    report.found.insert(
        "user_messages",
        source
            .count(
                "rocketchat_message",
                doc! {"_hidden": {"$ne": true}, "t": {"$exists": false}},
            )
            .await?,
    );
    report.found.insert(
        "encrypted_messages",
        source
            .count(
                "rocketchat_message",
                doc! {"_hidden": {"$ne": true}, "t": "e2e"},
            )
            .await?,
    );
    report.found.insert(
        "files",
        source
            .count("rocketchat_uploads", doc! {"complete": true})
            .await?,
    );
    report.found.insert(
        "custom_emoji",
        source.count("rocketchat_custom_emoji", doc! {}).await?,
    );
    report.found.insert(
        "avatars",
        source.count("rocketchat_avatars", doc! {}).await?,
    );
    let done: Vec<(String, i64)> =
        sqlx::query_as("SELECT kind,count(*) FROM rc_import_ids GROUP BY kind")
            .fetch_all(&app.pool)
            .await?;
    for (kind, count) in done {
        let kind: &'static str = match kind.as_str() {
            "user" => "users",
            "room" => "rooms",
            "emoji" => "custom_emoji",
            "avatar" => "avatars",
            _ => "room_avatars",
        };
        report.already.insert(kind, count as u64);
    }
    let messages: i64 = sqlx::query_scalar("SELECT count(*) FROM messages WHERE id LIKE 'rc-%'")
        .fetch_one(&app.pool)
        .await?;
    report.already.insert("messages", messages as u64);
    Ok(report)
}

fn progress(step: &str) {
    eprintln!("rocketchat import: {step}");
}

impl Import<'_> {
    fn objects(&self) -> ImportResult<&crate::objects::LocalObjects> {
        self.app
            .objects
            .as_ref()
            .ok_or_else(|| "the objects directory (VIBEZ_OBJECTS_DIR) is required".into())
    }
}

pub(crate) async fn mapped(app: &App, kind: &str, rc: &str) -> ImportResult<Option<String>> {
    Ok(
        sqlx::query_scalar("SELECT vibez_id FROM rc_import_ids WHERE kind=$1 AND rc_id=$2")
            .bind(kind)
            .bind(rc)
            .fetch_optional(&app.pool)
            .await?,
    )
}

pub(crate) async fn remember(
    tx: &mut Transaction<'_, Postgres>,
    kind: &str,
    rc: &str,
    vibez: &str,
) -> ImportResult<()> {
    sqlx::query(
        "INSERT INTO rc_import_ids(kind,rc_id,vibez_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
    )
    .bind(kind)
    .bind(rc)
    .bind(vibez)
    .execute(&mut **tx)
    .await?;
    Ok(())
}
