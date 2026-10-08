import Foundation
import RocketVibeCore
import XCTest

@testable import RocketVibeKit

final class SettingsTests: XCTestCase {
    func testCategoriesFollowTheAccount() {
        XCTAssertEqual(SettingsCategory.visible(.init()), [.language, .accounts, .app])
        XCTAssertEqual(
            SettingsCategory.visible(.init(signedIn: true, legacy: true)),
            [.account, .notifications, .language, .encryption, .accounts, .app]
        )
        XCTAssertEqual(
            SettingsCategory.visible(.init(signedIn: true)),
            [.account, .notifications, .language, .accounts, .app],
            "a native server without encryption, security, devices or bots"
        )
        XCTAssertEqual(
            SettingsCategory.visible(.init(signedIn: true, devices: true, bots: true)),
            [.account, .notifications, .language, .devices, .bots, .accounts, .app]
        )
        XCTAssertEqual(SettingsCategory.visible(.init(signedIn: true, crypto: true, security: true, devices: true, bots: true, voice: true)), SettingsCategory.allCases)
        setFrench(french: false)
        XCTAssertEqual(SettingsCategory.account.title, "My account")
        XCTAssertEqual(SettingsCategory.app.title, "App")
        XCTAssertEqual(SettingsCategory.bots.title, "Bots")
    }

    func testThePanelFitsTheWindow() {
        XCTAssertEqual(SettingsLayout.panel(width: 1000, height: 700).width, 850)
        XCTAssertEqual(SettingsLayout.panel(width: 1000, height: 700).height, 595)
        XCTAssertEqual(SettingsLayout.panel(width: 2560, height: 1440).width, 1100, "capped")
        XCTAssertEqual(SettingsLayout.panel(width: 2560, height: 1440).height, 800)
        XCTAssertEqual(SettingsLayout.panel(width: 420, height: 380).width, 360, "at least the minimum")
        XCTAssertEqual(SettingsLayout.panel(width: 300, height: 300).height, 300, "never past the window")
        XCTAssertTrue(SettingsLayout.singlePane(panelWidth: 360))
        XCTAssertFalse(SettingsLayout.singlePane(panelWidth: 850))
    }

    @MainActor
    func testTheOverlayOpensOnAShownCategory() {
        let home = FileManager.default.temporaryDirectory.appendingPathComponent("rv-settings-\(UUID())")
        defer { try? FileManager.default.removeItem(at: home) }
        let app = AppModel(home: home.path)
        XCTAssertFalse(app.settingsShown)
        app.openSettings(.security)
        XCTAssertTrue(app.settingsShown)
        XCTAssertEqual(app.shownSettingsCategory, .language, "nothing to secure without an account")
        app.settingsCategory = .app
        XCTAssertEqual(app.shownSettingsCategory, .app)
        app.closeSettings()
        XCTAssertFalse(app.settingsShown)
        app.openSettings()
        XCTAssertEqual(app.shownSettingsCategory, .app, "where it was left")
        XCTAssertTrue(app.panelShown, "the window's shortcuts wait")
        app.showLogin(error: nil)
        XCTAssertFalse(app.settingsShown, "the sign-in form closes it")
        XCTAssertFalse(app.panelShown)
    }

    func testReactionCodes() {
        XCTAssertEqual(reactionEmoji(code: ":thumbsup:", custom: false, rocketChat: false), ":+1:")
        XCTAssertEqual(reactionEmoji(code: ":party_parrot:", custom: true, rocketChat: false), ":party_parrot:")
        XCTAssertNil(reactionEmoji(code: ":party_parrot:", custom: false, rocketChat: false))
        XCTAssertEqual(reactionEmoji(code: ":thumbsup:", custom: true, rocketChat: true), ":+1:", "a name Rocket.Chat accepts")
        XCTAssertTrue(rocketChatReactsWith(code: "+1"))
        XCTAssertTrue(sameEmoji(a: ":+1:", b: ":thumbsup:"))
        XCTAssertFalse(sameEmoji(a: ":+1:", b: ":heart:"))
    }
}
