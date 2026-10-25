import RocketVibeCore
@testable import RocketVibeKit
import XCTest

final class BodyLinksTests: XCTestCase {
    private func run(_ text: String, link: String? = nil) -> Run {
        Run(text: text, bold: false, italic: false, strike: false, code: false, link: link, mention: false,
            highlight: false, customEmoji: nil)
    }

    func testTheLinksOfAMessageInOrderOnceEach() {
        let blocks: [BodyBlock] = [
            .paragraph(runs: [run("see "), run("site", link: "https://a.example"), run(" and "),
                              run("@bob", link: "rv-user:bob")]),
            .quote(blocks: [.paragraph(runs: [run("x", link: "https://b.example")])]),
            .list(items: [ListItem(marker: "-", runs: [run("again", link: "https://a.example"),
                                                       run("#general", link: "rv-room:general")])]),
            .code(text: "https://not.a.link"),
        ]
        XCTAssertEqual(linkAddresses(blocks), ["https://a.example", "https://b.example"])
    }
}
