import Foundation
import Observation
import RocketVibeCore

public enum Screen: Equatable {
    case starting
    case login
    case chat
}

/// The app's state: signed in or not, the room list, the open room.
@MainActor @Observable
public final class AppModel {
    public let client: Client
    public let login = LoginModel()
    public private(set) var screen = Screen.starting
    public private(set) var provider: ChatProvider?
    public var chat: Chat? { provider?.legacy }
    public var native: NativeChat? { provider?.native }
    public var signedIn: Bool { provider != nil }
    public private(set) var account: Account?
    public private(set) var accounts: [Account] = []
    public private(set) var groups: [RoomGroup] = []
    public private(set) var connection = ConnectionState.offline
    /// Encrypted rooms readable and writable (my E2E key unlocked).
    public private(set) var e2eUnlocked = false
    public private(set) var room: RoomModel?
    public private(set) var thread: RoomModel?
    public private(set) var collapsed: Set<RoomSection>
    /// Bumped when photos or custom emoji change: views reload their images.
    public private(set) var imagesVersion = 0
    public private(set) var media: MediaStore?
    /// A short message for the window's toast.
    public var notice: String?

    /// Room ids opened, for back and forward.
    var history: [String] = []
    var historyAt = -1
    @ObservationIgnored var pending = Pending()
    @ObservationIgnored var flush: Task<Void, Never>?
    @ObservationIgnored var sessionId = UUID()
    @ObservationIgnored var selectionId = UUID()

    public var onIncoming: ((Incoming) -> Void)?
    /// The dock badge: mentions and direct messages.
    public var onAttention: ((Int64) -> Void)?

    public init(home: String) {
        client = Client(home: home)
        Strings.setUp(configDir: client.configDir())
        collapsed = Self.loadCollapsed(client.configDir())
    }

    public var rooms: [Room] { groups.flatMap(\.rooms) }

    public var unreadRooms: Int { rooms.filter { $0.unread > 0 || $0.alert }.count }

    /// The active account if there is one, the sign-in form otherwise.
    public func start() async {
        accounts = await client.accounts()
        if let first = accounts.first, await resume(first) { return }
        showLogin(error: nil)
    }

    @discardableResult
    public func resume(_ account: Account) async -> Bool {
        let selected = UUID()
        selectionId = selected
        do {
            let provider: ChatProvider
            if account.genre == "rocketvibe" {
                provider = .rocketVibe(try await client.nativeResume(key: account.key))
            } else {
                provider = .rocketChat(try await client.resume(key: account.key))
            }
            guard selected == selectionId else { provider.shutdown(); return false }
            begin(provider)
            return true
        } catch { return false }
    }

    public func submitLogin() async {
        guard !login.busy else { return }
        let selected = UUID()
        selectionId = selected
        let form = login.revision
        if let chat = await login.submit(client: client) {
            let fresh = await client.accounts()
            guard selected == selectionId, form == login.revision else { chat.shutdown(); return }
            accounts = fresh
            begin(chat)
        }
    }

    public func showLogin(error: String?) {
        selectionId = UUID()
        login.reset(known: client.knownServers(), error: error)
        screen = .login
    }

    /// Back to the account in use, from the form opened to add another.
    public func cancelLogin() {
        selectionId = UUID()
        login.leave()
        if signedIn { screen = .chat }
    }

    func begin(_ provider: ChatProvider) {
        if case let .rocketVibe(native) = provider { native.activateAccount() }
        end()
        self.provider = provider
        account = provider.account()
        if let chat { media = MediaStore(chat: chat) }
        connection = .connecting
        let expected = sessionId
        provider.listen(Relay { [weak self] event in
            guard let self, self.sessionId == expected else { return }
            self.handle(event)
        })
        e2eUnlocked = chat?.e2eUnlocked() ?? false
        reloadRooms()
        screen = .chat
    }

    func end() {
        sessionId = UUID()
        selectionId = UUID()
        room?.deactivate()
        thread?.deactivate()
        provider?.shutdown()
        flush?.cancel()
        flush = nil
        pending = Pending()
        room = nil
        thread = nil
        provider = nil
        account = nil
        e2eUnlocked = false
        connection = .offline
        media = nil
        groups = []
        history = []
        historyAt = -1
    }

    public func signOut() async {
        guard let provider else { return }
        let expected = sessionId
        do { try await provider.signOut() }
        catch { notice = error.localizedDescription; return }
        guard expected == sessionId else { return }
        end()
        accounts = await client.accounts()
        if let next = accounts.first, await resume(next) { return }
        showLogin(error: nil)
    }

    func handle(_ event: Event) {
        switch event {
        case let .changed(rooms, rids):
            later(rooms: rooms, rids: rids)
        case .resync:
            later(everything: true)
        case let .connection(state):
            let wasOnline = connection == .online
            connection = state
            if let native {
                if let error = native.status().error {
                    notice = L(error == "server_identity_changed" ? "native.identity_changed" : error == "session_rejected" ? "login.expired" : "native.error")
                }
                if state == .online && !wasOnline, let room {
                    Task { await room.load() }
                }
            }
        case .expired:
            end()
            Task {
                accounts = await client.accounts()
                showLogin(error: L("login.expired"))
            }
        case let .typing(rid):
            if room?.rid == rid { room?.refreshTyping() }
        case .presence:
            later(rooms: true)
        case let .upload(rid):
            if room?.rid == rid { room?.refreshUploads() }
        case .avatar:
            media?.forget()
            imagesVersion += 1
            later(rooms: true)
        case .e2e:
            e2eUnlocked = chat?.e2eUnlocked() ?? false
            later(everything: true)
        case let .incoming(incoming):
            onIncoming?(incoming)
        }
    }

    /// Gathers what the events ask for and reloads it once, a frame and a half later.
    func later(rooms: Bool = false, everything: Bool = false, rids: [String] = []) {
        pending.add(rooms: rooms, everything: everything, rids: rids)
        guard flush == nil else { return }
        flush = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 25_000_000)
            guard !Task.isCancelled, let self else { return }
            self.flush = nil
            let pending = self.pending
            self.pending = Pending()
            if pending.reloadsRooms { self.reloadRooms() }
            if pending.reloads(self.room?.rid) { self.room?.reload();self.room?.refreshTyping() }
            if pending.reloads(self.thread?.rid) { self.thread?.reload();self.thread?.refreshTyping() }
        }
    }

    func reloadRooms() {
        guard let provider, let fresh = try? provider.rooms() else { return }
        if fresh != groups { groups = fresh }
        if let room {
            if room.membershipIsCurrent, let fresh = rooms.first(where: { $0.rid == room.rid }) { room.update(room: fresh) }
            else {
                room.deactivate()
                self.room = nil
                closeThread()
            }
        }
        onAttention?(chat?.attention() ?? 0)
        if let thread {
            if thread.membershipIsCurrent, let fresh = rooms.first(where: { $0.rid == thread.rid }) { thread.update(room: fresh) }
            else { closeThread() }
        }
    }

    public func open(_ rid: String, remember: Bool = true) {
        guard let provider, let found = rooms.first(where: { $0.rid == rid }) else { return }
        if room?.rid == rid { return }
        selectionId = UUID()
        if remember {
            history = Array(history.prefix(historyAt + 1)) + [rid]
            historyAt = history.count - 1
        }
        room?.deactivate()
        closeThread()
        let model = RoomModel(provider: provider, room: found)
        room = model
        Task { await model.load() }
    }

    /// The room, scrolled to that message: what a notification opens.
    public func open(_ rid: String, message: String) async {
        open(rid)
        if let room, room.rid == rid, !(await room.jump(to: message)) {
            notice = L("marked.not_loaded")
        }
    }

    public func openThread(_ rootId: String) {
        guard let provider, let room else { return }
        if let native = provider.native, !native.supportedFeatures().contains("threads") { return }
        let model = RoomModel(provider: provider, room: room.room, threadId: rootId)
        thread?.deactivate()
        thread = model
        Task { await model.load() }
    }

    public func closeThread() {
        thread?.deactivate()
        thread = nil
    }

    public var canGoBack: Bool { historyAt > 0 }
    public var canGoForward: Bool { historyAt + 1 < history.count }

    public func goBack() {
        guard canGoBack else { return }
        historyAt -= 1
        open(history[historyAt], remember: false)
    }

    public func goForward() {
        guard canGoForward else { return }
        historyAt += 1
        open(history[historyAt], remember: false)
    }

    public func markRead() async {
        if let chat, let room { await chat.markRead(rid: room.rid) }
    }

    /// Nil when unlocked, else what went wrong.
    public func unlock(password: String) async -> String? {
        guard let chat else { return nil }
        do {
            try await chat.e2eUnlock(password: password)
            e2eUnlocked = chat.e2eUnlocked()
            return nil
        } catch let RvError.Local(message) {
            switch message {
            case "e2e-wrong": return L("e2e.wrong")
            case "e2e-no-keys": return L("e2e.no_keys")
            default: return L("e2e.failed")
            }
        } catch {
            return L("e2e.failed")
        }
    }

    public func lock() {
        chat?.e2eLock()
        e2eUnlocked = false
    }

    public func reconnect() {
        chat?.reconnectNow()
        native?.reconnect()
    }

    /// Opens what the spotlight found: a direct room with a person, or a channel (joined if need be).
    public func go(to found: Found) async {
        guard let provider else { return }
        let expected = sessionId
        let selected = UUID()
        selectionId = selected
        do {
            let rid: String
            switch found {
            case let .user(_, username, _):
                rid = try await provider.direct(username: username)
            case let .room(id, _, _):
                if !rooms.contains(where: { $0.rid == id }) { try await provider.join(rid: id) }
                rid = id
            }
            for _ in 0..<40 where !rooms.contains(where: { $0.rid == rid }) {
                guard expected == sessionId, selected == selectionId else { return }
                try? await Task.sleep(nanoseconds: 100_000_000)
            }
            guard expected == sessionId, selected == selectionId else { return }
            open(rid)
        } catch {
            if expected == sessionId, selected == selectionId { notice = L("spotlight.open_failed") }
        }
    }

    public func toggle(_ section: RoomSection) {
        if collapsed.contains(section) { collapsed.remove(section) } else { collapsed.insert(section) }
        let lines = collapsed.map(Self.key).sorted().joined(separator: "\n")
        try? lines.write(toFile: client.configDir() + "/collapsed-sections", atomically: true, encoding: .utf8)
    }

    static func key(_ section: RoomSection) -> String {
        switch section {
        case .unread: return "unread"
        case .favorites: return "favorites"
        case .channels: return "channels"
        case .direct: return "direct"
        }
    }

    static func loadCollapsed(_ configDir: String) -> Set<RoomSection> {
        let text = (try? String(contentsOfFile: configDir + "/collapsed-sections", encoding: .utf8)) ?? ""
        let all: [RoomSection] = [.unread, .favorites, .channels, .direct]
        let keys = Set(text.split(whereSeparator: \.isNewline).map { $0.trimmingCharacters(in: .whitespaces) })
        return Set(all.filter { keys.contains(key($0)) })
    }
}
