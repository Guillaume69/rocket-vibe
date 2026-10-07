import Foundation
import RocketVibeCore
import XCTest

@testable import RocketVibeKit

final class ModalsTests: XCTestCase {
    func testTheTopModalAloneIsCancelledAndNeverActedOn() {
        var stack = ModalStack<String>()
        var cancelled: [String] = []
        let (a, b) = (UUID(), UUID())
        XCTAssertTrue(stack.isEmpty)
        stack.cancelTop()
        XCTAssertEqual(cancelled, [], "nothing open, nothing to cancel")
        stack.show(a, "settings confirm", cancel: { cancelled.append("a") })
        stack.show(b, "unlock", cancel: { cancelled.append("b") })
        XCTAssertEqual(stack.top?.payload, "unlock")
        stack.cancelTop()
        XCTAssertEqual(cancelled, ["b"], "a click outside cancels the top one only")
        stack.show(a, "settings confirm, again", cancel: { cancelled.append("a2") })
        XCTAssertEqual(stack.layers.map(\.payload), ["settings confirm, again", "unlock"], "refreshed in place")
        stack.hide(b)
        XCTAssertEqual(stack.top?.id, a)
        stack.cancelTop()
        XCTAssertEqual(cancelled, ["b", "a2"])
        stack.hide(a)
        XCTAssertTrue(stack.isEmpty)
    }

    /// A click outside the incoming-call prompt sets the ring aside: no
    /// prompt, no ringtone, and nothing sent (the call is not declined).
    @MainActor
    func testAnIgnoredRingNoLongerPromptsButStaysUndeclined() {
        let ring = VoiceCall(id: "c1", room: "r", callerId: "bob", callerName: "Bob", calleeId: "me", state: "ringing")
        let other = VoiceCall(id: "c2", room: "s", callerId: "eve", callerName: "Eve", calleeId: "me", state: "ringing")
        XCTAssertEqual(VoiceModel.incoming([ring], me: "me", answered: nil, ignored: [], room: nil)?.id, "c1")
        XCTAssertNil(VoiceModel.incoming([ring], me: "me", answered: nil, ignored: ["c1"], room: nil))
        XCTAssertEqual(VoiceModel.incoming([ring, other], me: "me", answered: nil, ignored: ["c1"], room: nil)?.id, "c2",
                       "another call still rings")
        XCTAssertEqual(ring.state, "ringing")
    }

    func testModalSizesFitTheWindow() {
        XCTAssertEqual(ModalLayout.size(.card, width: 1000, height: 700).width, 952)
        XCTAssertEqual(ModalLayout.size(.card, width: 30, height: 30).height, 0)
        XCTAssertEqual(ModalLayout.size(.sheet(width: 520, height: 640), width: 1200, height: 900).width, 520)
        XCTAssertEqual(ModalLayout.size(.sheet(width: 520, height: 640), width: 500, height: 400).height, 360)
        XCTAssertEqual(ModalLayout.size(.media, width: 2000, height: 2000).width, 1100)
        XCTAssertEqual(ModalLayout.size(.fullWindow, width: 800, height: 600).height, 600)
    }
}
