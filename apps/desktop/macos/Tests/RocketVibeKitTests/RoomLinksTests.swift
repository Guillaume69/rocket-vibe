import Foundation
import RocketVibeCore
import XCTest

final class RoomLinksTests: XCTestCase {
    func testNativeThreadLinkCrossesUniFFIWithItsTargets() {
        let url = "rocketvibe://salon/room?host=https%3A%2F%2Fchat.example.org%2Fnative&instanceId=instance&dataEpoch=epoch&msg=reply&tmid=root"
        let link = parseRoomLink(url: url)
        XCTAssertEqual(link?.rid, "room")
        XCTAssertEqual(link?.message, "reply")
        XCTAssertEqual(link?.root, "root")
    }
    func testMalformedScopeNeverBecomesAPlainRoomLink() {
        for url in ["rocketvibe://salon/room?nativeScope=null", "rocketvibe://salon/room?instanceId=instance", "rocketvibe://salon/room?host=https%3A%2F%2Fbearer%40chat.example.org"] {
            XCTAssertNil(parseRoomLink(url: url))
        }
        XCTAssertEqual(parseRoomLink(url: "rocketvibe://salon/room")?.rid, "room")
    }
}
