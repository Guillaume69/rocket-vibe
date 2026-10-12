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

    func testIncomingCallsRequireAResponseAndStillAllowRemoteTeardown() {
        var stack = ModalStack<String>()
        let (settings, incoming) = (UUID(), UUID())
        var cancelled: [String] = []
        stack.show(settings, "settings", cancel: { cancelled.append("settings") })
        stack.show(incoming, "ringing", dismissible: false, cancel: { cancelled.append("call") })
        stack.top?.cancel() // The actual backdrop handler.
        stack.cancelTop() // Escape.
        XCTAssertTrue(cancelled.isEmpty)
        XCTAssertEqual(stack.top?.payload, "ringing")
        stack.show(incoming, "caller updated", dismissible: false, cancel: { cancelled.append("call") })
        stack.cancelTop()
        XCTAssertTrue(cancelled.isEmpty)
        XCTAssertEqual(stack.layers.count, 2)
        stack.hide(incoming) // Accept/Decline, caller cancellation or account teardown.
        XCTAssertEqual(stack.top?.id, settings)
        stack.cancelTop()
        XCTAssertEqual(cancelled, ["settings"], "ordinary modals remain dismissible")
    }

    /// Internal suppression still filters a retired ring without declining it.
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
