import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import RocketVibeCore
import XCTest
@testable import RocketVibeKit

/// Runs with a disposable native server and a real Secret Service / macOS Keychain.
final class NativeProviderTests: XCTestCase {
    @MainActor
    func testExistingModelsLoginSendOfflineResumeDraftAndLogout() async throws {
        guard let server = ProcessInfo.processInfo.environment["RV_NATIVE_TEST_SERVER"],
              let password = ProcessInfo.processInfo.environment["RV_NATIVE_TEST_PASSWORD"] else {
            throw XCTSkip("Native integration server unset")
        }
        let home = FileManager.default.temporaryDirectory.appendingPathComponent("rv-native-kit-\(UUID())").path
        defer { try? FileManager.default.removeItem(atPath: home) }
        let app = AppModel(home: home)
        defer { app.end() }
        app.login.server = server
        app.login.user = "desktop"
        app.login.password = "wrong-password"
        await app.submitLogin()
        XCTAssertFalse(app.signedIn)
        XCTAssertEqual(app.login.error, L("login.rejected"))
        app.login.password = password
        await app.submitLogin()
        XCTAssertEqual(app.screen, .chat, app.login.error ?? "no login error")
        XCTAssertNil(app.chat)
        let native = try XCTUnwrap(app.native)
        let account = try XCTUnwrap(app.account)
        XCTAssertEqual(account.genre, "rocketvibe")
        try await until(diagnostics: { "Native connection: \(native.status())" }) { app.connection == .online }

        let devices = DevicesModel(app: app)
        await devices.load()
        XCTAssertNil(devices.error)
        let thisDevice = try XCTUnwrap(devices.rows.first { $0.current })
        devices.labels[thisDevice.id] = "Swift desktop"
        await devices.rename(thisDevice)
        XCTAssertNil(devices.error)
        XCTAssertEqual(devices.rows.first { $0.current }?.label, "Swift desktop")
        let beforeCurrentRevoke = devices.rows.count
        await devices.revoke(thisDevice)
        XCTAssertEqual(devices.rows.count, beforeCurrentRevoke, "Use the existing sign-out flow for this device")
        // A second login kept only in test memory does not replace the app's keychain.
        let extra = try await makeExtraDevice(server: server, password: password)
        await devices.load()
        let otherDevice = try XCTUnwrap(devices.rows.first { $0.id == extra.id })
        XCTAssertFalse(otherDevice.current)
        await devices.revoke(otherDevice)
        XCTAssertNil(devices.error)
        XCTAssertFalse(devices.rows.contains { $0.id == extra.id })
        var probe = URLRequest(url: URL(string: server + "/api/v1/me")!)
        probe.setValue("Bearer " + extra.token, forHTTPHeaderField: "Authorization")
        let (_, rejected) = try await URLSession.shared.data(for: probe)
        XCTAssertEqual((rejected as? HTTPURLResponse)?.statusCode, 401)

        let rid = try await native.createRoom(name: "swift-native-\(UUID())", private: true)
        try await until { app.rooms.contains { $0.rid == rid } }
        app.open(rid)
        let room = try XCTUnwrap(app.room)
        try await until { !room.loading }
        XCTAssertFalse(room.supportsFiles)
        XCTAssertTrue(room.supportsRoomInfo)
        let roomInfo = try await room.roomDetails()
        XCTAssertEqual(roomInfo.id, rid)
        XCTAssertEqual(roomInfo.kind, "p")
        XCTAssertEqual(roomInfo.members, 1)
        XCTAssertFalse(roomInfo.readOnly)
        XCTAssertFalse(room.roomInformationRevision.isEmpty)
        let originalRoomRevision = room.roomInformationRevision
        try await changeRoomTopic(server: server, password: password, rid: rid, name: roomInfo.name)
        try await until { room.roomInformationRevision != originalRoomRevision }
        let refreshedRoomInfo = try await room.roomDetails()
        XCTAssertEqual(refreshedRoomInfo.topic, "Topic changed on another device")
        room.draft = "**Swift shared view** :smile:"
        await room.send()
        try await until { room.messages.contains { $0.text == "**Swift shared view** :smile:" && $0.delivery == .sent } }
        let message = try XCTUnwrap(room.messages.last)
        XCTAssertTrue(message.mine)
        XCTAssertFalse(message.body.isEmpty)
        try await until { room.actions(for: message).contains(.edit) && room.actions(for: message).contains(.delete) && room.actions(for: message).contains(.react) }
        XCTAssertEqual(room.quickReactions.count, 6)
        await room.react(message, shortcode: ":+1:", add: true)
        try await until { room.messages.first { $0.id == message.id }?.reactions.count == 1 }
        let reacted = try XCTUnwrap(room.messages.first { $0.id == message.id })
        XCTAssertTrue(reacted.reactions[0].mine)
        XCTAssertEqual(reacted.reactions[0].glyph, "👍")
        XCTAssertEqual(reacted.ts, message.ts)
        XCTAssertTrue(room.quickReactionIsMine(reacted, shortcode: ":+1:"))
        await room.react(reacted, shortcode: ":thumbsup:", add: false)
        try await until { room.messages.first { $0.id == message.id }?.reactions.isEmpty == true }
        XCTAssertTrue(room.supportsEditing)
        XCTAssertTrue(room.supportsMarks)
        try await room.pin(message, true)
        try await room.star(message, true)
        try await until { room.messages.first { $0.id == message.id }?.pinned == true }
        let pins = try await room.marked(starred: false)
        let stars = try await room.marked(starred: true)
        XCTAssertEqual(pins.map(\.id), [message.id])
        XCTAssertEqual(stars.map(\.id), [message.id])
        XCTAssertTrue(stars[0].starred)
        try await room.star(stars[0], false)
        try await room.pin(pins[0], false)
        let emptyPins = try await room.marked(starred: false)
        let emptyStars = try await room.marked(starred: true)
        XCTAssertTrue(emptyPins.isEmpty)
        XCTAssertTrue(emptyStars.isEmpty)
        try await room.prepareMutation(message, editing: true)
        try await room.edit(message, text: "Swift native edited")
        try await until { room.messages.contains { $0.id == message.id && $0.text == "Swift native edited" } }
        let edited = try XCTUnwrap(room.messages.first { $0.id == message.id })
        try await room.prepareMutation(edited, editing: true)
        let competing = try await native.messageActions(messageId: message.id)
        try await native.edit(room: rid, messageId: message.id, revision: competing.revision, text: "Concurrent Swift edit")
        do {
            try await room.edit(edited, text: "Stale editor must not overwrite")
            XCTFail("A stale editor must receive revision_conflict")
        } catch let RvError.Server(status, _, code, _, _, _) {
            XCTAssertEqual(status, 409)
            XCTAssertEqual(code, "revision_conflict")
        }
        try await until { room.messages.contains { $0.id == message.id && $0.text == "Concurrent Swift edit" } }
        let latest = try XCTUnwrap(room.messages.first { $0.id == message.id })
        try await room.prepareMutation(latest, editing: true)
        XCTAssertEqual(room.editingText(latest), "Stale editor must not overwrite", "A failed edit remains available for review")
        XCTAssertEqual(room.editingOriginalText(latest), "Concurrent Swift edit")
        try await room.prepareMutation(latest, editing: false)
        try await room.delete(latest)
        try await until { !room.messages.contains { $0.id == message.id } }
        XCTAssertEqual(room.quickReactions.count, 6)

        let directoryClient = Client(home: home + "/directory-owner")
        let directoryOwner = try await directoryClient.nativeLogin(server: server, user: "mobile", password: password)
        defer { directoryOwner.shutdown() }
        try await until { directoryOwner.status().state == .online }
        let publicName = "swift-directory-\(UUID())"
        let publicId = try await directoryOwner.createRoom(name: publicName, private: false)
        XCTAssertFalse(app.rooms.contains { $0.rid == publicId })
        let found = try await app.provider!.spotlight(query: publicName)
        XCTAssertEqual(found.count, 1)
        await app.go(to: found[0])
        try await until { app.room?.room.rid == publicId && app.room?.loading == false }
        XCTAssertEqual(app.room?.room.kind, "c")
        let publicView = try XCTUnwrap(app.room)
        publicView.draft = "Swift joined public directory"
        await publicView.send()
        try await until { publicView.messages.contains { $0.text == "Swift joined public directory" && $0.delivery == .sent } }
        try await directoryOwner.logout()
        app.open(rid)
        let originalView = try XCTUnwrap(app.room)
        try await until { !originalView.loading }

        native.suspend()
        try await until { app.connection == .offline }
        originalView.draft = "Swift offline durable"
        await originalView.send()
        XCTAssertEqual(originalView.messages.last?.delivery, .pending)
        let intent = try XCTUnwrap(originalView.messages.last?.id)
        originalView.draft = "draft before switching"
        // The debounced save must be flushed even when switching immediately.
        let resumed = await app.resume(account)
        XCTAssertTrue(resumed)
        XCTAssertTrue(originalView.messages.isEmpty, "The old room model must be inactive after switching")
        devices.labels[thisDevice.id] = "Stale device callback"
        await devices.rename(thisDevice)
        XCTAssertEqual(devices.rows.first { $0.id == thisDevice.id }?.label, "Swift desktop")
        try await until { app.connection == .online }
        app.open(rid)
        let reopened = try XCTUnwrap(app.room)
        XCTAssertEqual(reopened.draft, "draft before switching")
        try await until { reopened.messages.contains { $0.id == intent && $0.delivery == .sent } }
        XCTAssertEqual(reopened.messages.filter { $0.text == "Swift offline durable" }.count, 1)
        // Retained views / callbacks of the old account cannot enqueue another message.
        originalView.draft = "stale callback"
        await originalView.send()
        XCTAssertFalse(reopened.messages.contains { $0.text == "stale callback" })

        app.showLogin(error: nil)
        app.cancelLogin()
        XCTAssertEqual(app.screen, .chat)
        let people = try await app.provider!.spotlight(query: "mobile")
        XCTAssertFalse(people.isEmpty)
        await app.go(to: people[0])
        try await until { app.room?.room.kind == "d" }
        await app.signOut()
        XCTAssertEqual(app.screen, .login)
        XCTAssertFalse(app.signedIn)
        XCTAssertTrue(app.accounts.isEmpty)
        let savedAccounts = await app.client.accounts()
        XCTAssertTrue(savedAccounts.isEmpty)
    }

    @MainActor
    func testExistingRoomManagementUsesDurableCommands() async throws {
        guard let server = ProcessInfo.processInfo.environment["RV_NATIVE_TEST_SERVER"],
              let password = ProcessInfo.processInfo.environment["RV_NATIVE_TEST_PASSWORD"] else {
            throw XCTSkip("Native integration server unset")
        }
        let home = FileManager.default.temporaryDirectory.appendingPathComponent("rv-room-controls-\(UUID())").path
        let peerHome = FileManager.default.temporaryDirectory.appendingPathComponent("rv-room-controls-peer-\(UUID())").path
        defer { try? FileManager.default.removeItem(atPath: home); try? FileManager.default.removeItem(atPath: peerHome) }
        let app = AppModel(home: home), peer = AppModel(home: peerHome)
        defer { app.end(); peer.end() }
        for (model, username) in [(app, "desktop"), (peer, "mobile")] {
            model.login.server = server; model.login.user = username; model.login.password = password
            await model.submitLogin(); XCTAssertEqual(model.screen, .chat, model.login.error ?? "login failed")
        }
        let native = try XCTUnwrap(app.native), account = try XCTUnwrap(app.account)
        let rid = try await native.createRoom(name: "swift-room-controls-\(UUID())", private: true)
        try await until { app.rooms.contains { $0.rid == rid } }; app.open(rid)
        let room = try XCTUnwrap(app.room); try await until { !room.loading }
        let originalMembership = try XCTUnwrap(native.membershipVersion(room: rid))
        room.draft = "Draft belonging to the original membership"
        let originalFavorite = try XCTUnwrap(room.favoriteState())
        XCTAssertFalse(originalFavorite.present)
        native.suspend()
        try await until { app.connection == .offline }
        try room.changeFavorite(present:true,state:originalFavorite)
        let queuedFavorite = try XCTUnwrap(room.favoriteState())
        XCTAssertFalse(queuedFavorite.present, "A pending preference never moves the sidebar optimistically")
        XCTAssertNotNil(queuedFavorite.intention)
        native.reconnect()
        try await until { (try? room.favoriteState())?.present == true && (try? room.favoriteState())?.intention == nil }
        try await until { app.rooms.first { $0.rid == rid }?.favorite == true }
        XCTAssertThrowsError(try room.changeFavorite(present:false,state:originalFavorite))
        try room.changeFavorite(present:false,state:try XCTUnwrap(room.favoriteState()))
        try await until { (try? room.favoriteState())?.present == false && (try? room.favoriteState())?.intention == nil }
        let original = try await room.roomManagement()
        XCTAssertTrue(original.canEdit); XCTAssertTrue(original.canChangeRoles); XCTAssertTrue(original.canLeave)
        var fields = original.fields
        fields.topic = "Topic from existing Swift model"; fields.description = "Description"; fields.announcement = "Announcement"; fields.readOnly = true; fields.privateRoom = false
        try await room.updateRoom(fields: fields, revision: original.revision)
        let current = try await room.roomManagement()
        XCTAssertEqual(current.fields, fields); XCTAssertEqual(current.info.kind, "c"); XCTAssertTrue(current.info.readOnly)
        try await until { !room.room.readOnly }
        XCTAssertNil(try room.roomIntention())
        try await native.invite(room: rid, username: "mobile")
        let invited = try await room.roomManagement()
        let members = try await room.roomMembers(after: nil, revision: invited.revision)
        let mobile = try XCTUnwrap(members.members.first { $0.username == "mobile" })
        try await until { peer.rooms.contains { $0.rid == rid } }; peer.open(rid)
        let peerRoom = try XCTUnwrap(peer.room)
        try await until { !peerRoom.loading && peerRoom.room.readOnly }
        try await room.changeRoomRole(target: mobile.id, role: "owner", revision: members.revision)
        try await until { !peerRoom.room.readOnly }
        let transferred = try await room.roomManagement()
        try await room.changeRoomRole(target: account.userId, role: "member", revision: transferred.revision)
        let demoted = try await room.roomManagement()
        XCTAssertFalse(demoted.canEdit); XCTAssertFalse(demoted.canChangeRoles); XCTAssertTrue(demoted.canLeave)
        try await until { room.room.readOnly }
        XCTAssertTrue(app.room === room)
        XCTAssertEqual(room.draft, "Draft belonging to the original membership", "Role changes preserve the open composer")
        XCTAssertEqual(try native.membershipVersion(room: rid), originalMembership)
        try await room.leaveRoom(revision: demoted.revision)
        try await until { !app.rooms.contains { $0.rid == rid } && app.room == nil }
        XCTAssertFalse(room.supportsRoomInfo)
        XCTAssertEqual(room.draft, "", "Withdrawal clears the retained model's private buffer")
        let lastOwner = try await peerRoom.roomManagement()
        do { try await peerRoom.leaveRoom(revision: lastOwner.revision); XCTFail("The last owner must remain") }
        catch { guard case let RvError.Server(_, _, code, _, _, _) = error else { throw error }; XCTAssertEqual(code, "last_room_owner") }
        let rejected = try XCTUnwrap(peerRoom.roomIntention())
        XCTAssertTrue(rejected.failed); XCTAssertEqual(rejected.kind, "leave")
        let cleared = try await peerRoom.dismissRoomIntention(key: rejected.key)
        XCTAssertTrue(cleared); XCTAssertNil(try peerRoom.roomIntention())
        try await peer.native!.invite(room: rid, username: "desktop")
        try await until { app.rooms.contains { $0.rid == rid } }
        app.open(rid)
        let freshRoom = try XCTUnwrap(app.room)
        XCTAssertNotEqual(try native.membershipVersion(room: rid), originalMembership)
        XCTAssertThrowsError(try native.setFavoriteFromState(room:rid,present:true,membership:originalFavorite.membership,revision:originalFavorite.revision))
        XCTAssertEqual(freshRoom.draft, "")
        freshRoom.draft = "Fresh draft after rejoining"
        try native.setDraftFromMembership(room: rid, text: freshRoom.draft, membership: native.membershipVersion(room: rid))
        XCTAssertThrowsError(try native.setDraftFromMembership(room: rid, text: "Delayed original flush", membership: originalMembership))
        XCTAssertThrowsError(try native.sendFromMembership(room: rid, text: "Delayed original send", membership: originalMembership))
        room.draft = "Retained inactive view"
        await room.send()
        XCTAssertEqual(try native.draftFromMembership(room: rid, membership: native.membershipVersion(room: rid)), freshRoom.draft)
        XCTAssertFalse(try native.messages(room: rid, limit: 100).contains { $0.text == "Delayed original send" || $0.text == "Retained inactive view" })
        await app.signOut(); await peer.signOut()
    }

    @MainActor
    func testFactorsPreserveActiveAccountRecoverLostAckAndRecreateModels() async throws {
        guard let server = ProcessInfo.processInfo.environment["RV_NATIVE_TEST_SERVER"],
              let password = ProcessInfo.processInfo.environment["RV_NATIVE_TEST_PASSWORD"],
              let factorServer = ProcessInfo.processInfo.environment["RV_NATIVE_TEST_FACTOR_URL"],
              let path = ProcessInfo.processInfo.environment["RV_NATIVE_TEST_FACTOR_FILE"] else {
            throw XCTSkip("requires disposable factor ACK-loss bench")
        }
        let issued = try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: path))) as! [String: Any]
        let codes = try XCTUnwrap(issued["codes"] as? [String])
        let backup = try XCTUnwrap(codes.first)
        let home = "/tmp/rv-swift-factor-\(UUID())"
        defer { try? FileManager.default.removeItem(atPath: home) }
        let original = AppModel(home: home)
        defer { original.end() }
        original.login.server = server
        original.login.user = "desktop"
        original.login.password = password
        await original.submitLogin()
        XCTAssertEqual(original.account?.username, "desktop")
        let activePath = URL(fileURLWithPath: original.client.configDir()).appendingPathComponent("active-account")
        let active = try String(contentsOf: activePath, encoding: .utf8)
        original.showLogin(error: nil)
        original.login.server = factorServer
        original.login.user = "swift-factor"
        original.login.password = password
        await original.submitLogin()
        XCTAssertEqual(original.login.nativeMethods, ["totp", "recovery_code"])
        XCTAssertEqual(original.login.password, "")
        XCTAssertEqual(original.account?.username, "desktop")
        let initialAccounts = await original.client.accounts()
        XCTAssertEqual(initialAccounts.count, 1, "Pre-authentication proof must not enter the account index")
        original.login.selectNativeMethod("recovery_code")
        original.login.code = "INVALID-BACKUP"
        await original.submitLogin()
        XCTAssertEqual(original.login.error, L("login.bad_code"))
        XCTAssertEqual(try String(contentsOf: activePath, encoding: .utf8), active)
        XCTAssertEqual(original.login.code, "")
        XCTAssertTrue(original.login.pendingConfirmation)
        original.end()

        // A new client/model reads the private proof from the actual keyring.
        let recreated = AppModel(home: home)
        defer { recreated.end() }
        recreated.showLogin(error: nil)
        recreated.login.server = factorServer
        recreated.login.user = "swift-factor"
        recreated.login.password = password
        await recreated.submitLogin()
        XCTAssertEqual(recreated.login.nativeMethods, ["totp", "recovery_code"])
        XCTAssertTrue(recreated.login.pendingConfirmation)
        XCTAssertFalse(recreated.signedIn)

        // Leaving while a request is running invalidates its form callbacks.
        recreated.login.selectNativeMethod("recovery_code")
        recreated.login.code = "INVALID-LATE"
        let late = Task { await recreated.submitLogin() }
        for _ in 0..<100 where !recreated.login.busy { await Task.yield() }
        XCTAssertTrue(recreated.login.busy)
        recreated.login.leave()
        await late.value
        XCTAssertNil(recreated.login.method)
        XCTAssertNil(recreated.login.error)
        XCTAssertFalse(recreated.login.busy)
        XCTAssertEqual(try String(contentsOf: activePath, encoding: .utf8), active)

        recreated.login.password = password
        await recreated.submitLogin()
        recreated.login.selectNativeMethod("recovery_code")
        recreated.login.code = backup
        await recreated.submitLogin()
        XCTAssertFalse(recreated.signedIn, "A dropped success response cannot install a session")
        XCTAssertTrue(recreated.login.pendingConfirmation)
        XCTAssertEqual(recreated.login.code, "")
        XCTAssertEqual(try String(contentsOf: activePath, encoding: .utf8), active)
        let pendingAccounts = await recreated.client.accounts()
        XCTAssertEqual(pendingAccounts.count, 1)

        // Blank confirmation probes the accepted candidate before using a code.
        await recreated.submitLogin()
        XCTAssertEqual(recreated.screen, .chat, recreated.login.error ?? "factor confirmation failed")
        XCTAssertEqual(recreated.account?.username, "swift-factor")
        XCTAssertEqual(recreated.login.code, "")
        XCTAssertEqual(recreated.login.password, "")
        XCTAssertTrue(recreated.login.nativeMethods.isEmpty)
        try await until { recreated.connection == .online }
        recreated.end()
        let restarted = AppModel(home: home)
        defer { restarted.end() }
        await restarted.start()
        XCTAssertEqual(restarted.account?.username, "swift-factor")
        try await until { restarted.connection == .online }
    }

    @MainActor
    func testInvitationInExistingLoginModelAndKeychainResume() async throws {
        guard let server = ProcessInfo.processInfo.environment["RV_NATIVE_TEST_SERVER"],
              let password = ProcessInfo.processInfo.environment["RV_NATIVE_TEST_PASSWORD"],
              let path = ProcessInfo.processInfo.environment["RV_NATIVE_TEST_INVITATION_FILE"] else {
            throw XCTSkip("requires disposable native invitation bench")
        }
        let issued = try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: path))) as! [String: Any]
        let token = try XCTUnwrap(issued["token"] as? String)
        let home = "/tmp/rv-swift-signup-\(UUID())"
        let app = AppModel(home: home)
        defer { app.end() }
        app.login.server = server
        app.login.user = "swift-invited"
        app.login.password = password
        await app.login.probe(client: app.client)
        XCTAssertTrue(app.login.canRegister)
        app.login.registering = true
        app.login.invitation = token
        await app.submitLogin()
        XCTAssertEqual(app.screen, .chat, app.login.error ?? "no signup error")
        XCTAssertEqual(app.account?.username, "swift-invited")
        XCTAssertEqual(app.login.invitation, "")
        XCTAssertEqual(app.login.password, "")
        XCTAssertFalse(app.login.registering)
        try await until { app.connection == .online }
        let saved = try XCTUnwrap(app.account)
        let resumed = await app.resume(saved)
        XCTAssertTrue(resumed)
        try await until { app.connection == .online }
        await app.signOut()
        XCTAssertTrue(app.accounts.isEmpty)
    }

    @MainActor
    func testOpaqueAttemptReplayAfterRenewalDoesNotRewindCredentials() async throws {
        guard let server = ProcessInfo.processInfo.environment["RV_NATIVE_TEST_SERVER"],
              let password = ProcessInfo.processInfo.environment["RV_NATIVE_TEST_PASSWORD"] else {
            throw XCTSkip("requires disposable renewal bench")
        }
        let home = "/tmp/rv-swift-replay-\(UUID())"
        defer { try? FileManager.default.removeItem(atPath: home) }
        let client = Client(home: home)
        let attempt = try await client.nativeStartLogin(server: server, user: "swift-replay", password: password,
                                                       accountCode: nil, recovering: false)
        XCTAssertTrue(attempt.methods().isEmpty)
        let first = try await attempt.commit()
        defer { first.shutdown() }
        let activePath = URL(fileURLWithPath: client.configDir()).appendingPathComponent("active-account").path
        XCTAssertFalse(FileManager.default.fileExists(atPath: activePath), "Credential commit does not activate an account")
        first.activateAccount()
        try await until { first.status().state == .online }
        // The bench caps this account's first bearer at one day, forcing renewal.
        let replay = try await attempt.commit()
        XCTAssertEqual(replay.account().key, first.account().key)
        replay.shutdown()
        let resumed = try await client.nativeResume(key: first.account().key)
        defer { resumed.shutdown() }
        try await until { resumed.status().state == .online }
        let devices = try await resumed.deviceSessions()
        XCTAssertEqual(devices.count, 1)
        try await resumed.logout()
    }

    @MainActor
    func testRecoveryInExistingLoginModelRevokesOldSessionAndResumes() async throws {
        guard let server = ProcessInfo.processInfo.environment["RV_NATIVE_TEST_SERVER"],
              let password = ProcessInfo.processInfo.environment["RV_NATIVE_TEST_PASSWORD"],
              let path = ProcessInfo.processInfo.environment["RV_NATIVE_TEST_RECOVERY_FILE"] else {
            throw XCTSkip("requires disposable recovery bench")
        }
        let old = try await makeExtraDevice(server: server, password: password, username: "swift-recovery")
        let issued = try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: path))) as! [String: Any]
        let token = try XCTUnwrap(issued["token"] as? String)
        let app = AppModel(home: "/tmp/rv-swift-recovery-\(UUID())")
        defer { app.end() }
        app.login.server = server
        app.login.user = "swift-recovery"
        app.login.password = "native-recovered-test-password"
        await app.login.probe(client: app.client)
        XCTAssertTrue(app.login.canRecover)
        app.login.recovering = true
        app.login.invitation = token
        await app.submitLogin()
        XCTAssertEqual(app.screen, .chat, app.login.error ?? "no recovery error")
        XCTAssertEqual(app.account?.username, "swift-recovery")
        XCTAssertEqual(app.login.invitation, "")
        XCTAssertEqual(app.login.password, "")
        XCTAssertFalse(app.login.recovering)
        try await until { app.connection == .online }
        var probe = URLRequest(url: URL(string: server + "/api/v1/me")!)
        probe.setValue("Bearer " + old.token, forHTTPHeaderField: "Authorization")
        let (_, response) = try await URLSession.shared.data(for: probe)
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 401)
        let saved = try XCTUnwrap(app.account)
        let resumed = await app.resume(saved)
        XCTAssertTrue(resumed)
        try await until { app.connection == .online }
        await app.signOut()
        XCTAssertTrue(app.accounts.isEmpty)
    }

    @MainActor
    private func makeExtraDevice(server: String, password: String, username: String = "desktop") async throws -> (id: String, token: String) {
        var request = URLRequest(url: URL(string: server + "/api/v1/auth/login")!)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: ["username":username, "password":password])
        let (body, response) = try await URLSession.shared.data(for: request)
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
        let login = try JSONSerialization.jsonObject(with: body) as! [String: Any]
        let token = try XCTUnwrap(login["token"] as? String)
        var listing = URLRequest(url: URL(string: server + "/api/v1/me/sessions")!)
        listing.setValue("Bearer " + token, forHTTPHeaderField: "Authorization")
        let (sessions, _) = try await URLSession.shared.data(for: listing)
        let records = try JSONSerialization.jsonObject(with: sessions) as! [[String: Any]]
        return (try XCTUnwrap(records.first { $0["current"] as? Bool == true }?["id"] as? String), token)
    }

    @MainActor
    private func changeRoomTopic(server: String, password: String, rid: String, name: String) async throws {
        let device = try await makeExtraDevice(server: server, password: password)
        var read = URLRequest(url: URL(string: server + "/api/v1/rooms/" + rid)!)
        read.setValue("Bearer " + device.token, forHTTPHeaderField: "Authorization")
        let (data, response) = try await URLSession.shared.data(for: read)
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
        let details = try JSONSerialization.jsonObject(with: data) as! [String: Any]
        var change = read
        change.httpMethod = "PATCH"
        change.setValue("application/json", forHTTPHeaderField: "Content-Type")
        change.httpBody = try JSONSerialization.data(withJSONObject: ["operation_id": "swift-room-" + UUID().uuidString, "expected_revision": details["revision"] as! String, "name": name, "private": true, "topic": "Topic changed on another device", "description": "", "announcement": "", "read_only": false])
        let (_, changed) = try await URLSession.shared.data(for: change)
        XCTAssertEqual((changed as? HTTPURLResponse)?.statusCode, 200)
        var logout = URLRequest(url: URL(string: server + "/api/v1/auth/logout")!)
        logout.httpMethod = "POST"
        logout.setValue("Bearer " + device.token, forHTTPHeaderField: "Authorization")
        let (_, closed) = try await URLSession.shared.data(for: logout)
        XCTAssertEqual((closed as? HTTPURLResponse)?.statusCode, 204)
    }

    @MainActor
    private func until(file: StaticString = #filePath, line: UInt = #line, diagnostics: () -> String = { "" }, _ condition: @escaping @MainActor () -> Bool) async throws {
        for _ in 0..<300 {
            if condition() { return }
            try await Task.sleep(nanoseconds: 100_000_000)
        }
        XCTFail("Native model condition did not become true. \(diagnostics())", file: file, line: line)
        throw RvError.Local(message: "test timeout")
    }
}
