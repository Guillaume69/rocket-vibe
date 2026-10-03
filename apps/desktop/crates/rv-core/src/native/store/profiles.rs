use super::{NativeStore, json};
use base64::{Engine, engine::general_purpose::STANDARD};
use rusqlite::{OptionalExtension, params};
use rv_protocol::profiles::{AvatarCommand, ProfileReceipt, ProfileStamp, UpdatePreferences, UpdateProfile};
use rv_protocol::{User, live::LiveState};
use serde::{Deserialize, Serialize};

#[derive(Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum ProfileOperation {
    Profile { input: UpdateProfile },
    Preferences { input: UpdatePreferences },
    Avatar { input: AvatarCommand, upload: Option<AvatarUpload> },
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AvatarUpload {
    pub mime: String,
    pub base64: String,
}
impl AvatarUpload {
    pub fn from_bytes(mime: String, bytes: &[u8]) -> Self {
        Self { mime, base64: STANDARD.encode(bytes) }
    }
    pub fn bytes(&self) -> Option<Vec<u8>> {
        if !matches!(self.mime.as_str(), "image/png" | "image/jpeg") || self.base64.len() > 2_796_204 {
            return None;
        }
        STANDARD
            .decode(&self.base64)
            .ok()
            .filter(|b| !b.is_empty() && b.len() <= 2 * 1024 * 1024 && STANDARD.encode(b) == self.base64)
    }
}
fn identifier(s: &str) -> bool {
    !s.is_empty() && s.len() <= 128 && s.bytes().all(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_'))
}
impl ProfileOperation {
    pub fn id(&self) -> &str {
        match self {
            Self::Profile { input } => &input.operation_id,
            Self::Preferences { input } => &input.operation_id,
            Self::Avatar { input, .. } => &input.operation_id,
        }
    }
    pub fn slot(&self) -> &str {
        match self {
            Self::Profile { .. } => "profile",
            Self::Preferences { .. } => "preferences",
            Self::Avatar { .. } => "avatar",
        }
    }
    pub fn revision(&self) -> &str {
        match self {
            Self::Profile { input } => &input.expected_revision,
            Self::Preferences { input } => &input.expected_revision,
            Self::Avatar { input, .. } => &input.expected_revision,
        }
    }
    fn valid(&self) -> bool {
        identifier(self.id())
            && identifier(self.revision())
            && match self {
                Self::Profile { input } => {
                    identifier(&input.username)
                        && !input.display_name.trim().is_empty()
                        && input.display_name.len() <= 256
                        && input.bio.len() <= 4096
                        && input.status_text.len() <= 512
                        && !input.bio.contains('\0')
                        && !input.display_name.chars().chain(input.status_text.chars()).any(char::is_control)
                }
                Self::Preferences { input } => !input.language.is_empty() && input.language.len() <= 35,
                Self::Avatar { upload, .. } => upload.as_ref().is_none_or(|u| u.bytes().is_some()),
            }
    }
    fn same_form(&self, other: &Self) -> bool {
        let strip = |op: &Self| {
            let mut value = serde_json::to_value(op).expect("typed profile command");
            let input = value["input"].as_object_mut().unwrap();
            input.remove("operation_id");
            input.remove("expected_revision");
            value
        };
        strip(self) == strip(other)
    }
}
#[derive(Clone)]
pub struct SavedProfileOperation {
    pub command: ProfileOperation,
    pub phase: String,
    pub error: Option<String>,
}
#[derive(Clone, Debug)]
pub struct DirectPeer {
    pub user: User,
    pub avatar_file_id: Option<String>,
}
fn row(r: &rusqlite::Row<'_>) -> rusqlite::Result<SavedProfileOperation> {
    let id: String = r.get(0)?;
    let slot: String = r.get(1)?;
    let payload: String = r.get(2)?;
    let command: ProfileOperation = serde_json::from_str(&payload).map_err(|_| rusqlite::Error::InvalidQuery)?;
    if command.id() != id || command.slot() != slot || !command.valid() {
        return Err(rusqlite::Error::InvalidQuery);
    }
    Ok(SavedProfileOperation { command, phase: r.get(3)?, error: r.get(4)? })
}
pub(super) fn initialize(conn: &rusqlite::Connection) -> rusqlite::Result<()> {
    conn.execute_batch("CREATE TABLE IF NOT EXISTS native_profile_operations(id TEXT PRIMARY KEY,slot TEXT NOT NULL UNIQUE,payload TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','proof','failed')),error TEXT);
        CREATE TABLE IF NOT EXISTS native_users(uid TEXT PRIMARY KEY,payload TEXT NOT NULL,seen INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS native_direct_peers(rid TEXT PRIMARY KEY,membership TEXT NOT NULL,uid TEXT NOT NULL,payload TEXT NOT NULL);")
}
fn save_identities(tx: &rusqlite::Transaction<'_>, profiles: &[ProfileStamp]) -> rusqlite::Result<()> {
    if profiles.len() > 512 {
        return Err(rusqlite::Error::InvalidQuery);
    }
    for profile in profiles {
        let payload = json(profile)?;
        let old: Option<String> = tx
            .query_row("SELECT payload FROM native_users WHERE uid=?1", [&profile.user.id], |r| r.get(0))
            .optional()?;
        if old.as_deref() == Some(&payload) {
            continue;
        }
        tx.execute("INSERT INTO native_users VALUES(?1,?2,(SELECT coalesce(max(seen),0)+1 FROM native_users)) ON CONFLICT(uid) DO UPDATE SET payload=excluded.payload,seen=excluded.seen", params![profile.user.id,payload])?;
    }
    tx.execute(
        "DELETE FROM native_users WHERE uid IN(SELECT uid FROM native_users ORDER BY seen DESC LIMIT -1 OFFSET 512)",
        [],
    )?;
    Ok(())
}
impl NativeStore {
    /// Persist public DM identities, but never the expiring presence/typing observation.
    pub fn live_profiles(&self, state: &LiveState, alive: impl Fn() -> bool) -> rusqlite::Result<()> {
        if state.limited || state.ttl_ms == 0 || state.ttl_ms > 8000 {
            return Ok(());
        }
        self.atomic(|tx| {
            if !alive() || !self.same(tx)? { return Err(rusqlite::Error::InvalidQuery); }
            for room in &state.rooms {
                let current = super::read_states::state_in(tx, &room.room_id)?;
                if current.and_then(|s| s.membership_version).as_deref() != Some(room.membership_version.as_str()) {
                    return Err(rusqlite::Error::InvalidQuery);
                }
                let direct: bool = tx.query_row("SELECT json_extract(payload,'$.kind')='direct' FROM native_rooms WHERE id=?1", [&room.room_id], |r| r.get(0)).optional()?.unwrap_or(false);
                match room.direct_peer.as_ref().filter(|_| direct) {
                    Some(user) => {
                        tx.execute("INSERT INTO native_direct_peers VALUES(?1,?2,?3,?4) ON CONFLICT(rid) DO UPDATE SET membership=excluded.membership,uid=excluded.uid,payload=excluded.payload",params![room.room_id,room.membership_version,user.id,json(user)?])?;
                    }
                    None => { tx.execute("DELETE FROM native_direct_peers WHERE rid=?1", [&room.room_id])?; }
                }
            }
            save_identities(tx, &state.profiles)?;
            if !alive() { return Err(rusqlite::Error::InvalidQuery); }
            Ok(())
        })
    }
    pub fn direct_peer(&self, rid: &str) -> rusqlite::Result<Option<DirectPeer>> {
        let conn = self.conn.lock().unwrap();
        if !self.same(&conn)? {
            return Ok(None);
        }
        conn.query_row("SELECT coalesce(json_extract(u.payload,'$.user'),p.payload),json_extract(u.payload,'$.avatar_file_id') FROM native_direct_peers p JOIN native_rooms r ON r.id=p.rid JOIN native_read_states s ON s.rid=p.rid LEFT JOIN native_users u ON u.uid=p.uid WHERE p.rid=?1 AND p.membership=json_extract(s.payload,'$.membership_version') AND json_extract(r.payload,'$.kind')='direct'",[rid],|r| {
            let payload: String = r.get(0)?;
            let user = serde_json::from_str(&payload).map_err(|_| rusqlite::Error::InvalidQuery)?;
            Ok(DirectPeer { user, avatar_file_id:r.get(1)? })
        }).optional()
    }
    pub fn profile_avatar_path(&self, username: &str) -> rusqlite::Result<Option<String>> {
        let conn = self.conn.lock().unwrap();
        if !self.same(&conn)? {
            return Ok(None);
        }
        Ok(conn.query_row("SELECT json_extract(payload,'$.avatar_file_id') FROM native_users WHERE json_extract(payload,'$.user.username')=?1",[username],|r|r.get::<_,Option<String>>(0)).optional()?.flatten().map(|id|format!("rv-avatar:{id}")))
    }
    pub fn profile_identity(&self, uid: &str) -> rusqlite::Result<Option<ProfileStamp>> {
        let conn = self.conn.lock().unwrap();
        if !self.same(&conn)? {
            return Ok(None);
        }
        conn.query_row("SELECT payload FROM native_users WHERE uid=?1", [uid], |r| {
            let payload: String = r.get(0)?;
            serde_json::from_str(&payload).map_err(|_| rusqlite::Error::InvalidQuery)
        })
        .optional()
    }
    pub fn profile_identities(&self, profiles: &[ProfileStamp], alive: impl Fn() -> bool) -> rusqlite::Result<()> {
        if profiles.len() > 512 {
            return Err(rusqlite::Error::InvalidQuery);
        }
        self.atomic(|tx| {
            if !alive() || !self.same(tx)? {
                return Err(rusqlite::Error::InvalidQuery);
            }
            save_identities(tx, profiles)?;
            if !alive() {
                return Err(rusqlite::Error::InvalidQuery);
            }
            Ok(())
        })
    }
    pub fn profile_operation(&self, slot: &str) -> rusqlite::Result<Option<SavedProfileOperation>> {
        let conn = self.conn.lock().unwrap();
        if !self.same(&conn)? {
            return Ok(None);
        }
        conn.query_row("SELECT id,slot,payload,state,error FROM native_profile_operations WHERE slot=?1", [slot], row)
            .optional()
    }
    pub fn profile_version(&self) -> rusqlite::Result<i64> {
        let conn = self.conn.lock().unwrap();
        if !self.same(&conn)? {
            return Ok(0);
        }
        conn.query_row("SELECT coalesce(max(seen),0) FROM native_users", [], |r| r.get(0))
    }
    pub fn avatar_current(&self, id: &str) -> rusqlite::Result<bool> {
        let conn = self.conn.lock().unwrap();
        if !self.same(&conn)? {
            return Ok(false);
        }
        conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM native_users WHERE json_extract(payload,'$.avatar_file_id')=?1)",
            [id],
            |r| r.get(0),
        )
    }
    pub fn stage_profile_operation(
        &self,
        command: ProfileOperation,
    ) -> rusqlite::Result<Option<SavedProfileOperation>> {
        if !command.valid() {
            return Err(rusqlite::Error::InvalidQuery);
        }
        self.atomic(|tx| {
            if !self.same(tx)? {
                return Err(rusqlite::Error::InvalidQuery);
            }
            if let Some(old) = tx
                .query_row(
                    "SELECT id,slot,payload,state,error FROM native_profile_operations WHERE slot=?1",
                    [command.slot()],
                    row,
                )
                .optional()?
            {
                return Ok((old.phase != "failed" && old.command.same_form(&command)).then_some(old));
            }
            tx.execute(
                "INSERT INTO native_profile_operations(id,slot,payload) VALUES(?1,?2,?3)",
                params![command.id(), command.slot(), json(&command)?],
            )?;
            Ok(Some(SavedProfileOperation { command, phase: "pending".into(), error: None }))
        })
    }
    pub fn pending_profile_operations(&self) -> rusqlite::Result<Vec<SavedProfileOperation>> {
        self.atomic(|tx|{
            if !self.same(tx)?{return Ok(vec![]);}
            let mut values=Vec::new();
            let ids=tx.prepare("SELECT id FROM native_profile_operations WHERE state='pending' ORDER BY rowid")?.query_map([],|r|r.get::<_,String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
            for id in ids {
                match tx.query_row("SELECT id,slot,payload,state,error FROM native_profile_operations WHERE id=?1",[&id],row){
                    Ok(value)=>values.push(value),Err(_)=>{tx.execute("UPDATE native_profile_operations SET state='failed',error='invalid_profile_command' WHERE id=?1",[id])?;}
                }
            }
            Ok(values)
        })
    }
    pub fn mark_profile_operation(
        &self,
        saved: &SavedProfileOperation,
        phase: &str,
        error: Option<&str>,
    ) -> rusqlite::Result<()> {
        self.atomic(|tx| {
            if self.same(tx)? {
                tx.execute(
                    "UPDATE native_profile_operations SET state=?1,error=?2 WHERE slot=?3 AND id=?4",
                    params![phase, error, saved.command.slot(), saved.command.id()],
                )?;
            }
            Ok(())
        })
    }
    pub fn dismiss_profile_operation(&self, slot: &str, id: &str) -> rusqlite::Result<bool> {
        self.atomic(|tx| {
            if !self.same(tx)? {
                return Ok(false);
            }
            Ok(tx.execute(
                "DELETE FROM native_profile_operations WHERE slot=?1 AND id=?2 AND state IN ('proof','failed')",
                params![slot, id],
            )? == 1)
        })
    }
    pub fn confirm_profile_operation(
        &self,
        saved: &SavedProfileOperation,
        receipt: &ProfileReceipt,
        alive: impl Fn() -> bool,
    ) -> rusqlite::Result<()> {
        if saved.command.id() != receipt.operation_id || !identifier(&receipt.applied_revision) {
            return Err(rusqlite::Error::InvalidQuery);
        }
        self.atomic(|tx| {
            if !alive() || !self.same(tx)? {
                return Err(rusqlite::Error::InvalidQuery);
            }
            tx.execute(
                "DELETE FROM native_profile_operations WHERE slot=?1 AND id=?2",
                params![saved.command.slot(), receipt.operation_id],
            )?;
            if !alive() {
                return Err(rusqlite::Error::InvalidQuery);
            }
            Ok(())
        })
    }
}
