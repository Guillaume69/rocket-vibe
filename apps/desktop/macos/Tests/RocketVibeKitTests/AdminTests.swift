import Foundation
import RocketVibeCore
import XCTest

@testable import RocketVibeKit

/// A server administration answering from memory, slowly when asked to.
final class FakeAdmin: ServerAdminProtocol, @unchecked Sendable {
    var people: [AdminUser] = []
    var reportedMessagesList: [AdminReportedMessage] = []
    var refusal: String?
    var delays: [String: UInt64] = [:]
    var calls: [String] = []
    var reasonsAsked = 0
    var reported: [(String, String)] = []

    static func user(_ id: String, admin: Bool = false, active: Bool = true) -> AdminUser {
        AdminUser(id: id, username: id, name: id.capitalized, avatar: nil, avatarVersion: nil, admin: admin, active: active,
                  bot: false, status: .online, createdAt: "2026-10-01T09:00:00Z", lastSeenAt: nil, revision: "1")
    }

    static func lite(_ id: String, deleted: Bool = false) -> AdminUserLite {
        AdminUserLite(id: id, username: id, name: "", deleted: deleted, shown: deleted ? L("user.deleted") : id)
    }

    static func message(_ id: String, author: AdminUserLite, reports: [AdminReport]? = nil) -> AdminReportedMessage {
        AdminReportedMessage(messageId: id, roomId: "r", roomName: "general", roomKind: .public, author: author, text: "spam",
                             createdAt: "2026-10-07T09:00:00Z", deleted: false, count: 2, latestAt: "2026-10-07T10:00:00Z",
                             reports: reports)
    }

    private func refuse() throws {
        if let refusal { throw RvError.Local(message: refusal) }
    }

    func product() -> AdminProduct { .rocketVibe }
    func myId() -> String { "me" }
    func isAdmin() async -> Bool { true }
    func reportsSupported() -> Bool { true }
    func overview() async throws -> AdminOverview {
        try refuse()
        let kinds = AdminKindCounts(total: 3, public: 1, private: 1, direct: 1, discussions: nil, encrypted: 0)
        return AdminOverview(
            product: .rocketVibe, version: "0.9.0", uptimeSeconds: 90_000, database: "PostgreSQL 18.1", migration: "50",
            runtime: nil, instanceId: "i", users: AdminUserCounts(total: 3, active: 3, deactivated: 0, admins: 1, online: 1, away: 0, busy: 0, offline: 2),
            rooms: kinds, messages: kinds, uploadsCount: 1, uploadsBytes: 2048, reportedMessages: 2, reportedUsers: 1)
    }
    func latestVersion() async -> String? { "1.0.0" }
    func users(after: String?, query: String) async throws -> AdminUserPage {
        calls.append("users:\(query):\(after ?? "")")
        if let delay = delays[query] { try await Task.sleep(nanoseconds: delay) }
        try refuse()
        let matching = people.filter { query.isEmpty || $0.username.contains(query) }
        let start = Int(after ?? "0") ?? 0
        let page = Array(matching.dropFirst(start).prefix(2))
        let next = start + 2 < matching.count ? String(start + 2) : nil
        return AdminUserPage(items: page, next: next)
    }
    func setAdmin(user: AdminUser, admin: Bool) async throws -> AdminUser {
        calls.append("setAdmin:\(user.id):\(admin)")
        try refuse()
        return user
    }
    func setActive(user: AdminUser, active: Bool) async throws -> AdminUser {
        calls.append("setActive:\(user.id):\(active)")
        try refuse()
        return user
    }
    func deleteUser(user: AdminUser) async throws {
        calls.append("delete:\(user.id)")
        try refuse()
        people.removeAll { $0.id == user.id }
    }
    func rooms(after: String?, query: String) async throws -> AdminRoomPage { AdminRoomPage(items: [], next: nil) }
    func reportedMessages(after: String?) async throws -> AdminReportedMessagePage {
        calls.append("reportedMessages")
        return AdminReportedMessagePage(items: reportedMessagesList, next: nil)
    }
    func messageReports(item: AdminReportedMessage) async throws -> [AdminReport] {
        reasonsAsked += 1
        return [AdminReport(reporter: Self.lite("bob"), reason: "rude", at: "2026-10-07T10:00:00Z")]
    }
    func dismissMessageReports(item: AdminReportedMessage) async throws {
        calls.append("dismiss:\(item.messageId)")
        reportedMessagesList.removeAll { $0.messageId == item.messageId }
    }
    func deleteReportedMessage(item: AdminReportedMessage) async throws { calls.append("deleteMessage:\(item.messageId)") }
    func deactivateAuthor(item: AdminReportedMessage) async throws { calls.append("deactivateAuthor:\(item.author.id)") }
    func reportedUsers(after: String?) async throws -> AdminReportedUserPage { AdminReportedUserPage(items: [], next: nil) }
    func userReports(item: AdminReportedUser) async throws -> [AdminReport] { [] }
    func dismissUserReports(item: AdminReportedUser) async throws { calls.append("dismissUser:\(item.user.id)") }
    func reportMessage(messageId: String, reason: String) async throws {
        try refuse()
        reported.append((messageId, reason))
    }
    func reportUser(userId: String, reason: String) async throws {
        try refuse()
        reported.append((userId, reason))
    }
}

final class AdminTests: XCTestCase {
    override func setUp() { setFrench(french: false) }

    @MainActor
    func until(_ condition: @escaping @MainActor () -> Bool) async throws {
        for _ in 0..<200 {
            if condition() { return }
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        XCTFail("timed out")
    }

    func testTexts() {
        XCTAssertEqual(AdminText.error(code: "self_administration"), L("admin.error_self"))
        XCTAssertEqual(AdminText.error(code: "last_administrator"), L("admin.error_last_admin"))
        XCTAssertEqual(AdminText.error(code: "revision_conflict"), L("admin.error_conflict"))
        XCTAssertEqual(AdminText.error(code: "error-action-not-allowed"), L("admin.error_denied"))
        XCTAssertEqual(AdminText.error(code: "connection_failed"), L("admin.failed"))
        XCTAssertEqual(AdminText.error(RvError.Local(message: "permission_denied")), L("admin.error_denied"))
        XCTAssertEqual(AdminText.duration(90_000), "1 d 1 h")
        XCTAssertEqual(AdminText.duration(3_720), "1 h 2 min")
        XCTAssertEqual(AdminText.duration(59), "0 min")
        XCTAssertEqual(AdminText.date("2026-10-07T09:00:00Z", timeZone: TimeZone(identifier: "UTC")!), "7 Oct 2026")
        XCTAssertEqual(AdminText.date("2026-10-07T09:00:00.123Z", timeZone: TimeZone(identifier: "UTC")!), "7 Oct 2026")
        XCTAssertEqual(AdminText.date("soon"), "soon")
        XCTAssertEqual(AdminText.update(current: "8.5.1", latest: "8.8.1"), "Update available: 8.8.1")
        XCTAssertEqual(AdminText.update(current: "8.8.1", latest: "8.8.1"), L("admin.up_to_date"))
        XCTAssertNil(AdminText.update(current: "8.8.1", latest: nil))
        XCTAssertEqual(AdminCategory.allCases.map(\.title), ["Dashboard", "Moderation", "Rooms", "Users"])
    }

    @MainActor
    func testSearchesNeverShowAStaleAnswerAndPagesFollow() async throws {
        let fake = FakeAdmin()
        fake.people = ["alice", "albert", "alfred", "bob"].map { FakeAdmin.user($0) }
        fake.delays["a"] = 400_000_000
        let model = AdminModel(source: fake)
        model.show(.users)
        try await until { model.users.loaded }
        XCTAssertEqual(model.users.items.map(\.id), ["alice", "albert"])
        model.users.more()
        try await until { model.users.items.count == 4 }
        XCTAssertNil(model.users.next)
        model.users.search("a")
        try await Task.sleep(nanoseconds: 300_000_000)
        model.users.search("bo")
        try await until { model.users.loaded && !model.users.loading }
        XCTAssertEqual(model.users.items.map(\.id), ["bob"])
        try await Task.sleep(nanoseconds: 300_000_000)
        XCTAssertEqual(model.users.items.map(\.id), ["bob"], "the slow answer to `a` came too late")
    }

    @MainActor
    func testDashboardModerationAndActions() async throws {
        let fake = FakeAdmin()
        fake.people = [FakeAdmin.user("me", admin: true), FakeAdmin.user("bob")]
        fake.reportedMessagesList = [FakeAdmin.message("m1", author: FakeAdmin.lite("bob")),
                                     FakeAdmin.message("m2", author: FakeAdmin.lite("gone", deleted: true), reports: [])]
        let model = AdminModel(source: fake)
        model.show(.dashboard)
        try await until { model.overview != nil && model.latestVersion != nil }
        XCTAssertEqual(model.reportCount, 3)
        XCTAssertEqual(model.updateNote, "Update available: 1.0.0")
        XCTAssertEqual(model.deleteUserBody, L("admin.delete_user_body_rv"))

        model.show(.moderation)
        try await until { model.reportedMessages.loaded }
        let first = model.reportedMessages.items[0]
        model.open(.message(first))
        try await until { model.reasons != nil }
        XCTAssertEqual(model.reasons?.first?.reason, "rude")
        XCTAssertEqual(fake.reasonsAsked, 1, "read when the item opens")
        XCTAssertTrue(model.canDeactivateAuthor(first))
        let gone = model.reportedMessages.items[1]
        XCTAssertFalse(model.canDeactivateAuthor(gone), "a deleted author")
        model.open(.message(gone))
        XCTAssertEqual(model.reasons, [], "carried by the list")
        XCTAssertEqual(fake.reasonsAsked, 1)
        model.open(.message(first))
        await model.dismiss(first)
        XCTAssertEqual(model.notice, L("admin.done"))
        XCTAssertNil(model.detail)
        try await until { model.reportedMessages.loaded && model.reportedMessages.items.count == 1 }

        model.show(.users)
        try await until { model.users.loaded }
        XCTAssertTrue(model.isMe(model.users.items[0]))
        let bob = model.users.items[1]
        fake.refusal = "last_administrator"
        await model.setAdmin(bob, false)
        XCTAssertEqual(model.notice, L("admin.error_last_admin"))
        fake.refusal = nil
        await model.delete(bob)
        XCTAssertTrue(fake.calls.contains("delete:bob"))
        try await until { model.users.loaded && model.users.items.count == 1 }

        fake.refusal = "failed"
        model.close()
        await model.refreshOverview()
        XCTAssertNil(model.overviewError, "nothing applies once closed")
    }

    @MainActor
    func testReportDraft() async throws {
        let fake = FakeAdmin()
        let draft = ReportDraft(target: .message("m1"))
        XCTAssertEqual(draft.title, L("report.title_message"))
        XCTAssertFalse(draft.canSend)
        draft.edit("   ")
        XCTAssertFalse(draft.canSend, "a reason is required")
        draft.edit(String(repeating: "x", count: 1_200))
        XCTAssertEqual(draft.reason.count, ReportDraft.maxLength)
        draft.edit("  spam  ")
        XCTAssertTrue(draft.canSend)
        let sent = await draft.send(with: fake)
        XCTAssertEqual(sent, L("report.sent"))
        XCTAssertEqual(fake.reported.first?.1, "spam")
        fake.refusal = "self_report"
        let refused = await ReportDraft(target: .user("me")).send(with: fake)
        XCTAssertEqual(refused, L("report.failed"), "nothing typed")
        let mine = ReportDraft(target: .user("me"))
        mine.edit("why")
        XCTAssertEqual(mine.title, L("report.user"))
        let failed = await mine.send(with: fake)
        XCTAssertEqual(failed, L("report.failed"))
    }

    @MainActor
    func testTheAdministrationNeedsAnAdministrator() {
        let home = FileManager.default.temporaryDirectory.appendingPathComponent("rv-admin-\(UUID())")
        defer { try? FileManager.default.removeItem(at: home) }
        let app = AppModel(home: home.path)
        app.openAdmin()
        XCTAssertNil(app.admin, "no account, no administration")
        XCTAssertFalse(app.reportsSupported)
        app.startReport(.message("m"))
        XCTAssertNil(app.reporting)
        XCTAssertFalse(app.deletedAccount(username: "deleted-x"), "only RocketVibe reserves the name")
        XCTAssertTrue(deletedUsername(username: "deleted-x"))
    }
}
