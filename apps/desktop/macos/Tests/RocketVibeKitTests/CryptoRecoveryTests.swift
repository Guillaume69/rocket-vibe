import Foundation
import XCTest
@testable import RocketVibeKit

final class CryptoRecoveryTests: XCTestCase {
    private func decode<T: Decodable>(_ json: String) throws -> T {
        let decoder = JSONDecoder(); decoder.keyDecodingStrategy = .convertFromSnakeCase
        return try decoder.decode(T.self, from: Data(json.utf8))
    }
    func testInterruptedBackupKeepsExactLargeRevisionAndCancellationState() throws {
        let status: CryptoBackupStatus = try decode("""
        {"controls_root":true,"root_fingerprint":"root","receipt":{"backup_id":"packet","backup_revision":"9007199254740993"},"pending":true,"code_saved":false,"cancel_requested":true}
        """)
        XCTAssertEqual(status.receipt?.backupRevision, "9007199254740993")
        XCTAssertTrue(status.pending)
        XCTAssertTrue(status.cancelRequested)
        XCTAssertFalse(status.codeSaved)
        let restore: CryptoRestorePreview = try decode("""
        {"id":"9007199254740994","root_fingerprint":"root","backup_id":"packet"}
        """)
        XCTAssertEqual(restore.id, "9007199254740994")
        XCTAssertEqual(restore.backupId, "packet")
    }
    @MainActor
    func testClosingSettingsClearsInputAndMakesItImpossibleToDisplayAgain() async {
        let app = AppModel(home: FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString).path)
        defer { app.end() }
        let model = CryptoModel(app: app)
        model.restoreCode = "disposable-test-code"
        model.close()
        await model.showRecoveryCode()
        XCTAssertTrue(model.restoreCode.isEmpty)
        XCTAssertTrue(model.recoveryCode.isEmpty)
        XCTAssertNil(model.backupApproval)
        XCTAssertNil(model.restoreApproval)
        XCTAssertFalse(model.busy)
    }
}
