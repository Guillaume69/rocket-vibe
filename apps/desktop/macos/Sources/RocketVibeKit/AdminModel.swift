import Foundation
import Observation
import RocketVibeCore

/// A category of the server administration, in sidebar order: the GTK
/// app's (`rv-gtk/src/admin.rs`). It opens on the Dashboard.
public enum AdminCategory: String, CaseIterable, Identifiable, Sendable {
    case dashboard, moderation, rooms, users, emoji

    public var id: String { rawValue }
    public var title: String { L("admin.cat.\(rawValue)") }
}

/// What the administration says, as the GTK app says it.
public enum AdminText {
    /// A refusal (`AdminFailure` carries the server's code), as rv-core words it.
    public static func error(_ error: Error) -> String {
        if case let AdminFailure.Refused(code, _, _) = error { return self.error(code: code) }
        return L("admin.failed")
    }

    public static func error(code: String) -> String {
        L(adminErrorKey(code: code))
    }

    /// A figure the server may refuse to give: "–" then.
    public static func figure(_ value: UInt64?) -> String {
        value.map { String($0) } ?? L("admin.unknown")
    }

    public static func duration(_ seconds: UInt64) -> String {
        let (days, hours, minutes) = (seconds / 86_400, seconds % 86_400 / 3600, seconds % 3600 / 60)
        if days > 0 { return L("admin.days", ["d": String(days), "h": String(hours)]) }
        if hours > 0 { return L("admin.hours", ["h": String(hours), "m": String(minutes)]) }
        return L("admin.minutes", ["m": String(minutes)])
    }

    /// `2026-10-07T09:00:00Z` as a local date (`7 Oct 2026`); as it came when unreadable.
    public static func date(_ text: String, timeZone: TimeZone = .current) -> String {
        let parser = ISO8601DateFormatter()
        parser.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        var parsed = parser.date(from: text)
        if parsed == nil {
            parser.formatOptions = [.withInternetDateTime]
            parsed = parser.date(from: text)
        }
        guard let parsed else { return text }
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: Strings.french ? "fr_FR" : "en_GB")
        formatter.timeZone = timeZone
        formatter.dateFormat = "d MMM yyyy"
        return formatter.string(from: parsed)
    }

    /// The version line's note: an update, or up to date; nothing when unknown.
    public static func update(current: String, latest: String?) -> String? {
        guard let latest else { return nil }
        return serverUpdateAvailable(current: current, latest: latest)
            ? L("admin.update_available", ["version": latest]) : L("admin.up_to_date")
    }
}

/// One list of the administration (users, rooms, reports), by pages, with a
/// search for those that have one. A reload or a new search drops a page
/// still on its way, so an answer to an older query never shows.
@MainActor @Observable
public final class AdminList<Item> {
    public private(set) var items: [Item] = []
    /// The following page's key; nil at the end.
    public private(set) var next: String?
    public private(set) var loading = false
    public private(set) var error: String?
    /// The first page came back: an empty list now says so.
    public private(set) var loaded = false
    public private(set) var query = ""
    @ObservationIgnored private var generation = 0
    @ObservationIgnored private var task: Task<Void, Never>?
    @ObservationIgnored private let fetch: (String?, String) async throws -> ([Item], String?)
    @ObservationIgnored private var started = false

    public init(fetch: @escaping (String?, String) async throws -> ([Item], String?)) {
        self.fetch = fetch
    }

    /// The first showing loads the first page; later ones keep what is there.
    public func start() {
        guard !started else { return }
        started = true
        reload()
    }

    public func reload() { restart(after: 0) }

    /// Typed into the search: the list reloads once typing pauses.
    public func search(_ text: String) {
        guard text != query else { return }
        query = text
        restart(after: 250_000_000)
    }

    /// "Show more": the next page, after the ones shown.
    public func more() {
        guard let next, !loading else { return }
        let expected = generation
        task = Task { await load(after: next, generation: expected) }
    }

    /// The screen closed: nothing more is applied.
    public func close() {
        generation &+= 1
        task?.cancel()
    }

    private func restart(after delay: UInt64) {
        started = true
        generation &+= 1
        task?.cancel()
        items = []; next = nil; error = nil; loaded = false
        let expected = generation
        task = Task {
            if delay > 0 {
                try? await Task.sleep(nanoseconds: delay)
                guard !Task.isCancelled else { return }
            }
            await load(after: nil, generation: expected)
        }
    }

    private func load(after: String?, generation expected: Int) async {
        guard expected == generation else { return }
        loading = true
        let result: Result<([Item], String?), Error>
        do { result = .success(try await fetch(after, query)) } catch { result = .failure(error) }
        guard expected == generation else { return }
        loading = false
        loaded = true
        switch result {
        case let .success((page, following)):
            items += page
            next = following
        case let .failure(failure):
            error = AdminText.error(failure)
        }
    }
}

/// A second question after a refusal that asks one: Rocket.Chat deactivating
/// or deleting the last owner of rooms (which then go or change owner), or
/// deleting a reported message it can only delete with all of its author's.
public struct AdminFollowUp: Identifiable {
    public let id = UUID()
    public let title: String
    public let message: String
    public let action: String
    let moderation: Bool
    let run: () async throws -> Void
}

/// A page opened over a category: an account, a reported message or account.
public enum AdminDetail: Equatable {
    case user(AdminUser)
    case message(AdminReportedMessage)
    case reportedUser(AdminReportedUser)
}

/// The server administration of the open account: the dashboard, the
/// moderation of reports, rooms and users, and the actions on them. Every
/// answer is applied only while the screen is open.
@MainActor @Observable
public final class AdminModel {
    public let source: any ServerAdminProtocol
    public let product: AdminProduct
    /// My account: no action is offered on it.
    public let myId: String
    public private(set) var category = AdminCategory.dashboard
    public private(set) var overview: AdminOverview?
    public private(set) var overviewError: String?
    /// The newest published server version, asked once per opening.
    public private(set) var latestVersion: String?
    /// Open reports, for the Moderation badge.
    public private(set) var reportCount: UInt64 = 0
    /// RocketVibe with bots: whether every account may create one (an
    /// administrator always may); nil where the server has no bots.
    public private(set) var userBots: Bool?
    public private(set) var settingUserBots = false
    /// The server lets this administrator add and remove custom emoji.
    public let emojiSupported: Bool
    /// The server's icon can be changed here (the Dashboard's Server icon card).
    public let iconSupported: Bool
    /// The server's icon as the rails show it, once read; nil without one.
    public private(set) var icon: Data?
    public private(set) var settingIcon = false
    /// The categories this server offers, in sidebar order.
    public var categories: [AdminCategory] { AdminCategory.allCases.filter { $0 != .emoji || emojiSupported } }
    /// The server's custom emoji, once read; `emojisError` when they could not be.
    public private(set) var emojis: [AdminEmoji]?
    public private(set) var emojisError: String?
    public let users: AdminList<AdminUser>
    public let rooms: AdminList<AdminRoom>
    public let reportedMessages: AdminList<AdminReportedMessage>
    public let reportedUsers: AdminList<AdminReportedUser>
    public private(set) var detail: AdminDetail?
    /// The opened report's reasons, read when it opens unless the list carried them.
    public private(set) var reasons: [AdminReport]?
    public private(set) var reasonsError: String?
    public private(set) var busy = false
    /// Whether the opened reported account is active, once its page read it.
    public private(set) var reportedUserActive: Bool?
    /// The second question to ask, until answered.
    public private(set) var followUp: AdminFollowUp?
    /// The panel's toast: "Done", or what went wrong.
    public var notice: String?
    @ObservationIgnored private var detailGeneration = 0
    @ObservationIgnored private var overviewGeneration = 0
    @ObservationIgnored private var askedLatest = false
    @ObservationIgnored public private(set) var alive = true

    public init(source: any ServerAdminProtocol) {
        self.source = source
        product = source.product()
        myId = source.myId()
        emojiSupported = source.emojiSupported()
        iconSupported = source.iconSupported()
        users = AdminList { after, query in
            let page = try await source.users(after: after, query: query)
            return (page.items, page.next)
        }
        rooms = AdminList { after, query in
            let page = try await source.rooms(after: after, query: query)
            return (page.items, page.next)
        }
        reportedMessages = AdminList { after, _ in
            let page = try await source.reportedMessages(after: after)
            return (page.items, page.next)
        }
        reportedUsers = AdminList { after, _ in
            let page = try await source.reportedUsers(after: after)
            return (page.items, page.next)
        }
    }

    /// Shows a category, loading it the first time.
    public func show(_ category: AdminCategory) {
        self.category = category
        closeDetail()
        switch category {
        case .dashboard: if overview == nil && overviewError == nil { Task { await refreshOverview(refresh: false) } }
        case .moderation: reportedMessages.start(); reportedUsers.start()
        case .rooms: rooms.start()
        case .users: users.start()
        case .emoji: if emojis == nil { Task { await loadEmojis() } }
        }
    }

    /// Reads the server's icon (the Dashboard asks once).
    public func loadIcon() async {
        guard alive, iconSupported else { return }
        let found = await source.icon()
        if alive { icon = found.map { Data($0) } }
    }

    /// Sets the icon from a square PNG of `iconSide()` pixels, or removes it
    /// (`nil`); true once the server has it.
    public func setIcon(png: Data?) async -> Bool {
        guard alive, iconSupported, !settingIcon else { return false }
        settingIcon = true
        defer { settingIcon = false }
        do {
            try await source.setIcon(png: png.map { [UInt8]($0) })
            guard alive else { return false }
            notice = L(png == nil ? "admin.icon_removed" : "admin.icon_saved")
            await loadIcon()
            return true
        } catch {
            if alive { notice = AdminText.error(error) }
            return false
        }
    }

    /// Reads the custom emoji again (also refreshing the pickers' index).
    public func loadEmojis() async {
        guard alive else { return }
        emojisError = nil
        do {
            let list = try await source.emojis()
            if alive { emojis = list }
        } catch {
            if alive { emojisError = AdminText.error(error) }
        }
    }

    /// Adds an emoji from an image file; true once the server has it.
    public func createEmoji(name: String, aliases: String, file: URL) async -> Bool {
        guard alive, !busy else { return false }
        busy = true
        defer { busy = false }
        do {
            try await source.createEmoji(name: name, aliases: aliases, file: file.path)
            guard alive else { return false }
            notice = L("admin.emoji_added")
            await loadEmojis()
            return true
        } catch {
            if alive { notice = AdminText.error(error) }
            return false
        }
    }

    public func deleteEmoji(_ item: AdminEmoji) async {
        guard alive, !busy else { return }
        busy = true
        defer { busy = false }
        do {
            try await source.deleteEmoji(item: item)
            if alive { notice = L("admin.emoji_deleted") }
        } catch {
            if alive { notice = AdminText.error(error) }
        }
        await loadEmojis()
    }

    /// The figures; Rocket.Chat counts them again only with `refresh` (the
    /// refresh button: a full count on the server), its cached ones otherwise.
    public func refreshOverview(refresh: Bool) async {
        guard alive else { return }
        overviewGeneration &+= 1
        let expected = overviewGeneration
        overview = nil; overviewError = nil
        do {
            let fresh = try await source.overview(refresh: refresh)
            guard alive, expected == overviewGeneration else { return }
            overview = fresh
            reportCount = (fresh.reportedMessages ?? 0) + (fresh.reportedUsers ?? 0)
            let bots = try? await source.userBots()
            guard alive, expected == overviewGeneration else { return }
            userBots = bots
        } catch {
            guard alive, expected == overviewGeneration else { return }
            overviewError = AdminText.error(error)
        }
        if !askedLatest {
            askedLatest = true
            let found = await source.latestVersion()
            if alive { latestVersion = found }
        }
    }

    /// Opens bot creation to every account, or back to administrators only;
    /// the switch follows the server's answer.
    public func setUserBots(_ on: Bool) async {
        guard alive, userBots != nil, !settingUserBots else { return }
        settingUserBots = true
        defer { settingUserBots = false }
        do {
            let now = try await source.setUserBots(on: on)
            if alive { userBots = now }
        } catch {
            if alive { notice = AdminText.error(error) }
        }
    }

    /// "Figures as of ...": Rocket.Chat's snapshot date; nothing when live.
    public var asOf: String? {
        overview?.asOf.map { L("admin.as_of", ["date": AdminText.date($0)]) }
    }

    /// A reported message's words: "Encrypted message" from an encrypted room.
    public func text(_ item: AdminReportedMessage) -> String {
        item.deleted ? L("admin.message_deleted") : item.encrypted ? L("admin.encrypted_message") : item.text
    }

    /// The version line's note, once the latest version is known.
    public var updateNote: String? {
        overview.flatMap { AdminText.update(current: $0.version, latest: latestVersion) }
    }

    public func isMe(_ user: AdminUser) -> Bool { user.id == myId }
    public func canDeleteMessage(_ item: AdminReportedMessage) -> Bool { !item.deleted }
    public func canDeactivateAuthor(_ item: AdminReportedMessage) -> Bool { !item.author.deleted && item.author.id != myId }
    /// Unless known inactive: Rocket.Chat's list does not say, its page does.
    public func canDeactivate(_ item: AdminReportedUser) -> Bool {
        let shown = detail == .reportedUser(item) ? reportedUserActive : nil
        return item.user.id != myId && (shown ?? item.active) != false
    }
    /// What deleting an account does to its messages, by server.
    public var deleteUserBody: String {
        L(product == .rocketChat ? "admin.delete_user_body_rc" : "admin.delete_user_body_rv")
    }

    /// Opens an item's page; a report's reasons are read now if the list did not carry them.
    public func open(_ detail: AdminDetail) {
        detailGeneration &+= 1
        let expected = detailGeneration
        self.detail = detail
        reasons = nil; reasonsError = nil; reportedUserActive = nil
        let work: (() async throws -> ([AdminReport], Bool?))?
        switch detail {
        case .user: work = nil
        case let .message(item):
            if let known = item.reports { reasons = known; work = nil } else {
                work = { (try await self.source.messageReports(item: item), nil) }
            }
        case let .reportedUser(item):
            reportedUserActive = item.active
            if let known = item.reports, item.active != nil { reasons = known; work = nil } else {
                work = {
                    let found = try await self.source.userReports(item: item)
                    return (found.reports, found.active)
                }
            }
        }
        guard let work else { return }
        Task {
            do {
                let (found, active) = try await work()
                if alive, expected == detailGeneration {
                    reasons = found
                    if let active { reportedUserActive = active }
                }
            } catch {
                if alive, expected == detailGeneration { reasonsError = AdminText.error(error) }
            }
        }
    }

    /// Back from an item to its category.
    public func closeDetail() {
        detailGeneration &+= 1
        detail = nil; reasons = nil; reasonsError = nil; reportedUserActive = nil
    }

    public func setAdmin(_ user: AdminUser, _ admin: Bool) async {
        await act { _ in _ = try await self.source.setAdmin(user: user, admin: admin) }
    }
    public func setActive(_ user: AdminUser, _ active: Bool) async {
        await act { relinquish in _ = try await self.source.setActive(user: user, active: active, relinquish: relinquish) }
    }
    public func delete(_ user: AdminUser) async {
        await act { relinquish in try await self.source.deleteUser(user: user, relinquish: relinquish) }
    }
    public func dismiss(_ item: AdminReportedMessage) async {
        await act(moderation: true) { _ in try await self.source.dismissMessageReports(item: item) }
    }
    public func delete(_ item: AdminReportedMessage) async {
        await act(moderation: true, bulk: item) { _ in try await self.source.deleteReportedMessage(item: item) }
    }
    public func deactivateAuthor(_ item: AdminReportedMessage) async {
        await act(moderation: true) { relinquish in try await self.source.deactivateAuthor(item: item, relinquish: relinquish) }
    }
    public func dismiss(_ item: AdminReportedUser) async {
        await act(moderation: true) { _ in try await self.source.dismissUserReports(item: item) }
    }
    public func deactivate(_ item: AdminReportedUser) async {
        await act(moderation: true) { relinquish in _ = try await self.source.setActive(user: item.user, active: false, relinquish: relinquish) }
    }

    /// The second question answered yes (`pending`, kept by the view as it
    /// closes the question): the action again, as it asked.
    public func confirmFollowUp(_ asked: AdminFollowUp? = nil) async {
        guard let pending = asked ?? followUp else { return }
        followUp = nil
        await act(moderation: pending.moderation) { _ in try await pending.run() }
    }

    public func dismissFollowUp() { followUp = nil }

    /// An action: on success "Done", back to the list, reloaded; a refusal
    /// that asks a second question asks it; else why not. `work` is told
    /// whether the person agreed to give up room ownerships (Rocket.Chat).
    private func act(moderation: Bool = false, bulk: AdminReportedMessage? = nil,
                     _ work: @escaping (Bool) async throws -> Void) async {
        guard alive, !busy else { return }
        busy = true
        defer { busy = false }
        do {
            try await work(false)
            guard alive else { return }
            notice = L("admin.done")
            closeDetail()
            if moderation { reportedMessages.reload(); reportedUsers.reload() } else { users.reload() }
        } catch let AdminFailure.Refused(code, lastOwner, count) {
            guard alive else { return }
            if code == "user-last-owner", let lastOwner {
                followUp = AdminFollowUp(title: L("admin.last_owner_title"), message: Self.lastOwnerText(lastOwner),
                                         action: L("admin.last_owner_confirm"), moderation: moderation) { try await work(true) }
            } else if code == "moderation_bulk_only", let item = bulk {
                followUp = AdminFollowUp(title: L("admin.bulk_delete_title"),
                                         message: L("admin.bulk_delete_body", ["n": String(count ?? 0)]),
                                         action: L("admin.bulk_delete"), moderation: true) {
                    try await self.source.deleteAuthorReportedMessages(item: item)
                }
            } else {
                notice = AdminText.error(code: code)
            }
        } catch {
            if alive { notice = L("admin.failed") }
        }
    }

    /// The rooms that go (the person is their only member) and those whose ownership moves.
    static func lastOwnerText(_ rooms: AdminLastOwner) -> String {
        var lines: [String] = []
        if !rooms.removed.isEmpty { lines.append(L("admin.last_owner_removed", ["rooms": rooms.removed.joined(separator: ", ")])) }
        if !rooms.transferred.isEmpty { lines.append(L("admin.last_owner_transferred", ["rooms": rooms.transferred.joined(separator: ", ")])) }
        return lines.joined(separator: "\n")
    }

    public func close() {
        alive = false
        detailGeneration &+= 1; overviewGeneration &+= 1
        users.close(); rooms.close(); reportedMessages.close(); reportedUsers.close()
    }
}

/// What a member reports.
public enum ReportTarget: Equatable, Sendable {
    case message(String)
    case user(String)
}

/// The Report dialog's state: a reason, required, at most 1,000 characters.
@MainActor @Observable
public final class ReportDraft: Identifiable {
    public let id = UUID()
    public let target: ReportTarget
    public private(set) var reason = ""
    public private(set) var sending = false

    public init(target: ReportTarget) { self.target = target }

    public static var maxLength: Int { Int(reportReasonMax()) }
    public var title: String {
        if case .message = target { return L("report.title_message") }
        return L("report.user")
    }
    public var body: String {
        if case .message = target { return L("report.body_message") }
        return L("report.body_user")
    }
    /// What is typed, cut at the longest reason the servers take. They count
    /// Unicode scalars (rv-core's `valid_reason`), not what Swift calls characters.
    public func edit(_ text: String) {
        let scalars = text.unicodeScalars
        reason = scalars.count > Self.maxLength ? String(String.UnicodeScalarView(scalars.prefix(Self.maxLength))) : text
    }
    public var canSend: Bool { !sending && reportReason(text: reason) != nil }

    /// Sends it; the toast to show.
    public func send(with source: any ServerAdminProtocol) async -> String {
        guard !sending, let reason = reportReason(text: reason) else { return L("report.failed") }
        sending = true
        defer { sending = false }
        do {
            switch target {
            case let .message(id): try await source.reportMessage(messageId: id, reason: reason)
            case let .user(id): try await source.reportUser(userId: id, reason: reason)
            }
            return L("report.sent")
        } catch {
            return L("report.failed")
        }
    }
}

extension AppModel {
    /// Asks the server whether this account administers it.
    public func refreshAdministrator() async {
        guard let provider else { administrator = false; return }
        let expected = sessionId
        let allowed = await provider.admin().isAdmin()
        if expected == sessionId { administrator = allowed }
    }

    /// The administration over the window, on its Dashboard; closes the settings.
    public func openAdmin() {
        guard administrator, let provider else { return }
        settingsShown = false
        admin?.close()
        let model = AdminModel(source: provider.admin())
        admin = model
        model.show(.dashboard)
    }

    public func closeAdmin() {
        admin?.close()
        admin = nil
    }

    /// Members may report here (RocketVibe: when the server takes reports).
    public var reportsSupported: Bool { provider?.supportsReports == true }

    /// A RocketVibe account deleted by an administrator: its profile reads
    /// "Deleted user". Rocket.Chat reserves no username.
    public func deletedAccount(username: String) -> Bool {
        native != nil && deletedUsername(username: username)
    }

    /// Opens the Report dialog on a message or an account.
    public func startReport(_ target: ReportTarget) {
        guard reportsSupported else { return }
        reporting = ReportDraft(target: target)
    }

    public func cancelReport() { reporting = nil }

    /// Sends the open report, then says how it went in the window's toast.
    public func sendReport() async {
        guard let draft = reporting, let provider else { return }
        let expected = sessionId
        let text = await draft.send(with: provider.admin())
        guard expected == sessionId, reporting === draft else { return }
        reporting = nil
        notice = text
    }
}
