import Foundation
import XCTest
@testable import RocketVibeKit

final class CryptoHistoryTests: XCTestCase {
    private func decode<T: Decodable>(_ json: String) throws -> T {
        let decoder = JSONDecoder(); decoder.keyDecodingStrategy = .convertFromSnakeCase
        return try decoder.decode(T.self, from: Data(json.utf8))
    }
    func testOffersAndPreviewKeepExactFingerprintsAndLargeCounts() throws {
        let offers: CryptoHistoryOffers = try decode("""
        {"id":"7","offers":[{"fingerprint":"\(String(repeating: "ab", count: 32))","device":"phone","expires_at":"9007199254740993"}]}
        """)
        XCTAssertEqual(offers.offers.first?.device, "phone")
        XCTAssertEqual(offers.offers.first?.expiresAt, "9007199254740993")
        let preview: CryptoHistoryPreview = try decode("""
        {"id":"8","fingerprint":"fp","device":"phone","can_delegate":false,"periods":[{"room":"general","documents":"9007199254740995"}]}
        """)
        XCTAssertEqual(preview.periods.first?.documents, "9007199254740995")
        let waiting: CryptoHistoryImport = try decode(#"{"state":"waiting","request":"fp"}"#)
        XCTAssertEqual(waiting.request, "fp")
        let idle: CryptoHistoryImport = try decode(#"{"state":"idle"}"#)
        XCTAssertNil(idle.request)
        XCTAssertEqual(CryptoHistoryState.requested("fp").fingerprint, "fp")
        XCTAssertNil(CryptoHistoryState.shared.fingerprint)
    }
    func testHistoryBackupStatusKeepsTheGenerationAndPendingState() throws {
        let status: CryptoHistoryBackupStatus = try decode("""
        {"holds_key":true,"generation":"\(String(repeating: "ab", count: 16))","receipt":{"scope":{"instance_id":"i","data_epoch":"e"},"operation_id":"op","device_id":"desktop","incarnation":"01","device_revision":"1","root_fingerprint":"fp","generation":"g","generation_revision":"9007199254740993","package_digest":"d"},"pending":false,"code_saved":false,"cancel_requested":false}
        """)
        XCTAssertTrue(status.holdsKey)
        XCTAssertEqual(status.receipt?.generationRevision, "9007199254740993")
        let preview: CryptoHistoryBackupPreview = try decode(#"{"id":"7","generation_revision":null}"#)
        XCTAssertNil(preview.generationRevision)
    }
    @MainActor
    func testClosedSettingsNeverShowTheHistoryCode() async {
        let app = AppModel(home: FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString).path)
        defer { app.end() }
        let model = CryptoModel(app: app)
        model.historyJoinCode = "rvh1-disposable"
        model.close()
        await model.showHistoryCode()
        XCTAssertTrue(model.historyCode.isEmpty)
        XCTAssertTrue(model.historyJoinCode.isEmpty)
        XCTAssertNil(model.historyBackup)
    }
    @MainActor
    func testClosedSettingsNeverShareOrKeepOffers() async {
        let app = AppModel(home: FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString).path)
        defer { app.end() }
        let model = CryptoModel(app: app)
        model.close()
        await model.reviewHistoryRequests()
        await model.shareHistory()
        XCTAssertNil(model.historyOffers)
        XCTAssertNil(model.historyPreview)
        XCTAssertEqual(model.history, .idle)
        XCTAssertFalse(model.busy)
    }
}
