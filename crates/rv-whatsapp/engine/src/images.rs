//! The pictures the engine makes: an attachment's preview and a link's
//! thumbnails, as JPEG.

use std::io::Cursor;

use image::codecs::jpeg::JpegEncoder;
use image::{DynamicImage, ImageReader, Limits};

pub fn decode(data: &[u8]) -> Option<DynamicImage> {
    let mut limits = Limits::default();
    limits.max_image_width = Some(16_384);
    limits.max_image_height = Some(16_384);
    limits.max_alloc = Some(256 << 20);
    let mut reader = ImageReader::new(Cursor::new(data))
        .with_guessed_format()
        .ok()?;
    reader.limits(limits);
    reader
        .decode()
        .ok()
        .filter(|i| i.width() > 0 && i.height() > 0)
}

/// A JPEG of the image within `side` x `side` pixels, and its size.
pub fn scaled_jpeg(image: &DynamicImage, side: u32, quality: u8) -> Option<(Vec<u8>, u32, u32)> {
    let scaled = if image.width().max(image.height()) > side {
        image.thumbnail(side, side)
    } else {
        image.clone()
    };
    let rgb = scaled.to_rgb8();
    let mut out = Vec::new();
    JpegEncoder::new_with_quality(&mut out, quality)
        .encode_image(&rgb)
        .ok()?;
    Some((out, rgb.width(), rgb.height()))
}

/// An image's size and the small JPEG WhatsApp shows before a download.
pub fn preview(data: &[u8]) -> (i64, i64, Vec<u8>) {
    let Some(image) = decode(data) else {
        return (0, 0, Vec::new());
    };
    let thumb = scaled_jpeg(&image, 96, 60)
        .map(|(jpeg, _, _)| jpeg)
        .unwrap_or_default();
    (image.width().into(), image.height().into(), thumb)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_preview_fits_its_box_and_keeps_the_size() {
        let image = DynamicImage::new_rgb8(400, 200);
        let mut png = Vec::new();
        image
            .write_to(&mut Cursor::new(&mut png), image::ImageFormat::Png)
            .unwrap();
        let (w, h, thumb) = preview(&png);
        assert_eq!((w, h), (400, 200));
        let small = decode(&thumb).unwrap();
        assert_eq!((small.width(), small.height()), (96, 48));
        assert_eq!(preview(b"not an image"), (0, 0, Vec::new()));
        let (_, w, h) = scaled_jpeg(&DynamicImage::new_rgb8(10, 20), 720, 80).unwrap();
        assert_eq!((w, h), (10, 20), "never enlarged");
    }
}
