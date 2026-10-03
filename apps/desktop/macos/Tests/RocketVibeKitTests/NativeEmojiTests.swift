import Foundation
import RocketVibeCore
import XCTest
@testable import RocketVibeKit

final class NativeEmojiTests:XCTestCase {
    @MainActor
    func testCatalogueProtectedImageAndExistingSuggestions() async throws {
        guard let server=ProcessInfo.processInfo.environment["RV_FILE_TEST_SERVER"],
              let password=ProcessInfo.processInfo.environment["RV_FILE_TEST_PASSWORD"] else{throw XCTSkip("Native emoji bench unset")}
        let home=FileManager.default.temporaryDirectory.appendingPathComponent("rv-emoji-kit-\(UUID())")
        defer{try? FileManager.default.removeItem(at:home)}
        let app=AppModel(home:home.path);defer{app.end()}
        app.login.server=server;app.login.user="desktop-files";app.login.password=password
        await app.submitLogin()
        let native=try XCTUnwrap(app.native)
        for _ in 0..<200 {if app.connection == .online{break};try await Task.sleep(nanoseconds:50_000_000)}
        XCTAssertEqual(app.connection,.online)
        XCTAssertTrue(native.supportedFeatures().contains("custom_emojis"))
        XCTAssertTrue(native.customEmojiNames().contains("party_parrot"))
        let path=try XCTUnwrap(native.customEmoji(code:"vibe_parrot"))
        XCTAssertEqual(path,native.customEmoji(code:"party_parrot"))
        let media=try XCTUnwrap(app.media)
        XCTAssertEqual(media.customEmoji("party_parrot"),path)
        let loaded=await media.load(path)
        let data=try XCTUnwrap(loaded)
        XCTAssertEqual(data.contentType,"image/png");XCTAssertGreaterThan(data.bytes.count,8)
        let suggestions=try XCTUnwrap(native.suggestions(beforeCursor:"hello :vibe"))
        XCTAssertEqual(suggestions.items.first?.insert,":vibe_parrot: ")
        XCTAssertEqual(suggestions.items.first?.image,path)
        app.end();XCTAssertFalse(media.current(path));XCTAssertNil(media.cached(path))
    }
}
