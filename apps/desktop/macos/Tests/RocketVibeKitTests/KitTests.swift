import Foundation
import RocketVibeCore
import XCTest

@testable import RocketVibeKit

final class PendingTests: XCTestCase {
    func testABurstReloadsEachThingOnce() {
        var pending = Pending()
        XCTAssertTrue(pending.isEmpty)
        pending.add(rids: ["a"])
        pending.add(rooms: true, rids: ["b", "a"])
        XCTAssertTrue(pending.reloadsRooms)
        XCTAssertTrue(pending.reloads("a"))
        XCTAssertTrue(pending.reloads("b"))
        XCTAssertFalse(pending.reloads("c"))
        XCTAssertFalse(pending.reloads(nil))
        pending.add(everything: true)
        XCTAssertTrue(pending.reloads("c"))
    }
}

final class FormattingTests: XCTestCase {
    var calendar = Calendar(identifier: .gregorian)

    override func setUp() {
        calendar.timeZone = .current
        setFrench(french: false)
    }

    func ms(_ y: Int, _ m: Int, _ d: Int, _ h: Int = 12) -> Int64 {
        let date = calendar.date(from: DateComponents(year: y, month: m, day: d, hour: h, minute: 5))!
        return Int64(date.timeIntervalSince1970 * 1000)
    }

    func testRoomListTimes() {
        let now = Formatting.date(ms(2026, 9, 29, 18))
        XCTAssertEqual(Formatting.shortTime(ms(2026, 9, 29), now: now, calendar: calendar), "12:05")
        XCTAssertEqual(Formatting.shortTime(ms(2026, 9, 27), now: now, calendar: calendar), "Sun")
        XCTAssertEqual(Formatting.shortTime(ms(2026, 9, 1), now: now, calendar: calendar), "01/09/2026")
        XCTAssertEqual(Formatting.shortTime(0, now: now, calendar: calendar), "")
    }

    func testDaySeparators() {
        let now = Formatting.date(ms(2026, 9, 29, 18))
        XCTAssertEqual(Formatting.day(ms(2026, 9, 29, 1), now: now, calendar: calendar), "Today")
        XCTAssertEqual(Formatting.day(ms(2026, 9, 28), now: now, calendar: calendar), "Yesterday")
        XCTAssertEqual(Formatting.day(ms(2026, 9, 1), now: now, calendar: calendar), "Tuesday 1 September 2026")
        setFrench(french: true)
        XCTAssertEqual(Formatting.day(ms(2026, 9, 28), now: now, calendar: calendar), "Hier")
        XCTAssertEqual(Formatting.day(ms(2026, 9, 1), now: now, calendar: calendar), "mardi 1 septembre 2026")
    }
}

final class StringsTests: XCTestCase {
    func testTheSharedCatalog() {
        setFrench(french: true)
        XCTAssertTrue(Strings.french)
        XCTAssertEqual(L("message.replies", count: 0), "0 réponse")
        XCTAssertEqual(L("typing.one", ["a": "bob"]), "bob écrit…")
        setFrench(french: false)
        XCTAssertEqual(L("message.replies", count: 0), "0 replies")
    }

    func testTheSavedLanguageWins() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("rv-lang-\(getpid())")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        Strings.setUp(configDir: dir.path, languages: ["fr-FR"])
        XCTAssertTrue(Strings.french)
        try "en\n".write(to: dir.appendingPathComponent("language"), atomically: true, encoding: .utf8)
        Strings.setUp(configDir: dir.path, languages: ["fr-FR"])
        XCTAssertFalse(Strings.french)
    }

    @MainActor
    func testLoginErrors() {
        setFrench(french: false)
        XCTAssertEqual(LoginModel.describe(status: 0, message: "", askingCode: false), L("login.unreachable"))
        XCTAssertEqual(LoginModel.describe(status: 401, message: "", askingCode: true), L("login.bad_code"))
        XCTAssertEqual(LoginModel.describe(status: 401, message: "", askingCode: false), L("login.rejected"))
        XCTAssertEqual(LoginModel.describe(status: 500, message: "boom", askingCode: false), "boom")
    }
}

/// Against the test server: `RV_TEST_SERVER=http://localhost:3000`.
final class LiveTests: XCTestCase {
    @MainActor
    func testSignInOpenARoomAndSend() async throws {
        guard let server = ProcessInfo.processInfo.environment["RV_TEST_SERVER"] else {
            throw XCTSkip("RV_TEST_SERVER unset")
        }
        let home = FileManager.default.temporaryDirectory.appendingPathComponent("rv-kit-\(getpid())").path
        defer { try? FileManager.default.removeItem(atPath: home) }
        let app = AppModel(home: home)
        app.login.server = server
        app.login.user = "alice"
        app.login.password = "wrong"
        await app.submitLogin()
        XCTAssertEqual(app.screen, .starting)
        XCTAssertEqual(app.login.error, L("login.rejected"))

        app.login.password = "alice-dev-2026"
        await app.submitLogin()
        XCTAssertEqual(app.screen, .chat)
        try await until { app.rooms.contains { $0.name == "test-public" } }
        try await until { app.connection == .online }

        let rid = app.rooms.first { $0.name == "test-public" }!.rid
        app.open(rid)
        let room = try XCTUnwrap(app.room)
        let text = "swift kit \(getpid())"
        room.draft = text
        await room.send()
        try await until { room.messages.contains { $0.text == text && $0.delivery == .sent } }
        XCTAssertEqual(room.draft, "")
        let mine = try XCTUnwrap(room.lastMine())
        XCTAssertEqual(mine.text, text)
        let actions = room.actions(for: mine)
        XCTAssertTrue(actions.contains(.edit))
        try await room.delete(mine)
        try await until { !room.messages.contains { $0.id == mine.id } }

        let avatar = await app.media?.load(app.media!.avatar(user: "alice"))
        XCTAssertFalse(avatar?.bytes.isEmpty ?? true)
        await app.signOut()
        XCTAssertEqual(app.screen, .login)
    }

    @MainActor
    func testTheProbeSaysWhatTheServerIs() async throws {
        guard let server = ProcessInfo.processInfo.environment["RV_TEST_SERVER"] else {
            throw XCTSkip("RV_TEST_SERVER unset")
        }
        setFrench(french: false)
        let home = FileManager.default.temporaryDirectory.appendingPathComponent("rv-probe-\(getpid())").path
        defer { try? FileManager.default.removeItem(atPath: home) }
        let app = AppModel(home: home)
        app.login.server = server
        await app.login.probe(client: app.client)
        XCTAssertTrue(app.login.probeLine?.hasPrefix("Rocket.Chat 8.") ?? false, app.login.probeLine ?? "nil")
        XCTAssertFalse(app.login.probeBad)
        app.login.server = "http://127.0.0.1:9"
        await app.login.probe(client: app.client)
        XCTAssertEqual(app.login.probeLine, L("login.probe_failed"))
        XCTAssertTrue(app.login.probeBad)
    }

    @MainActor
    func until(_ condition: @escaping @MainActor () -> Bool) async throws {
        var tries = 0
        while !condition() && tries < 200 {
            tries += 1
            try await Task.sleep(nanoseconds: 100_000_000)
        }
        XCTAssertTrue(condition())
    }
}
