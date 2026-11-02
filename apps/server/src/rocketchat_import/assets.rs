//! Custom emoji and the avatars of people and rooms.

use mongodb::bson::doc;

use super::source::{id, number, strings, text};
use super::text::emoji_name;
use super::{Import, ImportResult, mapped, remember};

impl Import<'_> {
    pub(super) async fn emojis(&mut self) -> ImportResult<()> {
        for emoji in self
            .source
            .all("rocketchat_custom_emoji", doc! {}, doc! {"name": 1})
            .await?
        {
            let (Some(rc), Some(rc_name)) = (id(&emoji), text(&emoji, "name").map(str::to_owned))
            else {
                continue;
            };
            let rc_aliases = strings(&emoji, "aliases");
            let Some(name) = emoji_name(&rc_name) else {
                continue;
            };
            let known = match mapped(self.app, "emoji", &rc).await? {
                Some(_) => {
                    self.report.again("custom_emoji");
                    true
                }
                None => {
                    self.emoji(&rc, &rc_name, &name, &rc_aliases, text(&emoji, "extension"))
                        .await?
                }
            };
            if known {
                for code in std::iter::once(&rc_name).chain(&rc_aliases) {
                    self.emoji.insert(code.clone(), name.clone());
                }
            }
        }
        Ok(())
    }

    /// Creates one emoji; false when it could not come over.
    async fn emoji(
        &mut self,
        rc: &str,
        rc_name: &str,
        name: &str,
        rc_aliases: &[String],
        extension: Option<&str>,
    ) -> ImportResult<bool> {
        let existing: Option<String> =
            sqlx::query_scalar("SELECT id FROM custom_emojis WHERE name=$1")
                .bind(name)
                .fetch_optional(&self.app.pool)
                .await?;
        if rv_protocol::emojis::canonical(name).is_some() {
            // Vibez reserves standard codes: reactions with it get the standard glyph.
            self.report
                .skip("custom emoji named like a standard one (the standard one is used)");
            return Ok(false);
        }
        if let Some(existing) = existing {
            // An emoji of that name was made on Vibez first: reactions use it.
            let mut tx = self.app.pool.begin().await?;
            remember(&mut tx, "emoji", rc, &existing).await?;
            tx.commit().await?;
            self.report
                .skip("custom emoji whose name Vibez already has (the Vibez one is used)");
            return Ok(true);
        }
        let Some(bytes) = self
            .source
            .emoji(rc_name, extension.unwrap_or("png"))
            .await?
        else {
            self.report.skip("custom emoji image not found");
            return Ok(false);
        };
        let mut aliases: Vec<String> = rc_aliases
            .iter()
            .filter_map(|a| emoji_name(a))
            .filter(|a| a != name && rv_protocol::emojis::canonical(a).is_none())
            .collect();
        aliases.sort();
        aliases.dedup();
        aliases.truncate(8);
        let operation = format!("rc-emoji-{}", &crate::auth::hash_token(rc)[..32]);
        match crate::custom_emojis::put(self.app, &operation, name, aliases, None, bytes).await {
            Ok(_) => {}
            Err(error) => {
                self.report
                    .skip(format!("custom emoji refused ({})", error.code));
                return Ok(false);
            }
        }
        let vibez: String = sqlx::query_scalar("SELECT id FROM custom_emojis WHERE name=$1")
            .bind(name)
            .fetch_one(&self.app.pool)
            .await?;
        let mut tx = self.app.pool.begin().await?;
        remember(&mut tx, "emoji", rc, &vibez).await?;
        tx.commit().await?;
        self.report.add("custom_emoji");
        Ok(true)
    }

    /// People's avatars, before the rooms; a room's come after it exists.
    pub(super) async fn avatars(&mut self) -> ImportResult<()> {
        for avatar in self
            .source
            .all(
                "rocketchat_avatars",
                doc! {"userId": {"$exists": true}},
                doc! {"_id": 1},
            )
            .await?
        {
            let (Some(rc), Some(owner)) = (id(&avatar), text(&avatar, "userId")) else {
                continue;
            };
            let Some(person) = self.people.get(owner).cloned() else {
                continue;
            };
            if mapped(self.app, "avatar", &rc).await?.is_some() {
                self.report.again("avatars");
                continue;
            }
            let Some(object) = self.avatar_object(&rc, &avatar).await? else {
                continue;
            };
            let mut tx = self.app.pool.begin().await?;
            sqlx::query(
                "UPDATE users SET avatar_file_id=$2 WHERE id=$1 AND avatar_file_id IS NULL",
            )
            .bind(&person.id)
            .bind(&object)
            .execute(&mut *tx)
            .await?;
            remember(&mut tx, "avatar", &rc, &object).await?;
            tx.commit().await?;
            self.report.add("avatars");
        }
        Ok(())
    }

    pub(super) async fn room_avatars(&mut self) -> ImportResult<()> {
        for avatar in self
            .source
            .all(
                "rocketchat_avatars",
                doc! {"rid": {"$exists": true}},
                doc! {"_id": 1},
            )
            .await?
        {
            let (Some(rc), Some(rid)) = (id(&avatar), text(&avatar, "rid")) else {
                continue;
            };
            let Some(room) = mapped(self.app, "room", rid).await? else {
                continue;
            };
            if mapped(self.app, "room_avatar", &rc).await?.is_some() {
                self.report.again("room_avatars");
                continue;
            }
            let Some(object) = self.avatar_object(&rc, &avatar).await? else {
                continue;
            };
            let mut tx = self.app.pool.begin().await?;
            sqlx::query(
                "UPDATE rooms SET avatar_object_id=$2 WHERE id=$1 AND avatar_object_id IS NULL",
            )
            .bind(&room)
            .bind(&object)
            .execute(&mut *tx)
            .await?;
            remember(&mut tx, "room_avatar", &rc, &object).await?;
            tx.commit().await?;
            self.report.add("room_avatars");
        }
        Ok(())
    }

    /// The avatar re-encoded the way Vibez stores its own (PNG, at most
    /// 512 pixels), as an object.
    async fn avatar_object(
        &mut self,
        rc: &str,
        avatar: &mongodb::bson::Document,
    ) -> ImportResult<Option<String>> {
        let store = text(avatar, "store").unwrap_or("GridFS:Avatars");
        let size = number(avatar, "size").unwrap_or(0);
        let Some(bytes) = self
            .source
            .file(store, rc, "rocketchat_avatars", size)
            .await?
        else {
            self.report
                .skip("avatar not readable (missing, or stored outside GridFS and FileSystem)");
            return Ok(None);
        };
        let mime = text(avatar, "type").unwrap_or("image/png").to_owned();
        let encoded = match tokio::task::spawn_blocking(move || {
            crate::profiles::decode_avatar(&mime, &bytes)
        })
        .await?
        {
            Ok(encoded) => encoded,
            Err(_) => {
                self.report
                    .skip("avatar in a format Vibez does not take (only PNG and JPEG)");
                return Ok(None);
            }
        };
        Ok(Some(
            self.objects()?.put(encoded).await.map_err(|e| e.code)?,
        ))
    }
}
