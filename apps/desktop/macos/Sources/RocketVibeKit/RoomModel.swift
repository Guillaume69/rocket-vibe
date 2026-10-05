import Foundation
import Observation
import RocketVibeCore

let historyPage: Int64 = 50

/// One open room, or one thread: its messages as the store holds them,
/// paged back on demand; or, after a jump to an old message, the history
/// around it (`context`) until that reaches the local one.
@MainActor @Observable
public final class RoomModel {
    public private(set) var room: Room
    /// The thread's root message id, None for the room itself.
    public let threadId: String?
    let chat: Chat
    public private(set) var messages: [MessageItem] = []
    public private(set) var hasOlder = true
    /// The history around an old message, shown instead of the store's.
    public private(set) var context: ContextView?
    public var hasNewer: Bool { context?.hasNewer() ?? false }
    public private(set) var loading = false
    public private(set) var typing: [String] = []
    public private(set) var uploads: [Upload] = []
    /// Set to scroll to a message (a notification, a pinned one): cleared by the view.
    public var reveal: String?
    /// What the server told me alone here, such as a slash command's answer.
    public var note: String?
    let unreadAfter: Int64?
    var limit = historyPage
    var draftSave: Task<Void, Never>?
    /// Each message's actions, asked of rv-ffi once per version of the list.
    @ObservationIgnored var actionsOf: [String: [MessageAction]] = [:]

    public var draft: String {
        didSet {
            let (chat, rid, thread, text) = (chat, room.rid, threadId, draft)
            draftSave?.cancel()
            draftSave = Task {
                try? await Task.sleep(nanoseconds: 400_000_000)
                if !Task.isCancelled { chat.setDraft(rid: rid, threadId: thread, text: text) }
            }
        }
    }

    init(chat: Chat, room: Room, threadId: String? = nil) {
        self.chat = chat
        self.room = room
        self.threadId = threadId
        let unread = room.unread > 0 || room.alert
        unreadAfter = unread && threadId == nil ? chat.lastSeen(rid: room.rid) : nil
        draft = chat.draft(rid: room.rid, threadId: threadId)
    }

    public var rid: String { room.rid }

    func update(room: Room) {
        if room != self.room { self.room = room }
    }

    /// Publishes only what changed: an equal list leaves every row alone.
    public func reload() {
        let fresh = threadId.map { chat.threadMessages(rootId: $0) }
            ?? context?.messages(unreadAfter: unreadAfter)
            ?? chat.messages(rid: room.rid, limit: limit, unreadAfter: unreadAfter)
        if fresh != messages {
            messages = fresh
            actionsOf.removeAll()
        }
        if threadId == nil { refreshUploads() }
    }

    func refreshTyping() {
        let fresh = threadId == nil ? chat.typing(rid: room.rid) : []
        if fresh != typing { typing = fresh }
    }

    func refreshUploads() {
        let fresh = chat.uploads(rid: room.rid)
        if fresh != uploads { uploads = fresh }
    }

    /// Shows what the store has, then the server's newest page.
    func load() async {
        reload()
        let (chat, rid) = (chat, room.rid)
        Task { await chat.prepareActions(rid: rid) }
        loading = true
        defer { loading = false }
        if let threadId {
            try? await chat.loadThread(rootId: threadId)
            hasOlder = false
        } else if let more = try? await chat.openRoom(rid: room.rid, kind: room.kind) {
            hasOlder = more
        }
        reload()
    }

    /// One more page of history. False when there is none or one is coming.
    @discardableResult
    public func loadOlder() async -> Bool {
        guard !loading, hasOlder, threadId == nil, let oldest = messages.first?.ts else { return false }
        loading = true
        defer { loading = false }
        if let context {
            guard (try? await context.older()) != nil else { return false }
            show(context)
            return true
        }
        guard let page = try? await chat.loadOlder(rid: room.rid, kind: room.kind, oldestTs: oldest) else {
            return false
        }
        hasOlder = page.more
        if let shown = page.limit { limit = shown }
        reload()
        return true
    }

    /// One more page of the context window, toward the present.
    @discardableResult
    public func loadNewer() async -> Bool {
        guard !loading, let context, context.hasNewer() else { return false }
        loading = true
        defer { loading = false }
        guard (try? await context.newer(localOldest: localOldest())) != nil else { return false }
        show(context)
        return true
    }

    /// Back to the store's messages, live again.
    public func leaveContext() {
        guard context != nil else { return }
        context = nil
        hasOlder = true
        reload()
    }

    /// Scrolls to the message; one not loaded, however old, is shown in the
    /// history around it.
    public func jump(to id: String) async -> Bool {
        if !messages.contains(where: { $0.id == id }) {
            guard threadId == nil else { return false }
            loading = true
            let window = try? await chat.contextAround(
                rid: room.rid, kind: room.kind, id: id, localOldest: localOldest())
            loading = false
            guard let window else { return false }
            show(window)
        }
        let found = messages.contains { $0.id == id }
        if found { reveal = id }
        return found
    }

    /// The oldest message of the local history, which runs unbroken to the present.
    func localOldest() -> Int64? {
        chat.localOldest(rid: room.rid, limit: limit)
    }

    /// Shows the window, or merges it into the store once it reached the local history.
    func show(_ window: ContextView) {
        hasOlder = window.hasOlder()
        if window.hasNewer() {
            context = window
        } else {
            limit = max(limit, window.merge())
            context = nil
        }
        reload()
    }

    /// Sends the draft, or runs it when it names a slash command. A refused
    /// command goes back into the draft, and the refusal is returned.
    @discardableResult
    public func send() async -> String? {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return nil }
        if threadId == nil { leaveContext() }
        draft = ""
        draftSave?.cancel()
        chat.setDraft(rid: room.rid, threadId: threadId, text: "")
        if text.hasPrefix("/") {
            do {
                if try await chat.runCommand(rid: room.rid, text: text, threadId: threadId) { return nil }
            } catch {
                if draft.isEmpty { draft = text }
                let reason: String
                if case let RvError.Server(_, message, _, _) = error { reason = message } else { reason = error.localizedDescription }
                return L("command.failed", ["error": reason])
            }
        }
        await chat.send(rid: room.rid, text: text, threadId: threadId)
        return nil
    }

    public func retry(_ id: String) async {
        await chat.retry(id: id)
    }

    public func react(_ message: MessageItem, shortcode: String, add: Bool) async {
        try? await chat.react(messageId: message.id, shortcode: shortcode, add: add)
    }

    public func actions(for message: MessageItem) -> [MessageAction] {
        if let known = actionsOf[message.id] { return known }
        let actions = chat.actions(rid: room.rid, messageId: message.id, inThread: threadId != nil)
        actionsOf[message.id] = actions
        return actions
    }

    public var quickReactions: [String] { chat.quickReactions() }

    public func edit(_ message: MessageItem, text: String) async throws {
        try await chat.edit(rid: room.rid, messageId: message.id, text: text)
    }

    public func delete(_ message: MessageItem) async throws {
        try await chat.delete(rid: room.rid, messageId: message.id)
    }

    public func pin(_ message: MessageItem, _ on: Bool) async throws {
        try await chat.pin(messageId: message.id, on: on)
    }

    public func star(_ message: MessageItem, _ on: Bool) async throws {
        try await chat.star(messageId: message.id, on: on)
    }

    /// Puts a quote of the message at the start of the draft.
    public func quote(_ message: MessageItem) async {
        let q = await chat.quote(
            kind: room.kind, slug: room.slug, rid: room.rid, messageId: message.id, text: message.text ?? "")
        draft = q + draft
    }

    /// My latest message still editable, for the Up arrow in an empty composer.
    public func lastMine() -> MessageItem? {
        messages.last { $0.mine && $0.system == nil && $0.delivery == .sent }
    }

    public func attach(path: String, name: String, mime: String, caption: String?, temporary: Bool) async -> String? {
        do {
            try await chat.attach(
                rid: room.rid, path: path, name: name, mime: mime, caption: caption, temporary: temporary)
            refreshUploads()
            return nil
        } catch let RvError.Local(message) {
            if message == "encrypted-files-off" {
                return L("attach.encrypted_off", ["name": name])
            }
            if message.hasPrefix("too-large:") {
                return L("attach.too_large", ["name": name, "max": String(message.dropFirst("too-large:".count))])
            }
            return L("attach.type_refused", ["name": name, "type": String(message.dropFirst("type-not-allowed:".count))])
        } catch {
            return error.localizedDescription
        }
    }

    public func retryUpload(_ id: String) async {
        await chat.retryUpload(id: id)
    }

    public func discardUpload(_ id: String) {
        chat.discardUpload(id: id)
        refreshUploads()
    }
}
