import Foundation
import Observation
import RocketVibeCore

let historyPage: Int64 = 50

/// One open room, or one thread: its messages as the store holds them,
/// paged back on demand.
@MainActor @Observable
public final class RoomModel {
    public private(set) var room: Room
    /// The thread's root message id, None for the room itself.
    public let threadId: String?
    public let provider: ChatProvider
    var chat: Chat? { provider.legacy }
    public var supportsFiles: Bool { provider.supportsFiles }
    public var supportsEditing: Bool { provider.supportsEditing }
    public var supportsMarks: Bool { chat != nil || (provider.native?.supportedFeatures().contains("pins") == true && provider.native?.supportedFeatures().contains("stars") == true) }
    public var canAbandon: Bool { provider.native != nil }
    public private(set) var error: String?
    var active = true
    public private(set) var messages: [MessageItem] = []
    public private(set) var hasOlder = true
    public private(set) var loading = false
    public private(set) var typing: [String] = []
    public private(set) var uploads: [Upload] = []
    /// Set to scroll to a message (a notification, a pinned one): cleared by the view.
    public var reveal: String?
    let unreadAfter: Int64?
    var limit = historyPage
    var draftSave: Task<Void, Never>?
    /// Each message's actions, asked of rv-ffi once per version of the list.
    @ObservationIgnored var actionsOf: [String: [MessageAction]] = [:]
    private var nativeActions: [String: NativeMessageActions] = [:]
    @ObservationIgnored private var actionLoads: Set<String> = []
    @ObservationIgnored private var mutations: [String: NativeMessageActions] = [:]

    public var draft: String {
        didSet {
            guard active else { return }
            let (provider, rid, thread, text) = (provider, room.rid, threadId, draft)
            draftSave?.cancel()
            draftSave = Task {
                try? await Task.sleep(nanoseconds: 400_000_000)
                if !Task.isCancelled { try? provider.setDraft(rid: rid, thread: thread, text: text) }
            }
        }
    }

    convenience init(chat: Chat, room: Room, threadId: String? = nil) {
        self.init(provider: .rocketChat(chat), room: room, threadId: threadId)
    }

    init(provider: ChatProvider, room: Room, threadId: String? = nil) {
        self.provider = provider
        self.room = room
        self.threadId = threadId
        let unread = room.unread > 0 || room.alert
        unreadAfter = unread && threadId == nil ? provider.legacy?.lastSeen(rid: room.rid) : nil
        draft = (try? provider.draft(rid: room.rid, thread: threadId)) ?? ""
    }

    /// Flush before leaving; a delayed save must not outlive this visible room.
    func deactivate() {
        guard active else { return }
        draftSave?.cancel()
        try? provider.setDraft(rid: room.rid, thread: threadId, text: draft)
        active = false
        messages = []
        actionsOf.removeAll()
        nativeActions.removeAll()
        mutations.removeAll()
    }

    public var rid: String { room.rid }

    func update(room: Room) {
        if room != self.room { self.room = room }
    }

    /// Publishes only what changed: an equal list leaves every row alone.
    public func reload() {
        guard active, let fresh = try? provider.messages(rid: room.rid, limit: limit, thread: threadId, unreadAfter: unreadAfter) else { return }
        if fresh != messages {
            let changed = fresh.filter { item in messages.first { $0.id == item.id } != item }
            messages = fresh
            actionsOf.removeAll()
            for item in changed { nativeActions.removeValue(forKey: item.id) }
            if provider.native != nil {
                for item in fresh where item.delivery == .sent { loadNativeActions(item) }
            }
        }
        if threadId == nil { refreshUploads() }
    }

    func refreshTyping() {
        let fresh = threadId == nil ? (chat?.typing(rid: room.rid) ?? []) : []
        if fresh != typing { typing = fresh }
    }

    func refreshUploads() {
        let fresh = chat?.uploads(rid: room.rid) ?? []
        if fresh != uploads { uploads = fresh }
    }

    /// Shows what the store has, then the server's newest page.
    func load() async {
        guard active, !loading else { return }
        reload()
        if let chat {
            let rid = room.rid
            Task { await chat.prepareActions(rid: rid) }
        }
        loading = true
        defer { loading = false }
        if let more = try? await provider.load(room: room, thread: threadId), active {
            hasOlder = more
        }
        reload()
    }

    /// One more page of history. False when there is none or one is coming.
    @discardableResult
    public func loadOlder() async -> Bool {
        guard active, !loading, hasOlder, threadId == nil, let oldest = messages.first?.ts else { return false }
        loading = true
        defer { loading = false }
        guard let more = try? await provider.loadOlder(room: room, oldestTs: oldest), active else {
            return false
        }
        hasOlder = more
        limit += historyPage
        reload()
        return true
    }

    /// Pages back until the message is loaded, then asks the view to scroll to it.
    public func jump(to id: String) async -> Bool {
        for _ in 0..<30 where !messages.contains(where: { $0.id == id }) {
            if !(await loadOlder()) { break }
        }
        let found = messages.contains { $0.id == id }
        if found { reveal = id }
        return found
    }

    public func send() async {
        guard active else { return }
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        draft = ""
        draftSave?.cancel()
        do {
            // Clear before awaiting the transport: words typed during an RC send must survive.
            try provider.setDraft(rid: room.rid, thread: threadId, text: "")
            try await provider.send(rid: room.rid, text: text, thread: threadId)
            reload()
        } catch {
            if active {
                draft = draft.isEmpty ? text : text + "\n" + draft
                self.error = error.localizedDescription
            }
        }
    }

    public func retry(_ id: String) async {
        guard active else { return }
        do { try await provider.retry(id); reload() }
        catch { self.error = error.localizedDescription }
    }

    public func abandon(_ id: String) {
        guard active, let native = provider.native else { return }
        do { try native.abandon(id: id); reload() }
        catch { self.error = error.localizedDescription }
    }

    public func react(_ message: MessageItem, shortcode: String, add: Bool) async {
        guard active else { return }
        do {
            if let native = provider.native {
                try await native.react(room: room.rid, messageId: message.id, emoji: shortcode, present: add)
                if active { reload() }
            } else if let chat {
                try await chat.react(messageId: message.id, shortcode: shortcode, add: add)
            }
        } catch { if active { self.error = mutationError(error) } }
    }

    public func actions(for message: MessageItem) -> [MessageAction] {
        guard active else { return [] }
        guard let chat else {
            loadNativeActions(message)
            guard let rights = nativeActions[message.id] else { return [.copy] }
            var result: [MessageAction] = [.copy]
            let deadline = rights.editUntil.flatMap { value -> Date? in
                let parser = ISO8601DateFormatter()
                parser.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
                return parser.date(from: value) ?? ISO8601DateFormatter().date(from: value)
            }
            let unexpired = deadline.map { $0 > Date() } ?? (rights.editUntil == nil)
            if rights.edit && unexpired && supportsEditing { result.append(.edit) }
            if rights.delete && provider.native?.supportedFeatures().contains("deletion") == true { result.append(.delete) }
            if rights.react && provider.native?.supportedFeatures().contains("reactions") == true { result.append(.react) }
            if rights.pin && provider.native?.supportedFeatures().contains("pins") == true { result.append(message.pinned ? .unpin : .pin) }
            if rights.star && provider.native?.supportedFeatures().contains("stars") == true { result.append(message.starred ? .unstar : .star) }
            return result
        }
        if let known = actionsOf[message.id] { return known }
        let actions = chat.actions(rid: room.rid, messageId: message.id, inThread: threadId != nil)
        actionsOf[message.id] = actions
        return actions
    }

    private func loadNativeActions(_ message: MessageItem) {
        guard active, message.delivery == .sent, nativeActions[message.id] == nil,
              !actionLoads.contains(message.id), let native = provider.native else { return }
        actionLoads.insert(message.id)
        Task {
            defer { actionLoads.remove(message.id) }
            guard let rights = try? await native.messageActions(messageId: message.id), active,
                  messages.first(where: { $0.id == message.id }) == message else { return }
            nativeActions[message.id] = rights
        }
    }

    /// Capture the text and revision before opening the existing editor or confirmation.
    public func prepareMutation(_ message: MessageItem, editing: Bool) async throws {
        guard active else { throw RvError.Local(message: L("native.error")) }
        guard let native = provider.native else { return }
        let context = try await native.messageActions(messageId: message.id)
        guard active, editing ? context.edit : context.delete else { throw RvError.Local(message: L("actions.refused")) }
        mutations[message.id] = context
    }

    public func editingText(_ message: MessageItem) -> String {
        mutations[message.id]?.draft ?? mutations[message.id]?.text ?? message.text ?? ""
    }
    public func editingOriginalText(_ message: MessageItem) -> String {
        mutations[message.id]?.text ?? message.text ?? ""
    }
    public func mutationError(_ error: Error) -> String {
        guard provider.native != nil else { return L("actions.refused") }
        if case let RvError.Server(status, _, code, _, _, _) = error {
            if code == "revision_conflict" { return L("native.message_changed") }
            if code == "message_action_pending" { return L("native.action_pending") }
            if status == 0 || status == 429 || status >= 500 { return L("native.action_retry") }
        }
        return L("actions.refused")
    }

    public var quickReactions: [String] {
        if let chat { return chat.quickReactions() }
        return provider.native?.supportedFeatures().contains("reactions") == true
            ? [":+1:", ":heart:", ":joy:", ":tada:", ":open_mouth:", ":pray:"] : []
    }
    public func quickReactionIsMine(_ message: MessageItem, shortcode: String) -> Bool {
        guard provider.native != nil else { return false }
        let glyph = replaceShortcodes(text: shortcode)
        return message.reactions.contains { $0.mine && $0.glyph == glyph }
    }

    private func editableChat() throws -> Chat {
        guard active, let chat else { throw RvError.Local(message: L("native.error")) }
        return chat
    }

    public func edit(_ message: MessageItem, text: String) async throws {
        if let native = provider.native {
            guard active, let context = mutations[message.id] else { throw RvError.Local(message: "revision_required") }
            try await native.edit(room: room.rid, messageId: message.id, revision: context.revision, text: text)
            mutations.removeValue(forKey: message.id)
            reload()
            return
        }
        try await editableChat().edit(rid: room.rid, messageId: message.id, text: text)
    }

    public func delete(_ message: MessageItem) async throws {
        if let native = provider.native {
            guard active, let context = mutations[message.id] else { throw RvError.Local(message: "revision_required") }
            try await native.delete(room: room.rid, messageId: message.id, revision: context.revision)
            mutations.removeValue(forKey: message.id)
            reload()
            return
        }
        try await editableChat().delete(rid: room.rid, messageId: message.id)
    }

    public func pin(_ message: MessageItem, _ on: Bool) async throws {
        if let native = provider.native {
            guard active else { throw RvError.Local(message: L("native.error")) }
            try await native.setMark(room: room.rid, messageId: message.id, present: on, starred: false)
            reload(); return
        }
        try await editableChat().pin(messageId: message.id, on: on)
    }

    public func star(_ message: MessageItem, _ on: Bool) async throws {
        if let native = provider.native {
            guard active else { throw RvError.Local(message: L("native.error")) }
            try await native.setMark(room: room.rid, messageId: message.id, present: on, starred: true)
            reload(); return
        }
        try await editableChat().star(messageId: message.id, on: on)
    }

    /// The existing two-tab list, with the provider's account-scoped marks.
    public func marked(starred: Bool) async throws -> [MessageItem] {
        guard active else { return [] }
        if let native = provider.native { return try await native.marked(room: room.rid, starred: starred) }
        return try await editableChat().marked(rid: room.rid, starred: starred)
    }

    /// Puts a quote of the message at the start of the draft.
    public func quote(_ message: MessageItem) async {
        guard active, let chat else { return }
        let q = await chat.quote(
            kind: room.kind, slug: room.slug, rid: room.rid, messageId: message.id, text: message.text ?? "")
        draft = q + draft
    }

    /// My latest message still editable, for the Up arrow in an empty composer.
    public func lastMine() -> MessageItem? {
        guard active, supportsEditing else { return nil }
        return messages.last { $0.mine && $0.system == nil && $0.delivery == .sent }
    }

    public func attach(path: String, name: String, mime: String, caption: String?, temporary: Bool) async -> String? {
        guard active, let chat else { return L("native.error") }
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
        guard active else { return }
        await chat?.retryUpload(id: id)
    }

    public func discardUpload(_ id: String) {
        guard active else { return }
        chat?.discardUpload(id: id)
        refreshUploads()
    }
}
