//! A newer release of the app: found at startup (every 6 hours at most) or on
//! demand, offered in a card, installed in place on Linux, through the
//! installer on Windows, and by opening the disk image on macOS, whose signed
//! bundle must never be patched.

use std::cell::RefCell;
use std::path::{Path, PathBuf};
use std::rc::Rc;

use gtk::glib;
use gtk::prelude::*;
use rv_core::update::{self, Checked, Platform, Release};

use crate::i18n::{t, tf};
use crate::on_tokio;

type Presenter = Rc<dyn Fn(Release)>;

thread_local! {
    static PRESENTER: RefCell<Option<Presenter>> = RefCell::default();
}

fn config_dir() -> PathBuf {
    glib::user_config_dir().join("rocket-vibe-rs")
}

fn cache_file() -> PathBuf {
    glib::user_cache_dir().join("rocket-vibe-rs").join("update.json")
}

fn off_file() -> PathBuf {
    config_dir().join("no-update-check")
}

pub fn automatic() -> bool {
    !off_file().exists()
}

pub fn set_automatic(on: bool) {
    if on {
        let _ = std::fs::remove_file(off_file());
    } else {
        let _ = std::fs::create_dir_all(config_dir());
        let _ = std::fs::write(off_file(), "");
    }
}

/// The version compared against; `RV_SMOKE_UPDATE_FROM` plays an older one.
pub fn running_version() -> String {
    std::env::var("RV_SMOKE_UPDATE_FROM").unwrap_or_else(|_| env!("CARGO_PKG_VERSION").to_owned())
}

fn load() -> Checked {
    std::fs::read_to_string(cache_file()).ok().and_then(|text| Checked::from_json(&text)).unwrap_or_default()
}

fn save(checked: &Checked) {
    let file = cache_file();
    if let Some(dir) = file.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let _ = std::fs::write(file, checked.to_json());
}

fn now_ms() -> i64 {
    glib::real_time() / 1000
}

/// Asks GitHub; the newer release, if any, is `Ok(Some)` even when dismissed.
pub async fn check() -> Result<Option<Release>, String> {
    let releases = on_tokio(update::fetch_releases()).await?;
    let latest = update::latest(&releases, Platform::current());
    let mut checked = load();
    checked.at_ms = now_ms();
    checked.latest = latest.clone();
    save(&checked);
    Ok(latest.filter(|r| update::is_newer(&r.version, &running_version())))
}

pub fn dismiss(version: &str) {
    let mut checked = load();
    checked.dismissed = Some(version.to_owned());
    save(&checked);
}

/// Where an offered release is shown; set once by the window.
pub fn set_presenter(present: impl Fn(Release) + 'static) {
    PRESENTER.with_borrow_mut(|p| *p = Some(Rc::new(present)));
}

pub fn present(release: Release) {
    if let Some(present) = PRESENTER.with_borrow(Clone::clone) {
        present(release);
    }
}

/// At startup: the cached offer at once, a fresh check when one is due.
pub fn startup() {
    if !automatic() {
        return;
    }
    let checked = load();
    let running = running_version();
    let shown = checked.offer(&running).cloned();
    if let Some(release) = shown.clone() {
        present(release);
    }
    if !checked.due(now_ms()) {
        return;
    }
    glib::spawn_future_local(async move {
        if let Err(e) = check().await {
            eprintln!("Update check failed: {e}");
            return;
        }
        if let Some(release) = load().offer(&running).filter(|r| shown.as_ref() != Some(r)) {
            present(release.clone());
        }
    });
}

/// What an update did, for the card to say.
pub enum Outcome {
    /// The new binary is in place: restart to run it.
    Replaced,
    /// The installer runs now: the app must quit.
    #[cfg_attr(not(windows), expect(dead_code))]
    InstallerStarted,
    /// The disk image is open for the user to copy the app.
    ImageOpened,
    /// Nothing to do here: the release page was opened instead.
    PageOpened,
}

fn staging_dir() -> PathBuf {
    glib::user_cache_dir().join("rocket-vibe-rs").join("update")
}

async fn fetch(url: String, dest: PathBuf, progress: impl Fn(f64) + 'static) -> Result<(), String> {
    let (sender, receiver) = async_channel::unbounded::<f64>();
    let shown = glib::spawn_future_local(async move {
        while let Ok(fraction) = receiver.recv().await {
            progress(fraction);
        }
    });
    let result = on_tokio(async move {
        update::download(&url, &dest, move |done, total| {
            if let Some(total) = total.filter(|t| *t > 0) {
                let _ = sender.try_send(done as f64 / total as f64);
            }
        })
        .await
    })
    .await;
    let _ = shown.await;
    result
}

/// The file named `name` in `dir` or one level below, as a release archive lays it out.
fn find_in(dir: &Path, name: &str) -> Option<PathBuf> {
    let direct = dir.join(name);
    if direct.is_file() {
        return Some(direct);
    }
    std::fs::read_dir(dir).ok()?.flatten().map(|e| e.path().join(name)).find(|p| p.is_file())
}

#[cfg(unix)]
fn make_executable(path: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755))
}

#[cfg(not(unix))]
fn make_executable(_path: &Path) -> std::io::Result<()> {
    Ok(())
}

/// The new binary written beside the running one, then renamed over it.
fn replace_running(new_binary: &Path) -> Result<(), String> {
    let exe = std::env::current_exe().and_then(std::fs::canonicalize).map_err(|e| e.to_string())?;
    let name = exe.file_name().ok_or("no binary name")?.to_string_lossy().into_owned();
    let staged = exe.with_file_name(format!(".{name}.new"));
    std::fs::copy(new_binary, &staged).map_err(|e| e.to_string())?;
    let replaced = make_executable(&staged).and_then(|()| std::fs::rename(&staged, &exe));
    if let Err(e) = replaced {
        let _ = std::fs::remove_file(&staged);
        return Err(e.to_string());
    }
    Ok(())
}

async fn install_archive(asset: &update::Asset, progress: impl Fn(f64) + 'static) -> Result<(), String> {
    let dir = staging_dir();
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let archive = dir.join(&asset.name);
    fetch(asset.url.clone(), archive.clone(), progress).await?;
    let unpacked = dir.join("unpacked");
    std::fs::create_dir_all(&unpacked).map_err(|e| e.to_string())?;
    let status = std::process::Command::new("tar")
        .arg("-xzf")
        .arg(&archive)
        .arg("-C")
        .arg(&unpacked)
        .status()
        .map_err(|e| e.to_string())?;
    if !status.success() {
        return Err(format!("tar: {status}"));
    }
    let binary = find_in(&unpacked, "rocket-vibe-gtk").ok_or("no binary in the archive")?;
    let result = replace_running(&binary);
    let _ = std::fs::remove_dir_all(&dir);
    result
}

/// An install made by the installer, which it can upgrade; not the zip.
#[cfg(windows)]
fn installed_by_setup() -> bool {
    std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent()?.parent().map(|app| app.join("unins000.exe")))
        .is_some_and(|uninstaller| uninstaller.exists())
}

#[cfg(windows)]
async fn run_installer(asset: &update::Asset, progress: impl Fn(f64) + 'static) -> Result<(), String> {
    let dir = std::env::temp_dir().join("rocket-vibe-update");
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let setup = dir.join(&asset.name);
    fetch(asset.url.clone(), setup.clone(), progress).await?;
    std::process::Command::new(&setup)
        .args(["/SILENT", "/SUPPRESSMSGBOXES", "/NORESTART", "/relaunch=1"])
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/// Downloads and installs `release` the way this platform can.
pub async fn install(
    widget: &gtk::Widget,
    release: &Release,
    progress: impl Fn(f64) + 'static,
) -> Result<Outcome, String> {
    let Some(asset) = release.asset.clone() else {
        crate::cards::open_uri(widget, &release.page);
        return Ok(Outcome::PageOpened);
    };
    match Platform::current() {
        Some(Platform::LinuxX86_64) => match install_archive(&asset, progress).await {
            Ok(()) => Ok(Outcome::Replaced),
            Err(e) => {
                eprintln!("In-place update failed: {e}");
                crate::cards::open_uri(widget, &release.page);
                Ok(Outcome::PageOpened)
            }
        },
        #[cfg(windows)]
        Some(Platform::WindowsX86_64) if installed_by_setup() => {
            run_installer(&asset, progress).await.map(|()| Outcome::InstallerStarted)
        }
        Some(Platform::MacosArm64) => {
            let image = crate::cards::download_path(&asset.name);
            fetch(asset.url.clone(), image.clone(), progress).await?;
            crate::cards::open_file(widget, &image, || {});
            Ok(Outcome::ImageOpened)
        }
        _ => {
            crate::cards::open_uri(widget, &release.page);
            Ok(Outcome::PageOpened)
        }
    }
}

/// Starts the freshly installed binary once this one is gone: a single
/// instance would otherwise hand the launch back to the process quitting.
pub fn relaunch() -> bool {
    let Ok(exe) = std::env::current_exe() else { return false };
    std::process::Command::new("sh").arg("-c").arg("sleep 1; exec \"$0\"").arg(exe).spawn().is_ok()
}

/// The card offering `release`. `quit` closes the app for a restart or the installer.
pub fn card(release: Release, quit: Rc<dyn Fn()>, close: Rc<dyn Fn()>) -> gtk::Widget {
    let title = gtk::Label::builder()
        .label(tf("update.available", &[("version", &release.version)]))
        .xalign(0.0)
        .wrap(true)
        .hexpand(true)
        .css_classes(["update-title"])
        .build();
    let dismiss_button = gtk::Button::builder()
        .icon_name("window-close-symbolic")
        .tooltip_text(t("update.later"))
        .valign(gtk::Align::Start)
        .css_classes(["flat", "circular", "update-close"])
        .build();
    let top = gtk::Box::builder().spacing(6).build();
    top.append(&title);
    top.append(&dismiss_button);
    let bar = gtk::ProgressBar::builder().visible(false).build();
    let install_label =
        if Platform::current() == Some(Platform::MacosArm64) { t("update.download") } else { t("update.install") };
    let install_button = gtk::Button::builder().label(install_label).css_classes(["update-install"]).build();
    let notes = gtk::Button::builder().label(t("update.notes")).css_classes(["flat", "update-notes"]).build();
    let buttons = gtk::Box::builder().spacing(6).build();
    buttons.append(&install_button);
    buttons.append(&notes);
    let card =
        gtk::Box::builder().orientation(gtk::Orientation::Vertical).spacing(8).css_classes(["update-card"]).build();
    card.append(&top);
    card.append(&bar);
    card.append(&buttons);

    let page = release.page.clone();
    notes.connect_clicked(move |button| crate::cards::open_uri(button, &page));
    let version = release.version.clone();
    dismiss_button.connect_clicked(move |_| {
        dismiss(&version);
        close();
    });
    let replaced = Rc::new(std::cell::Cell::new(false));
    install_button.connect_clicked(glib::clone!(
        #[weak]
        card,
        #[weak]
        title,
        #[weak]
        bar,
        move |button| {
            if replaced.get() {
                if relaunch() {
                    quit();
                }
                return;
            }
            button.set_sensitive(false);
            bar.set_visible(true);
            bar.set_fraction(0.0);
            title.set_label(&tf("update.downloading", &[("percent", "0")]));
            let (release, quit, replaced, button) = (release.clone(), quit.clone(), replaced.clone(), button.clone());
            glib::spawn_future_local(async move {
                let progress = glib::clone!(
                    #[weak]
                    bar,
                    #[weak]
                    title,
                    move |fraction: f64| {
                        bar.set_fraction(fraction);
                        let percent = format!("{}", (fraction * 100.0).round() as u32);
                        title.set_label(&tf("update.downloading", &[("percent", &percent)]));
                    }
                );
                let outcome = install(card.upcast_ref(), &release, progress).await;
                bar.set_visible(false);
                button.set_sensitive(true);
                match outcome {
                    Ok(Outcome::Replaced) => {
                        replaced.set(true);
                        title.set_label(t("update.installed"));
                        button.set_label(t("update.restart"));
                    }
                    Ok(Outcome::InstallerStarted) => quit(),
                    Ok(Outcome::ImageOpened) => title.set_label(t("update.dmg")),
                    Ok(Outcome::PageOpened) => {
                        title.set_label(&tf("update.available", &[("version", &release.version)]))
                    }
                    Err(e) => {
                        eprintln!("Update failed: {e}");
                        title.set_label(t("update.failed"));
                    }
                }
            });
        }
    ));
    card.upcast()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_binary_is_found_in_the_archive_folder() {
        let dir = std::env::temp_dir().join(format!("rv-update-test-{}", std::process::id()));
        let nested = dir.join("rocket-vibe-desktop-0.3.0-linux-x86_64");
        std::fs::create_dir_all(&nested).unwrap();
        assert_eq!(find_in(&dir, "rocket-vibe-gtk"), None);
        std::fs::write(nested.join("rocket-vibe-gtk"), "bin").unwrap();
        assert_eq!(find_in(&dir, "rocket-vibe-gtk"), Some(nested.join("rocket-vibe-gtk")));
        std::fs::write(dir.join("rocket-vibe-gtk"), "top").unwrap();
        assert_eq!(find_in(&dir, "rocket-vibe-gtk"), Some(dir.join("rocket-vibe-gtk")));
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
