//! Mattermost and kChat (Infomaniak's Mattermost) servers.

/// Upstream Mattermost, or kChat: a bearer from Infomaniak, its own socket.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Flavor {
    Mattermost,
    Kchat,
}
