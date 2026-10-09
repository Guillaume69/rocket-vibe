import Foundation
import RocketVibeCore

/// A category of the settings overlay, in sidebar order: the GTK app's
/// (`rv-gtk/src/settings.rs`), each shown only when it has something for the
/// open account.
public enum SettingsCategory: String, CaseIterable, Identifiable, Sendable {
    case account, notifications, language, voice, encryption, security, devices, bots, workflows, accounts, app

    public var id: String { rawValue }
    public var title: String { L("settings.cat.\(rawValue)") }

    /// What the open account offers the categories that depend on it.
    public struct Scope: Equatable, Sendable {
        /// An account is open; none on the sign-in form.
        public var signedIn: Bool
        /// Rocket.Chat: the E2E key's lock.
        public var legacy: Bool
        /// RocketVibe: this device's encryption, 2FA and factors, device sessions.
        public var crypto: Bool
        public var security: Bool
        public var devices: Bool
        /// RocketVibe with bot accounts (RFC 0003): my bots and their keys.
        public var bots: Bool
        /// RocketVibe with workflows (RFC 0004): mine, their steps and runs.
        public var workflows: Bool
        /// RocketVibe with voice: the microphone, speakers and noise remover.
        public var voice: Bool

        public init(signedIn: Bool = false, legacy: Bool = false, crypto: Bool = false, security: Bool = false, devices: Bool = false, bots: Bool = false, workflows: Bool = false, voice: Bool = false) {
            self.signedIn = signedIn; self.legacy = legacy; self.crypto = crypto; self.security = security; self.devices = devices; self.bots = bots; self.workflows = workflows; self.voice = voice
        }
    }

    public static func visible(_ scope: Scope) -> [SettingsCategory] {
        allCases.filter { category in
            switch category {
            case .account, .notifications: return scope.signedIn
            case .language, .accounts, .app: return true
            case .encryption: return scope.signedIn && (scope.legacy || scope.crypto)
            case .security: return scope.signedIn && scope.security
            case .devices: return scope.signedIn && scope.devices
            case .bots: return scope.signedIn && scope.bots
            case .workflows: return scope.signedIn && scope.workflows
            case .voice: return scope.signedIn && scope.voice
            }
        }
    }
}

/// The settings panel in a window: 85 % of it, capped near 1100 x 800, at
/// least 360 x 360 unless the window is smaller; one pane when narrow.
public enum SettingsLayout {
    public static let maximum = (width: 1100.0, height: 800.0)
    public static let minimum = (width: 360.0, height: 360.0)
    /// Below this panel width the categories and the page share one pane.
    public static let collapseBelow = 640.0

    public static func panel(width: Double, height: Double) -> (width: Double, height: Double) {
        func fit(_ size: Double, _ least: Double, _ most: Double) -> Double {
            min(max(size * 0.85, min(least, size)), most)
        }
        return (fit(width, minimum.width, maximum.width), fit(height, minimum.height, maximum.height))
    }

    public static func singlePane(panelWidth: Double) -> Bool { panelWidth < collapseBelow }
}

extension AppModel {
    public var settingsScope: SettingsCategory.Scope {
        SettingsCategory.Scope(
            signedIn: signedIn,
            legacy: chat != nil && chat?.isMattermost() != true,
            crypto: native?.cryptoSettingsSupported() == true,
            security: native?.securitySupported() == true,
            devices: native?.supportedFeatures().contains("device_sessions") == true,
            bots: native?.supportedFeatures().contains("bots") == true,
            workflows: native?.supportedFeatures().contains("workflows") == true,
            voice: voice != nil
        )
    }

    public var settingsCategories: [SettingsCategory] { SettingsCategory.visible(settingsScope) }

    /// The chosen category, or the first one when it has nothing for this account.
    public var shownSettingsCategory: SettingsCategory? {
        let visible = settingsCategories
        return visible.contains(settingsCategory) ? settingsCategory : visible.first
    }

    /// The settings or the administration cover the window: its own
    /// shortcuts (search, send, an inline edit's Return) wait.
    public var panelShown: Bool { settingsShown || admin != nil }

    /// ⌘, and the gear: the overlay, on `category` when given, else where it was left.
    public func openSettings(_ category: SettingsCategory? = nil) {
        if let category { settingsCategory = category }
        closeAdmin()
        settingsShown = true
        Task { await refreshAdministrator() }
    }

    /// The backdrop, Escape, the close button, and leaving for another account.
    public func closeSettings() {
        settingsShown = false
    }
}
