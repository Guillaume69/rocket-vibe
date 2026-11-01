//! Rooms: channels, private groups, direct messages (a group DM becomes a
//! private room, Vibez's direct rooms having two people), discussions as
//! rooms of their own; their members, roles, favorites and read positions.

use std::collections::BTreeSet;

use mongodb::bson::{Document, doc};

use super::source::{flag, id, json, strings, sub, text, time};
use super::text::bounded;
use super::{Import, ImportResult, Person, mapped, remember};
use crate::auth::random_token;

struct Member {
    person: Person,
    role: &'static str,
    favorite: bool,
    read_until: Option<chrono::DateTime<chrono::Utc>>,
    room_key: Option<String>,
}

impl Import<'_> {
    pub(super) async fn rooms(&mut self) -> ImportResult<()> {
        let rooms = self
            .source
            .all("rocketchat_room", doc! {}, doc! {"ts": 1})
            .await?;
        let total = rooms.len();
        for (index, room) in rooms.into_iter().enumerate() {
            let Some(rc) = id(&room) else { continue };
            let Some(kind) = text(&room, "t").map(str::to_owned) else {
                continue;
            };
            if !matches!(kind.as_str(), "c" | "p" | "d") {
                self.report
                    .skip(format!("room of type `{kind}` (livechat and others)"));
                continue;
            }
            let members = self.members(&rc, &room, &kind).await?;
            let vibez = match mapped(self.app, "room", &rc).await? {
                Some(vibez) => {
                    self.report.again("rooms");
                    vibez
                }
                None => match self.create_room(&rc, &room, &kind, &members).await? {
                    Some(vibez) => vibez,
                    None => continue,
                },
            };
            let joined = self.join(&vibez, &members).await?;
            eprintln!(
                "rocketchat import: room {}/{total} {}",
                index + 1,
                text(&room, "fname").or(text(&room, "name")).unwrap_or(&rc)
            );
            let added = self.messages(&rc, &vibez).await?;
            self.settle(&vibez, &members, &joined, added).await?;
        }
        self.room_avatars().await
    }

    async fn members(
        &mut self,
        rc: &str,
        room: &Document,
        kind: &str,
    ) -> ImportResult<Vec<Member>> {
        let mut members = Vec::new();
        let mut seen = BTreeSet::new();
        for subscription in self
            .source
            .all("rocketchat_subscription", doc! {"rid": rc}, doc! {"ts": 1})
            .await?
        {
            let Some(user) = sub(&subscription, "u")
                .and_then(|u| text(u, "_id"))
                .map(str::to_owned)
            else {
                continue;
            };
            let Some(person) = self.people.get(&user).cloned() else {
                self.report.skip("membership of a person not imported");
                continue;
            };
            if !seen.insert(person.id.clone()) {
                continue;
            }
            let roles = strings(&subscription, "roles");
            members.push(Member {
                role: if roles.iter().any(|r| r == "owner") {
                    "owner"
                } else if roles.iter().any(|r| r == "moderator") {
                    "moderator"
                } else {
                    "member"
                },
                favorite: flag(&subscription, "f"),
                read_until: time(&subscription, "ls"),
                room_key: text(&subscription, "E2EKey").map(str::to_owned),
                person,
            });
        }
        // A direct room's people, even when a subscription is gone.
        if kind == "d" {
            for user in strings(room, "uids") {
                let Some(person) = self.people.get(&user).cloned() else {
                    continue;
                };
                if seen.insert(person.id.clone()) {
                    members.push(Member {
                        person,
                        role: "member",
                        favorite: false,
                        read_until: None,
                        room_key: None,
                    });
                }
            }
        }
        Ok(members)
    }

    async fn create_room(
        &mut self,
        rc: &str,
        room: &Document,
        kind: &str,
        members: &[Member],
    ) -> ImportResult<Option<String>> {
        let mut people: Vec<&Person> = members.iter().map(|m| &m.person).collect();
        people.sort_by(|a, b| a.id.cmp(&b.id));
        let (vibez_kind, name, pair) = match kind {
            "d" if people.len() == 2 => (
                "direct",
                format!("{} / {}", people[0].username, people[1].username),
                Some(format!("{}:{}", people[0].id, people[1].id)),
            ),
            "d" if people.is_empty() => {
                self.report.skip("direct room with nobody imported");
                return Ok(None);
            }
            "d" => {
                let mut names: Vec<&str> = people.iter().map(|p| p.username.as_str()).collect();
                names.sort();
                ("private", names.join(", "), None)
            }
            "p" => ("private", room_name(room, rc), None),
            _ => ("public", room_name(room, rc), None),
        };
        let mut tx = self.app.pool.begin().await?;
        if let Some(pair) = &pair {
            // The two already talk on Vibez: their history joins that room.
            let existing: Option<String> =
                sqlx::query_scalar("SELECT id FROM rooms WHERE direct_pair=$1")
                    .bind(pair)
                    .fetch_optional(&mut *tx)
                    .await?;
            if let Some(existing) = existing {
                remember(&mut tx, "room", rc, &existing).await?;
                tx.commit().await?;
                self.report.add("direct_rooms_joined_to_existing_ones");
                return Ok(Some(existing));
            }
        }
        let vibez = random_token()[..24].to_owned();
        sqlx::query("INSERT INTO rooms(id,name,kind,direct_pair,read_only,topic,description,announcement,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)")
            .bind(&vibez)
            .bind(bounded(name.trim(), 128))
            .bind(vibez_kind)
            .bind(&pair)
            .bind(flag(room, "ro"))
            .bind(bounded(text(room, "topic").unwrap_or_default(), 1024))
            .bind(bounded(text(room, "description").unwrap_or_default(), 4096))
            .bind(bounded(text(room, "announcement").unwrap_or_default(), 4096))
            .bind(time(room, "ts"))
            .execute(&mut *tx)
            .await?;
        if flag(room, "encrypted") || text(room, "e2eKeyId").is_some() {
            let keys =
                doc! {"e2eKeyId": text(room, "e2eKeyId"), "encrypted": flag(room, "encrypted")};
            sqlx::query("INSERT INTO rc_import_e2ee_keys(kind,room_id,payload) VALUES('room',$1,$2) ON CONFLICT DO NOTHING")
                .bind(&vibez)
                .bind(json(&keys))
                .execute(&mut *tx)
                .await?;
        }
        remember(&mut tx, "room", rc, &vibez).await?;
        tx.commit().await?;
        self.report.add(match vibez_kind {
            "direct" => "direct_rooms",
            _ if kind == "d" => "group_and_self_direct_rooms_as_private_rooms",
            _ if text(room, "prid").is_some() => "discussions",
            _ => "rooms",
        });
        Ok(Some(vibez))
    }

    /// The people added to the room on this pass.
    async fn join(&mut self, room: &str, members: &[Member]) -> ImportResult<BTreeSet<String>> {
        let mut joined = BTreeSet::new();
        let mut tx = self.app.pool.begin().await?;
        for member in members {
            let added = sqlx::query(
                "INSERT INTO members(room_id,user_id,role) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
            )
            .bind(room)
            .bind(&member.person.id)
            .bind(member.role)
            .execute(&mut *tx)
            .await?
            .rows_affected();
            if added > 0 {
                self.report.add("memberships");
                joined.insert(member.person.id.clone());
            }
            if let Some(key) = &member.room_key {
                sqlx::query("INSERT INTO rc_import_e2ee_keys(kind,room_id,user_id,payload) VALUES('member',$1,$2,$3) ON CONFLICT DO NOTHING")
                    .bind(room)
                    .bind(&member.person.id)
                    .bind(serde_json::json!({"E2EKey": key}))
                    .execute(&mut *tx)
                    .await?;
            }
        }
        tx.commit().await?;
        Ok(joined)
    }

    /// Read positions and favorites from Rocket.Chat for the people who just
    /// joined (a later pass leaves what they did on Vibez alone), then the room
    /// published once so connected clients list it.
    async fn settle(
        &mut self,
        room: &str,
        members: &[Member],
        joined: &BTreeSet<String>,
        added: u64,
    ) -> ImportResult<()> {
        let mut tx = self.app.pool.begin().await?;
        for member in members.iter().filter(|m| joined.contains(&m.person.id)) {
            sqlx::query("UPDATE room_read_states SET root_position=p.at,reply_position=p.at,favorite=favorite OR $4 FROM (SELECT COALESCE((SELECT max(position) FROM messages WHERE room_id=$1 AND created_at<=$3),0) AS at) p WHERE room_id=$1 AND user_id=$2")
                .bind(room)
                .bind(&member.person.id)
                .bind(member.read_until)
                .bind(member.favorite)
                .execute(&mut *tx)
                .await?;
        }
        if added > 0 || !joined.is_empty() {
            let position = crate::store::next_position(&mut tx)
                .await
                .map_err(|e| e.code)?;
            let row: crate::store::RoomRow = sqlx::query_as("UPDATE rooms SET revision=$2 WHERE id=$1 RETURNING id,name,kind,revision,EXISTS(SELECT 1 FROM e2ee_groups g WHERE g.room_id=rooms.id) AS encrypted,voice")
                .bind(room)
                .bind(position)
                .fetch_one(&mut *tx)
                .await?;
            crate::store::event(
                &mut tx,
                position,
                room,
                None,
                rv_protocol::Change::RoomUpsert(row.wire()),
            )
            .await
            .map_err(|e| e.code)?;
            sqlx::query("DELETE FROM snapshot_heads WHERE user_id IN (SELECT user_id FROM members WHERE room_id=$1) OR $1=ANY(room_ids)")
                .bind(room)
                .execute(&mut *tx)
                .await?;
        }
        tx.commit().await?;
        Ok(())
    }
}

fn room_name(room: &Document, rc: &str) -> String {
    text(room, "fname")
        .or(text(room, "name"))
        .filter(|n| !n.trim().is_empty())
        .unwrap_or(rc)
        .to_owned()
}
