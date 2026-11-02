//! Messages, oldest first so positions follow Rocket.Chat's order: text,
//! edits, threads, quotes, reactions, pins, stars, mentions and files.
//! Encrypted ones keep their ciphertext under a placeholder.

use std::collections::HashSet;

use futures_util::TryStreamExt;
use mongodb::bson::{Bson, Document, doc};
use sqlx::types::Json;

use super::source::{flag, id, json, list, number, strings, sub, text, time};
use super::text::{
    bounded, linked_message, message_id, quoted_text, reaction, renamed_mentions,
    without_quote_links,
};
use super::{Import, ImportResult, Person};
use crate::auth::random_token;
use rv_protocol::parity::{FileDescriptor, QuoteReference};

const BATCH: usize = 200;
const MAX_TEXT: usize = 32_768;

/// Shown in place of an encrypted Rocket.Chat message, in the room's text,
/// until the decryption the archive tables allow is written.
pub const ENCRYPTED_PLACEHOLDER: &str = "🔒 *Encrypted message from Rocket.Chat, not readable yet* · *Message chiffré venu de Rocket.Chat, pas encore lisible*";

struct File {
    upload: String,
    object: String,
    bytes: i64,
    sha256: String,
    media_type: String,
    filename: String,
    rc: String,
}

struct Plan {
    id: String,
    doc: Document,
    author: Person,
    encrypted: bool,
    files: Vec<File>,
}

impl Import<'_> {
    /// Imports the room's messages not imported yet; answers how many.
    pub(super) async fn messages(&mut self, rc_room: &str, room: &str) -> ImportResult<u64> {
        let mut cursor = self
            .source
            .stream(
                "rocketchat_message",
                doc! {"rid": rc_room, "_hidden": {"$ne": true}},
                doc! {"ts": 1, "_id": 1},
            )
            .await?;
        let mut added = 0;
        let mut batch = Vec::with_capacity(BATCH);
        while let Some(doc) = cursor.try_next().await? {
            batch.push(doc);
            if batch.len() == BATCH {
                added += self.batch(room, std::mem::take(&mut batch)).await?;
            }
        }
        if !batch.is_empty() {
            added += self.batch(room, batch).await?;
        }
        Ok(added)
    }

    async fn batch(&mut self, room: &str, docs: Vec<Document>) -> ImportResult<u64> {
        let ids: Vec<String> = docs
            .iter()
            .filter_map(id)
            .map(|rc| message_id(&rc))
            .collect();
        let existing: HashSet<String> =
            sqlx::query_scalar("SELECT id FROM messages WHERE id=ANY($1)")
                .bind(&ids)
                .fetch_all(&self.app.pool)
                .await?
                .into_iter()
                .collect();
        let mut plans = Vec::new();
        for doc in docs {
            let Some(rc) = id(&doc) else { continue };
            let vibez = message_id(&rc);
            if existing.contains(&vibez) {
                self.report.again("messages");
                continue;
            }
            let encrypted = match text(&doc, "t") {
                None => false,
                Some("e2e") => true,
                Some(kind) => {
                    self.report.skip(format!("system message `{kind}`"));
                    continue;
                }
            };
            let Some(author) = sub(&doc, "u")
                .and_then(|u| text(u, "_id"))
                .map(str::to_owned)
            else {
                self.report.skip("message without an author");
                continue;
            };
            let shown = sub(&doc, "u")
                .and_then(|u| text(u, "name").or(text(u, "username")))
                .map(str::to_owned);
            let author = self.author(&author, shown.as_deref()).await?;
            let files = self.files(&doc).await?;
            plans.push(Plan {
                id: vibez,
                doc,
                author,
                encrypted,
                files,
            });
        }
        if plans.is_empty() {
            return Ok(0);
        }
        let mut tx = self.app.pool.begin().await?;
        let last: i64 = sqlx::query_scalar(
            "UPDATE instance SET position=position+$1 WHERE singleton RETURNING position",
        )
        .bind(plans.len() as i64)
        .fetch_one(&mut *tx)
        .await?;
        let mut position = last - plans.len() as i64;
        let mut added = 0;
        for plan in plans {
            position += 1;
            if self.insert(&mut tx, room, position, plan).await? {
                added += 1;
            }
        }
        tx.commit().await?;
        Ok(added)
    }

    /// The message's files, read and stored as objects before the batch's
    /// transaction (thumbnails Rocket.Chat derived are left out).
    async fn files(&mut self, doc: &Document) -> ImportResult<Vec<File>> {
        let mut described: Vec<&Document> = list(doc, "files")
            .iter()
            .filter_map(Bson::as_document)
            .collect();
        if described.is_empty() {
            described.extend(sub(doc, "file"));
        }
        let mut files = Vec::new();
        for file in described {
            if text(file, "typeGroup") == Some("thumb") {
                continue;
            }
            let Some(rc) = id(file) else { continue };
            let upload = self
                .source
                .all("rocketchat_uploads", doc! {"_id": &rc}, doc! {})
                .await?
                .into_iter()
                .next();
            let store = upload
                .as_ref()
                .and_then(|u| text(u, "store"))
                .unwrap_or("GridFS:Uploads")
                .to_owned();
            let size = upload
                .as_ref()
                .and_then(|u| number(u, "size"))
                .or(number(file, "size"))
                .unwrap_or(0);
            let Some(bytes) = self
                .source
                .file(&store, &rc, "rocketchat_uploads", size)
                .await?
            else {
                self.report.skip(if size > super::source::MAX_FILE {
                    "file over 100 MiB"
                } else {
                    "file not readable (missing, or stored outside GridFS and FileSystem)"
                });
                continue;
            };
            let sha256 = crate::auth::hash_token_bytes(&bytes);
            let length = bytes.len() as i64;
            let object = self.objects()?.put(bytes).await.map_err(|e| e.code)?;
            files.push(File {
                upload: random_token()[..24].to_owned(),
                object,
                bytes: length,
                sha256,
                media_type: text(file, "type")
                    .or(upload.as_ref().and_then(|u| text(u, "type")))
                    .filter(|t| !t.is_empty())
                    .unwrap_or("application/octet-stream")
                    .to_owned(),
                filename: bounded(text(file, "name").unwrap_or("file"), 255),
                rc,
            });
        }
        Ok(files)
    }

    /// One message inside the batch; false when it had nothing to show.
    async fn insert(
        &mut self,
        tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
        room: &str,
        position: i64,
        plan: Plan,
    ) -> ImportResult<bool> {
        let doc = &plan.doc;
        let mut quotes = Vec::new();
        let mut body = String::new();
        let raw = if plan.encrypted {
            ENCRYPTED_PLACEHOLDER.to_owned()
        } else {
            renamed_mentions(
                without_quote_links(text(doc, "msg").unwrap_or_default()),
                &self.renamed,
            )
        };
        if !plan.encrypted {
            for attachment in list(doc, "attachments")
                .iter()
                .filter_map(Bson::as_document)
            {
                if let Some(target) = text(attachment, "message_link").and_then(linked_message) {
                    let found: Option<(String, i64)> = sqlx::query_as(
                        "SELECT room_id,revision FROM messages WHERE id=$1 AND NOT deleted",
                    )
                    .bind(message_id(target))
                    .fetch_optional(&mut **tx)
                    .await?;
                    match found {
                        Some((quoted_room, revision)) if quotes.len() < 8 => {
                            quotes.push(QuoteReference {
                                room_id: quoted_room,
                                message_id: message_id(target),
                                revision: revision.to_string(),
                            })
                        }
                        _ => body.push_str(&quoted_text(
                            text(attachment, "author_name"),
                            text(attachment, "text").unwrap_or_default(),
                        )),
                    }
                    continue;
                }
                if text(attachment, "type") == Some("file")
                    || attachment.contains_key("image_url")
                        && plan
                            .files
                            .iter()
                            .any(|f| Some(f.rc.as_str()) == text(attachment, "fileId"))
                {
                    continue;
                }
                let title = text(attachment, "title").filter(|t| !t.is_empty());
                let content = text(attachment, "text").filter(|t| !t.is_empty());
                if title.is_some() || content.is_some() {
                    if !body.is_empty() && !body.ends_with('\n') {
                        body.push('\n');
                    }
                    if let Some(title) = title {
                        body.push_str(&format!("**{title}**\n"));
                    }
                    if let Some(content) = content {
                        body.push_str(content);
                        body.push('\n');
                    }
                }
            }
        }
        if !body.is_empty() && !raw.is_empty() {
            body.push('\n');
        }
        body.push_str(&raw);
        let body = bounded(body.trim_end(), MAX_TEXT);
        let shown_files: Vec<&File> = if plan.encrypted {
            Vec::new()
        } else {
            plan.files.iter().collect()
        };
        if body.trim().is_empty() && quotes.is_empty() && shown_files.is_empty() {
            self.report.skip("empty message");
            return Ok(false);
        }
        let root = match text(doc, "tmid") {
            None => None,
            Some(root) => {
                let root = message_id(root);
                let present: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM messages WHERE id=$1 AND room_id=$2 AND system IS NULL)")
                    .bind(&root)
                    .bind(room)
                    .fetch_one(&mut **tx)
                    .await?;
                if present {
                    Some(root)
                } else {
                    self.report
                        .skip("thread reply whose root did not come over (kept in the room)");
                    None
                }
            }
        };
        let descriptors: Vec<FileDescriptor> = shown_files
            .iter()
            .map(|f| FileDescriptor {
                id: f.upload.clone(),
                room_id: room.to_owned(),
                bytes: f.bytes.to_string(),
                sha256: f.sha256.clone(),
                media_type: f.media_type.clone(),
                filename: Some(f.filename.clone()),
                encrypted: false,
            })
            .collect();
        let created = time(doc, "ts").unwrap_or_else(chrono::Utc::now);
        sqlx::query("INSERT INTO messages(id,room_id,author_id,operation_id,text,created_at,position,revision,edited_at,pinned,quote_references,reply_to,files,also_in_room) VALUES($1,$2,$3,$1,$4,$5,$6,$6,$7,$8,$9,$10,$11,$12)")
            .bind(&plan.id)
            .bind(room)
            .bind(&plan.author.id)
            .bind(&body)
            .bind(created)
            .bind(position)
            .bind(time(doc, "editedAt"))
            .bind(flag(doc, "pinned"))
            .bind(Json(&quotes))
            .bind(&root)
            .bind(Json(&descriptors))
            .bind(root.is_some() && flag(doc, "tshow"))
            .execute(&mut **tx)
            .await?;
        for file in shown_files {
            sqlx::query("INSERT INTO uploads(id,user_id,operation_id,fingerprint,room_id,membership_version,data_epoch,bytes,sha256,media_type,filename,state,object_id,message_id,complete_fingerprint,created_at,expires_at) VALUES($1,$2,$1,'rocketchat-import',$3,'rocketchat-import',$4,$5,$6,$7,$8,'completed',$9,$10,'rocketchat-import',$11,$11)")
                .bind(&file.upload)
                .bind(&plan.author.id)
                .bind(room)
                .bind(&self.data_epoch)
                .bind(file.bytes)
                .bind(&file.sha256)
                .bind(&file.media_type)
                .bind(&file.filename)
                .bind(&file.object)
                .bind(&plan.id)
                .bind(created)
                .execute(&mut **tx)
                .await?;
            self.report.add("files");
        }
        if plan.encrypted {
            sqlx::query("INSERT INTO rc_import_encrypted_messages(message_id,room_id,payload) VALUES($1,$2,$3)")
                .bind(&plan.id)
                .bind(room)
                .bind(json(doc))
                .execute(&mut **tx)
                .await?;
            for file in &plan.files {
                sqlx::query("INSERT INTO rc_import_encrypted_files(object_id,message_id,rc_file_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING")
                    .bind(&file.object)
                    .bind(&plan.id)
                    .bind(&file.rc)
                    .execute(&mut **tx)
                    .await?;
                self.report.add("encrypted_files_archived");
            }
            self.report.add("encrypted_messages_archived");
        } else {
            self.mentions(tx, &plan.id, room, &plan.author.id, &body)
                .await?;
            self.report.add("messages");
        }
        self.reactions(tx, &plan.id, doc).await?;
        for star in list(doc, "starred").iter().filter_map(Bson::as_document) {
            let Some(person) = text(star, "_id").and_then(|u| self.people.get(u)) else {
                continue;
            };
            sqlx::query("INSERT INTO message_stars(message_id,user_id,present,revision) VALUES($1,$2,true,$3) ON CONFLICT DO NOTHING")
                .bind(&plan.id)
                .bind(&person.id)
                .bind(position)
                .execute(&mut **tx)
                .await?;
        }
        // Rocket.Chat's `replies` are a thread's followers.
        for follower in strings(doc, "replies") {
            let Some(person) = self.people.get(&follower) else {
                continue;
            };
            sqlx::query("INSERT INTO thread_follows(root_id,room_id,user_id,present,revision) SELECT $1,$2,$3,true,$4 WHERE EXISTS(SELECT 1 FROM members WHERE room_id=$2 AND user_id=$3) ON CONFLICT DO NOTHING")
                .bind(&plan.id)
                .bind(room)
                .bind(&person.id)
                .bind(position)
                .execute(&mut **tx)
                .await?;
        }
        if root.is_some() {
            self.report.add("thread_replies");
        }
        Ok(true)
    }

    async fn reactions(
        &mut self,
        tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
        message: &str,
        doc: &Document,
    ) -> ImportResult<()> {
        let Some(reactions) = sub(doc, "reactions") else {
            return Ok(());
        };
        for (code, who) in reactions {
            let Some(emoji) = reaction(code, &self.emoji) else {
                self.report
                    .skip("reaction with an emoji Vibez does not know");
                continue;
            };
            let Some(who) = who.as_document() else {
                continue;
            };
            for username in strings(who, "usernames") {
                let Some(person) = self
                    .usernames
                    .get(&username)
                    .and_then(|rc| self.people.get(rc))
                else {
                    continue;
                };
                sqlx::query("INSERT INTO message_reactions(message_id,user_id,emoji) VALUES($1,$2,$3) ON CONFLICT DO NOTHING")
                    .bind(message)
                    .bind(&person.id)
                    .bind(&emoji)
                    .execute(&mut **tx)
                    .await?;
                self.report.add("reactions");
            }
        }
        Ok(())
    }

    /// Direct and `@all` mentions, as a send records them; `@here` is left
    /// out, since it names whoever is online at the time of sending.
    async fn mentions(
        &self,
        tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
        message: &str,
        room: &str,
        author: &str,
        text: &str,
    ) -> ImportResult<()> {
        let mut names = rv_protocol::markdown::mention_names(text);
        let all = names.remove("all");
        names.remove("here");
        sqlx::query("INSERT INTO message_mentions(message_id,user_id,kind,token) SELECT $1,u.id,'direct',u.username FROM users u JOIN members m ON m.user_id=u.id WHERE m.room_id=$2 AND u.id<>$3 AND NOT u.disabled AND u.username=ANY($4) ON CONFLICT DO NOTHING")
            .bind(message)
            .bind(room)
            .bind(author)
            .bind(names.into_iter().collect::<Vec<_>>())
            .execute(&mut **tx)
            .await?;
        if all {
            sqlx::query("INSERT INTO message_mentions(message_id,user_id,kind,token) SELECT $1,u.id,'all','all' FROM users u JOIN members m ON m.user_id=u.id WHERE m.room_id=$2 AND u.id<>$3 AND NOT u.disabled ON CONFLICT DO NOTHING")
                .bind(message)
                .bind(room)
                .bind(author)
                .execute(&mut **tx)
                .await?;
        }
        Ok(())
    }
}
