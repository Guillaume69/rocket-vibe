import Foundation
import RocketVibeCore

/// The same view models and views, with a transport chosen for each account.
public enum ChatProvider {
    case rocketChat(Chat)
    case rocketVibe(NativeChat)

    public var legacy: Chat? {
        if case let .rocketChat(chat) = self { return chat }
        return nil
    }
    public var native: NativeChat? {
        if case let .rocketVibe(chat) = self { return chat }
        return nil
    }
    public var supportsFiles: Bool { legacy != nil || native?.supportedFeatures().contains("uploads") == true }
    public var supportsEditing: Bool { legacy != nil || native?.supportedFeatures().contains("editing") == true }
    public var supportsRoomInfo: Bool { legacy != nil || native?.supportedFeatures().contains("room_info") == true }
    public var supportsProfiles: Bool { legacy != nil || native?.profilesAvailable() == true }
    public var supportsCalls: Bool { legacy != nil || native?.supportedFeatures().contains("calls") == true }
    public func startPersonCall(username:String,userId:String) async throws -> String {
        switch self {
        case let .rocketChat(chat):
            let rid = try await chat.openDm(username:username)
            return try await chat.startCall(rid:rid)
        case let .rocketVibe(chat): return try await chat.startDirectCall(userId:userId)
        }
    }
    public func callAvailable(rid:String, membership:String? = nil) async -> Bool {
        switch self {
        case let .rocketChat(chat): return await chat.callAvailable()
        case let .rocketVibe(chat):
            guard let membership else { return false }
            return await chat.callAvailable(room:rid,membership:membership)
        }
    }
    public func startCall(rid:String, membership:String? = nil) async throws -> String {
        switch self {
        case let .rocketChat(chat): return try await chat.startCall(rid:rid)
        case let .rocketVibe(chat):
            guard let membership else { throw CancellationError() }
            return try await chat.startCall(room:rid,membership:membership)
        }
    }
    func joinCall(rid:String,callId:String,membership:String?) async throws -> String {
        switch self {
        case let .rocketChat(chat): return try await chat.joinCall(callId:callId)
        case let .rocketVibe(chat):
            guard let membership else { throw CancellationError() }
            return try await chat.joinCall(room:rid,callId:callId,membership:membership)
        }
    }
    func callLink(rid:String,callId:String,membership:String?) async throws -> String {
        switch self {
        case let .rocketChat(chat): return try await chat.callLink(callId:callId)
        case let .rocketVibe(chat):
            guard let membership else { throw CancellationError() }
            return try await chat.callLink(room:rid,callId:callId,membership:membership)
        }
    }
    public func person(key:String,byId:Bool) async throws -> Person {
        switch self {case let .rocketChat(chat):return try await chat.person(key:key,byId:byId)
        case let .rocketVibe(chat):return try await chat.person(key:key,byId:byId)}
    }
    func roomDetails(rid: String) async throws -> RoomDetails {
        switch self { case let .rocketChat(chat): return try await chat.roomDetails(rid: rid)
        case let .rocketVibe(chat): return try await chat.roomDetails(room: rid) }
    }

    func account() -> Account {
        switch self { case let .rocketChat(chat): return chat.account()
        case let .rocketVibe(chat): return chat.account() }
    }
    func shutdown() {
        switch self { case let .rocketChat(chat): chat.shutdown()
        case let .rocketVibe(chat): chat.shutdown() }
    }
    func listen(_ listener: Listener) {
        switch self { case let .rocketChat(chat): chat.setListener(listener: listener)
        case let .rocketVibe(chat): chat.setListener(listener: listener) }
    }
    func rooms() throws -> [RoomGroup] {
        switch self { case let .rocketChat(chat): return chat.rooms()
        case let .rocketVibe(chat): return try chat.roomGroups() }
    }
    func messages(rid: String, limit: Int64, thread: String?, unreadAfter: Int64?, nativeBoundary:NativeRoomReadState? = nil, nativeMembership:String? = nil) throws -> [MessageItem] {
        switch self {
        case let .rocketChat(chat):
            return thread.map { chat.threadMessages(rootId: $0) } ?? chat.messages(rid: rid, limit: limit, unreadAfter: unreadAfter)
        case let .rocketVibe(chat):
            if let thread { return try chat.threadMessageItems(room:rid,root:thread,membership:nativeMembership ?? "") }
            if let boundary=nativeBoundary {
                return try chat.messageItemsFromBoundary(room:rid,limit:UInt32(clamping:limit),membership:boundary.membership,rootPosition:boundary.rootPosition)
            }
            return try chat.messageItems(room: rid, limit: UInt32(clamping: limit))
        }
    }
    func draft(rid: String, thread: String?) throws -> String {
        switch self { case let .rocketChat(chat): return chat.draft(rid: rid, threadId: thread)
        case let .rocketVibe(chat):
            if let thread { return try chat.threadDraftFromMembership(room:rid,root:thread,membership:chat.membershipVersion(room:rid)) }
            return try chat.draft(room: rid) }
    }
    func setDraft(rid: String, thread: String?, text: String) throws {
        switch self { case let .rocketChat(chat): chat.setDraft(rid: rid, threadId: thread, text: text)
        case let .rocketVibe(chat):
            if let thread { try chat.setThreadDraftFromMembership(room:rid,root:thread,text:text,membership:chat.membershipVersion(room:rid)) }
            else { try chat.setDraft(room: rid, text: text) } }
    }
    func load(room: Room, thread: String?) async throws -> Bool {
        switch self {
        case let .rocketChat(chat):
            if let thread { try await chat.loadThread(rootId: thread); return false }
            return try await chat.openRoom(rid: room.rid, kind: room.kind)
        case let .rocketVibe(chat):
            if let thread { try await chat.loadThread(room:room.rid,root:thread); return false }
            return try await chat.history(room: room.rid, older: false)
        }
    }
    func loadOlder(room: Room, oldestTs: Int64) async throws -> Bool {
        switch self { case let .rocketChat(chat): return try await chat.loadOlder(rid: room.rid, kind: room.kind, oldestTs: oldestTs)
        case let .rocketVibe(chat): return try await chat.history(room: room.rid, older: true) }
    }
    public func send(rid: String, text: String, thread: String? = nil) async throws {
        switch self { case let .rocketChat(chat): await chat.send(rid: rid, text: text, threadId: thread)
        case let .rocketVibe(chat):
            if let thread { _ = try chat.sendReplyFromMembership(room:rid,root:thread,text:text,membership:chat.membershipVersion(room:rid),quotes:[]) }
            else { _ = try chat.send(room: rid, text: text) } }
    }
    func retry(_ id: String) async throws {
        switch self { case let .rocketChat(chat): await chat.retry(id: id)
        case let .rocketVibe(chat): try chat.retry(id: id) }
    }
    func signOut() async throws {
        switch self { case let .rocketChat(chat): await chat.signOut()
        case let .rocketVibe(chat): try await chat.logout() }
    }
    public func spotlight(query: String) async throws -> [Found] {
        switch self { case let .rocketChat(chat): return try await chat.spotlight(query: query)
        case let .rocketVibe(chat): return try await chat.spotlight(query: query) }
    }
    func direct(username: String,userId:String? = nil) async throws -> String {
        switch self { case let .rocketChat(chat): return try await chat.openDm(username: username)
        case let .rocketVibe(chat): if let userId,!userId.isEmpty{return try await chat.directUser(userId:userId)};return try await chat.direct(username: username) }
    }
    func join(rid: String) async throws {
        switch self { case let .rocketChat(chat): try await chat.joinChannel(rid: rid)
        case let .rocketVibe(chat): _ = try await chat.joinPublic(room: rid) }
    }
}
