//! People: accounts with their password hash, verified address, profile text
//! and Rocket.Chat encryption keys; a tombstone for an author who no longer
//! exists.

use mongodb::bson::{Document, doc};

use super::source::{flag, id, json, strings, sub, text, time};
use super::text::{bounded, username};
use super::{Import, ImportResult, Person, mapped, remember};
use crate::auth::{ROCKETCHAT_BCRYPT, random_token};

/// No password: an account brought over without one (LDAP, OAuth, a bot)
/// signs in only after an invitation or a recovery code sets it.
const NO_PASSWORD: &str = "!";

impl Import<'_> {
    pub(super) async fn users(&mut self) -> ImportResult<()> {
        for user in self
            .source
            .all("users", doc! {}, doc! {"createdAt": 1})
            .await?
        {
            let Some(rc) = id(&user) else { continue };
            let Some(rc_name) = text(&user, "username").map(str::to_owned) else {
                self.report.skip("user without a username");
                continue;
            };
            let person = match mapped(self.app, "user", &rc).await? {
                Some(vibez) => {
                    self.report.again("users");
                    let name: String = sqlx::query_scalar("SELECT username FROM users WHERE id=$1")
                        .bind(&vibez)
                        .fetch_one(&self.app.pool)
                        .await?;
                    Person {
                        id: vibez,
                        username: name,
                    }
                }
                None => self.create(&rc, &rc_name, &user).await?,
            };
            if person.username != rc_name {
                self.renamed
                    .insert(rc_name.clone(), person.username.clone());
            }
            self.usernames.insert(rc_name, rc.clone());
            self.people.insert(rc, person);
        }
        Ok(())
    }

    async fn create(&mut self, rc: &str, rc_name: &str, user: &Document) -> ImportResult<Person> {
        let wanted = username(rc_name);
        let mut tx = self.app.pool.begin().await?;
        // Someone who made their Vibez account under the same name before the
        // import keeps it, password included: the Rocket.Chat account joins it.
        let existing: Option<String> = sqlx::query_scalar(
            "SELECT u.id FROM users u WHERE u.username=$1 AND NOT u.deleted AND NOT EXISTS(SELECT 1 FROM rc_import_ids i WHERE i.kind='user' AND i.vibez_id=u.id)",
        )
        .bind(&wanted)
        .fetch_optional(&mut *tx)
        .await?;
        if let Some(vibez) = existing {
            remember(&mut tx, "user", rc, &vibez).await?;
            self.keys(&mut tx, &vibez, user).await?;
            tx.commit().await?;
            self.report.add("users_joined_to_existing_accounts");
            return Ok(Person {
                id: vibez,
                username: wanted,
            });
        }
        let mut name = wanted.clone();
        for attempt in 1.. {
            // A deleted account's name is retired for good (a trigger refuses it).
            let taken: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM users WHERE username=$1) OR EXISTS(SELECT 1 FROM retired_usernames WHERE username=lower($1))")
                .bind(&name)
                .fetch_one(&mut *tx)
                .await?;
            if !taken {
                break;
            }
            name = if attempt == 1 {
                format!("{wanted}_rc")
            } else {
                format!("{wanted}_rc{attempt}")
            };
        }
        let vibez = random_token()[..24].to_owned();
        let password = sub(user, "services")
            .and_then(|s| sub(s, "password"))
            .and_then(|p| text(p, "bcrypt"))
            .map(|hash| format!("{ROCKETCHAT_BCRYPT}{hash}"))
            .unwrap_or_else(|| NO_PASSWORD.to_owned());
        let roles = strings(user, "roles");
        let bot = text(user, "type") == Some("bot") || roles.iter().any(|r| r == "bot");
        let display = text(user, "name")
            .filter(|n| !n.trim().is_empty())
            .unwrap_or(rc_name);
        sqlx::query("INSERT INTO users(id,username,display_name,password_hash,admin,disabled,bot,created_at,bio,status_text) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)")
            .bind(&vibez)
            .bind(&name)
            .bind(bounded(display, 128))
            .bind(&password)
            .bind(roles.iter().any(|r| r == "admin"))
            .bind(user.get("active").is_some() && !flag(user, "active"))
            .bind(bot)
            .bind(time(user, "createdAt"))
            .bind(bounded(text(user, "bio").unwrap_or_default(), 4096))
            .bind(bounded(text(user, "statusText").unwrap_or_default(), 512))
            .execute(&mut *tx)
            .await?;
        let verified = super::source::list(user, "emails")
            .iter()
            .filter_map(|e| e.as_document())
            .find(|e| flag(e, "verified"))
            .and_then(|e| text(e, "address"))
            .and_then(|a| crate::mail::normalized_address(a).ok());
        if let Some(address) = verified {
            let added = sqlx::query("INSERT INTO account_emails(user_id,address,verified_at) VALUES($1,$2,clock_timestamp()) ON CONFLICT DO NOTHING")
                .bind(&vibez)
                .bind(&address)
                .execute(&mut *tx)
                .await?
                .rows_affected();
            if added == 0 {
                self.report
                    .skip("verified address already used by another account");
            }
        }
        remember(&mut tx, "user", rc, &vibez).await?;
        self.keys(&mut tx, &vibez, user).await?;
        tx.commit().await?;
        self.report.add("users");
        if password == NO_PASSWORD && !bot {
            self.report
                .skip("users imported without a password (they need a recovery code)");
        }
        Ok(Person {
            id: vibez,
            username: name,
        })
    }

    /// The person's Rocket.Chat RSA key pair, the private half still wrapped by
    /// their E2E password.
    async fn keys(
        &self,
        tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
        vibez: &str,
        user: &Document,
    ) -> ImportResult<()> {
        if let Some(keys) = sub(user, "e2e") {
            sqlx::query("INSERT INTO rc_import_e2ee_keys(kind,user_id,payload) VALUES('user',$1,$2) ON CONFLICT DO NOTHING")
                .bind(vibez)
                .bind(json(keys))
                .execute(&mut **tx)
                .await?;
        }
        Ok(())
    }

    /// The account of a message author: imported, or a tombstone standing for
    /// someone the Rocket.Chat database no longer has, shown under the name the
    /// message carried.
    pub(super) async fn author(&mut self, rc: &str, shown: Option<&str>) -> ImportResult<Person> {
        if let Some(person) = self.people.get(rc) {
            return Ok(person.clone());
        }
        let person = match mapped(self.app, "user", rc).await? {
            Some(vibez) => {
                let name: String = sqlx::query_scalar("SELECT username FROM users WHERE id=$1")
                    .bind(&vibez)
                    .fetch_one(&self.app.pool)
                    .await?;
                Person {
                    id: vibez,
                    username: name,
                }
            }
            None => {
                let vibez = random_token()[..24].to_owned();
                let name = format!("deleted-{}", &crate::auth::hash_token(rc)[..16]);
                let display = shown.filter(|n| !n.trim().is_empty()).unwrap_or(&name);
                let mut tx = self.app.pool.begin().await?;
                sqlx::query("INSERT INTO users(id,username,display_name,password_hash,disabled,deleted) VALUES($1,$2,$3,$4,true,true)")
                    .bind(&vibez)
                    .bind(&name)
                    .bind(bounded(display, 128))
                    .bind(NO_PASSWORD)
                    .execute(&mut *tx)
                    .await?;
                remember(&mut tx, "user", rc, &vibez).await?;
                tx.commit().await?;
                self.report.add("former_users_as_tombstones");
                Person {
                    id: vibez,
                    username: name,
                }
            }
        };
        self.people.insert(rc.to_owned(), person.clone());
        Ok(person)
    }
}
