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
    func messages(rid: String, limit: Int64, thread: String?, unreadAfter: Int64?) throws -> [MessageItem] {
        switch self {
        case let .rocketChat(chat):
            return thread.map { chat.threadMessages(rootId: $0) } ?? chat.messages(rid: rid, limit: limit, unreadAfter: unreadAfter)
        case let .rocketVibe(chat):
            return try chat.messageItems(room: rid, limit: UInt32(clamping: limit))
        }
    }
    func draft(rid: String, thread: String?) throws -> String {
        switch self { case let .rocketChat(chat): return chat.draft(rid: rid, threadId: thread)
        case let .rocketVibe(chat): return try chat.draft(room: rid) }
    }
    func setDraft(rid: String, thread: String?, text: String) throws {
        switch self { case let .rocketChat(chat): chat.setDraft(rid: rid, threadId: thread, text: text)
        case let .rocketVibe(chat): try chat.setDraft(room: rid, text: text) }
    }
    func load(room: Room, thread: String?) async throws -> Bool {
        switch self {
        case let .rocketChat(chat):
            if let thread { try await chat.loadThread(rootId: thread); return false }
            return try await chat.openRoom(rid: room.rid, kind: room.kind)
        case let .rocketVibe(chat): return try await chat.history(room: room.rid, older: false)
        }
    }
    func loadOlder(room: Room, oldestTs: Int64) async throws -> Bool {
        switch self { case let .rocketChat(chat): return try await chat.loadOlder(rid: room.rid, kind: room.kind, oldestTs: oldestTs)
        case let .rocketVibe(chat): return try await chat.history(room: room.rid, older: true) }
    }
    public func send(rid: String, text: String, thread: String? = nil) async throws {
        switch self { case let .rocketChat(chat): await chat.send(rid: rid, text: text, threadId: thread)
        case let .rocketVibe(chat): _ = try chat.send(room: rid, text: text) }
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
    func direct(username: String) async throws -> String {
        switch self { case let .rocketChat(chat): return try await chat.openDm(username: username)
        case let .rocketVibe(chat): return try await chat.direct(username: username) }
    }
}
