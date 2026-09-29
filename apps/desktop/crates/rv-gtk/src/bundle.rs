//! Where a packaged app keeps the data it carries beside its binary: the
//! Windows folder's `share`, the macOS bundle's `Resources/share`.

use std::path::PathBuf;

pub fn share_dirs() -> Vec<PathBuf> {
    let Some(bin) = std::env::current_exe().ok().and_then(|exe| exe.parent().map(std::path::Path::to_path_buf)) else {
        return Vec::new();
    };
    vec![bin.join("../share"), bin.join("../Resources/share")]
}
