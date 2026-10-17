import RocketVibeCore
import XCTest

@testable import RocketVibeKit

final class CardMenuTests: XCTestCase {
    let options = [MenuOption(label: "Low", value: "low"), MenuOption(label: "Élevée", value: "high")]

    func testTheLabelIsTheChoiceThenTheInitialOptionThenTheName() {
        let menu = CardMenu(source: .options, options: options, initial: "high")
        XCTAssertEqual(CardMenus.label(menu, name: "Priority", chosen: "Low"), "Low")
        XCTAssertEqual(CardMenus.label(menu, name: "Priority", chosen: nil), "Élevée")
        XCTAssertEqual(CardMenus.label(CardMenu(source: .users, options: [], initial: "u-bob"), name: "Assign", chosen: nil), "Assign")
    }

    func testListedOptionsFilterByLabelIgnoringCaseAndAccents() {
        XCTAssertEqual(CardMenus.filter(options, "  "), options)
        XCTAssertEqual(CardMenus.filter(options, "elev").map(\.value), ["high"])
        XCTAssertEqual(CardMenus.filter(options, "LO").map(\.value), ["low"])
        XCTAssertTrue(CardMenus.filter(options, "none").isEmpty)
    }
}
