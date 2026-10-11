import Foundation
import XCTest
@testable import RocketVibeKit

final class MediaFileCacheTests: XCTestCase {
    func testIndependentAccountsCannotReuseTheSameProtectedPath() throws {
        let first = MediaFileCache()
        let second = MediaFileCache()
        defer { first.clear(); second.clear() }
        let path = "/file-upload/same/report.pdf"
        let a = try first.save(path, name: "report.pdf", bytes: Data("Alice".utf8))
        XCTAssertNil(second.cached(path))
        let b = try second.save(path, name: "report.pdf", bytes: Data("Bob".utf8))
        XCTAssertNotEqual(a, b)
        XCTAssertEqual(try Data(contentsOf: a), Data("Alice".utf8))
        XCTAssertEqual(try Data(contentsOf: b), Data("Bob".utf8))
        first.clear()
        XCTAssertFalse(FileManager.default.fileExists(atPath: a.path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: b.path))
    }

    func testAnAttachmentNameCannotEscapeItsPrivateDirectory() throws {
        let cache = MediaFileCache()
        defer { cache.clear() }
        let file = try cache.save("/file-upload/id", name: "../..\\secret.pdf", bytes: Data([1]))
        XCTAssertTrue(file.deletingLastPathComponent().lastPathComponent.hasPrefix("rv-media-"))
        XCTAssertFalse(file.lastPathComponent.contains("\\"))
        XCTAssertEqual(cache.cached("/file-upload/id"), file)
    }
}
