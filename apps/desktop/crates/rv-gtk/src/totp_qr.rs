//! The QR code of an authenticator setup link, drawn black on white whatever the theme.
use gtk::prelude::*;
use qrcode::{Color, EcLevel, QrCode};

pub(crate) const QUIET_ZONE: usize = 4;
const MODULE_PIXELS: usize = 4;

pub(crate) struct Matrix {
    pub(crate) width: usize,
    dark: Vec<bool>,
}

impl Matrix {
    pub(crate) fn totp(uri: &str) -> Option<Self> {
        if !uri.starts_with("otpauth://totp/") {
            return None;
        }
        let code = QrCode::with_error_correction_level(uri.as_bytes(), EcLevel::M).ok()?;
        let inner = code.width();
        let width = inner + 2 * QUIET_ZONE;
        let mut dark = vec![false; width * width];
        for (index, color) in code.to_colors().into_iter().enumerate() {
            let (x, y) = (index % inner, index / inner);
            dark[(y + QUIET_ZONE) * width + x + QUIET_ZONE] = color == Color::Dark;
        }
        Some(Self { width, dark })
    }

    pub(crate) fn dark(&self, x: usize, y: usize) -> bool {
        self.dark[y * self.width + x]
    }
}

pub(crate) fn area(label: &str) -> gtk::DrawingArea {
    let area = gtk::DrawingArea::builder()
        .accessible_role(gtk::AccessibleRole::Img)
        .halign(gtk::Align::Center)
        .margin_top(12)
        .margin_bottom(12)
        .css_classes(["native-security-qr"])
        .visible(false)
        .build();
    area.update_property(&[gtk::accessible::Property::Label(label)]);
    area
}

pub(crate) fn show(area: &gtk::DrawingArea, uri: Option<&str>) {
    let matrix = uri.and_then(Matrix::totp);
    let side = matrix.as_ref().map_or(0, |m| (m.width * MODULE_PIXELS) as i32);
    area.set_content_width(side);
    area.set_content_height(side);
    area.set_visible(matrix.is_some());
    area.set_draw_func(move |_, cr, width, height| {
        if let Some(matrix) = &matrix {
            paint(matrix, cr, width, height);
        }
    });
}

fn paint(matrix: &Matrix, cr: &gtk::cairo::Context, width: i32, height: i32) {
    let module = (width.min(height) as usize / matrix.width).max(1) as f64;
    let side = module * matrix.width as f64;
    let (left, top) = (((width as f64 - side) / 2.0).floor(), ((height as f64 - side) / 2.0).floor());
    cr.set_antialias(gtk::cairo::Antialias::None);
    cr.set_source_rgb(1.0, 1.0, 1.0);
    cr.rectangle(left, top, side, side);
    let _ = cr.fill();
    cr.set_source_rgb(0.0, 0.0, 0.0);
    for y in 0..matrix.width {
        for x in 0..matrix.width {
            if matrix.dark(x, y) {
                cr.rectangle(left + x as f64 * module, top + y as f64 * module, module, module);
            }
        }
    }
    let _ = cr.fill();
}
