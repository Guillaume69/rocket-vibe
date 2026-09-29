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
    public private(set) var chat: Chat?
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
        guard let chat = try? await client.resume(key: account.key) else { return false }
        begin(chat)
        return true
    }

    public func submitLogin() async {
        if let chat = await login.submit(client: client) {
            accounts = await client.accounts()
            begin(chat)
        }
    }

    public func showLogin(error: String?) {
        login.reset(known: client.knownServers(), error: error)
        screen = .login
    }

    /// Back to the account in use, from the form opened to add another.
    public func cancelLogin() {
        if chat != nil { screen = .chat }
    }

    func begin(_ chat: Chat) {
        end()
        self.chat = chat
        account = chat.account()
        media = MediaStore(chat: chat)
        connection = .connecting
        chat.setListener(listener: Relay { [weak self] event in self?.handle(event) })
        e2eUnlocked = chat.e2eUnlocked()
        reloadRooms()
        screen = .chat
    }

    func end() {
        room = nil
        thread = nil
        chat = nil
        media = nil
        groups = []
        history = []
        historyAt = -1
    }

    public func signOut() async {
        guard let chat else { return }
        end()
        await chat.signOut()
        accounts = await client.accounts()
        if let next = accounts.first, await resume(next) { return }
        showLogin(error: nil)
    }

    func handle(_ event: Event) {
        switch event {
        case let .changed(rooms, rids):
            if rooms { reloadRooms() }
            if let room, rids.contains(room.rid) { room.reload() }
            if let thread, rids.contains(thread.rid) { thread.reload() }
        case .resync:
            reloadRooms()
            room?.reload()
            thread?.reload()
        case let .connection(state):
            connection = state
        case .expired:
            end()
            Task {
                accounts = await client.accounts()
                showLogin(error: L("login.expired"))
            }
        case let .typing(rid):
            if room?.rid == rid { room?.refreshTyping() }
        case .presence:
            reloadRooms()
        case let .upload(rid):
            if room?.rid == rid { room?.refreshUploads() }
        case .avatar:
            media?.forget()
            imagesVersion += 1
            reloadRooms()
        case .e2e:
            e2eUnlocked = chat?.e2eUnlocked() ?? false
            reloadRooms()
            room?.reload()
        case let .incoming(incoming):
            onIncoming?(incoming)
        }
    }

    func reloadRooms() {
        guard let chat else { return }
        groups = chat.rooms()
        if let room, let fresh = rooms.first(where: { $0.rid == room.rid }) { room.update(room: fresh) }
        onAttention?(chat.attention())
    }

    public func open(_ rid: String, remember: Bool = true) {
        guard let chat, let found = rooms.first(where: { $0.rid == rid }) else { return }
        if room?.rid == rid { return }
        if remember {
            history = Array(history.prefix(historyAt + 1)) + [rid]
            historyAt = history.count - 1
        }
        thread = nil
        let model = RoomModel(chat: chat, room: found)
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
        guard let chat, let room else { return }
        let model = RoomModel(chat: chat, room: room.room, threadId: rootId)
        thread = model
        Task { await model.load() }
    }

    public func closeThread() {
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
    }

    /// Opens what the spotlight found: a direct room with a person, or a channel (joined if need be).
    public func go(to found: Found) async {
        guard let chat else { return }
        do {
            let rid: String
            switch found {
            case let .user(_, username, _):
                rid = try await chat.openDm(username: username)
            case let .room(id, _, _):
                if !rooms.contains(where: { $0.rid == id }) { try await chat.joinChannel(rid: id) }
                rid = id
            }
            for _ in 0..<40 where !rooms.contains(where: { $0.rid == rid }) {
                try? await Task.sleep(nanoseconds: 100_000_000)
            }
            open(rid)
        } catch {
            notice = L("spotlight.open_failed")
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
        case .channels: return "channels"
        case .direct: return "direct"
        }
    }

    static func loadCollapsed(_ configDir: String) -> Set<RoomSection> {
        let text = (try? String(contentsOfFile: configDir + "/collapsed-sections", encoding: .utf8)) ?? ""
        let all: [RoomSection] = [.unread, .channels, .direct]
        let keys = Set(text.split(whereSeparator: \.isNewline).map { $0.trimmingCharacters(in: .whitespaces) })
        return Set(all.filter { keys.contains(key($0)) })
    }
}
