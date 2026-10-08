import Foundation
import Observation
import RocketVibeCore

/// A bot refusal (`RvError` carries the server's code), as rv-core words it
/// for both desktop apps.
public func botFailure(_ error: Error) -> String {
    if case let RvError.Server(_, _, code, _, _, _) = error { return L(botErrorKey(code: code ?? "")) }
    return L("bots.failed")
}

/// The bots of the open RocketVibe account (RFC 0003): the list, whether I
/// may create one, the API reference, and the keys of the bot I opened. A new
/// key is held in memory only, until its sheet closes.
@MainActor @Observable
public final class BotsModel {
    public private(set) var bots: [NativeBot] = []
    public private(set) var canCreate = false
    public private(set) var reference: NativeBotReference?
    public private(set) var loaded = false
    public private(set) var busy = false
    public private(set) var error: String?
    /// "Bot saved", or what went wrong with an action.
    public var notice: String?
    /// Each opened bot's keys, by bot id, read when it opens.
    public private(set) var keys: [String: [NativeBotKey]] = [:]
    /// The key just created: shown once, then dropped.
    public var created: NativeBotKeyCreated?
    @ObservationIgnored private weak var app: AppModel?
    @ObservationIgnored private let chat: NativeChat?
    @ObservationIgnored private let accountId: UUID

    public init(app: AppModel) {
        self.app = app
        chat = app.native
        accountId = app.sessionId
    }
    private var active: Bool { app?.sessionId == accountId && app?.native === chat && chat != nil }

    /// Every scope's wire name, in the order the form lists them.
    public static var scopes: [String] { botScopes() }
    public static func scopeText(_ scope: String) -> String { L(botScopeKey(scope: scope)) }

    /// The routes a scope opens; nil: those open to every key.
    public func routes(_ scope: String?) -> [NativeBotRoute] {
        guard let reference else { return [] }
        guard let scope else { return reference.always }
        return reference.scopes.first { $0.scope == scope }?.routes ?? []
    }
    /// What stays closed, and the sending budgets once the server said them.
    public var closedNote: String {
        guard let reference else { return L("bots.closed_routes") }
        return L("bots.closed_routes") + " " + L("bots.budgets", [
            "sends": String(reference.sendsPerMinute), "direct": String(reference.directPerMinute),
        ])
    }

    public func load() async {
        guard active, !busy, let chat else { return }
        busy = true
        error = nil
        defer { busy = false }
        do {
            let fresh = try await chat.bots()
            let can = (try? await chat.canCreateBot()) ?? false
            let found = try? await chat.botReference()
            guard active else { return }
            bots = fresh
            canCreate = can
            if let found { reference = found }
            loaded = true
        } catch {
            guard active else { return }
            self.error = botFailure(error)
            loaded = true
        }
    }

    /// The new bot, or nil with `notice` saying why.
    public func create(username: String, displayName: String, description: String, scopes: [String]) async -> NativeBot? {
        await act {
            try await $0.createBot(username: username, displayName: displayName, description: description, scopes: scopes)
        }
    }
    /// The display name is sent only when it changed; rv-core trims it and
    /// refuses an empty one.
    public func update(_ bot: NativeBot, displayName: String, description: String, scopes: [String]) async -> Bool {
        let name = displayName.trimmingCharacters(in: .whitespacesAndNewlines)
        let renamed: String? = name == bot.displayName ? nil : name
        let saved = await act {
            try await $0.updateBot(id: bot.id, displayName: renamed, description: description, scopes: scopes)
        }
        if saved != nil { notice = L("bots.saved") }
        return saved != nil
    }
    /// Sets the bot's photo (a PNG) or, with nil, removes it.
    public func setPhoto(_ bot: NativeBot, png: Data?) async {
        let saved = await act { try await $0.setBotAvatar(id: bot.id, mime: png == nil ? nil : "image/png", bytes: png ?? Data()) }
        if saved != nil { notice = L(png == nil ? "bots.photo_removed" : "bots.photo_saved") }
    }
    /// The chosen picture could not be made a photo.
    public func photoRejected() { if active && !busy { notice = L("bots.error_invalid_avatar") } }
    /// Final: its keys revoked, its rooms left, its username retired.
    public func delete(_ bot: NativeBot) async -> Bool {
        let done: Void? = await act { try await $0.deleteBot(id: bot.id) }
        return done != nil
    }

    public func loadKeys(_ bot: NativeBot) async {
        guard active, let chat else { return }
        do {
            let fresh = try await chat.botKeys(id: bot.id)
            guard active else { return }
            keys[bot.id] = fresh
        } catch {
            guard active else { return }
            notice = botFailure(error)
        }
    }
    /// `days` 0: the key never expires. The key lands in `created`, once.
    public func createKey(_ bot: NativeBot, label: String, days: UInt32) async {
        if let made = await act({ try await $0.createBotKey(id: bot.id, label: label, expiresInDays: days > 0 ? days : nil) }) {
            created = made
            await loadKeys(bot)
        }
    }
    public func revoke(_ bot: NativeBot, _ key: NativeBotKey) async {
        let done: Void? = await act { try await $0.revokeBotKey(bot: bot.id, key: key.id) }
        if done != nil { await loadKeys(bot) }
    }

    /// Runs one action, then reads the list again (key counts, scopes).
    private func act<T>(_ action: (NativeChat) async throws -> T) async -> T? {
        guard active, !busy, let chat else { return nil }
        busy = true
        notice = nil
        do {
            let result = try await action(chat)
            busy = false
            guard active else { return nil }
            await load()
            return result
        } catch {
            busy = false
            guard active else { return nil }
            notice = botFailure(error)
            return nil
        }
    }
}
