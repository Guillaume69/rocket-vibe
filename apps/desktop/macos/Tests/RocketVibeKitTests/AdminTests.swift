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
    /// Rocket.Chat refusing to drop the last owner of rooms until asked again.
    var lastOwner: AdminLastOwner?
    /// Rocket.Chat deleting a reported message only with all of its author's.
    var bulkOnly: UInt64?
    var product_: AdminProduct = .rocketVibe
    /// Nil: a server without bots.
    var userBots_: Bool? = false

    static func user(_ id: String, admin: Bool = false, active: Bool = true) -> AdminUser {
        AdminUser(id: id, username: id, name: id.capitalized, avatar: nil, avatarVersion: nil, admin: admin, active: active,
                  bot: false, status: .online, createdAt: "2026-10-01T09:00:00Z", lastSeenAt: nil, revision: "1")
    }

    static func lite(_ id: String, deleted: Bool = false) -> AdminUserLite {
        AdminUserLite(id: id, username: id, name: "", deleted: deleted, shown: deleted ? L("user.deleted") : id)
    }

    static func message(_ id: String, author: AdminUserLite, reports: [AdminReport]? = nil) -> AdminReportedMessage {
        AdminReportedMessage(messageId: id, roomId: "r", roomName: "general", roomKind: .public, author: author,
                             authorRevision: "1", text: "spam", encrypted: false,
                             createdAt: "2026-10-07T09:00:00Z", deleted: false, count: 2, latestAt: "2026-10-07T10:00:00Z",
                             reports: reports)
    }

    private func refuse() throws {
        if let refusal { throw AdminFailure.Refused(code: refusal, lastOwner: nil, count: nil) }
    }

    func product() -> AdminProduct { product_ }
    func myId() -> String { "me" }
    func isAdmin() async -> Bool { true }
    func reportsSupported() -> Bool { true }
    func overview(refresh: Bool) async throws -> AdminOverview {
        calls.append("overview:\(refresh)")
        try refuse()
        let kinds = AdminKindCounts(total: 3, public: 1, private: 1, direct: 1, discussions: nil, encrypted: 0)
        return AdminOverview(
            product: .rocketVibe, version: "0.9.0", uptimeSeconds: 90_000, database: "PostgreSQL 18.1", migration: "50",
            runtime: nil, instanceId: "i", users: AdminUserCounts(total: 3, active: 3, deactivated: 0, admins: 1, online: 1, away: 0, busy: 0, offline: 2),
            rooms: kinds, messages: kinds, uploadsCount: 1, uploadsBytes: 2048, reportedMessages: 2, reportedUsers: nil,
            asOf: "2026-10-07T09:00:00Z")
    }
    func latestVersion() async -> String? { "1.0.0" }
    func userBots() async throws -> Bool? { userBots_ }
    var icon_: [UInt8]?
    func iconSupported() -> Bool { true }
    func icon() async -> [UInt8]? { icon_ }
    func setIcon(png: [UInt8]?) async throws {
        calls.append("setIcon:\(png?.count ?? 0)")
        try refuse()
        icon_ = png
    }
    var emojiSupported_ = true
    var emojiList: [AdminEmoji] = []
    func emojiSupported() -> Bool { emojiSupported_ }
    func emojis() async throws -> [AdminEmoji] {
        calls.append("emojis")
        try refuse()
        return emojiList
    }
    func createEmoji(name: String, aliases: String, file: String) async throws {
        calls.append("createEmoji:\(name):\(aliases)")
        try refuse()
        emojiList.append(AdminEmoji(id: name, name: name, aliases: aliases.split(separator: ",").map(String.init),
                                    revision: "1", image: "/emoji-custom/\(name).png"))
    }
    func deleteEmoji(item: AdminEmoji) async throws {
        calls.append("deleteEmoji:\(item.name)")
        try refuse()
        emojiList.removeAll { $0.id == item.id }
    }
    func setUserBots(on: Bool) async throws -> Bool {
        calls.append("userBots:\(on)")
        try refuse()
        userBots_ = on
        return on
    }
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
    private func owning(_ relinquish: Bool) throws {
        if let lastOwner, !relinquish { throw AdminFailure.Refused(code: "user-last-owner", lastOwner: lastOwner, count: nil) }
    }
    func setActive(user: AdminUser, active: Bool, relinquish: Bool) async throws -> AdminUser {
        calls.append("setActive:\(user.id):\(active):\(relinquish)")
        try refuse()
        try owning(relinquish)
        return user
    }
    func deleteUser(user: AdminUser, relinquish: Bool) async throws {
        calls.append("delete:\(user.id):\(relinquish)")
        try refuse()
        try owning(relinquish)
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
    func deleteReportedMessage(item: AdminReportedMessage) async throws {
        calls.append("deleteMessage:\(item.messageId)")
        if let bulkOnly { throw AdminFailure.Refused(code: "moderation_bulk_only", lastOwner: nil, count: bulkOnly) }
    }
    func deleteAuthorReportedMessages(item: AdminReportedMessage) async throws { calls.append("deleteAll:\(item.author.id)") }
    func deactivateAuthor(item: AdminReportedMessage, relinquish: Bool) async throws {
        calls.append("deactivateAuthor:\(item.author.id):\(relinquish)")
    }
    func reportedUsers(after: String?) async throws -> AdminReportedUserPage { AdminReportedUserPage(items: [], next: nil) }
    func userReports(item: AdminReportedUser) async throws -> AdminReportedUserDetails {
        AdminReportedUserDetails(reports: [], active: false)
    }
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
        XCTAssertEqual(AdminText.error(code: "error-admin-required"), L("admin.error_last_admin"))
        XCTAssertEqual(AdminText.error(code: "not_found"), L("admin.error_not_found"))
        XCTAssertEqual(AdminText.error(code: "self_report"), L("report.error_self"))
        XCTAssertEqual(AdminText.error(code: "connection_failed"), L("native.offline"))
        XCTAssertEqual(AdminText.error(code: "something"), L("admin.failed"))
        XCTAssertEqual(AdminText.error(AdminFailure.Refused(code: "permission_denied", lastOwner: nil, count: nil)), L("admin.error_denied"))
        XCTAssertEqual(AdminText.figure(nil), L("admin.unknown"))
        XCTAssertEqual(AdminText.figure(3), "3")
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
        XCTAssertEqual(fake.calls.first, "overview:false", "the cached figures on opening")
        XCTAssertEqual(model.reportCount, 2, "a figure refused counts as none")
        XCTAssertEqual(model.asOf, "Figures as of 7 Oct 2026")
        XCTAssertEqual(model.updateNote, "Update available: 1.0.0")
        XCTAssertEqual(model.deleteUserBody, L("admin.delete_user_body_rv"))
        try await until { model.userBots != nil }
        XCTAssertEqual(model.userBots, false, "bots closed to members by default")
        await model.setUserBots(true)
        XCTAssertEqual(model.userBots, true)
        XCTAssertEqual(fake.calls.last, "userBots:true")

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
        XCTAssertTrue(fake.calls.contains("delete:bob:false"))
        try await until { model.users.loaded && model.users.items.count == 1 }

        // Rocket.Chat: the last owner of rooms is asked about them, then the action goes on.
        fake.lastOwner = AdminLastOwner(removed: ["solo"], transferred: ["team", "ops"])
        let carol = FakeAdmin.user("carol")
        model.notice = nil
        await model.setActive(carol, false)
        XCTAssertEqual(model.followUp?.title, L("admin.last_owner_title"))
        XCTAssertEqual(model.followUp?.message, "Deleted (only member): solo\nOwnership moves: team, ops")
        XCTAssertNil(model.notice, "nothing done yet")
        await model.confirmFollowUp()
        XCTAssertNil(model.followUp)
        XCTAssertEqual(fake.calls.filter { $0.hasPrefix("setActive:carol") }, ["setActive:carol:false:false", "setActive:carol:false:true"])
        XCTAssertEqual(model.notice, L("admin.done"))
        await model.delete(carol)
        XCTAssertNotNil(model.followUp)
        model.dismissFollowUp()
        XCTAssertEqual(fake.calls.filter { $0.hasPrefix("delete:carol") }, ["delete:carol:false"], "no means nothing")
        fake.lastOwner = nil

        // Rocket.Chat: a message it can only delete with all of its author's.
        fake.bulkOnly = 4
        let spam = FakeAdmin.message("m9", author: FakeAdmin.lite("bob"))
        await model.delete(spam)
        XCTAssertEqual(model.followUp?.message, L("admin.bulk_delete_body", ["n": "4"]))
        await model.confirmFollowUp()
        XCTAssertTrue(fake.calls.contains("deleteAll:bob"))
        fake.bulkOnly = nil

        // Rocket.Chat's list does not say whether a reported account is active; its page does.
        let reported = AdminReportedUser(user: FakeAdmin.user("dave", active: true), active: nil, count: 1,
                                         latestAt: "2026-10-07T10:00:00Z", reports: nil)
        XCTAssertTrue(model.canDeactivate(reported), "unknown: offered")
        model.open(.reportedUser(reported))
        try await until { model.reasons != nil }
        XCTAssertFalse(model.canDeactivate(reported), "the page says inactive")
        var encrypted = FakeAdmin.message("m8", author: FakeAdmin.lite("bob"))
        encrypted.encrypted = true
        encrypted.text = ""
        XCTAssertEqual(model.text(encrypted), L("admin.encrypted_message"))

        fake.refusal = "failed"
        model.close()
        await model.refreshOverview(refresh: true)
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
        // 600 thumbs with a skin tone: 600 characters, 1,200 scalars, cut as the servers count.
        draft.edit(String(repeating: "\u{1F44D}\u{1F3FD}", count: 600))
        XCTAssertEqual(draft.reason.unicodeScalars.count, ReportDraft.maxLength)
        XCTAssertTrue(draft.canSend)
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
    func testTheServerIconIsSetAndRemoved() async throws {
        let fake = FakeAdmin()
        let model = AdminModel(source: fake)
        XCTAssertTrue(model.iconSupported)
        await model.loadIcon()
        XCTAssertNil(model.icon)
        let saved = await model.setIcon(png: Data([1, 2, 3]))
        XCTAssertTrue(saved)
        XCTAssertEqual(model.icon, Data([1, 2, 3]))
        XCTAssertEqual(model.notice, L("admin.icon_saved"))
        fake.refusal = "error-invalid-file-width"
        let refused = await model.setIcon(png: Data([4]))
        XCTAssertFalse(refused)
        XCTAssertEqual(model.notice, L("admin.icon_error_size"))
        fake.refusal = nil
        _ = await model.setIcon(png: nil)
        XCTAssertNil(model.icon)
        XCTAssertEqual(fake.calls.filter { $0.hasPrefix("setIcon") }, ["setIcon:3", "setIcon:1", "setIcon:0"])
    }

    func testCustomEmojiAreListedAddedAndDeleted() async throws {
        let fake = FakeAdmin()
        let model = AdminModel(source: fake)
        XCTAssertEqual(model.categories.last, .emoji)
        model.show(.emoji)
        try await until { model.emojis != nil }
        XCTAssertEqual(model.emojis, [])
        let added = await model.createEmoji(name: "shipit", aliases: "ship_it", file: URL(fileURLWithPath: "/tmp/shipit.png"))
        XCTAssertTrue(added)
        XCTAssertEqual(model.emojis?.map(\.name), ["shipit"])
        XCTAssertEqual(model.notice, L("admin.emoji_added"))
        fake.refusal = "emoji_name_taken"
        let again = await model.createEmoji(name: "shipit", aliases: "", file: URL(fileURLWithPath: "/tmp/shipit.png"))
        XCTAssertFalse(again)
        XCTAssertEqual(model.notice, L("admin.emoji_error_taken"))
        fake.refusal = nil
        await model.deleteEmoji(model.emojis![0])
        XCTAssertEqual(model.emojis, [])
        fake.emojiSupported_ = false
        XCTAssertFalse(AdminModel(source: fake).categories.contains(.emoji))
    }

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
