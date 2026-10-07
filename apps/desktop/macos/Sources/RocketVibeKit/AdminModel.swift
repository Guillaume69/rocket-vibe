import Foundation
import Observation
import RocketVibeCore

/// A category of the server administration, in sidebar order: the GTK
/// app's (`rv-gtk/src/admin.rs`). It opens on the Dashboard.
public enum AdminCategory: String, CaseIterable, Identifiable, Sendable {
    case dashboard, moderation, rooms, users

    public var id: String { rawValue }
    public var title: String { L("admin.cat.\(rawValue)") }
}

/// What the administration says, as the GTK app says it.
public enum AdminText {
    /// A refusal or a failure (`RvError.Local` carries the server's code).
    public static func error(_ error: Error) -> String {
        if case let RvError.Local(code) = error { return self.error(code: code) }
        return L("admin.failed")
    }

    public static func error(code: String) -> String {
        switch code {
        case "self_administration", "self_report": return L("admin.error_self")
        case "last_administrator": return L("admin.error_last_admin")
        case "revision_conflict", "operation_conflict", "not_found": return L("admin.error_conflict")
        case "permission_denied": return L("admin.error_denied")
        default: return code.hasPrefix("error-") ? L("admin.error_denied") : L("admin.failed")
        }
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
    public let users: AdminList<AdminUser>
    public let rooms: AdminList<AdminRoom>
    public let reportedMessages: AdminList<AdminReportedMessage>
    public let reportedUsers: AdminList<AdminReportedUser>
    public private(set) var detail: AdminDetail?
    /// The opened report's reasons, read when it opens unless the list carried them.
    public private(set) var reasons: [AdminReport]?
    public private(set) var reasonsError: String?
    public private(set) var busy = false
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
        case .dashboard: if overview == nil && overviewError == nil { Task { await refreshOverview() } }
        case .moderation: reportedMessages.start(); reportedUsers.start()
        case .rooms: rooms.start()
        case .users: users.start()
        }
    }

    public func refreshOverview() async {
        guard alive else { return }
        overviewGeneration &+= 1
        let expected = overviewGeneration
        overview = nil; overviewError = nil
        do {
            let fresh = try await source.overview()
            guard alive, expected == overviewGeneration else { return }
            overview = fresh
            reportCount = fresh.reportedMessages + fresh.reportedUsers
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

    /// The version line's note, once the latest version is known.
    public var updateNote: String? {
        overview.flatMap { AdminText.update(current: $0.version, latest: latestVersion) }
    }

    public func isMe(_ user: AdminUser) -> Bool { user.id == myId }
    public func canDeleteMessage(_ item: AdminReportedMessage) -> Bool { !item.deleted }
    public func canDeactivateAuthor(_ item: AdminReportedMessage) -> Bool { !item.author.deleted && item.author.id != myId }
    public func canDeactivate(_ item: AdminReportedUser) -> Bool { item.user.id != myId && item.user.active }
    /// What deleting an account does to its messages, by server.
    public var deleteUserBody: String {
        L(product == .rocketChat ? "admin.delete_user_body_rc" : "admin.delete_user_body_rv")
    }

    /// Opens an item's page; a report's reasons are read now if the list did not carry them.
    public func open(_ detail: AdminDetail) {
        detailGeneration &+= 1
        let expected = detailGeneration
        self.detail = detail
        reasons = nil; reasonsError = nil
        let work: (() async throws -> [AdminReport])?
        switch detail {
        case .user: work = nil
        case let .message(item):
            if let known = item.reports { reasons = known; work = nil } else { work = { try await self.source.messageReports(item: item) } }
        case let .reportedUser(item):
            if let known = item.reports { reasons = known; work = nil } else { work = { try await self.source.userReports(item: item) } }
        }
        guard let work else { return }
        Task {
            do {
                let found = try await work()
                if alive, expected == detailGeneration { reasons = found }
            } catch {
                if alive, expected == detailGeneration { reasonsError = AdminText.error(error) }
            }
        }
    }

    /// Back from an item to its category.
    public func closeDetail() {
        detailGeneration &+= 1
        detail = nil; reasons = nil; reasonsError = nil
    }

    public func setAdmin(_ user: AdminUser, _ admin: Bool) async {
        await act(reload: users) { _ = try await self.source.setAdmin(user: user, admin: admin) }
    }
    public func setActive(_ user: AdminUser, _ active: Bool) async {
        await act(reload: users) { _ = try await self.source.setActive(user: user, active: active) }
    }
    public func delete(_ user: AdminUser) async {
        await act(reload: users) { try await self.source.deleteUser(user: user) }
    }
    public func dismiss(_ item: AdminReportedMessage) async {
        await act(moderation: true) { try await self.source.dismissMessageReports(item: item) }
    }
    public func delete(_ item: AdminReportedMessage) async {
        await act(moderation: true) { try await self.source.deleteReportedMessage(item: item) }
    }
    public func deactivateAuthor(_ item: AdminReportedMessage) async {
        await act(moderation: true) { try await self.source.deactivateAuthor(item: item) }
    }
    public func dismiss(_ item: AdminReportedUser) async {
        await act(moderation: true) { try await self.source.dismissUserReports(item: item) }
    }
    public func deactivate(_ item: AdminReportedUser) async {
        await act(moderation: true) { _ = try await self.source.setActive(user: item.user, active: false) }
    }

    /// An action: on success "Done", back to the list, reloaded; else why not.
    private func act(reload list: AdminList<AdminUser>? = nil, moderation: Bool = false, _ work: @escaping () async throws -> Void) async {
        guard alive, !busy else { return }
        busy = true
        defer { busy = false }
        do {
            try await work()
            guard alive else { return }
            notice = L("admin.done")
            closeDetail()
            list?.reload()
            if moderation { reportedMessages.reload(); reportedUsers.reload() }
        } catch {
            if alive { notice = AdminText.error(error) }
        }
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
    /// What is typed, cut at the longest reason the servers take.
    public func edit(_ text: String) {
        reason = text.count > Self.maxLength ? String(text.prefix(Self.maxLength)) : text
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
