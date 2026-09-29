//! Where a packaged app keeps the data it carries beside its binary: the
//! Windows folder's `share`, the macOS bundle's `Resources/share`, the
//! AppImage's `share` (sharun names its root in `SHARUN_DIR`).

use std::path::PathBuf;

pub fn share_dirs() -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = ["SHARUN_DIR", "APPDIR"]
        .into_iter()
        .filter_map(std::env::var_os)
        .filter(|root| !root.is_empty())
        .map(|root| PathBuf::from(root).join("share"))
        .collect();
    if let Some(bin) = std::env::current_exe().ok().and_then(|exe| exe.parent().map(std::path::Path::to_path_buf)) {
        dirs.extend([bin.join("../share"), bin.join("../Resources/share")]);
    }
    dirs.dedup();
    dirs
}
