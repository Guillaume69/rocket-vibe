//! Animated GIFs as whole RGBA frames, each already composited over the ones
//! before it, the way a browser shows them.

pub struct Frame {
    pub rgba: Vec<u8>,
    pub delay_ms: u32,
}

pub struct Animation {
    pub width: u32,
    pub height: u32,
    pub frames: Vec<Frame>,
}

pub fn is_gif(bytes: &[u8]) -> bool {
    bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a")
}

/// Browsers play a delay of 0 or 10 ms at 100 ms; so do we.
fn delay_ms(hundredths: u16) -> u32 {
    match u32::from(hundredths) * 10 {
        0..=10 => 100,
        ms => ms,
    }
}

/// Every frame, or only the first once they would take more than `budget`
/// bytes together. None when the bytes are not a GIF.
pub fn decode(bytes: &[u8], budget: usize) -> Option<Animation> {
    if !is_gif(bytes) {
        return None;
    }
    let mut options = gif::DecodeOptions::new();
    options.set_color_output(gif::ColorOutput::RGBA);
    let mut decoder = options.read_info(bytes).ok()?;
    let (width, height) = (usize::from(decoder.width()), usize::from(decoder.height()));
    if width == 0 || height == 0 {
        return None;
    }
    let size = width * height * 4;
    let mut canvas = vec![0u8; size];
    let mut frames = Vec::new();
    while let Ok(Some(frame)) = decoder.read_next_frame() {
        let (left, top) = (usize::from(frame.left), usize::from(frame.top));
        let (fw, fh) = (usize::from(frame.width), usize::from(frame.height));
        let before = (frame.dispose == gif::DisposalMethod::Previous).then(|| canvas.clone());
        for y in 0..fh {
            for x in 0..fw {
                let (cx, cy) = (left + x, top + y);
                let from = (y * fw + x) * 4;
                let Some(pixel) = frame.buffer.get(from..from + 4) else { continue };
                if pixel[3] == 0 || cx >= width || cy >= height {
                    continue;
                }
                let to = (cy * width + cx) * 4;
                canvas[to..to + 4].copy_from_slice(pixel);
            }
        }
        frames.push(Frame { rgba: canvas.clone(), delay_ms: delay_ms(frame.delay) });
        if (frames.len() + 1) * size > budget {
            frames.truncate(1);
            break;
        }
        match frame.dispose {
            gif::DisposalMethod::Background => {
                for y in top..(top + fh).min(height) {
                    let row = y * width * 4;
                    let (a, b) = (row + left * 4, row + (left + fw).min(width) * 4);
                    if a < b {
                        canvas[a..b].fill(0);
                    }
                }
            }
            gif::DisposalMethod::Previous => {
                if let Some(before) = before {
                    canvas = before;
                }
            }
            _ => {}
        }
    }
    if frames.is_empty() {
        return None;
    }
    Some(Animation { width: width as u32, height: height as u32, frames })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Two 2×1 frames: red then, over it, a green pixel on the right only.
    fn sample(dispose: gif::DisposalMethod) -> Vec<u8> {
        let mut out = Vec::new();
        {
            let palette = [255, 0, 0, 0, 255, 0, 0, 0, 0];
            let mut encoder = gif::Encoder::new(&mut out, 2, 1, &palette).unwrap();
            encoder.set_repeat(gif::Repeat::Infinite).unwrap();
            let mut first = gif::Frame::from_indexed_pixels(2, 1, vec![0, 0], None);
            first.delay = 0;
            first.dispose = dispose;
            encoder.write_frame(&first).unwrap();
            let mut second = gif::Frame::from_indexed_pixels(1, 1, vec![1], None);
            second.left = 1;
            second.delay = 25;
            encoder.write_frame(&second).unwrap();
        }
        out
    }

    #[test]
    fn frames_build_on_the_ones_before() {
        let animation = decode(&sample(gif::DisposalMethod::Keep), usize::MAX).unwrap();
        assert_eq!((animation.width, animation.height), (2, 1));
        assert_eq!(animation.frames.len(), 2);
        assert_eq!(animation.frames[0].rgba, [255, 0, 0, 255, 255, 0, 0, 255]);
        assert_eq!(animation.frames[1].rgba, [255, 0, 0, 255, 0, 255, 0, 255]);
        assert_eq!(animation.frames[0].delay_ms, 100);
        assert_eq!(animation.frames[1].delay_ms, 250);
    }

    #[test]
    fn a_frame_disposed_to_the_background_is_cleared() {
        let animation = decode(&sample(gif::DisposalMethod::Background), usize::MAX).unwrap();
        assert_eq!(animation.frames[1].rgba, [0, 0, 0, 0, 0, 255, 0, 255]);
    }

    #[test]
    fn over_budget_only_the_first_frame_stays() {
        let animation = decode(&sample(gif::DisposalMethod::Keep), 8).unwrap();
        assert_eq!(animation.frames.len(), 1);
    }

    #[test]
    fn other_bytes_are_not_a_gif() {
        assert!(decode(b"\x89PNG\r\n", usize::MAX).is_none());
        assert!(!is_gif(b"GIF"));
    }
}
