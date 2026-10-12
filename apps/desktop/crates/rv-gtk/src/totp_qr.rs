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

#[cfg(test)]
mod tests {
    use super::*;

    const URI: &str = "otpauth://totp/RocketVibe-0a1b2c3d:ada?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=RocketVibe-0a1b2c3d&algorithm=SHA1&digits=6&period=30";

    #[test]
    fn a_setup_link_encodes_to_a_version_8_symbol_with_a_quiet_zone() {
        let matrix = Matrix::totp(URI).unwrap();
        assert_eq!(matrix.width, 17 + 4 * 8 + 2 * QUIET_ZONE);
        for i in 0..QUIET_ZONE {
            for j in 0..matrix.width {
                for (x, y) in [(i, j), (j, i), (matrix.width - 1 - i, j), (j, matrix.width - 1 - i)] {
                    assert!(!matrix.dark(x, y));
                }
            }
        }
        let finder: Vec<String> = (0..7)
            .map(|y| (0..7).map(|x| if matrix.dark(x + QUIET_ZONE, y + QUIET_ZONE) { '1' } else { '0' }).collect())
            .collect();
        assert_eq!(finder, ["1111111", "1000001", "1011101", "1011101", "1011101", "1000001", "1111111"]);
    }

    #[test]
    fn only_otpauth_totp_links_are_drawn() {
        assert!(Matrix::totp("https://example.com/").is_none());
        assert!(Matrix::totp("otpauth://hotp/x?secret=A").is_none());
    }

    #[test]
    fn paint_puts_every_module_on_whole_pixels() {
        let matrix = Matrix::totp(URI).unwrap();
        let side = (matrix.width * MODULE_PIXELS) as i32;
        let mut surface = gtk::cairo::ImageSurface::create(gtk::cairo::Format::Rgb24, side, side).unwrap();
        {
            let cr = gtk::cairo::Context::new(&surface).unwrap();
            paint(&matrix, &cr, side, side);
        }
        surface.flush();
        let stride = surface.stride() as usize;
        let data = surface.data().unwrap();
        for y in 0..matrix.width {
            for x in 0..matrix.width {
                for (dx, dy) in [(0, 0), (MODULE_PIXELS - 1, MODULE_PIXELS - 1)] {
                    let (px, py) = (x * MODULE_PIXELS + dx, y * MODULE_PIXELS + dy);
                    let blue = data[py * stride + px * 4];
                    assert_eq!(blue, if matrix.dark(x, y) { 0 } else { 255 }, "module {x},{y}");
                }
            }
        }
    }
}
