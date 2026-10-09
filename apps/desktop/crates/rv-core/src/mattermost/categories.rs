//! My sidebar categories (Mattermost 5.32+, kChat alike): which rooms are
//! favourites, which sit in a category of my own, and the order of the
//! sections. Categories are per team; a direct message belongs to no team and
//! is listed in every team's, so the first team that lists a room places it.

use std::collections::HashMap;

use serde_json::Value;

use crate::normalize::Subscription;
use crate::rest::{CallOptions, RestClient, RestError};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Placement {
    pub favorite: bool,
    pub group_id: Option<String>,
    pub group_name: Option<String>,
    pub rank: i64,
}

/// Keeps each team's sections after the previous team's.
const TEAM_STRIDE: i64 = 1000;

pub async fn load(rest: &RestClient) -> Result<HashMap<String, Placement>, RestError> {
    let teams = rest.get("users/me/teams", CallOptions::default()).await?;
    let mut out = HashMap::new();
    for (index, team) in teams.as_array().into_iter().flatten().enumerate() {
        let Some(id) = team.get("id").and_then(Value::as_str) else { continue };
        let list = rest.get(&format!("users/me/teams/{id}/channels/categories"), CallOptions::default()).await?;
        for (rid, placement) in placements(&list, index as i64 * TEAM_STRIDE) {
            out.entry(rid).or_insert(placement);
        }
    }
    Ok(out)
}

pub fn placements(list: &Value, base: i64) -> HashMap<String, Placement> {
    let categories: Vec<&Value> = list.get("categories").and_then(Value::as_array).into_iter().flatten().collect();
    let by_id = |id: &str| categories.iter().find(|c| c.get("id").and_then(Value::as_str) == Some(id)).copied();
    let order: Vec<&str> = match list.get("order").and_then(Value::as_array) {
        Some(order) => order.iter().filter_map(Value::as_str).collect(),
        None => categories.iter().filter_map(|c| c.get("id").and_then(Value::as_str)).collect(),
    };
    let mut out = HashMap::new();
    for (position, id) in order.into_iter().enumerate() {
        let Some(category) = by_id(id) else { continue };
        let kind = category.get("type").and_then(Value::as_str);
        let custom = kind == Some("custom");
        let name = category.get("display_name").and_then(Value::as_str).filter(|n| !n.is_empty());
        for rid in category.get("channel_ids").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str)
        {
            out.entry(rid.to_owned()).or_insert_with(|| Placement {
                favorite: kind == Some("favorites"),
                group_id: custom.then(|| id.to_owned()),
                group_name: name.filter(|_| custom).map(str::to_owned),
                rank: base + position as i64,
            });
        }
    }
    out
}

pub fn place(subscription: &mut Subscription, placement: Option<&Placement>) {
    subscription.favorite = placement.is_some_and(|p| p.favorite);
    subscription.group_id = placement.and_then(|p| p.group_id.clone());
    subscription.group_name = placement.and_then(|p| p.group_name.clone());
    subscription.group_rank = placement.map(|p| p.rank);
}

/// Mattermost's own default when the preference was never set.
pub const DEFAULT_DM_LIMIT: usize = 40;

/// Which direct and group conversations my sidebar lists: a closed one is a
/// preference, `direct_channel_show` by the other person's id or
/// `group_channel_show` by channel id, valued "false"; and only the
/// `sidebar_settings/limit_visible_dms_gms` most recent of the Direct
/// Messages category are listed. One with something unread always shows.
#[derive(Debug, Clone)]
pub struct Sidebar {
    me: String,
    closed_people: std::collections::HashSet<String>,
    closed_groups: std::collections::HashSet<String>,
    pub limit: usize,
    listed: Option<std::collections::HashSet<String>>,
    /// Opened in this session: listed whatever their age.
    revealed: std::collections::HashSet<String>,
}

impl Sidebar {
    pub fn new(me: &str) -> Self {
        Sidebar {
            me: me.to_owned(),
            closed_people: Default::default(),
            closed_groups: Default::default(),
            limit: DEFAULT_DM_LIMIT,
            listed: None,
            revealed: Default::default(),
        }
    }

    /// Preferences from the catch-up (`replace`) or a `preferences_changed`; true when the list moves.
    pub fn apply(&mut self, list: &Value, replace: bool) -> bool {
        if replace {
            self.closed_people.clear();
            self.closed_groups.clear();
            self.limit = DEFAULT_DM_LIMIT;
        }
        let mut moved = replace;
        for p in list.as_array().into_iter().flatten() {
            let name = p.get("name").and_then(Value::as_str).unwrap_or_default().to_owned();
            let closed = p.get("value").and_then(Value::as_str) == Some("false");
            let set = match p.get("category").and_then(Value::as_str) {
                Some("direct_channel_show") => &mut self.closed_people,
                Some("group_channel_show") => &mut self.closed_groups,
                Some("sidebar_settings") if name == "limit_visible_dms_gms" => {
                    let limit = p.get("value").and_then(Value::as_str).and_then(|v| v.parse::<usize>().ok());
                    if let Some(limit) = limit.filter(|l| *l > 0 && *l != self.limit) {
                        self.limit = limit;
                        moved = true;
                    }
                    continue;
                }
                _ => continue,
            };
            if name.is_empty() || set.contains(&name) == closed {
                continue;
            }
            if closed {
                set.insert(name);
            } else {
                set.remove(&name);
            }
            moved = true;
        }
        moved
    }

    /// The conversations within the limit, most recent first; `elsewhere` names
    /// the ones in Favourites or a category of my own, outside the limit.
    pub fn rank<'a>(&mut self, channels: impl IntoIterator<Item = &'a Value>, elsewhere: impl Fn(&str) -> bool) {
        let mut open: Vec<&Value> = channels
            .into_iter()
            .filter(|c| conversation(c) && !self.closed(c))
            .filter(|c| !elsewhere(c.get("id").and_then(Value::as_str).unwrap_or_default()))
            .collect();
        open.sort_by_key(|c| std::cmp::Reverse(c.get("last_post_at").and_then(Value::as_i64).unwrap_or(0)));
        let recent =
            open.iter().take(self.limit).filter_map(|c| c.get("id").and_then(Value::as_str).map(str::to_owned));
        self.listed = Some(recent.chain(self.revealed.iter().cloned()).collect());
    }

    /// A conversation I just opened: listed whatever its age, as Mattermost does.
    pub fn reveal(&mut self, rid: &str) {
        self.revealed.insert(rid.to_owned());
        if let Some(listed) = &mut self.listed {
            listed.insert(rid.to_owned());
        }
    }

    pub fn is_listed(&self, channel: &Value, unread: i64, elsewhere: bool) -> bool {
        if !conversation(channel) || unread > 0 || elsewhere {
            return true;
        }
        if self.closed(channel) {
            return false;
        }
        let rid = channel.get("id").and_then(Value::as_str).unwrap_or_default();
        self.listed.as_ref().is_none_or(|l| l.contains(rid))
    }

    fn closed(&self, channel: &Value) -> bool {
        let id = channel.get("id").and_then(Value::as_str).unwrap_or_default();
        if channel.get("type").and_then(Value::as_str) == Some("G") {
            return self.closed_groups.contains(id);
        }
        let name = channel.get("name").and_then(Value::as_str).unwrap_or_default();
        let other = name.split("__").find(|p| *p != self.me).unwrap_or(&self.me);
        self.closed_people.contains(other)
    }
}

fn conversation(channel: &Value) -> bool {
    matches!(channel.get("type").and_then(Value::as_str), Some("D" | "G"))
}

/// In Favourites or a category of my own: outside the direct messages' limit.
pub fn placed_elsewhere(placement: Option<&Placement>) -> bool {
    placement.is_some_and(|p| p.favorite || p.group_id.is_some())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_room_takes_its_category_and_the_server_order() {
        let list = json!({
            "categories": [
                {"id": "fav", "type": "favorites", "channel_ids": ["f1"]},
                {"id": "tech", "type": "custom", "display_name": "TECH", "channel_ids": ["t1"]},
                {"id": "ch", "type": "channels", "display_name": "Channels", "channel_ids": ["c1", "t1"]},
            ],
            "order": ["tech", "fav", "ch"],
        });
        let map = placements(&list, 1000);
        let tech =
            Placement { favorite: false, group_id: Some("tech".into()), group_name: Some("TECH".into()), rank: 1000 };
        assert_eq!(map["t1"], tech);
        assert_eq!(map["f1"], Placement { favorite: true, group_id: None, group_name: None, rank: 1001 });
        assert_eq!(map["c1"], Placement { favorite: false, group_id: None, group_name: None, rank: 1002 });

        let mut s = Subscription { rid: "t1".into(), favorite: true, ..Default::default() };
        place(&mut s, map.get("t1"));
        assert_eq!((s.favorite, s.group_name.as_deref(), s.group_rank), (false, Some("TECH"), Some(1000)));
        place(&mut s, None);
        assert_eq!((s.group_id, s.group_rank), (None, None));
    }
}
