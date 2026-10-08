//! Bot accounts (RFC 0003, `docs/protocol/BOTS.md`): the bots I own, with
//! their scopes (each one's API read from the server's own gate table) and
//! their keys. A new key shows once, in a dialog, and is never kept.

use std::cell::RefCell;
use std::rc::Rc;
use std::sync::Arc;

use adw::prelude::*;
use gtk::glib;
use rv_core::native::NativeSession;
use rv_core::native::bots::{self, Bot, BotKey, BotKeyCreated, BotReference, BotRoute, BotScope};

use crate::i18n::{self, t, tf, tn};
use crate::on_tokio;
use crate::sidebar_dialog::Host;
use crate::widgets::{self, TileSize};

fn error_text(error: &rv_core::native::Error) -> &'static str {
    t(bots::error_key(error.code()))
}

/// `2026-10-07T09:00:00Z` as a local date and time.
fn when(text: &str) -> String {
    chrono::DateTime::parse_from_rfc3339(text)
        .map(|d| {
            let local = d.with_timezone(&chrono::Local);
            local.format_localized("%e %b %Y %H:%M", i18n::locale()).to_string().trim().to_owned()
        })
        .unwrap_or_else(|_| text.to_owned())
}

/// Rows of a group that are replaced together on each load.
struct Rows {
    group: glib::WeakRef<adw::PreferencesGroup>,
    rows: RefCell<Vec<gtk::Widget>>,
}

impl Rows {
    fn new(group: &adw::PreferencesGroup) -> Rc<Self> {
        Rc::new(Rows { group: group.downgrade(), rows: RefCell::default() })
    }
    fn add(&self, row: &impl IsA<gtk::Widget>) {
        if let Some(group) = self.group.upgrade() {
            group.add(row);
            self.rows.borrow_mut().push(row.as_ref().clone());
        }
    }
    fn note(&self, text: &str) {
        self.add(&adw::ActionRow::builder().title(text).use_markup(false).css_classes(["bot-note"]).build());
    }
    fn clear(&self) {
        let rows = self.rows.take();
        if let Some(group) = self.group.upgrade() {
            for row in rows {
                group.remove(&row);
            }
        }
    }
}

/// The page's state, shared by the subpages it opens.
#[derive(Clone)]
struct Ctx {
    host: Host,
    session: Arc<NativeSession>,
    list: Rc<Rows>,
    reference: Rc<RefCell<Option<BotReference>>>,
    /// The Security category, where a recent sign-in is made; None without one.
    security: Option<&'static str>,
}

/// Runs bot work on tokio; `done` only while the settings are open.
fn spawn<T: Send + 'static>(
    host: &Host,
    work: impl std::future::Future<Output = T> + Send + 'static,
    done: impl FnOnce(T) + 'static,
) {
    let host = host.clone();
    glib::spawn_future_local(async move {
        let result = on_tokio(work).await;
        if host.alive() {
            done(result);
        }
    });
}

/// Asks before an action that cannot be taken back.
fn confirm(host: &Host, heading: &str, body: &str, action: &str, run: impl Fn() + 'static) {
    let Some(parent) = host.widget() else { return };
    let alert = adw::AlertDialog::builder()
        .heading(heading)
        .body(body)
        .default_response("cancel")
        .close_response("cancel")
        .css_classes(["alert", "bot-confirm"])
        .build();
    alert.add_responses(&[("cancel", t("actions.cancel")), ("confirm", action)]);
    alert.set_response_appearance("confirm", adw::ResponseAppearance::Destructive);
    alert.connect_response(Some("confirm"), move |_, _| run());
    widgets::present(&alert, Some(&parent));
}

/// The Bots category: my bots, then "Create a bot" when I may.
pub(super) fn page(host: &Host, session: Arc<NativeSession>, security: Option<&'static str>) -> adw::PreferencesPage {
    let page = adw::PreferencesPage::builder().css_classes(["native-bots"]).build();
    let group = adw::PreferencesGroup::builder().title(t("bots.title")).description(t("bots.intro")).build();
    let refresh = gtk::Button::builder()
        .icon_name("view-refresh-symbolic")
        .tooltip_text(t("security.refresh"))
        .valign(gtk::Align::Center)
        .css_classes(["flat"])
        .build();
    group.set_header_suffix(Some(&refresh));
    page.add(&group);
    let ctx = Ctx { host: host.clone(), session, list: Rows::new(&group), reference: Rc::default(), security };
    let again = ctx.clone();
    refresh.connect_clicked(move |_| reload(&again));
    reload(&ctx);
    page
}

/// Reads my bots, whether I may create one and the API reference again.
fn reload(ctx: &Ctx) {
    ctx.list.clear();
    ctx.list.note(t("bots.loading"));
    let s = ctx.session.clone();
    let c = ctx.clone();
    spawn(
        &ctx.host,
        async move {
            let mine = s.bots().await;
            let can = s.can_create_bot().await.unwrap_or(false);
            let reference = s.bot_reference().await.ok();
            (mine, can, reference)
        },
        move |(mine, can, reference)| {
            if reference.is_some() {
                c.reference.replace(reference);
            }
            c.list.clear();
            match mine {
                Err(error) => c.list.note(error_text(&error)),
                Ok(mine) => {
                    if mine.is_empty() {
                        c.list.note(t("bots.empty"));
                    }
                    for bot in mine {
                        c.list.add(&bot_row(&c, bot));
                    }
                }
            }
            if can {
                let create = adw::ButtonRow::builder()
                    .title(t("bots.create"))
                    .start_icon_name("list-add-symbolic")
                    .css_classes(["bot-create"])
                    .build();
                let again = c.clone();
                create.connect_activated(move |_| create_page(&again));
                c.list.add(&create);
            } else {
                c.list.note(t("bots.closed"));
            }
        },
    );
}

fn bot_row(ctx: &Ctx, bot: Bot) -> adw::ActionRow {
    let row = adw::ActionRow::builder()
        .title(&bot.user.display_name)
        .subtitle(format!("@{} · {}", bot.user.username, tn("bots.keys_count", i64::from(bot.live_keys))))
        .use_markup(false)
        .activatable(true)
        .css_classes(["bot-row"])
        .build();
    row.add_prefix(&widgets::tile(&bot.user.username, &widgets::initial(&bot.user.username), TileSize::Message, false));
    row.add_suffix(&widgets::bot_badge());
    if bot.disabled {
        row.add_suffix(&widgets::badge(t("bots.disabled"), "deactivated"));
    }
    row.add_suffix(&gtk::Image::from_icon_name("go-next-symbolic"));
    let c = ctx.clone();
    row.connect_activated(move |_| detail_page(&c, bot.clone()));
    row
}

/// One scope's API: its routes, method and path, as the server admits them.
fn api_rows(row: &adw::ExpanderRow, routes: Vec<BotRoute>) {
    row.set_enable_expansion(!routes.is_empty());
    for route in routes {
        row.add_row(
            &adw::ActionRow::builder()
                .title(format!("{} {}", route.method, route.path))
                .use_markup(false)
                .css_classes(["monospace", "bot-route"])
                .build(),
        );
    }
}

type Checks = Rc<Vec<(BotScope, gtk::CheckButton)>>;

/// The scopes to tick, each with its API, then what every key may do and
/// what stays closed.
fn scope_group(reference: Option<&BotReference>, selected: &[BotScope]) -> (adw::PreferencesGroup, Checks) {
    let group = adw::PreferencesGroup::builder().title(t("bots.scopes")).css_classes(["bot-scopes"]).build();
    let mut checks = Vec::new();
    for scope in BotScope::ALL {
        let row = adw::ExpanderRow::builder()
            .title(t(bots::scope_key(scope)))
            .subtitle(format!("{} · {}", scope.as_str(), t("bots.api")))
            .title_lines(3)
            .build();
        let check = gtk::CheckButton::builder()
            .active(selected.contains(&scope))
            .valign(gtk::Align::Center)
            .css_classes(["bot-scope"])
            .build();
        check.set_widget_name(scope.as_str());
        row.add_prefix(&check);
        api_rows(&row, reference.map(|r| bots::routes(r, Some(scope))).unwrap_or_default());
        group.add(&row);
        checks.push((scope, check));
    }
    let always =
        adw::ExpanderRow::builder().title(t("bots.scope.always")).subtitle(t("bots.api")).title_lines(3).build();
    always.add_prefix(&gtk::Image::from_icon_name("object-select-symbolic"));
    api_rows(&always, reference.map(|r| bots::routes(r, None)).unwrap_or_default());
    group.add(&always);
    let mut closed = t("bots.closed_routes").to_owned();
    if let Some(r) = reference {
        closed.push(' ');
        closed.push_str(&tf(
            "bots.budgets",
            &[("sends", &r.sends_per_minute.to_string()), ("direct", &r.direct_per_minute.to_string())],
        ));
    }
    group.set_description(Some(&closed));
    (group, Rc::new(checks))
}

fn chosen(checks: &Checks) -> Vec<BotScope> {
    checks.iter().filter(|(_, check)| check.is_active()).map(|(scope, _)| *scope).collect()
}

/// The form of a new bot: username, display name, description, scopes.
fn create_page(ctx: &Ctx) {
    let page = adw::PreferencesPage::builder().css_classes(["native-bot-create"]).build();
    let fields = adw::PreferencesGroup::new();
    let username = adw::EntryRow::builder().title(t("bots.username")).css_classes(["bot-username"]).build();
    let name = adw::EntryRow::builder().title(t("bots.display_name")).build();
    let description = adw::EntryRow::builder().title(t("bots.description")).build();
    fields.add(&username);
    fields.add(&name);
    fields.add(&description);
    page.add(&fields);
    let (scopes, checks) = scope_group(ctx.reference.borrow().as_ref(), &[]);
    page.add(&scopes);
    let actions = adw::PreferencesGroup::new();
    let create = adw::ButtonRow::builder()
        .title(t("bots.create"))
        .css_classes(["suggested-action", "bot-create-submit"])
        .build();
    actions.add(&create);
    page.add(&actions);
    let shown = ctx.host.push(t("bots.create"), &page).downgrade();
    let c = ctx.clone();
    create.connect_activated(move |button| {
        let (s, chosen) = (c.session.clone(), chosen(&checks));
        let (user, display, about) =
            (username.text().to_string(), name.text().to_string(), description.text().to_string());
        button.set_sensitive(false);
        let (c, button, shown) = (c.clone(), button.clone(), shown.clone());
        spawn(&c.host.clone(), async move { s.create_bot(&user, &display, &about, &chosen).await }, move |result| {
            button.set_sensitive(true);
            match result {
                Ok(bot) => {
                    if let Some(shown) = shown.upgrade() {
                        c.host.pop_if(&shown);
                    }
                    reload(&c);
                    detail_page(&c, bot);
                }
                Err(error) => c.host.toast(error_text(&error)),
            }
        });
    });
}

/// One bot: its description and scopes, its keys, and its deletion.
fn detail_page(ctx: &Ctx, bot: Bot) {
    let page = adw::PreferencesPage::builder().css_classes(["native-bot"]).build();
    let id = bot.user.id.clone();

    let about =
        adw::PreferencesGroup::builder().description(tf("bots.owner", &[("owner", &bot.owner.username)])).build();
    let description = adw::EntryRow::builder()
        .title(t("bots.description"))
        .text(&bot.description)
        .css_classes(["bot-description"])
        .build();
    about.add(&description);
    if bot.disabled {
        about.set_header_suffix(Some(&widgets::badge(t("bots.disabled"), "deactivated")));
    }
    page.add(&about);
    let (scopes, checks) = scope_group(ctx.reference.borrow().as_ref(), &bot.scopes);
    page.add(&scopes);
    let save =
        adw::ButtonRow::builder().title(t("settings.save")).css_classes(["suggested-action", "bot-save"]).build();
    scopes.add(&save);
    let (c, bot_id) = (ctx.clone(), id.clone());
    save.connect_activated(move |button| {
        let (s, id, chosen) = (c.session.clone(), bot_id.clone(), chosen(&checks));
        let text = description.text().to_string();
        button.set_sensitive(false);
        let (c, button) = (c.clone(), button.clone());
        spawn(&c.host.clone(), async move { s.update_bot(&id, Some(&text), Some(&chosen)).await }, move |result| {
            button.set_sensitive(true);
            match result {
                Ok(_) => {
                    c.host.toast(t("bots.saved"));
                    reload(&c);
                }
                Err(error) => c.host.toast(error_text(&error)),
            }
        });
    });

    let keys = adw::PreferencesGroup::builder().title(t("bots.keys")).css_classes(["bot-keys"]).build();
    page.add(&keys);
    let list = Rows::new(&keys);
    let new_key = adw::PreferencesGroup::builder().title(t("bots.key_new")).build();
    let label = adw::EntryRow::builder().title(t("bots.key_label")).css_classes(["bot-key-label"]).build();
    let days = adw::SpinRow::with_range(0.0, f64::from(bots::KEY_DAYS), 1.0);
    days.set_title(t("bots.key_days"));
    days.set_value(0.0);
    let create = adw::ButtonRow::builder().title(t("bots.key_create")).css_classes(["bot-key-create"]).build();
    new_key.add(&label);
    new_key.add(&days);
    new_key.add(&create);
    if let Some(security) = ctx.security {
        let reauth = adw::ButtonRow::builder().title(t("security.verify")).css_classes(["bot-reauth"]).build();
        let host = ctx.host.clone();
        reauth.connect_activated(move |_| host.select(security));
        new_key.add(&reauth);
    }
    page.add(&new_key);
    load_keys(ctx, &id, &list);
    let (c, bot_id, rows) = (ctx.clone(), id.clone(), list.clone());
    create.connect_activated(move |button| {
        let (s, id) = (c.session.clone(), bot_id.clone());
        let name = label.text().to_string();
        let expiry = days.value().round() as u32;
        button.set_sensitive(false);
        let (c, button, rows, label, key_bot) =
            (c.clone(), button.clone(), rows.clone(), label.clone(), bot_id.clone());
        spawn(
            &c.host.clone(),
            async move { s.create_bot_key(&id, &name, (expiry > 0).then_some(expiry)).await },
            move |result| {
                button.set_sensitive(true);
                match result {
                    Ok(created) => {
                        label.set_text("");
                        show_key(&c.host, created, &c.session.info.base_url);
                        load_keys(&c, &key_bot, &rows);
                        reload(&c);
                    }
                    Err(error) => c.host.toast(error_text(&error)),
                }
            },
        );
    });

    let danger = adw::PreferencesGroup::new();
    let delete =
        adw::ButtonRow::builder().title(t("bots.delete")).css_classes(["destructive-action", "bot-delete"]).build();
    danger.add(&delete);
    page.add(&danger);
    let shown = ctx.host.push(&format!("@{}", bot.user.username), &page).downgrade();
    let (c, name) = (ctx.clone(), bot.user.username.clone());
    delete.connect_activated(move |_| {
        let (c, id, shown) = (c.clone(), id.clone(), shown.clone());
        let heading = tf("bots.delete_confirm", &[("name", &format!("@{name}"))]);
        confirm(&c.host.clone(), &heading, t("bots.delete_body"), t("bots.delete"), move || {
            let (s, id, c, shown) = (c.session.clone(), id.clone(), c.clone(), shown.clone());
            spawn(&c.host.clone(), async move { s.delete_bot(&id).await }, move |result| match result {
                Ok(()) => {
                    if let Some(shown) = shown.upgrade() {
                        c.host.pop_if(&shown);
                    }
                    reload(&c);
                }
                Err(error) => c.host.toast(error_text(&error)),
            });
        });
    });
}

fn load_keys(ctx: &Ctx, bot: &str, rows: &Rc<Rows>) {
    rows.clear();
    rows.note(t("crypto.loading"));
    let (s, id) = (ctx.session.clone(), bot.to_owned());
    let (c, rows, bot) = (ctx.clone(), rows.clone(), bot.to_owned());
    spawn(&ctx.host, async move { s.bot_keys(&id).await }, move |result| {
        rows.clear();
        match result {
            Err(error) => rows.note(error_text(&error)),
            Ok(keys) => {
                if keys.is_empty() {
                    rows.note(t("bots.no_keys"));
                }
                for key in keys {
                    rows.add(&key_row(&c, &bot, &rows, key));
                }
            }
        }
    });
}

fn key_row(ctx: &Ctx, bot: &str, rows: &Rc<Rows>, key: BotKey) -> adw::ExpanderRow {
    let row = adw::ExpanderRow::builder()
        .title(glib::markup_escape_text(&key.label))
        .subtitle(format!("…{}", key.hint))
        .css_classes(["bot-key-row"])
        .build();
    let expires = key.expires_at.as_deref().map_or_else(|| t("bots.key_never").to_owned(), when);
    let used = key.last_used_at.as_deref().map_or_else(|| t("bots.key_unused").to_owned(), when);
    for (title, value) in
        [("bots.key_created", when(&key.created_at)), ("bots.key_expires", expires), ("bots.key_used", used)]
    {
        row.add_row(&adw::ActionRow::builder().title(t(title)).subtitle(value).use_markup(false).build());
    }
    let revoke = adw::ButtonRow::builder()
        .title(t("bots.key_revoke"))
        .css_classes(["destructive-action", "bot-key-revoke"])
        .build();
    let (c, bot, rows, id) = (ctx.clone(), bot.to_owned(), rows.clone(), key.id);
    revoke.connect_activated(move |_| {
        let (c, bot, rows, id) = (c.clone(), bot.clone(), rows.clone(), id.clone());
        confirm(
            &c.host.clone(),
            t("bots.key_revoke_confirm"),
            t("bots.key_revoke_body"),
            t("bots.key_revoke"),
            move || {
                let (s, c, bot, rows, id) = (c.session.clone(), c.clone(), bot.clone(), rows.clone(), id.clone());
                let target = bot.clone();
                spawn(
                    &c.host.clone(),
                    async move { s.revoke_bot_key(&target, &id).await },
                    move |result| match result {
                        Ok(()) => {
                            load_keys(&c, &bot, &rows);
                            reload(&c);
                        }
                        Err(error) => c.host.toast(error_text(&error)),
                    },
                );
            },
        );
    });
    row.add_row(&revoke);
    row
}

/// A text to select and copy, monospace, with its Copy button.
fn copyable(text: &str, class: &str) -> gtk::Box {
    let line = gtk::Box::builder().spacing(8).build();
    line.append(
        &gtk::Label::builder()
            .label(text)
            .selectable(true)
            .wrap(true)
            .wrap_mode(gtk::pango::WrapMode::Char)
            .xalign(0.0)
            .hexpand(true)
            .css_classes(["monospace", class])
            .build(),
    );
    let copy = gtk::Button::builder()
        .icon_name("edit-copy-symbolic")
        .tooltip_text(t("actions.copy"))
        .valign(gtk::Align::Start)
        .css_classes(["flat", "bot-copy"])
        .build();
    let text = text.to_owned();
    copy.connect_clicked(move |button| {
        button.clipboard().set_text(&text);
        button.set_icon_name("object-select-symbolic");
        button.set_tooltip_text(Some(t("actions.copied")));
    });
    line.append(&copy);
    line
}

/// The new key, once: copy it now, it will not be shown again. The text
/// lives only in this dialog's widgets.
fn show_key(host: &Host, created: BotKeyCreated, base_url: &str) {
    let Some(parent) = host.widget() else { return };
    let content = gtk::Box::builder()
        .orientation(gtk::Orientation::Vertical)
        .spacing(12)
        .margin_top(18)
        .margin_bottom(24)
        .margin_start(24)
        .margin_end(24)
        .css_classes(["bot-key-dialog"])
        .build();
    content.append(
        &gtk::Label::builder()
            .label(t("bots.key_once"))
            .wrap(true)
            .xalign(0.0)
            .css_classes(["bot-key-warning"])
            .build(),
    );
    content.append(&copyable(&created.key, "bot-key"));
    content.append(&gtk::Label::builder().label(t("bots.example")).xalign(0.0).css_classes(["heading"]).build());
    content.append(&copyable(&bots::example(base_url, &created.key), "bot-example"));
    content.append(
        &gtk::Label::builder().label(t("bots.example_hint")).wrap(true).xalign(0.0).css_classes(["dim-label"]).build(),
    );
    let view = adw::ToolbarView::new();
    view.add_top_bar(&adw::HeaderBar::new());
    view.set_content(Some(
        &gtk::ScrolledWindow::builder()
            .hscrollbar_policy(gtk::PolicyType::Never)
            .propagate_natural_height(true)
            .child(&content)
            .build(),
    ));
    let dialog = adw::Dialog::builder().title(t("bots.key_title")).content_width(560).child(&view).build();
    widgets::present(&dialog, Some(&parent));
}
