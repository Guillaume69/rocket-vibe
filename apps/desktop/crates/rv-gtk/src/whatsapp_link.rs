//! Adding a WhatsApp account: a dialog showing the QR the phone scans, on a
//! new sealed state; and the one-time adoption of the device the pilot window
//! linked, without a new scan.
use std::cell::{Cell, RefCell};
use std::rc::Rc;
use std::sync::Arc;
use std::time::Duration;

use adw::prelude::*;
use gtk::glib;
use rv_core::session::SessionInfo;
use rv_core::whatsapp::{self, Connector};

use crate::i18n::t;
use crate::on_tokio;

fn data_dir() -> std::path::PathBuf {
    glib::user_data_dir().join("rocket-vibe-rs")
}

/// Opens the linking dialog; `done` gets the account once the phone linked it
/// and it is saved. Closing the dialog (Cancel, Escape, a click outside)
/// stops the attempt and erases its state.
pub fn open(parent: &impl IsA<gtk::Widget>, done: impl Fn(SessionInfo) + 'static) {
    let runner = whatsapp::Runner::from_env();
    let dialog = adw::Dialog::builder().title(t("wa.link_title")).content_width(420).build();
    let content = gtk::Box::builder()
        .orientation(gtk::Orientation::Vertical)
        .spacing(16)
        .margin_top(12)
        .margin_bottom(24)
        .margin_start(24)
        .margin_end(24)
        .build();
    content.append(
        &gtk::Label::builder()
            .label(t("wa.link_help"))
            .wrap(true)
            .justify(gtk::Justification::Center)
            .max_width_chars(48)
            .build(),
    );
    let qr = gtk::DrawingArea::builder().content_width(260).content_height(260).halign(gtk::Align::Center).build();
    qr.update_property(&[gtk::accessible::Property::Label(t("wa.qr"))]);
    qr.add_css_class("whatsapp-qr");
    content.append(&qr);
    let status = gtk::Label::builder().label(t("wa.connecting")).css_classes(["dim-label"]).wrap(true).build();
    content.append(&status);
    let refresh = gtk::Button::builder()
        .label(t("wa.reconnect"))
        .halign(gtk::Align::Center)
        .css_classes(["pill"])
        .visible(false)
        .build();
    content.append(&refresh);
    // Without a camera to scan with (or from the phone itself): a code instead.
    let by_number = gtk::Expander::builder().label(t("wa.pair_number")).build();
    let number_box = gtk::Box::builder().orientation(gtk::Orientation::Vertical).spacing(8).margin_top(8).build();
    number_box.append(
        &gtk::Label::builder()
            .label(t("wa.pair_number_help"))
            .wrap(true)
            .xalign(0.0)
            .css_classes(["dim-label", "caption"])
            .build(),
    );
    let number =
        gtk::Entry::builder().input_purpose(gtk::InputPurpose::Phone).placeholder_text("+33 6 12 34 56 78").build();
    let ask =
        gtk::Button::builder().label(t("wa.pair_number_ask")).css_classes(["pill"]).halign(gtk::Align::Center).build();
    let code =
        gtk::Label::builder().selectable(true).css_classes(["title-1", "whatsapp-pairing-code"]).visible(false).build();
    let code_help = gtk::Label::builder()
        .label(t("wa.pair_code_help"))
        .wrap(true)
        .justify(gtk::Justification::Center)
        .visible(false)
        .build();
    number_box.append(&number);
    number_box.append(&ask);
    number_box.append(&code);
    number_box.append(&code_help);
    by_number.set_child(Some(&number_box));
    content.append(&by_number);
    content.append(
        &gtk::Label::builder()
            .label(t("wa.local"))
            .wrap(true)
            .max_width_chars(48)
            .css_classes(["dim-label", "caption"])
            .build(),
    );
    let toolbar = adw::ToolbarView::new();
    toolbar.add_top_bar(&adw::HeaderBar::new());
    toolbar.set_content(Some(&content));
    dialog.set_child(Some(&toolbar));

    let state = match whatsapp::new_state_id() {
        Ok(state) => state,
        Err(_) => return,
    };
    let connector: Rc<RefCell<Option<Arc<Connector>>>> = Rc::default();
    let linked = Rc::new(Cell::new(false));
    let closed = Rc::new(Cell::new(false));
    let done = Rc::new(done);

    let (c, entry) = (connector.clone(), number.clone());
    ask.connect_clicked(move |button| {
        let digits: String = entry.text().chars().filter(char::is_ascii_digit).collect();
        if let Some(connector) = c.borrow().as_ref()
            && !digits.is_empty()
            && connector.pair_phone(digits).is_ok()
        {
            button.set_sensitive(false);
        }
    });
    let c = connector.clone();
    refresh.connect_clicked(move |button| {
        button.set_visible(false);
        if let Some(connector) = c.borrow().as_ref() {
            let _ = connector.reconnect();
        }
    });
    let (c, l, cl, s) = (connector.clone(), linked.clone(), closed.clone(), state.clone());
    dialog.connect_closed(move |_| {
        cl.set(true);
        if l.get() {
            return;
        }
        // Abandoned: the helper stops and the half-made state goes.
        let connector = c.borrow_mut().take();
        let info = whatsapp::account_info(&s, "", "");
        glib::spawn_future_local(async move {
            if let Some(connector) = connector {
                connector.stop();
                exited(&connector).await;
            }
            on_tokio(async move { crate::secrets::forget_whatsapp(&info).await }).await;
        });
    });
    crate::widgets::present(&dialog, Some(parent));

    let dialog_weak = dialog.downgrade();
    glib::spawn_future_local(async move {
        let (path, entry) = whatsapp::state_location(&data_dir(), &state);
        let started = on_tokio(async move {
            let key = crate::secrets::whatsapp_key(&entry, false).await?;
            Connector::start(&runner, &path, key).await
        })
        .await;
        let started = match started {
            Ok(started) => started,
            Err(_) => {
                status.set_label(t("wa.start_failed"));
                return;
            }
        };
        if closed.get() {
            started.stop();
            return;
        }
        connector.replace(Some(started.clone()));
        let mut changes = started.subscribe();
        let mut shown: Option<String> = None;
        loop {
            let s = started.snapshot();
            if let Some((code, _)) = &s.qr {
                if shown.as_ref() != Some(code) {
                    show_qr(&qr, code);
                    shown = Some(code.clone());
                }
                qr.set_visible(true);
            } else {
                qr.set_visible(false);
            }
            if let Some(pairing) = &s.pairing_code {
                // Shown as WhatsApp shows it: two groups of four.
                let shown =
                    if pairing.len() == 8 { format!("{}-{}", &pairing[..4], &pairing[4..]) } else { pairing.clone() };
                code.set_label(&shown);
                code.set_visible(true);
                code_help.set_visible(true);
            }
            if matches!(s.error.as_deref(), Some("phone_invalid" | "pairing_code_failed")) {
                ask.set_sensitive(true);
            }
            let label = match s.error.as_deref() {
                Some("client_outdated") => t("wa.client_outdated"),
                Some(code @ ("phone_invalid" | "pairing_code_failed")) => t(&format!("wa.{code}")),
                Some(_) if s.state == "error" => t("wa.connection_failed"),
                _ => t(&format!("wa.{}", s.state)),
            };
            status.set_label(label);
            refresh.set_visible(matches!(s.state.as_str(), "qr_expired" | "error" | "offline"));
            if let Some((jid, name)) = s.account.clone()
                && s.state == "connected"
            {
                let info = whatsapp::account_info(&state, &jid, &name);
                let saved = info.clone();
                on_tokio(async move { crate::secrets::save(&saved).await }).await;
                rv_core::whatsapp_session::handoff(&state, started.clone());
                linked.set(true);
                if let Some(dialog) = dialog_weak.upgrade() {
                    dialog.close();
                }
                done(info);
                return;
            }
            if s.exited || closed.get() {
                return;
            }
            if changes.changed().await.is_err() {
                return;
            }
        }
    });
}

/// The device the pilot window linked, made an account once: its state and
/// key stay where they are. None when there is none, it is adopted already,
/// or it cannot start now (another app holds it, its key is missing): the
/// next launch tries again and nothing is deleted.
pub async fn adopt_pilot(accounts: &[SessionInfo]) -> Option<SessionInfo> {
    let runner = whatsapp::Runner::from_env();
    if accounts.iter().any(|a| whatsapp::state_id(&a.base_url) == Some(whatsapp::PILOT_STATE)) {
        return None;
    }
    let (path, entry) = whatsapp::state_location(&data_dir(), whatsapp::PILOT_STATE);
    if !path.exists() {
        return None;
    }
    on_tokio(async move {
        let key = crate::secrets::whatsapp_key(&entry, true).await.ok()?;
        let connector = Connector::start(&runner, &path, key).await.ok()?;
        let mut changes = connector.subscribe();
        let account = tokio::time::timeout(Duration::from_secs(20), async {
            loop {
                let s = connector.snapshot();
                if let Some(account) = s.account {
                    return Some(account);
                }
                if s.exited || s.qr.is_some() || s.state == "error" {
                    return None;
                }
                changes.changed().await.ok()?;
            }
        })
        .await
        .ok()
        .flatten();
        let Some((jid, name)) = account else {
            connector.stop();
            return None;
        };
        let info = whatsapp::account_info(whatsapp::PILOT_STATE, &jid, &name);
        crate::secrets::save(&info).await;
        rv_core::whatsapp_session::handoff(whatsapp::PILOT_STATE, connector);
        Some(info)
    })
    .await
}

async fn exited(connector: &Connector) {
    let mut changes = connector.subscribe();
    let _ = tokio::time::timeout(Duration::from_secs(8), async {
        while !connector.exited() {
            if changes.changed().await.is_err() {
                return;
            }
        }
    })
    .await;
}

pub fn show_qr(area: &gtk::DrawingArea, code: &str) {
    let Ok(qr) = qrcode::QrCode::new(code.as_bytes()) else { return };
    let width = qr.width();
    area.set_draw_func(move |_, cr, w, h| {
        cr.set_antialias(gtk::cairo::Antialias::None);
        let module = (w.min(h) as f64 / (width + 8) as f64).floor().max(1.0);
        let side = module * (width + 8) as f64;
        let x = ((w as f64 - side) / 2.0).floor();
        let y = ((h as f64 - side) / 2.0).floor();
        cr.set_source_rgb(1.0, 1.0, 1.0);
        cr.rectangle(x, y, side, side);
        let _ = cr.fill();
        cr.set_source_rgb(0.0, 0.0, 0.0);
        for row in 0..width {
            for col in 0..width {
                if qr[(col, row)] == qrcode::Color::Dark {
                    cr.rectangle(x + (col + 4) as f64 * module, y + (row + 4) as f64 * module, module, module);
                }
            }
        }
        let _ = cr.fill();
    });
    area.queue_draw();
}
