//! The text zoom (Ctrl or Cmd with +, -, 0 or the mouse wheel), in percent, in
//! a file of the config dir GTK and SwiftUI share. The steps are a browser's.

use std::path::Path;

const FILE: &str = "zoom";
const STEPS: [u32; 10] = [67, 75, 80, 90, 100, 110, 125, 150, 175, 200];
pub const DEFAULT: u32 = 100;

/// The saved zoom, the default when none is saved or the file holds no step.
pub fn load(config: &Path) -> u32 {
    std::fs::read_to_string(config.join(FILE))
        .ok()
        .and_then(|text| text.trim().parse().ok())
        .filter(|percent| STEPS.contains(percent))
        .unwrap_or(DEFAULT)
}

/// Saves the zoom; the default leaves no file behind.
pub fn save(config: &Path, percent: u32) {
    if percent == DEFAULT {
        let _ = std::fs::remove_file(config.join(FILE));
    } else if std::fs::create_dir_all(config).is_ok() {
        let _ = std::fs::write(config.join(FILE), percent.to_string());
    }
}

/// The step after `percent`, larger when `zoom_in`; the same at either end.
pub fn step(percent: u32, zoom_in: bool) -> u32 {
    if zoom_in {
        STEPS.into_iter().find(|&s| s > percent).unwrap_or(STEPS[STEPS.len() - 1])
    } else {
        STEPS.into_iter().rev().find(|&s| s < percent).unwrap_or(STEPS[0])
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn steps_stop_at_either_end() {
        assert_eq!(step(100, true), 110);
        assert_eq!(step(100, false), 90);
        assert_eq!(step(200, true), 200);
        assert_eq!(step(67, false), 67);
        assert_eq!(step(105, true), 110, "between two steps");
        assert_eq!(step(105, false), 100);
    }

    #[test]
    fn the_saved_zoom_is_read_back_and_the_default_leaves_no_file() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(load(dir.path()), DEFAULT);
        save(dir.path(), 125);
        assert_eq!(load(dir.path()), 125);
        save(dir.path(), DEFAULT);
        assert!(!dir.path().join(FILE).exists());
        std::fs::write(dir.path().join(FILE), "123").unwrap();
        assert_eq!(load(dir.path()), DEFAULT, "not a step");
    }
}
