//! New versions of the desktop app, from the repository's GitHub releases.
//! The monorepo tags each app apart (`desktop-v0.3.0`, `mobile-v0.3.0`): only
//! the desktop's count, and only the asset built for this platform.

use std::path::Path;
use std::time::Duration;

use serde_json::{Value, json};

pub const REPO: &str = "Guillaume69/rocket-vibe";
pub const TAG_PREFIX: &str = "desktop-v";
pub const CHECK_EVERY_MS: i64 = 6 * 60 * 60 * 1000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Platform {
    LinuxX86_64,
    /// Running from the AppImage, which `APPIMAGE` names.
    LinuxAppImage,
    WindowsX86_64,
    MacosArm64,
}

impl Platform {
    pub fn current() -> Option<Platform> {
        let appimage = std::env::var_os("APPIMAGE").is_some_and(|path| !path.is_empty());
        Platform::of(std::env::consts::OS, std::env::consts::ARCH, appimage)
    }

    fn of(os: &str, arch: &str, appimage: bool) -> Option<Platform> {
        match (os, arch) {
            ("linux", "x86_64") if appimage => Some(Platform::LinuxAppImage),
            ("linux", "x86_64") => Some(Platform::LinuxX86_64),
            ("windows", "x86_64") => Some(Platform::WindowsX86_64),
            ("macos", "aarch64") => Some(Platform::MacosArm64),
            _ => None,
        }
    }

    /// What `.github/workflows/desktop.yml` names this platform's download.
    pub fn asset_suffix(self) -> &'static str {
        match self {
            Platform::LinuxX86_64 => "-linux-x86_64.tar.gz",
            Platform::LinuxAppImage => "-linux-x86_64.AppImage",
            Platform::WindowsX86_64 => "-windows-x86_64-setup.exe",
            Platform::MacosArm64 => "-macos-arm64.dmg",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Asset {
    pub name: String,
    pub url: String,
    pub size: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Release {
    pub version: String,
    /// The release's page, with its notes.
    pub page: String,
    /// None when the release carries nothing for this platform.
    pub asset: Option<Asset>,
}

/// `0.3.0`, `v0.3.0`, `0.3` → (0, 3, 0). A pre-release suffix is ignored.
pub fn parse_version(text: &str) -> Option<(u64, u64, u64)> {
    let core = text.trim().trim_start_matches(['v', 'V']).split(['-', '+']).next()?;
    let mut parts = core.split('.').map(|p| p.parse::<u64>().ok());
    let major = parts.next()??;
    let minor = parts.next().unwrap_or(Some(0))?;
    let patch = parts.next().unwrap_or(Some(0))?;
    Some((major, minor, patch))
}

pub fn is_newer(candidate: &str, current: &str) -> bool {
    match (parse_version(candidate), parse_version(current)) {
        (Some(a), Some(b)) => a > b,
        _ => false,
    }
}

fn release_of(entry: &Value, platform: Option<Platform>) -> Option<Release> {
    if entry["draft"].as_bool() == Some(true) || entry["prerelease"].as_bool() == Some(true) {
        return None;
    }
    let version = entry["tag_name"].as_str()?.strip_prefix(TAG_PREFIX)?;
    parse_version(version)?;
    let asset = platform.and_then(|p| {
        entry["assets"].as_array()?.iter().find_map(|a| {
            let name = a["name"].as_str()?;
            name.ends_with(p.asset_suffix()).then(|| Asset {
                name: name.to_owned(),
                url: a["browser_download_url"].as_str().unwrap_or_default().to_owned(),
                size: a["size"].as_u64().unwrap_or(0),
            })
        })
    });
    Some(Release {
        version: version.to_owned(),
        page: entry["html_url"].as_str().unwrap_or_default().to_owned(),
        asset: asset.filter(|a| !a.url.is_empty()),
    })
}

/// The newest desktop release in GitHub's release list, drafts and
/// pre-releases aside.
pub fn latest(releases: &Value, platform: Option<Platform>) -> Option<Release> {
    releases
        .as_array()?
        .iter()
        .filter_map(|entry| release_of(entry, platform))
        .max_by_key(|r| parse_version(&r.version))
}

/// The newest release when it is newer than `current`.
pub fn available(releases: &Value, current: &str, platform: Option<Platform>) -> Option<Release> {
    latest(releases, platform).filter(|r| is_newer(&r.version, current))
}

/// The last check: when, and the newest release it saw.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Checked {
    pub at_ms: i64,
    pub latest: Option<Release>,
    /// The version whose notice was closed: not shown again.
    pub dismissed: Option<String>,
}

impl Checked {
    pub fn due(&self, now_ms: i64) -> bool {
        self.at_ms == 0 || now_ms.saturating_sub(self.at_ms) >= CHECK_EVERY_MS || now_ms < self.at_ms
    }

    /// The release to offer when running `current`.
    pub fn offer(&self, current: &str) -> Option<&Release> {
        self.latest
            .as_ref()
            .filter(|r| is_newer(&r.version, current) && self.dismissed.as_deref() != Some(r.version.as_str()))
    }

    pub fn to_json(&self) -> String {
        let latest = self.latest.as_ref().map(|r| {
            json!({
                "version": r.version,
                "page": r.page,
                "asset": r.asset.as_ref().map(|a| json!({"name": a.name, "url": a.url, "size": a.size})),
            })
        });
        json!({"at_ms": self.at_ms, "latest": latest, "dismissed": self.dismissed}).to_string()
    }

    /// A check made for another kind of install (a tarball's, before the
    /// AppImage) names the wrong download: it is forgotten, and due again.
    pub fn for_platform(self, platform: Option<Platform>) -> Checked {
        let fits = |r: &Release| match (&r.asset, platform) {
            (Some(asset), Some(p)) => asset.name.ends_with(p.asset_suffix()),
            (Some(_), None) => false,
            (None, _) => true,
        };
        if self.latest.as_ref().is_none_or(fits) {
            return self;
        }
        Checked { at_ms: 0, latest: None, ..self }
    }

    pub fn from_json(text: &str) -> Option<Checked> {
        let v: Value = serde_json::from_str(text).ok()?;
        let latest = v["latest"].as_object().and_then(|r| {
            Some(Release {
                version: r.get("version")?.as_str()?.to_owned(),
                page: r.get("page").and_then(Value::as_str).unwrap_or_default().to_owned(),
                asset: r.get("asset").and_then(Value::as_object).and_then(|a| {
                    Some(Asset {
                        name: a.get("name")?.as_str()?.to_owned(),
                        url: a.get("url")?.as_str()?.to_owned(),
                        size: a.get("size").and_then(Value::as_u64).unwrap_or(0),
                    })
                }),
            })
        });
        Some(Checked {
            at_ms: v["at_ms"].as_i64().unwrap_or(0),
            latest,
            dismissed: v["dismissed"].as_str().map(str::to_owned),
        })
    }
}

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent(concat!("rocket-vibe-desktop/", env!("CARGO_PKG_VERSION")))
        .connect_timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())
}

/// A GitHub API answer, as JSON (the administration's latest server versions).
pub(crate) async fn github_json(url: &str) -> Result<Value, String> {
    let response = client()?
        .get(url)
        .header("Accept", "application/vnd.github+json")
        .timeout(Duration::from_secs(20))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !response.status().is_success() {
        return Err(format!("GitHub answered {}", response.status()));
    }
    response.json().await.map_err(|e| e.to_string())
}

/// GitHub's release list for the repository, newest first.
/// `ROCKET_VIBE_RELEASES` points at another list, as `scripts/install.sh` takes it.
pub async fn fetch_releases() -> Result<Value, String> {
    let url = std::env::var("ROCKET_VIBE_RELEASES")
        .ok()
        .filter(|url| !url.is_empty())
        .unwrap_or_else(|| format!("https://api.github.com/repos/{REPO}/releases?per_page=30"));
    let response = client()?
        .get(url)
        .header("Accept", "application/vnd.github+json")
        .timeout(Duration::from_secs(30))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !response.status().is_success() {
        return Err(format!("GitHub answered {}", response.status()));
    }
    response.json().await.map_err(|e| e.to_string())
}

/// Downloads `url` into `dest`, reporting (bytes so far, total when known).
pub async fn download(url: &str, dest: &Path, progress: impl Fn(u64, Option<u64>)) -> Result<(), String> {
    use tokio::io::AsyncWriteExt;
    let mut response = client()?.get(url).send().await.map_err(|e| e.to_string())?;
    if !response.status().is_success() {
        return Err(format!("download answered {}", response.status()));
    }
    let total = response.content_length();
    let partial = dest.with_extension("part");
    let mut file = tokio::fs::File::create(&partial).await.map_err(|e| e.to_string())?;
    let mut done = 0u64;
    while let Some(chunk) = response.chunk().await.map_err(|e| e.to_string())? {
        file.write_all(&chunk).await.map_err(|e| e.to_string())?;
        done += chunk.len() as u64;
        progress(done, total);
    }
    file.flush().await.map_err(|e| e.to_string())?;
    drop(file);
    if total.is_some_and(|t| t != done) {
        let _ = tokio::fs::remove_file(&partial).await;
        return Err("download cut short".into());
    }
    tokio::fs::rename(&partial, dest).await.map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn releases() -> Value {
        json!([
            {"tag_name": "mobile-v0.9.0", "html_url": "m", "draft": false, "prerelease": false,
             "assets": [{"name": "rocket-vibe-mobile-0.9.0.apk", "browser_download_url": "apk", "size": 1}]},
            {"tag_name": "desktop-v0.10.0", "html_url": "draft", "draft": true, "prerelease": false, "assets": []},
            {"tag_name": "desktop-v0.4.0-rc1", "html_url": "rc", "draft": false, "prerelease": true, "assets": []},
            {"tag_name": "desktop-v0.3.0", "html_url": "https://github.com/x/releases/tag/desktop-v0.3.0",
             "draft": false, "prerelease": false, "assets": [
                {"name": "rocket-vibe-desktop-0.3.0-linux-x86_64.tar.gz", "browser_download_url": "tgz", "size": 30},
                {"name": "rocket-vibe-desktop-0.3.0-linux-x86_64.AppImage", "browser_download_url": "appimage", "size": 35},
                {"name": "rocket-vibe-desktop-0.3.0-windows-x86_64.zip", "browser_download_url": "zip", "size": 40},
                {"name": "rocket-vibe-desktop-0.3.0-windows-x86_64-setup.exe", "browser_download_url": "exe", "size": 50},
                {"name": "rocket-vibe-desktop-0.3.0-macos-arm64.dmg", "browser_download_url": "dmg", "size": 60}]},
            {"tag_name": "desktop-v0.2.0", "html_url": "old", "draft": false, "prerelease": false, "assets": []}
        ])
    }

    #[test]
    fn versions_compare_by_number() {
        assert_eq!(parse_version("v0.3.0"), Some((0, 3, 0)));
        assert_eq!(parse_version("1.2"), Some((1, 2, 0)));
        assert_eq!(parse_version("0.4.0-rc1"), Some((0, 4, 0)));
        assert_eq!(parse_version("desktop-v0.3.0"), None);
        assert!(is_newer("0.10.0", "0.9.9"));
        assert!(!is_newer("0.3.0", "0.3.0"));
        assert!(!is_newer("garbage", "0.1.0"));
    }

    #[test]
    fn only_published_desktop_releases_count() {
        let found = latest(&releases(), Some(Platform::LinuxX86_64)).unwrap();
        assert_eq!(found.version, "0.3.0");
        assert_eq!(found.page, "https://github.com/x/releases/tag/desktop-v0.3.0");
        assert_eq!(found.asset.unwrap().url, "tgz");
    }

    #[test]
    fn each_platform_gets_its_own_download() {
        let asset = |p| latest(&releases(), Some(p)).unwrap().asset.unwrap().url;
        assert_eq!(asset(Platform::WindowsX86_64), "exe");
        assert_eq!(asset(Platform::MacosArm64), "dmg");
        assert_eq!(latest(&releases(), None).unwrap().asset, None);
        assert_eq!(asset(Platform::LinuxAppImage), "appimage");
        assert_eq!(asset(Platform::LinuxX86_64), "tgz");
        assert_eq!(Platform::of("linux", "aarch64", false), None);
        assert_eq!(Platform::of("linux", "x86_64", true), Some(Platform::LinuxAppImage));
        assert_eq!(Platform::of("linux", "x86_64", false), Some(Platform::LinuxX86_64));
        assert_eq!(Platform::of("macos", "aarch64", true), Some(Platform::MacosArm64));
    }

    #[test]
    fn offered_only_when_newer_and_not_dismissed() {
        assert!(available(&releases(), "0.3.0", None).is_none());
        assert_eq!(available(&releases(), "0.2.0", None).unwrap().version, "0.3.0");
        let mut checked = Checked { at_ms: 0, latest: latest(&releases(), None), dismissed: None };
        assert!(checked.offer("0.2.0").is_some());
        assert!(checked.offer("0.3.0").is_none());
        checked.dismissed = Some("0.3.0".into());
        assert!(checked.offer("0.2.0").is_none());
    }

    #[test]
    fn a_check_is_due_every_six_hours() {
        let checked = Checked { at_ms: 1_000, ..Default::default() };
        assert!(!checked.due(1_000 + CHECK_EVERY_MS - 1));
        assert!(checked.due(1_000 + CHECK_EVERY_MS));
        assert!(checked.due(0));
        assert!(Checked::default().due(5));
    }

    #[test]
    fn a_check_for_another_install_is_forgotten() {
        let tarball = Checked { at_ms: 7, latest: latest(&releases(), Some(Platform::LinuxX86_64)), dismissed: None };
        assert_eq!(tarball.clone().for_platform(Some(Platform::LinuxX86_64)), tarball);
        let moved = tarball.for_platform(Some(Platform::LinuxAppImage));
        assert_eq!((moved.at_ms, moved.latest), (0, None));
        let bare = Checked { at_ms: 7, latest: latest(&releases(), None), dismissed: None };
        assert_eq!(bare.clone().for_platform(Some(Platform::LinuxAppImage)), bare);
    }

    #[test]
    fn the_cache_round_trips() {
        let checked = Checked {
            at_ms: 42,
            latest: latest(&releases(), Some(Platform::WindowsX86_64)),
            dismissed: Some("0.2.0".into()),
        };
        assert_eq!(Checked::from_json(&checked.to_json()), Some(checked));
        let empty = Checked::default();
        assert_eq!(Checked::from_json(&empty.to_json()), Some(empty));
        assert_eq!(Checked::from_json("not json"), None);
    }
}
