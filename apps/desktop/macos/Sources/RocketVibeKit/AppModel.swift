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
    /// Accounts other than the open one with unread messages: the dots of the
    /// server rail. Only the open account is connected; `pollAccounts` checks
    /// the others with one read each.
    public private(set) var unreadAccounts: Set<String> = []
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
    @ObservationIgnored public private(set) var sessionId = UUID()
    @ObservationIgnored var selectionId = UUID()
    @ObservationIgnored private var pendingRoomLink: (String, RoomLink)?
    @ObservationIgnored private var roomLinkRequest = UUID()
    @ObservationIgnored private var pendingNotification: (key: String, message: String, text: String?)?
    @ObservationIgnored private var notificationRequest: String?

    public var onIncoming: ((Incoming) -> Void)?
    public var onWithdraw: ((String) -> Void)?
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
        if signedIn { return }
        // A callback already owns startup, including any keyring await.
        if pendingNotification != nil { return }
        if let (url, _) = pendingRoomLink {
            await openLink(url)
            if signedIn { return }
            showLogin(error: L("links.choose_account"))
            return
        }
        do {
            if let saved = try client.pendingNotificationNavigation() {
                let request = UUID()
                roomLinkRequest = request
                notificationRequest = saved.id
                pendingNotification = (saved.key,saved.message,nil)
                let matches = await client.notificationAccounts(key:saved.key)
                guard roomLinkRequest == request else { return }
                guard matches.count == 1 else {
                    _ = try client.clearNotificationNavigation(id:saved.id)
                    pendingNotification = nil; notificationRequest = nil
                    showLogin(error:L("links.choose_account")); return
                }
                if !(await resume(matches[0],preserveNavigation:true)) { showLogin(error:L("links.choose_account")) }
                guard roomLinkRequest == request else { return }
                followNotification()
                return
            }
        } catch { cancelNotificationNavigation(); notice = L("links.unavailable") }
        if let first = accounts.first, await resume(first) { return }
        showLogin(error: nil)
    }

    @discardableResult
    public func resume(_ account: Account, preserveNavigation: Bool = false) async -> Bool {
        if !preserveNavigation { cancelNotificationNavigation(); pendingRoomLink = nil }
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

    /// The signed-in accounts again, for the server rail.
    public func refreshAccounts() async {
        accounts = await client.accounts()
    }

    /// One read per account that is not the open one; an account it cannot
    /// tell about (offline, refused) keeps its dot as it was.
    public func pollAccounts() async {
        for other in accounts where other.key != account?.key {
            guard let unread = await client.accountUnread(key: other.key) else { continue }
            if other.key == account?.key { continue }
            if unread { unreadAccounts.insert(other.key) } else { unreadAccounts.remove(other.key) }
        }
    }

    /// From the server rail: the account opens, unless it is the open one.
    public func switchAccount(_ target: Account) async {
        guard target.key != account?.key else { return }
        unreadAccounts.remove(target.key)
        await resume(target)
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
        else if let native { media = MediaStore(native:native) }
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
        cancelNotificationNavigation()
        pendingRoomLink = nil
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
            // An edit or withdrawal in a source room also invalidates cards
            // displayed in another ordinary room or thread.
            let quotes = native != nil && (room?.hasPrivateQuoteProjection == true || thread?.hasPrivateQuoteProjection == true)
            let destinations = quotes ? [room?.rid, thread?.rid].compactMap { $0 } : []
            later(rooms: rooms, rids: rids + destinations)
        case .resync:
            for key in native?.withdrawnNotifications() ?? [] { onWithdraw?(key) }
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
            followRoomLink()
            followNotification()
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
            // Native photos have immutable IDs; retired IDs are rejected by the store.
            // A profile notification must not cancel a current protected download.
            if chat != nil { media?.forget() }
            imagesVersion += 1
            later(rooms: true)
        case .e2e:
            e2eUnlocked = chat?.e2eUnlocked() ?? false
            later(everything: true)
        case let .incoming(incoming):
            onIncoming?(incoming)
        case let .privateNote(rid, text):
            if thread?.rid == rid {
                thread?.note = text
            } else if room?.rid == rid {
                room?.note = text
            }
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
                closeThread(preserveNavigation:true)
            }
        }
        onAttention?(chat?.attention() ?? 0)
        if let thread {
            if thread.membershipIsCurrent, let fresh = rooms.first(where: { $0.rid == thread.rid }) { thread.update(room: fresh) }
            else { closeThread(preserveNavigation:true) }
        }
        followRoomLink(roomsLoaded: true)
        followNotification(roomsLoaded: true)
    }

    /// Used for both a cold launch URL and a link received by an open window.
    public func openLink(_ url: String) async {
        cancelNotificationNavigation()
        let request = UUID()
        roomLinkRequest = request
        pendingRoomLink = nil
        guard let link = parseRoomLink(url: url) else { notice = L("links.unavailable"); return }
        pendingRoomLink = (url, link)
        if acceptsRoomLink(url) { followRoomLink(); return }
        let matches = await client.roomLinkAccounts(url: url)
        guard roomLinkRequest == request else { return }
        guard matches.count == 1 else { notice = L("links.choose_account"); return }
        guard await resume(matches[0],preserveNavigation:true), roomLinkRequest == request else { return }
        followRoomLink()
    }

    /// Native OS callbacks can precede account startup. Keep their scope until
    /// catch-up, then read privately before opening or enqueueing a reply.
    public func notificationAction(key: String, message: String, text: String? = nil) async {
        cancelNotificationNavigation()
        let request = UUID()
        roomLinkRequest = request
        pendingRoomLink = nil
        pendingNotification = (key,message,text)
        if let text {
            do {
                if let native, native.acceptsNotification(key:key) {
                    _ = try native.replyNotification(key:key,message:message,text:text)
                    pendingNotification = nil
                    return
                }
                let account = try await client.queueNotificationReply(key:key,message:message,text:text)
                guard roomLinkRequest == request else { return }
                pendingNotification = nil
                if !(await resume(account,preserveNavigation:true)) { showLogin(error:L("links.choose_account")) }
            } catch {
                if roomLinkRequest == request { pendingNotification = nil; notice = L("links.unavailable"); if !signedIn { showLogin(error:L("links.choose_account")) } }
            }
            return
        }
        do {
            let id = try client.beginNotificationNavigation()
            notificationRequest = id
            if let native, native.acceptsNotification(key:key) {
                guard try native.captureNotificationNavigation(id:id,key:key,message:message) else { retireNotificationNavigation(); return }
                followNotification(); return
            }
            let account = try await client.captureNotificationNavigation(id:id,key:key,message:message)
            guard roomLinkRequest == request else { return }
            guard let account else { retireNotificationNavigation(); return }
            if !(await resume(account,preserveNavigation:true)) { showLogin(error:L("links.choose_account")) }
            guard roomLinkRequest == request else { return }
            followNotification()
        } catch {
            if roomLinkRequest == request { retireNotificationNavigation(); notice = L("links.unavailable"); if !signedIn { showLogin(error:L("links.choose_account")) } }
        }
    }

    private func cancelNotificationNavigation() {
        roomLinkRequest = UUID()
        pendingNotification = nil
        notificationRequest = nil
        do { try client.cancelNotificationNavigation() }
        catch { notice = L("links.unavailable") }
    }

    private func retireNotificationNavigation() {
        roomLinkRequest = UUID()
        pendingNotification = nil
        if let id = notificationRequest { _ = try? client.clearNotificationNavigation(id:id) }
        notificationRequest = nil
        if !signedIn { showLogin(error:L("links.choose_account")) }
    }

    private func followNotification(roomsLoaded: Bool = false) {
        guard let action = pendingNotification, action.text == nil, let id = notificationRequest,
              let saved = try? client.pendingNotificationNavigation(), saved.id == id,
              let native, native.acceptsNotification(key:action.key) else { return }
        if ["server_identity_changed","session_rejected"].contains(native.status().error ?? "") {
            _ = try? client.clearNotificationNavigation(id:id)
            pendingNotification = nil; notificationRequest = nil; notice = L("links.unavailable"); return
        }
        guard connection == .online else { return }
        guard rooms.contains(where: { native.notificationKey(rid:$0.rid) == action.key }) else {
            if roomsLoaded { _ = try? client.clearNotificationNavigation(id:id); pendingNotification = nil; notificationRequest = nil; notice = L("links.unavailable") }
            return
        }
        pendingNotification = nil
        let expected = sessionId
        let request = roomLinkRequest
        Task {
            do {
                let target = try await native.resolveNotificationNavigation(id:id)
                guard expected == sessionId, request == roomLinkRequest else { return }
                await open(target.rid,message:target.root ?? action.message,preserveNavigation:true)
                guard expected == sessionId, request == roomLinkRequest else { return }
                if let root = target.root { openThread(root,message:action.message,preserveNavigation:true) }
                _ = try client.clearNotificationNavigation(id:id)
                notificationRequest = nil
            } catch {
                guard expected == sessionId, request == roomLinkRequest else { return }
                if let saved = try? client.pendingNotificationNavigation(), saved.id == id {
                    pendingNotification = action
                    try? await Task.sleep(nanoseconds:5_000_000_000)
                    if expected == sessionId, request == roomLinkRequest { followNotification() }
                } else { notificationRequest = nil; notice = L("links.unavailable") }
            }
        }
    }

    private func acceptsRoomLink(_ url: String) -> Bool {
        native?.acceptsRoomLink(url: url) ?? chat?.acceptsRoomLink(url: url) ?? false
    }

    private func followRoomLink(roomsLoaded: Bool = false) {
        guard let (url, link) = pendingRoomLink, acceptsRoomLink(url), native == nil || connection == .online else { return }
        guard rooms.contains(where: { $0.rid == link.rid }) else {
            if roomsLoaded && connection == .online { pendingRoomLink = nil; notice = L("links.unavailable") }
            return
        }
        pendingRoomLink = nil
        let expected = sessionId
        let request = roomLinkRequest
        let native = self.native
        Task {
            do {
                let resolved = try await native?.resolveRoomLink(url: url) ?? link
                guard expected == sessionId, request == roomLinkRequest, acceptsRoomLink(url) else { return }
                if let message = resolved.root ?? resolved.message { await open(resolved.rid, message: message,preserveNavigation:true) }
                else { open(resolved.rid,preserveNavigation:true) }
                guard expected == sessionId, request == roomLinkRequest else { return }
                if let root = resolved.root { openThread(root, message: resolved.message,preserveNavigation:true) }
            } catch {
                guard expected == sessionId, request == roomLinkRequest else { return }
                notice = L("links.unavailable")
            }
        }
    }

    public func quoteElsewhere(source: RoomModel, message: String, destination: String) async {
        guard let native, source.provider.native === native, source.active, source.membershipIsCurrent,
              destination != source.rid, rooms.contains(where: { $0.rid == destination }) else { return }
        let account = sessionId
        do {
            let rights = try await native.roomManagement(room:destination)
            guard account == sessionId, source.active, source.membershipIsCurrent else { return }
            guard rights.canSend else { throw CancellationError() }
            let transfer = try await source.transferQuote(message)
            guard account == sessionId, source.active, source.membershipIsCurrent else { return }
            open(destination)
            guard let target = room, target.rid == destination else { throw CancellationError() }
            try await target.acceptQuote(transfer)
        } catch {
            if account == sessionId, room?.rid == source.rid || room?.rid == destination { notice = L("quote.unavailable") }
        }
    }
    public func open(_ rid: String, remember: Bool = true, preserveNavigation: Bool = false) {
        guard let provider, let found = rooms.first(where: { $0.rid == rid }) else { return }
        if !preserveNavigation { cancelNotificationNavigation(); pendingRoomLink = nil }
        if room?.rid == rid { return }
        selectionId = UUID()
        if remember {
            history = Array(history.prefix(historyAt + 1)) + [rid]
            historyAt = history.count - 1
        }
        room?.deactivate()
        closeThread(preserveNavigation:true)
        let model = RoomModel(provider: provider, room: found)
        room = model
        Task { await model.load() }
    }

    /// The room, scrolled to that message: what a notification opens.
    public func open(_ rid: String, message: String, preserveNavigation: Bool = false) async {
        open(rid,preserveNavigation:preserveNavigation)
        if let room, room.rid == rid, !(await room.jump(to: message)) {
            notice = L("marked.not_loaded")
        }
    }

    public func openThread(_ rootId: String, message: String? = nil, preserveNavigation: Bool = false) {
        guard let provider, let room else { return }
        if let native = provider.native, !native.supportedFeatures().contains("threads") { return }
        if !preserveNavigation { cancelNotificationNavigation(); pendingRoomLink = nil }
        let model = RoomModel(provider: provider, room: room.room, threadId: rootId)
        thread?.deactivate()
        thread = model
        Task {
            await model.load()
            if let message { _ = await model.jump(to: message) }
        }
    }

    public func closeThread(preserveNavigation: Bool = false) {
        if !preserveNavigation { cancelNotificationNavigation(); pendingRoomLink = nil }
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
            case let .user(id, username, _):
                rid = try await provider.direct(username: username,userId:id)
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
