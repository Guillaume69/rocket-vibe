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
