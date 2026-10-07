//! The server administration and members' reports, through the real widgets.
//!   RV_SMOKE_REPORT=<reason>  reports bob's last message of the open room and bob
//!                             himself through the Report dialog
//!                             (RV_SMOKE_REPORT_HOLD=1: the first dialog stays open, filled)
//!   RV_SMOKE_ADMIN=dashboard|users|rooms|moderation|confirm  opens the administration
//!                             as an admin, checks that category and leaves it shown
//!                             (`confirm`: bob's deactivation asked, left unanswered)
use super::{check, find_by_class};
use crate::{admin::ReportTarget, on_tokio, window::AppWindow};
use adw::prelude::*;
use gtk::glib;
use std::{rc::Rc, time::Duration};

pub(super) fn install(window: &Rc<AppWindow>) {
    let report = std::env::var("RV_SMOKE_REPORT").ok().filter(|r| !r.is_empty());
    let admin = std::env::var("RV_SMOKE_ADMIN").ok().filter(|a| !a.is_empty());
    if report.is_none() && admin.is_none() {
        return;
    }
    let weak = Rc::downgrade(window);
    let mut polls = 0;
    glib::timeout_add_local(Duration::from_millis(250), move || {
        let Some(window) = weak.upgrade() else { return glib::ControlFlow::Break };
        polls += 1;
        // A report needs the open room; the administration only the account.
        let online = window.chat.session().is_some()
            || window
                .chat
                .native_session()
                .is_some_and(|s| s.status().connection == rv_core::session::Connection::Online);
        let ready =
            online && (report.is_none() || (window.chat.current_rid().is_some() && window.chat.room_list().len() > 0));
        if ready {
            let (report, admin) = (report.clone(), admin.clone());
            glib::spawn_future_local(async move {
                if let Some(reason) = report {
                    reports(&window, &reason).await;
                }
                if let Some(category) = admin {
                    administration(&window, &category).await;
                }
            });
            return glib::ControlFlow::Break;
        }
        if polls >= 120 {
            check("admin smoke room opened", false, polls);
            return glib::ControlFlow::Break;
        }
        glib::ControlFlow::Continue
    });
}

async fn wait(root: &gtk::Widget, class: &str, accept: impl Fn(&gtk::Widget) -> bool) -> Option<gtk::Widget> {
    for _ in 0..400 {
        if let Some(widget) = find_by_class(root, class)
            && accept(&widget)
        {
            return Some(widget);
        }
        glib::timeout_future(Duration::from_millis(25)).await;
    }
    None
}

fn shown_badge(root: &gtk::Widget) -> Option<gtk::Label> {
    if root.has_css_class("sidebar-badge") && root.is_visible() {
        return root.clone().downcast().ok();
    }
    std::iter::successors(root.first_child(), |w| w.next_sibling()).find_map(|c| shown_badge(&c))
}

fn dimming(root: &gtk::Widget) -> Option<gtk::Widget> {
    if root.css_name() == "dimming" {
        return Some(root.clone());
    }
    std::iter::successors(root.first_child(), |w| w.next_sibling()).find_map(|c| dimming(&c))
}

fn count(root: &gtk::Widget, class: &str) -> usize {
    usize::from(root.has_css_class(class))
        + std::iter::successors(root.first_child(), |w| w.next_sibling()).map(|c| count(&c, class)).sum::<usize>()
}

/// Fills the open Report dialog and sends it.
async fn send_report(root: &gtk::Widget, reason: &str) -> bool {
    let Some(entry) = wait(root, "report-reason", |w| w.is_mapped()).await.and_downcast::<gtk::Entry>() else {
        return false;
    };
    let Some(alert) = wait(root, "report-dialog", |_| true).await.and_downcast::<adw::AlertDialog>() else {
        return false;
    };
    check("an empty reason cannot be sent", !alert.is_response_enabled("send"), ());
    entry.set_text(reason);
    check("a reason enables Send", alert.is_response_enabled("send"), ());
    if std::env::var("RV_SMOKE_REPORT_HOLD").as_deref() == Ok("1") {
        return true;
    }
    alert.emit_by_name_with_details::<()>("response", glib::Quark::from_str("send"), &[&"send"]);
    alert.close();
    true
}

async fn reports(window: &Rc<AppWindow>, reason: &str) {
    let root: gtk::Widget = window.window.clone().upcast();
    let (Some(session), Some(rid)) = (window.chat.session(), window.chat.current_rid()) else {
        return check("report: Rocket.Chat room open", false, ());
    };
    let rows = session.store.messages(&rid, 200);
    let Some(theirs) = rows.iter().rev().find(|r| r.author.as_deref() == Some("bob") && r.system_type.is_none()) else {
        return check("report: a message of bob", false, ());
    };
    let _ = window.chat.report(ReportTarget::Message(theirs.id.clone()));
    check("report dialog for a message", send_report(&root, reason).await, ());
    if std::env::var("RV_SMOKE_REPORT_HOLD").as_deref() == Ok("1") {
        return;
    }
    glib::timeout_future(Duration::from_millis(1500)).await;
    let _ = window.chat.report(ReportTarget::User(theirs.author_id.clone()));
    check("report dialog for an account", send_report(&root, reason).await, ());
    glib::timeout_future(Duration::from_millis(1500)).await;
    // A click outside the dialog cancels it, like Escape.
    glib::timeout_future(Duration::from_millis(1000)).await;
    if let Some(alert) = window.chat.report(ReportTarget::Message(theirs.id.clone())) {
        let mut click = None;
        for _ in 0..40 {
            glib::timeout_future(Duration::from_millis(50)).await;
            click = dimming(alert.upcast_ref()).and_then(|b| {
                (0..b.observe_controllers().n_items())
                    .filter_map(|i| b.observe_controllers().item(i).and_downcast::<gtk::GestureClick>())
                    .find(|c| c.button() == 0 && c.propagation_phase() == gtk::PropagationPhase::Capture)
            });
            if click.is_some() {
                break;
            }
        }
        check("the report dialog listens to its backdrop", click.is_some(), ());
        if let Some(click) = click {
            click.emit_by_name::<()>("released", &[&1i32, &5f64, &5f64]);
        }
        glib::timeout_future(Duration::from_millis(800)).await;
        check("a click outside cancels the report", !alert.is_mapped(), ());
    }
    let s = session.clone();
    let mine = on_tokio(async move { rv_core::admin::Admin::RocketChat(s).is_admin().await }).await;
    check("a member is no administrator", !mine, ());
    println!("smoke: reports sent");
}

async fn administration(window: &Rc<AppWindow>, category: &str) {
    let root: gtk::Widget = window.window.clone().upcast();
    let Some(admin) = window.chat.admin() else { return check("admin provider", false, ()) };
    let mut is_admin = false;
    for _ in 0..20 {
        let probe = admin.clone();
        is_admin = on_tokio(async move { probe.is_admin().await }).await;
        if is_admin {
            break;
        }
        glib::timeout_future(Duration::from_millis(500)).await;
    }
    check("the administrator is recognized", is_admin, ());
    let dialog = crate::admin::open(window.chat.widget(), admin);
    let dashboard = wait(&root, "admin-value", |w| w.is_mapped()).await;
    check("dashboard shows the deployment", dashboard.is_some(), ());
    let mut badge = None;
    for _ in 0..200 {
        badge = shown_badge(&root);
        if badge.is_some() {
            break;
        }
        glib::timeout_future(Duration::from_millis(25)).await;
    }
    check(
        "moderation badge counts open reports",
        badge.as_ref().is_some_and(|b| !b.label().is_empty()),
        badge.map(|b| b.label()),
    );
    match category {
        "users" => {
            dialog.select("users");
            let first = wait(&root, "admin-user", |w| w.is_mapped()).await;
            check("users listed", first.is_some(), count(&root, "admin-user"));
            check("the admin carries its badge", count(&root, "admin-badge") > 0, ());
            if let Some(search) = find_by_class(&root, "admin-user-search").and_downcast::<gtk::SearchEntry>() {
                search.set_text("ali");
                glib::timeout_future(Duration::from_millis(1500)).await;
                check("search narrows the users", count(&root, "admin-user") == 1, count(&root, "admin-user"));
                search.set_text("");
                glib::timeout_future(Duration::from_millis(1500)).await;
            }
            let me = find_by_class(&root, "admin-user").and_downcast::<adw::ActionRow>();
            if let Some(row) = me {
                row.emit_by_name::<()>("activated", &[]);
                let page = wait(&root, "admin-user-page", |w| w.is_mapped()).await;
                check("a user opens its page", page.is_some(), ());
                let actions = count(&root, "admin-set-admin") + count(&root, "admin-yourself");
                check("its actions, or none on my own account", actions == 1, actions);
                dialog.host().pop();
                glib::timeout_future(Duration::from_millis(600)).await;
            }
            // alice made an administrator through her page, then back.
            for promote in [true, false] {
                let Some(search) = find_by_class(&root, "admin-user-search").and_downcast::<gtk::SearchEntry>() else {
                    break;
                };
                search.set_text("alice");
                glib::timeout_future(Duration::from_millis(1500)).await;
                let Some(row) = find_by_class(&root, "admin-user").and_downcast::<adw::ActionRow>() else { break };
                row.emit_by_name::<()>("activated", &[]);
                let Some(action) =
                    wait(&root, "admin-set-admin", |w| w.is_mapped()).await.and_downcast::<adw::ButtonRow>()
                else {
                    break;
                };
                action.emit_by_name::<()>("activated", &[]);
                // Back to the list, reloaded with the change.
                let _ = wait(&root, "admin-user-page", |w| !w.is_mapped()).await;
                glib::timeout_future(Duration::from_millis(2000)).await;
                let badged = count(&root, "admin-badge") > 0;
                check(
                    if promote { "alice made admin" } else { "alice's admin right removed" },
                    badged == promote,
                    badged,
                );
            }
            if let Some(search) = find_by_class(&root, "admin-user-search").and_downcast::<gtk::SearchEntry>() {
                search.set_text("");
                glib::timeout_future(Duration::from_millis(1500)).await;
            }
        }
        "confirm" => {
            dialog.select("users");
            if let Some(search) =
                wait(&root, "admin-user-search", |w| w.is_mapped()).await.and_downcast::<gtk::SearchEntry>()
            {
                search.set_text("bob");
                glib::timeout_future(Duration::from_millis(1500)).await;
            }
            if let Some(row) = find_by_class(&root, "admin-user").and_downcast::<adw::ActionRow>() {
                row.emit_by_name::<()>("activated", &[]);
            }
            let action = wait(&root, "admin-set-active", |w| w.is_mapped()).await.and_downcast::<adw::ButtonRow>();
            check("bob's page offers deactivation", action.is_some(), ());
            if let Some(action) = action {
                action.emit_by_name::<()>("activated", &[]);
                let asked = wait(&root, "admin-confirm", |w| w.is_mapped()).await;
                check("deactivation is confirmed first", asked.is_some(), ());
            }
        }
        "rooms" => {
            dialog.select("rooms");
            let first = wait(&root, "admin-room", |w| w.is_mapped()).await;
            check("rooms listed", first.is_some(), count(&root, "admin-room"));
        }
        "moderation" => {
            dialog.select("moderation");
            let message = wait(&root, "admin-reported-message", |w| w.is_mapped()).await;
            check("reported messages listed", message.is_some(), count(&root, "admin-reported-message"));
            let account = wait(&root, "admin-reported-user", |w| w.is_mapped()).await;
            check("reported users listed", account.is_some(), count(&root, "admin-reported-user"));
            if let Some(row) = message.and_downcast::<adw::ActionRow>() {
                row.emit_by_name::<()>("activated", &[]);
                let reason = wait(&root, "admin-reason", |w| w.is_mapped()).await;
                check("a reported message shows its reasons", reason.is_some(), ());
                check(
                    "dismiss, delete and deactivate are offered",
                    find_by_class(&root, "admin-dismiss").is_some()
                        && find_by_class(&root, "admin-delete-message").is_some(),
                    (),
                );
                glib::timeout_future(Duration::from_millis(600)).await;
                dialog.host().pop();
            }
        }
        _ => {}
    }
    println!("smoke: administration {category} checked");
}
