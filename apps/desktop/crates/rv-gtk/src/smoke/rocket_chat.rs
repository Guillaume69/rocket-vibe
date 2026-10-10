//! Rocket.Chat steps of `RV_SMOKE_DETAILS`, against a real server:
//!   local_search:<text>   search across rooms on the device: the dialog lists
//!                         the hits under their rooms, a hit opens its room there
//!   also_in_room:<tag>    a thread reply with "Also send to the room" shows in
//!                         the room, `tshow` on the server; the next one does not
//!   invite:yes|no         whether I may share the room's invite link; with yes,
//!                         the direct link the dialog copies is served
//!   discussion:<tag>      starts a discussion from the last message through the
//!                         dialog; its card shows in the room and opens it.
//!                         RV_SMOKE_PEER ("<user id>|<token>") then starts one
//!                         I am not in: its card joins it
//!   preview:<room>        forwards the last message to <room>, whose list row
//!                         then reads "↪ Quoted message"

use std::rc::Rc;
use std::sync::Arc;
use std::time::Duration;

use adw::prelude::*;
use gtk::glib;
use rv_core::session::Session;
use rv_core::store::MessageRow;

use super::{check, find_by_class, find_named};
use crate::chat::ChatPage;

fn find_type<T: IsA<gtk::Widget>>(root: &gtk::Widget) -> Option<T> {
    if let Some(found) = root.downcast_ref::<T>() {
        return Some(found.clone());
    }
    std::iter::successors(root.first_child(), |w| w.next_sibling()).find_map(|c| find_type::<T>(&c))
}

fn labels(root: &gtk::Widget, out: &mut Vec<String>) {
    if let Some(label) = root.downcast_ref::<gtk::Label>() {
        out.push(label.label().to_string());
    }
    let mut child = root.first_child();
    while let Some(c) = child {
        labels(&c, out);
        child = c.next_sibling();
    }
}

async fn waited<T>(mut probe: impl FnMut() -> Option<T>, seconds: u64) -> Option<T> {
    for _ in 0..seconds * 5 {
        if let Some(found) = probe() {
            return Some(found);
        }
        glib::timeout_future(Duration::from_millis(200)).await;
    }
    probe()
}

fn peer(session: &Session) -> Option<rv_core::rest::RestClient> {
    let (uid, token) = std::env::var("RV_SMOKE_PEER").ok().and_then(|p| {
        let (uid, token) = p.split_once('|')?;
        Some((uid.to_owned(), token.to_owned()))
    })?;
    let rest = rv_core::rest::RestClient::new(session.info.base_url.parse().ok()?);
    rest.set_credentials(Some(rv_core::rest::Credentials { auth_token: token, user_id: uid }));
    Some(rest)
}

pub(super) async fn local_search_checks(chat: Rc<ChatPage>, session: Arc<Session>, spec: String) {
    // `<text>|<other room>`: the other room is opened first, so its history is on the device too.
    let (text, other) = match spec.split_once('|') {
        Some((text, other)) => (text.to_owned(), Some(other.to_owned())),
        None => (spec, None),
    };
    let back = chat.current_rid();
    let other = other.and_then(|name| chat.room_named(&name));
    if let Some(other) = &other {
        chat.open_room(other);
        glib::timeout_future(Duration::from_millis(4000)).await;
        if let Some(back) = &back {
            chat.open_room(back);
        }
    }
    let wanted = if other.is_some() { 2 } else { 1 };
    let rooms_of = |hits: &[MessageRow]| hits.iter().map(|m| m.rid.clone()).collect::<std::collections::BTreeSet<_>>();
    let hits = waited(
        || {
            let hits = session.search_local(&text);
            (rooms_of(&hits).len() >= wanted).then_some(hits)
        },
        10,
    )
    .await
    .unwrap_or_else(|| session.search_local(&text));
    let rooms = rooms_of(&hits);
    check("hits in as many rooms as opened", rooms.len() >= wanted, &rooms);
    check(
        "search across rooms finds",
        !hits.is_empty()
            && hits.iter().all(|m| m.text.as_deref().is_some_and(|t| t.to_lowercase().contains(&text.to_lowercase()))),
        (hits.len(), rooms.len()),
    );
    check("newest first", hits.windows(2).all(|w| w[0].ts >= w[1].ts), ());
    check("at most 60", hits.len() <= rv_core::store::SEARCH_LIMIT as usize, hits.len());
    let Some(dialog) = chat.open_local_search() else {
        check("the search dialog opens", false, ());
        return;
    };
    let Some(entry) = find_type::<gtk::SearchEntry>(dialog.upcast_ref()) else {
        check("the search entry", false, ());
        return;
    };
    entry.set_text(&text);
    // A hit in another room than the open one, when there is one: the jump crosses rooms.
    let in_room = |m: &&MessageRow| m.thread_id.is_none();
    let elsewhere = hits.iter().filter(in_room).find(|m| Some(&m.rid) != back.as_ref());
    let Some(first) = elsewhere.or_else(|| hits.iter().find(in_room)).cloned() else {
        check("a hit in a room", false, ());
        return;
    };
    let shown = waited(|| find_named(dialog.upcast_ref(), &format!("local-hit-{}", first.id)), 5).await;
    check("the dialog lists the hit", shown.is_some(), &first.id);
    if let Some(hit) = &shown {
        let mut words = Vec::new();
        labels(hit, &mut words);
        let room = session.store.room_name(&first.rid).map(|(name, _)| name).unwrap_or_default();
        check("under its room's name", words.first() == Some(&room), (&words.first(), &room));
    }
    dialog.close();
    chat.open_search_hit(&first.rid, &first.id, None);
    let reached = waited(|| chat.room_list().row(&first.id), 8).await;
    check(
        "a hit opens its room at the message",
        chat.current_rid().as_deref() == Some(&first.rid) && reached.is_some(),
        &first.rid,
    );
}

pub(super) async fn also_in_room_checks(chat: Rc<ChatPage>, session: Arc<Session>, rid: String, tag: String) {
    check("also in the room offered", session.also_in_room_available(), ());
    let root_text = format!("{tag} root");
    let (s, r, t) = (session.clone(), rid.clone(), root_text.clone());
    crate::on_tokio(async move { s.send(&r, &t).await }).await;
    let me = session.info.user_id.clone();
    let mine =
        |text: &str| {
            let text = text.to_owned();
            let me = me.clone();
            let session = session.clone();
            let rid = rid.clone();
            move || {
                session.store.messages(&rid, 200).into_iter().chain(session.store.search_messages(&text, 5)).find(|m| {
                    m.author_id == me && m.outbox_status.is_none() && m.text.as_deref() == Some(text.as_str())
                })
            }
        };
    let Some(root) = waited(mine(&root_text), 10).await else {
        check("the root is sent", false, ());
        return;
    };
    chat.open_thread_of(&root.id);
    let Some(thread) = waited(|| chat.thread(), 5).await else {
        check("the thread opens", false, ());
        return;
    };
    check("the check button is offered", thread.also.is_visible(), ());
    thread.also.set_active(true);
    let shown_text = format!("{tag} shown");
    thread.composer.set_text(&shown_text);
    thread.composer.submit_now();
    check("unchecked once sent", !thread.also.is_active(), ());
    let in_room = waited(
        || session.store.messages(&rid, 200).into_iter().find(|m| m.text.as_deref() == Some(shown_text.as_str())),
        2,
    )
    .await;
    check("in the room at once", in_room.is_some(), ());
    let delivered = waited(
        || {
            session.store.messages(&rid, 200).into_iter().find(|m| {
                m.text.as_deref() == Some(shown_text.as_str())
                    && m.outbox_status.is_none()
                    && m.thread_id.as_deref() == Some(&root.id)
            })
        },
        10,
    )
    .await;
    check("delivered in the thread and shown in the room", delivered.is_some(), delivered.as_ref().map(|m| &m.id));
    if let Some(reply) = &delivered {
        let (s, id) = (session.clone(), reply.id.clone());
        let doc = crate::on_tokio(async move {
            s.rest.get("chat.getMessage", rv_core::rest::CallOptions::params([("msgId", id.as_str())])).await
        })
        .await;
        let tshow = doc.as_ref().ok().and_then(|d| d.pointer("/message/tshow")).and_then(|v| v.as_bool());
        check("the server holds tshow", tshow == Some(true), tshow);
    }
    let hidden_text = format!("{tag} hidden");
    thread.composer.set_text(&hidden_text);
    thread.composer.submit_now();
    let hidden = waited(
        || {
            session
                .store
                .thread_messages(&root.id)
                .into_iter()
                .find(|m| m.text.as_deref() == Some(hidden_text.as_str()) && m.outbox_status.is_none())
        },
        10,
    )
    .await;
    let in_room = session.store.messages(&rid, 200).iter().any(|m| m.text.as_deref() == Some(hidden_text.as_str()));
    check("the next reply stays in the thread", hidden.is_some() && !in_room, (hidden.is_some(), in_room));
}

pub(super) async fn invite_checks(chat: Rc<ChatPage>, session: Arc<Session>, rid: String, expected: bool) {
    let (s, r) = (session.clone(), rid.clone());
    let allowed = crate::on_tokio(async move { s.can_invite(&r).await }).await;
    check(&format!("invite link offered: {expected}"), allowed == expected, allowed);
    chat.show_room_info();
    let root = chat.widget().root().map(|r| r.upcast::<gtk::Widget>());
    let group = waited(|| root.as_ref().and_then(|r| find_by_class(r, "room-invite")), 6).await;
    check("the information dialog agrees", group.is_some() == expected, group.is_some());
    if !expected {
        // The server agrees: a member gets 400 `not_authorized`.
        let (s, r) = (session.clone(), rid.clone());
        let refused = crate::on_tokio(async move { s.invite_link(&r).await }).await;
        check("the server refuses a member", refused.as_ref().is_err_and(|e| e.status == 400), &refused);
        return;
    }
    let Some(row) = group.as_ref().and_then(find_type::<adw::ActionRow>) else {
        check("the invite row", false, ());
        return;
    };
    adw::prelude::ActionRowExt::activate(&row);
    let link = waited(|| row.subtitle().filter(|s| !s.is_empty()).map(|s| s.to_string()), 8).await;
    let base = session.settings().await.site_url.clone().unwrap_or_else(|| session.info.base_url.clone());
    check(
        "a direct link on Site_Url",
        link.as_deref().is_some_and(|l| l.starts_with(&format!("{}/invite/", base.trim_end_matches('/')))),
        &link,
    );
    let (s, r) = (session.clone(), rid.clone());
    let again = crate::on_tokio(async move { s.invite_link(&r).await }).await;
    check("asking again gives the same link", again.as_ref().ok() == link.as_ref(), &again);
    if let Some(token) = link.as_deref().and_then(|l| l.rsplit('/').next()).map(str::to_owned) {
        let anonymous = rv_core::rest::RestClient::new(session.info.base_url.parse().unwrap());
        let options = rv_core::rest::CallOptions {
            anonymous: true,
            ..rv_core::rest::CallOptions::body(serde_json::json!({"token": token}))
        };
        let valid = crate::on_tokio(async move { anonymous.post("validateInviteToken", options).await }).await;
        check(
            "the server knows the invite",
            valid.as_ref().is_ok_and(|v| v.get("valid").and_then(|v| v.as_bool()) == Some(true)),
            &valid,
        );
    }
}

fn card_in(session: &Arc<Session>, row: &MessageRow) -> Option<gtk::Widget> {
    let display = rv_core::timeline::Display {
        row: row.clone(),
        show_header: true,
        show_day: false,
        gutter_time: false,
        new_marker: false,
    };
    let widget = crate::rows::message_widget(&display, &session.info.user_id, Some(session), None, Rc::new(|_| {}));
    find_by_class(&widget, "discussion-card")
}

pub(super) async fn discussion_checks(chat: Rc<ChatPage>, session: Arc<Session>, rid: String, tag: String) {
    check("discussions offered", session.discussions_available(), ());
    let source = format!("{tag} source\nsecond line");
    let (s, r, t) = (session.clone(), rid.clone(), source.clone());
    crate::on_tokio(async move { s.send(&r, &t).await }).await;
    let me = session.info.user_id.clone();
    let Some(row) =
        waited(
            || {
                session.store.messages(&rid, 100).into_iter().find(|m| {
                    m.author_id == me && m.outbox_status.is_none() && m.text.as_deref() == Some(source.as_str())
                })
            },
            10,
        )
        .await
    else {
        check("the source message is sent", false, ());
        return;
    };
    let Some(dialog) = chat.start_discussion(Some(&row)) else {
        check("the discussion dialog opens", false, ());
        return;
    };
    let entry = find_by_class(dialog.upcast_ref(), "discussion-name-entry").and_downcast::<gtk::Entry>();
    let suggested = entry.as_ref().map(|e| e.text().to_string());
    check("the name is suggested", suggested.as_deref() == Some(&format!("{tag} source")), &suggested);
    let name = format!("{tag} discussion");
    if let Some(entry) = &entry {
        entry.set_text("  ");
    }
    let create = find_by_class(dialog.upcast_ref(), "discussion-create").and_downcast::<gtk::Button>();
    check("no name, no creation", create.as_ref().is_some_and(|c| !c.is_sensitive()), ());
    if let Some(entry) = &entry {
        entry.set_text(&name);
    }
    if let Some(first) = find_by_class(dialog.upcast_ref(), "discussion-first").and_downcast::<gtk::TextView>() {
        first.buffer().set_text(&format!("{tag} first"));
    }
    if let Some(create) = create {
        create.emit_clicked();
    }
    let created = waited(
        || {
            session.store.messages(&rid, 100).into_iter().find(|m| {
                m.system_type.as_deref() == Some("discussion-created") && m.text.as_deref() == Some(name.as_str())
            })
        },
        15,
    )
    .await;
    let drid = created.as_ref().and_then(|m| m.discussion_id.clone());
    check("the room announces the discussion", drid.is_some(), &drid);
    let Some(drid) = drid else { return };
    // The stream may announce it before the creation's answer opens it.
    let opened = waited(|| (chat.current_rid().as_deref() == Some(drid.as_str())).then_some(()), 10).await;
    check("the discussion opened", opened.is_some(), chat.current_rid());
    check("and is listed", session.store.listed(&drid), ());
    let first = waited(
        || session.store.messages(&drid, 20).into_iter().find(|m| m.text.as_deref() == Some(&format!("{tag} first"))),
        10,
    )
    .await;
    check("with its first message", first.is_some(), ());
    let card = created.as_ref().and_then(|m| card_in(&session, m));
    check("drawn as a card", card.is_some(), ());
    if let Some(card) = &card {
        let mut words = Vec::new();
        labels(card, &mut words);
        check("the card names it", words.contains(&name), &words);
    }
    chat.open_room(&rid);
    chat.play(crate::rows::RowEvent::OpenDiscussion(drid.clone()), false);
    check("its Open opens it", chat.current_rid().as_deref() == Some(drid.as_str()), chat.current_rid());

    // One someone else starts, which I am not in: its card joins it.
    chat.open_room(&rid);
    let Some(peer) = peer(&session) else {
        check("RV_SMOKE_PEER given", false, ());
        return;
    };
    let theirs = format!("{tag} theirs");
    let (r, t) = (rid.clone(), theirs.clone());
    let made =
        crate::on_tokio(
            async move { rv_core::rocketchat::actions::create_discussion(&peer, &r, &t, None, None).await },
        )
        .await;
    let their_rid = made.as_ref().ok().and_then(|d| d.get("_id")).and_then(|v| v.as_str()).map(str::to_owned);
    check("the peer starts a discussion", their_rid.is_some(), made.as_ref().err());
    let Some(their_rid) = their_rid else { return };
    let announced = waited(
        || {
            session
                .store
                .messages(&rid, 100)
                .into_iter()
                .find(|m| m.discussion_id.as_deref() == Some(their_rid.as_str()))
        },
        10,
    )
    .await;
    check("its card arrives", announced.is_some(), ());
    check("not listed before", !session.store.listed(&their_rid), ());
    chat.play(crate::rows::RowEvent::OpenDiscussion(their_rid.clone()), false);
    let opened = waited(|| (chat.current_rid().as_deref() == Some(their_rid.as_str())).then_some(()), 10).await;
    check(
        "Open joins a public one and opens it",
        opened.is_some() && session.store.listed(&their_rid),
        chat.current_rid(),
    );
}

pub(super) async fn preview_checks(session: Arc<Session>, rid: String, target: String) {
    let Some(to) = session.store.rooms().into_iter().find(|r| r.name == target || r.slug.as_deref() == Some(&target))
    else {
        check("the target room is listed", false, &target);
        return;
    };
    let Some(row) = session.store.messages(&rid, 30).into_iter().rev().find(|m| m.system_type.is_none()) else {
        check("a message to forward", false, ());
        return;
    };
    let (s, room) = (session.clone(), session.store.rooms().into_iter().find(|r| r.rid == rid));
    let (kind, slug) = room.map(|r| (r.kind, r.slug)).unwrap_or_default();
    let (r, id, target_rid) = (rid.clone(), row.id.clone(), to.rid.clone());
    let sent = crate::on_tokio(async move { s.forward(&kind, slug.as_deref(), &r, &id, &target_rid).await }).await;
    check("forwarded", sent.is_ok(), &sent);
    let listed = waited(
        || {
            session.store.rooms().into_iter().find(|r| {
                r.rid == to.rid
                    && r.last_message.as_deref().is_some_and(|m| m.starts_with("[ ](") && m.contains(&row.id))
            })
        },
        10,
    )
    .await;
    check("the target's last message is the forward", listed.is_some(), ());
    let Some(listed) = listed else { return };
    let widget = crate::rows::room_widget_with_presence(&listed, Some(&session), None);
    let preview = find_by_class(&widget, "room-preview").and_downcast::<gtk::Label>().map(|l| l.label().to_string());
    let expected = crate::i18n::t("rooms.quoted_message");
    check("the list reads it as a quoted message", preview.as_deref() == Some(expected), &preview);
}
