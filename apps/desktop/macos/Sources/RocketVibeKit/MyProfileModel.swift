import Foundation
import Observation
import RocketVibeCore

/// The existing personal form, bound to one account and its provider.
@MainActor @Observable
public final class MyProfileModel {
    public private(set) var saved: Me?
    public var edited: Me?
    public var password = ""
    public var method: String?
    public var code = ""
    public private(set) var message: String?
    public private(set) var busy = false
    public private(set) var intentions: [NativeProfileIntention] = []
    public private(set) var language = "auto"
    public private(set) var desktopNotifications = "default"
    @ObservationIgnored private weak var app: AppModel?
    @ObservationIgnored private let provider: ChatProvider?
    @ObservationIgnored private let accountId: UUID
    @ObservationIgnored private var own: NativeOwnProfile?
    @ObservationIgnored private var profileRevision = ""
    @ObservationIgnored private var visible = true

    public init(app: AppModel) {
        self.app = app; provider = app.provider; accountId = app.sessionId
    }
    public var native: Bool { provider?.native != nil }
    public func intention(_ slot: String) -> NativeProfileIntention? { intentions.first { $0.slot == slot } }
    public var isCurrent: Bool { active }
    public var editable: Bool { active && !busy && intention("profile") == nil }
    public var preferencesEditable: Bool { active && !busy && saved != nil && intention("preferences") == nil }
    public var photoEditable: Bool { active && !busy && saved != nil && intention("avatar") == nil }
    private var active: Bool { visible && app?.sessionId == accountId && !Task.isCancelled }

    public func close() {
        visible = false; own = nil; saved = nil; edited = nil; intentions = []; busy = false; profileRevision = ""
        password = ""; method = nil; code = ""; message = nil
    }
    public func load() async { await run(announce: false) { try await self.reload(resetDraft: true) } }
    private func pending() throws {
        guard let chat = provider?.native else { intentions = []; return }
        intentions = try ["profile", "preferences", "avatar"].compactMap { try chat.profileIntention(slot: $0) }
        if let preferences = intention("preferences")?.preferences {
            language = preferences.language; desktopNotifications = preferences.desktopNotifications
        }
        if let app, active, ["auto", "fr", "en"].contains(language) {
            try? language.write(toFile: app.client.configDir() + "/language", atomically: true, encoding: .utf8)
        }
    }
    private func install(_ fresh: NativeOwnProfile, resetDraft: Bool) throws {
        let dirty = edited.flatMap { edited in saved.map { !Self.sameFields(edited, $0) } } ?? false
        if resetDraft || !dirty || saved.map({ Self.sameFields($0, fresh.me) }) == true { profileRevision = fresh.revision }
        own = fresh; saved = fresh.me
        language = fresh.preferences.language; desktopNotifications = fresh.preferences.desktopNotifications
        try pending()
        if resetDraft || !dirty { edited = fresh.me }
        if var fields = intention("profile")?.fields {
            fields.email = fresh.me.email; fields.avatar = fresh.me.avatar
            fields.desktopNotifications = fresh.me.desktopNotifications
            edited = fields
        }
        if let preferences = intention("preferences")?.preferences {
            language = preferences.language; desktopNotifications = preferences.desktopNotifications
        }
    }
    private static func sameFields(_ a: Me, _ b: Me) -> Bool {
        a.username == b.username && a.name == b.name && a.bio == b.bio && a.status == b.status && a.statusText == b.statusText
    }
    private func reload(resetDraft: Bool) async throws {
        guard active else { return }
        if let chat = provider?.native {
            let fresh = try await chat.ownProfile()
            guard active else { return }
            try install(fresh, resetDraft: resetDraft)
        } else if let chat = provider?.legacy {
            let fresh = try await chat.me()
            guard active else { return }
            saved = fresh; desktopNotifications = fresh.desktopNotifications
            if resetDraft || edited == nil { edited = fresh }
        }
    }
    public func save() async {
        guard let before = saved, let after = edited else { return }
        await run {
            if let chat = self.provider?.native, self.own != nil {
                let fresh: NativeOwnProfile
                if self.intention("profile") != nil { fresh = try await chat.resumeProfileIntention(slot: "profile") }
                else { fresh = try await chat.updateOwnProfile(revision: self.profileRevision, after: after) }
                guard self.active else { return }
                try self.install(fresh, resetDraft: true)
            } else if let chat = self.provider?.legacy {
                if after.status != before.status || after.statusText != before.statusText {
                    try await chat.setStatus(status: after.status, message: after.statusText)
                }
                try await chat.updateProfile(before: before, after: after, password: self.password.isEmpty ? nil : self.password,
                                             method: self.method, code: self.method == nil ? nil : self.code)
                guard self.active else { return }
                try await self.reload(resetDraft: true)
            }
            self.password = ""; self.method = nil; self.code = ""
        }
    }
    public func setLanguage(_ choice: String) async {
        await preference { $0.language = choice }
        guard active, language == choice, let app else { return }
        try? choice.write(toFile: app.client.configDir() + "/language", atomically: true, encoding: .utf8)
    }
    public func setNotifications(_ choice: String) async {
        if native { await preference { $0.desktopNotifications = choice } }
        else { await run {
            try await self.provider?.legacy?.setDesktopNotifications(value: choice)
            guard self.active else { return }
            self.desktopNotifications = choice
        } }
    }
    private func preference(_ change: (inout NativePreferences) -> Void) async {
        guard preferencesEditable, var preferences = own?.preferences, let chat = provider?.native else { return }
        change(&preferences)
        await run {
            let fresh = try await chat.updatePreferences(preferences: preferences)
            guard self.active else { return }
            try self.install(fresh, resetDraft: false)
        }
    }
    public func changePhoto(png: Data?) async {
        guard photoEditable else { return }
        await run {
            guard let chat = self.provider?.native, let own = self.own else { return }
            let fresh = try await chat.changeAvatar(revision: own.revision, mime: png == nil ? nil : "image/png", bytes: png ?? Data())
            guard self.active else { return }
            try self.install(fresh, resetDraft: false)
        }
    }
    public func legacyPhoto(path: String, mime: String) async {
        await run { try await self.provider?.legacy?.setAvatar(path: path, mime: mime); try await self.reload(resetDraft: false) }
    }
    public func photoRejected() { if active && !busy { message = L("settings.save_failed") } }
    public func removePhoto() async {
        if native { await changePhoto(png: nil) }
        else { await run { try await self.provider?.legacy?.resetAvatar(); try await self.reload(resetDraft: false) } }
    }
    public func resume(_ slot: String) async {
        await run {
            guard let chat = self.provider?.native else { return }
            let fresh = try await chat.resumeProfileIntention(slot: slot)
            guard self.active else { return }
            try self.install(fresh, resetDraft: slot == "profile")
        }
    }
    public func discard(_ intention: NativeProfileIntention) async {
        await run {
            guard let chat = self.provider?.native else { return }
            guard try await chat.dismissProfileIntention(slot: intention.slot, key: intention.key) else { throw RvError.Local(message: "profile_action_pending") }
            guard self.active else { return }
            try self.pending()
            try await self.reload(resetDraft: intention.slot == "profile")
        }
    }
    private func run(announce: Bool = true, _ action: () async throws -> Void) async {
        guard active, !busy else { return }
        busy = true; message = nil
        defer { if active { busy = false } }
        do { try await action(); guard active else { return }; message = announce ? L("settings.saved") : nil }
        catch {
            guard active else { return }
            try? pending()
            if case let RvError.Server(_, _, errorCode, twoFactor, _, _) = error {
                if !native, let twoFactor { method = twoFactor.method }
                message = L(errorCode == "reauthentication_required" ? "security.required" : errorCode == "revision_conflict" ? "profile.conflict" : "settings.save_failed")
            } else if case let RvError.Local(text) = error, text == "password-needed" { message = L("settings.current_password") }
            else { message = L("settings.save_failed") }
        }
    }
}
