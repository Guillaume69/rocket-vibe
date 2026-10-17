import Foundation
import Observation
import RocketVibeCore

public enum Screen: Equatable {
    case starting
    case login
    case chat
}

/// `AppModel.zoom` as a factor, which `Font.vibe` reads: a view drawing
/// with it is drawn again when the zoom changes.
@Observable
public final class TextScale: @unchecked Sendable {
    public static let shared = TextScale()
    public internal(set) var factor = 1.0
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
    public private(set) var accounts: [Account] = [] {
        didSet {
            let saved = (try? String(contentsOfFile: client.configDir() + "/server-rail-order", encoding: .utf8)) ?? ""
            railAccounts = Self.orderForRail(accounts, keys: saved.split(separator: "\n").map(String.init))
            let keys = Set(accounts.map(\.key))
            (history, historyAt) = Self.pruned(history, at: historyAt) { keys.contains($0.account) }
        }
    }
    /// Tile positions are independent of the active-first list used at startup.
    public private(set) var railAccounts: [Account] = []

    /// Drops the account `moved` on `target`'s tile: it takes that place,
    /// kept for the next launch and for GTK (`server-rail-order`).
    public func moveRailAccount(_ moved: String, onto target: String) -> Bool {
        guard let order = client.moveRailAccount(keys: railAccounts.map(\.key), moved: moved, target: target) else { return false }
        railAccounts = Self.orderForRail(accounts, keys: order)
        return true
    }

    /// Cmd + digit: the rail's account at `slot` (0 for Cmd+1), as its tile does.
    public func openRailSlot(_ slot: Int) async {
        guard railAccounts.indices.contains(slot) else { return }
        await switchAccount(railAccounts[slot])
    }

    static func orderForRail(_ accounts: [Account], keys: [String]) -> [Account] {
        accounts.enumerated().sorted { left, right in
            let a = keys.firstIndex(of: left.element.key) ?? keys.count
            let b = keys.firstIndex(of: right.element.key) ?? keys.count
            return a == b ? left.offset < right.offset : a < b
        }.map(\.element)
    }
    /// Accounts with unread messages: the dots of the server rail on the
    /// accounts not open. Every account stays connected (`keepAccountsConnected`).
    public private(set) var unreadAccounts: Set<String> = []
    /// What calls for me on each account, for the dock's count.
    @ObservationIgnored private var accountAttention: [String: Int64] = [:]
    @ObservationIgnored private var watchingAccounts = false
    /// A call ringing on an account not on screen.
    public private(set) var backgroundCall: BackgroundCall?
    /// A message of an account not on screen, with its notification's scope.
    public var onBackgroundIncoming: ((Incoming, String) -> Void)?
    /// The background call changed: the window's ringtone, dock and notification follow.
    public var onBackgroundCall: ((BackgroundCall?) -> Void)?
    /// Each account's server icon (PNG or JPEG), when its server has one:
    /// the rail shows it instead of the host's initial.
    public private(set) var serverIcons: [String: Data] = [:]
    public private(set) var groups: [RoomGroup] = []
    /// Moves with every reload of the room list, whether or not a row changed:
    /// what the list leaves out (a room's own notifications) follows it.
    public private(set) var roomsRevision = 0
    public private(set) var connection = ConnectionState.offline
    /// Encrypted rooms readable and writable (my E2E key unlocked).
    public private(set) var e2eUnlocked = false
    public private(set) var room: RoomModel?
    public private(set) var thread: RoomModel?
    /// The open account's folded sections, by `RoomGroup.key`.
    public private(set) var collapsed: Set<String> = []
    /// The user hid the server rail (Settings > Accounts), shared with GTK.
    public private(set) var railHidden: Bool
    /// The text zoom in percent (Cmd with +, -, 0 or the wheel), shared with GTK.
    public private(set) var zoom: UInt32
    /// Bumped when photos or custom emoji change: views reload their images.
    public private(set) var imagesVersion = 0
    public private(set) var media: MediaStore?
    /// Voice on a Vibez server that offers it, the sidecar shipped.
    public private(set) var voice: VoiceModel?
    /// A short message for the window's toast.
    public var notice: String?
    /// The quick room switcher (Cmd+K) over the window.
    public var switching = false
    /// The settings overlay over the window, and the category it shows
    /// (`shownSettingsCategory` falls back when it has nothing here).
    public internal(set) var settingsShown = false
    public var settingsCategory = SettingsCategory.account
    /// This account administers its server: the rail tile's menu and the
    /// settings' link to the administration. Asked when a session begins.
    public internal(set) var administrator = false
    /// The server administration over the window, while it is shown.
    public internal(set) var admin: AdminModel?
    /// The report being written, for the window's sheet.
    public internal(set) var reporting: ReportDraft?
    /// A bot key just made (`BotsModel.createKey`), for the window's sheet:
    /// shown once, in memory only, dropped when dismissed or the account ends.
    public internal(set) var botKey: NativeBotKeyCreated?
    /// A workflow's new webhook URL (`WorkflowsModel.generateWebhook`), for
    /// the window's sheet: shown once, in memory only, like `botKey`.
    public internal(set) var workflowWebhook: String?
    /// The Reminders list over the window, from the account menu.
    public var remindersShown = false
    /// Moves when a reminder is set, cancelled or fired: the message menus
    /// and the list read the device's reminders again.
    public internal(set) var remindersRevision = 0
    /// A reminder whose time came, for the app's notifications (`Reminders.swift`).
    public var onReminder: ((DueReminder) -> Void)?
    @ObservationIgnored var reminderTimer: Task<Void, Never>?

    /// Rooms opened on any account, for back and forward.
    struct Visit: Equatable {
        let account: String
        let rid: String
    }
    var history: [Visit] = []
    var historyAt = -1
    /// The open account's last room, reopened once its row is there.
    @ObservationIgnored var pendingLastRoom: String?
    @ObservationIgnored var pending = Pending()
    @ObservationIgnored var flush: Task<Void, Never>?
    @ObservationIgnored public private(set) var sessionId = UUID()
    @ObservationIgnored var selectionId = UUID()
    @ObservationIgnored private var pendingRoomLink: (String, RoomLink)?
    @ObservationIgnored private var roomLinkRequest = UUID()
    @ObservationIgnored private var pendingNotification: (key: String, message: String, text: String?)?
    @ObservationIgnored private var notificationRequest: String?

    public var onIncoming: ((Incoming) -> Void)?
    /// A call started by the other member of a direct room, ringing (rv-core's `call_ring`).
    public private(set) var ringingCall: RingingCall?
    /// The ringing call changed: the window's ringtone, dock and notification follow.
    public var onCallRing: ((RingingCall?) -> Void)?
    public var onWithdraw: ((String) -> Void)?
    /// The dock badge: mentions and direct messages.
    public var onAttention: ((Int64) -> Void)?
    /// The voice sounds, played by the app (a cue, a looped tone or silence).
    public var onVoiceCue: ((VoiceCue) -> Void)?
    public var onVoiceTone: ((VoiceTone?) -> Void)?

    public init(home: String) {
        client = Client(home: home)
        Strings.setUp(configDir: client.configDir())
        railHidden = FileManager.default.fileExists(atPath: client.configDir() + "/hide-server-rail")
        zoom = client.zoom()
        TextScale.shared.factor = Double(zoom) / 100
    }

    /// Larger (`true`), smaller, or back to 100 % (`nil`).
    public func zoom(in larger: Bool?) {
        let next = larger.map { zoomStep(percent: zoom, zoomIn: $0) } ?? 100
        guard next != zoom else { return }
        client.setZoom(percent: next)
        TextScale.shared.factor = Double(next) / 100
        zoom = next
    }

    public var rooms: [Room] { groups.flatMap(\.rooms) }

    /// The new bot key's sheet closed: the key is gone for good.
    public func dismissBotKey() { botKey = nil }
    /// The webhook URL's sheet closed: the secret is gone for good.
    public func dismissWorkflowWebhook() { workflowWebhook = nil }

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
    public func resume(_ account: Account, preserveNavigation: Bool = false, reopen: Bool = true) async -> Bool {
        if !preserveNavigation { cancelNotificationNavigation(); pendingRoomLink = nil }
        let selected = UUID()
        selectionId = selected
        do {
            let provider: ChatProvider
            if account.genre == "vibez" {
                provider = .vibez(try await client.nativeResume(key: account.key))
            } else {
                provider = .rocketChat(try await client.resume(key: account.key))
            }
            guard selected == selectionId else { provider.shutdown(); return false }
            begin(provider, reopen: reopen && !preserveNavigation)
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

    /// Signs in with the bearer of a finished Infomaniak sign-in (kChat).
    public func submitInfomaniak(_ signIn: KchatSignIn, redirect: String) async {
        if await login.finishInfomaniak(signIn, redirect: redirect) { await submitLogin() }
    }

    /// The signed-in accounts again, for the server rail, and their icons.
    public func refreshAccounts() async {
        accounts = await client.accounts()
        // Not awaited: the unread poll that follows does not wait for icons.
        Task { await refreshServerIcons() }
    }

    /// Reads every account's server icon again (also after an administrator
    /// changed one); a read that concludes nothing keeps the icon shown.
    public func refreshServerIcons() async {
        for one in accounts {
            switch await client.serverIcon(key: one.key) {
            case let .image(bytes): serverIcons[one.key] = bytes
            case .absent: serverIcons.removeValue(forKey: one.key)
            case .unknown: break
            }
        }
    }

    /// Every signed-in account connected, those not on screen heard here.
    public func keepAccountsConnected() async {
        if !watchingAccounts {
            watchingAccounts = true
            client.watchAccounts(listener: AccountRelay { [weak self] in self?.handleAccount($0) })
            // Here rather than in the rail, which a hidden rail never draws.
            refreshMutes()
        }
        await client.keepAccountsConnected()
    }

    /// The muted accounts (`Client.muteAccount`, the file GTK reads too):
    /// no notification, sound or ring, their dot and dock count held back.
    public private(set) var mutedAccounts: Set<String> = []
    @ObservationIgnored private var muteEnd: Task<Void, Never>?

    /// Reads the mutes again (GTK may have changed them), and again when the
    /// earliest timed one ends: a day at most apart, so a damaged end
    /// far in the future never overflows the wait.
    public func refreshMutes() {
        mutedAccounts = Set(client.mutedAccounts())
        showAttention()
        muteEnd?.cancel()
        guard let end = client.nextMuteEnd() else { return }
        let left = end - Int64(Date().timeIntervalSince1970 * 1000)
        let wait = UInt64(min(max(0, left), 86_400_000) + 500)
        muteEnd = Task { [weak self] in
            try? await Task.sleep(nanoseconds: wait * 1_000_000)
            guard !Task.isCancelled else { return }
            self?.refreshMutes()
        }
    }

    /// Whether the account is muted now, from the set `refreshMutes` keeps
    /// (no file read per event).
    public func isMuted(_ key: String) -> Bool { mutedAccounts.contains(key) }

    /// Accounts being signed out from the rail: not opened meanwhile.
    @ObservationIgnored private var leaving: Set<String> = []

    public func mute(_ target: Account, _ choice: MuteChoice) {
        client.muteAccount(account: target.key, choice: choice)
        refreshMutes()
    }

    public func unmute(_ target: Account) {
        client.unmuteAccount(account: target.key)
        refreshMutes()
    }

    /// The rail's "Log out": the open account as the account menu does it,
    /// another one through `Client.signOutAccount`.
    public func signOut(_ target: Account) async {
        if target.key == account?.key {
            await signOut()
            return
        }
        guard leaving.insert(target.key).inserted else { return }
        defer { leaving.remove(target.key) }
        if backgroundCall?.account == target.key { endBackgroundCall() }
        do { try await client.signOutAccount(account: target.key) }
        catch { notice = L("rail.logout_failed"); return }
        unreadAccounts.remove(target.key)
        accountAttention[target.key] = nil
        accounts = await client.accounts()
        refreshMutes()
    }

    func handleAccount(_ event: AccountEvent) {
        switch event {
        case let .unread(key, unread, attention):
            if unread { unreadAccounts.insert(key) } else { unreadAccounts.remove(key) }
            accountAttention[key] = attention
            showAttention()
        case let .incoming(key, scope, incoming):
            guard key != account?.key, !isMuted(key) else { return }
            onBackgroundIncoming?(incoming, scope)
        case let .call(key, call):
            guard key != account?.key, call == nil || !isMuted(key) else { return }
            if let call {
                guard backgroundCall == nil, ringingCall == nil else { return }
                backgroundCall = call
            } else if backgroundCall?.account == key {
                backgroundCall = nil
            } else { return }
            onBackgroundCall?(backgroundCall)
        case let .expired(key):
            unreadAccounts.remove(key)
            accountAttention[key] = nil
            showAttention()
            if backgroundCall?.account == key { endBackgroundCall() }
        }
    }

    /// The dock's count: the open account's rooms and what the others hold.
    func showAttention() {
        let others = accountAttention.filter { $0.key != account?.key && !mutedAccounts.contains($0.key) }.values.reduce(0, +)
        let own = account.map { mutedAccounts.contains($0.key) } == true ? 0 : (chat?.attention() ?? 0)
        onAttention?(own + others)
    }

    /// The open account is muted: its messages notify nothing, its calls ring silently.
    public var openMuted: Bool { account.map { isMuted($0.key) } ?? false }

    private func endBackgroundCall() {
        backgroundCall = nil
        onBackgroundCall?(nil)
    }

    /// What the window's tone should be without the background call.
    public var foregroundTone: VoiceTone? { voice?.tone ?? (ringingCall != nil ? .ringtone : nil) }

    /// Accept: the account opens; a call's link to open, None for a voice
    /// ring (its session joins) or when the server refused.
    public func answerBackgroundCall(_ call: BackgroundCall) async -> String? {
        endBackgroundCall()
        guard let target = accounts.first(where: { $0.key == call.account }) else { return nil }
        await switchAccount(target, reopen: !call.voice)
        guard account?.key == call.account else { return nil }
        if call.voice {
            answer(VoiceCall(id: call.id, room: call.rid, callerId: "", callerName: call.caller,
                             calleeId: account?.userId ?? "", state: "ringing"))
            return nil
        }
        guard let chat else { return nil }
        chat.dismissCall()
        return try? await chat.joinCall(callId: call.id)
    }

    public func declineBackgroundCall(_ call: BackgroundCall) {
        endBackgroundCall()
        Task { await client.declineBackgroundCall(call: call) }
    }

    /// A click outside or Escape: it stops ringing here, nothing is declined.
    public func ignoreBackgroundCall(_ call: BackgroundCall) {
        endBackgroundCall()
        client.ignoreBackgroundCall(call: call)
    }

    /// A background account's notification: that account opens on the message.
    public func openBackgroundNotification(scope: String, message: String) async {
        guard let target = client.backgroundTarget(scope: scope) else { return }
        if account?.key != target.account {
            guard let other = accounts.first(where: { $0.key == target.account }) else {
                notice = L("links.unavailable")
                return
            }
            await switchAccount(other, reopen: false)
            guard account?.key == target.account else { return }
        }
        if message.isEmpty { open(target.rid) } else { await open(target.rid, message: message) }
    }

    /// From the server rail: the account opens on its last room, unless it is the open one.
    public func switchAccount(_ target: Account, reopen: Bool = true) async {
        guard target.key != account?.key, !leaving.contains(target.key) else { return }
        await resume(target, reopen: reopen)
    }

    public func showLogin(error: String?) {
        settingsShown = false
        closeAdmin()
        reporting = nil
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

    func begin(_ provider: ChatProvider, reopen: Bool = true) {
        if case let .vibez(native) = provider { native.activateAccount() }
        end()
        self.provider = provider
        let opened = provider.account()
        account = opened
        collapsed = Set(client.collapsedSections(account: opened.key))
        if let chat { media = MediaStore(chat: chat) }
        else if let native { media = MediaStore(native:native) }
        if let native, native.voiceSupported() {
            let voice = VoiceModel(native: native)
            voice.onNotice = { [weak self] in self?.notice = $0 }
            voice.onCue = { [weak self] in self?.onVoiceCue?($0) }
            voice.onTone = { [weak self] in self?.onVoiceTone?($0) }
            voice.isDirect = { [weak self] rid in self?.rooms.first(where: { $0.rid == rid })?.kind == "d" }
            self.voice = voice
        }
        connection = .connecting
        let expected = sessionId
        provider.listen(Relay { [weak self] event in
            guard let self, self.sessionId == expected else { return }
            self.handle(event)
        })
        e2eUnlocked = chat?.e2eUnlocked() ?? false
        pendingLastRoom = reopen ? client.lastRoom(account: opened.key) : nil
        reloadRooms()
        screen = .chat
        Task { await refreshAdministrator() }
        if backgroundCall?.account == account?.key { endBackgroundCall() }
        // A call that started ringing while the account was in the background.
        if let call = chat?.incomingCall() {
            ringingCall = call
            onCallRing?(call)
        }
    }

    func end() {
        sessionId = UUID()
        selectionId = UUID()
        closeAdmin()
        administrator = false
        reporting = nil
        botKey = nil
        workflowWebhook = nil
        room?.deactivate()
        thread?.deactivate()
        provider?.shutdown()
        if voice != nil { onVoiceTone?(nil) }
        voice = nil
        if ringingCall != nil {
            ringingCall = nil
            onCallRing?(nil)
        }
        flush?.cancel()
        flush = nil
        pending = Pending()
        room = nil
        thread = nil
        provider = nil
        account = nil
        collapsed = []
        e2eUnlocked = false
        connection = .offline
        media?.close()
        media = nil
        groups = []
    }

    public func signOut() async {
        guard let provider else { return }
        cancelNotificationNavigation()
        pendingRoomLink = nil
        // A mute does not outlive the account: signing in again starts unmuted.
        if let key = account?.key {
            client.unmuteAccount(account: key)
            refreshMutes()
        }
        let expected = sessionId
        do { try await provider.signOut() }
        catch { notice = error.localizedDescription; return }
        guard expected == sessionId else { return }
        end()
        accounts = await client.accounts()
        if let next = accounts.first, await resume(next) { return }
        showLogin(error: nil)
    }

    /// Accept: the ring stops; the call's link to open, None when the server refused.
    public func answerCall(_ call: RingingCall) async -> String? {
        guard let chat else { return nil }
        chat.dismissCall()
        return try? await chat.joinCall(callId: call.callId)
    }

    /// Who calls: the server's name for them, else the direct room's.
    public func callerName(_ call: RingingCall) -> String {
        call.callerName ?? rooms.first { $0.rid == call.rid }?.name ?? ""
    }

    public func declineCall(_ call: RingingCall) {
        guard let chat else { return }
        Task { await chat.declineCall(callId: call.callId) }
    }

    /// A click outside or Escape: the ring stops here, nothing is declined.
    public func ignoreCall() {
        chat?.dismissCall()
    }

    func handle(_ event: Event) {
        switch event {
        case let .changed(rooms, rids):
            // An edit or withdrawal in a source room also invalidates cards
            // displayed in another ordinary room or thread.
            let quotes = native != nil && (room?.hasPrivateQuoteProjection == true || thread?.hasPrivateQuoteProjection == true)
            let destinations = quotes ? [room?.rid, thread?.rid].compactMap { $0 } : []
            later(rooms: rooms, rids: rids + destinations)
            voice?.refresh()
        case .voice:
            voice?.refresh()
        case .resync:
            voice?.refresh()
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
            if !openMuted { onIncoming?(incoming) }
        case .callRing:
            ringingCall = chat?.incomingCall()
            onCallRing?(ringingCall)
        case let .privateNote(rid, text, body, cards, postId):
            let note = PrivateNoteItem(text: text, body: body, cards: cards, postId: postId)
            if thread?.rid == rid {
                thread?.note = note
            } else if room?.rid == rid {
                room?.note = note
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
        roomsRevision &+= 1
        if let room {
            if room.membershipIsCurrent, let fresh = rooms.first(where: { $0.rid == room.rid }) { room.update(room: fresh) }
            else {
                room.deactivate()
                self.room = nil
                closeThread(preserveNavigation:true)
            }
        }
        showAttention()
        if let thread {
            if thread.membershipIsCurrent, let fresh = rooms.first(where: { $0.rid == thread.rid }) { thread.update(room: fresh) }
            else { closeThread(preserveNavigation:true) }
        }
        followRoomLink(roomsLoaded: true)
        followNotification(roomsLoaded: true)
        reopenLastRoomIfListed()
    }

    private func reopenLastRoomIfListed() {
        guard let rid = pendingLastRoom else { return }
        if pendingRoomLink != nil || pendingNotification != nil || room != nil {
            pendingLastRoom = nil
            return
        }
        guard rooms.contains(where: { $0.rid == rid }) else {
            if !rooms.isEmpty { pendingLastRoom = nil }
            return
        }
        pendingLastRoom = nil
        open(rid, preserveNavigation: true)
    }

    /// Used for both a cold launch URL and a link received by an open window.
    public func openLink(_ url: String) async {
        cancelNotificationNavigation()
        pendingLastRoom = nil
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
        pendingLastRoom = nil
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
    /// Forwards a message of `source` (Rocket.Chat): `destination` opens, and
    /// the message's permalink goes there as a quote, through the outbox.
    public func forward(source: RoomModel, message: String, destination: String) async {
        guard chat != nil, source.provider.legacy === chat, rooms.contains(where: { $0.rid == destination }) else { return }
        let account = sessionId
        open(destination)
        do { try await source.forward(message, to: destination) }
        catch { if account == sessionId { notice = L("forward.failed") } }
    }

    public func open(_ rid: String, remember: Bool = true, preserveNavigation: Bool = false) {
        guard let provider, let found = rooms.first(where: { $0.rid == rid }) else { return }
        if !preserveNavigation { cancelNotificationNavigation(); pendingRoomLink = nil }
        // Another room: its chat, not the voice page shown before.
        if let voice, voice.shown != rid { voice.shown = nil }
        if room?.rid == rid { return }
        selectionId = UUID()
        if let key = account?.key {
            if remember {
                history = Array(history.prefix(historyAt + 1)) + [Visit(account: key, rid: rid)]
                historyAt = history.count - 1
            }
            client.setLastRoom(account: key, rid: rid)
        }
        room?.deactivate()
        closeThread(preserveNavigation:true)
        let model = RoomModel(provider: provider, room: found)
        model.onNotice = { [weak self] in self?.notice = $0 }
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

    /// A room picked in the list: a voice channel joins its session and shows its page.
    public func select(_ rid: String) {
        open(rid)
        if let voice, rooms.first(where: { $0.rid == rid })?.voice == true { Task { await voice.join(rid) } }
    }

    /// The header's call button and a call row's: the room's voice session, its
    /// page, ringing the other member of a direct room (`ring`).
    public func joinVoice(_ rid: String, ring: Bool) {
        open(rid)
        if let voice { Task { await voice.join(rid, ring: ring) } }
    }

    /// The voice page of a room, its chat behind it.
    public func showVoice(_ rid: String) {
        open(rid)
        voice?.shown = rid
    }

    /// An incoming call answered: its room, its page, the session.
    public func answer(_ call: VoiceCall) {
        open(call.room)
        if let voice { Task { await voice.answer(call) } }
    }

    public func openThread(_ rootId: String, message: String? = nil, preserveNavigation: Bool = false) {
        guard let provider, let room else { return }
        if let native = provider.native, !native.supportedFeatures().contains("threads") { return }
        if !preserveNavigation { cancelNotificationNavigation(); pendingRoomLink = nil }
        let model = RoomModel(provider: provider, room: room.room, threadId: rootId)
        model.onNotice = { [weak self] in self?.notice = $0 }
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
        Task { await step(-1) }
    }

    public func goForward() {
        guard canGoForward else { return }
        Task { await step(1) }
    }

    /// Moves along the history; the cursor goes back where it was when the room cannot open.
    func step(_ offset: Int) async {
        let from = historyAt
        let to = from + offset
        guard history.indices.contains(to) else { return }
        historyAt = to
        let visit = history[to]
        if !(await walk(to: visit)), historyAt == to, from < history.count {
            historyAt = from
        }
    }

    /// A room of the history, on its own account: switching to it first when it is another.
    func walk(to visit: Visit) async -> Bool {
        if account?.key != visit.account {
            guard let other = accounts.first(where: { $0.key == visit.account }) else {
                notice = L("links.unavailable")
                return false
            }
            await switchAccount(other, reopen: false)
            guard account?.key == visit.account,
                  await waitListed(visit.rid, account: sessionId, selected: selectionId) else { return false }
        }
        open(visit.rid, remember: false)
        return room?.rid == visit.rid
    }

    /// The history without the visits `keep` refuses, the cursor on the
    /// nearest visit kept at or before it, adjacent repeats merged.
    nonisolated static func pruned(_ history: [Visit], at: Int, keep: (Visit) -> Bool) -> ([Visit], Int) {
        var kept: [Visit] = []
        var cursor = -1
        for (index, visit) in history.enumerated() where keep(visit) {
            if kept.last != visit { kept.append(visit) }
            if index <= at { cursor = kept.count - 1 }
        }
        return (kept, cursor)
    }

    /// The room list's "Mark as unread" (`unread`) or "Mark as read", on
    /// Rocket.Chat. The open room marked unread is left first, as the official
    /// web client does: still open, it would read itself again.
    public func markRoom(_ rid: String, unread: Bool) async {
        guard let chat, chat.unreadMarksAvailable() else { return }
        let accountKey = account?.key
        if unread, room?.rid == rid { leaveRoom() }
        do { try await chat.markRoom(rid: rid, unread: unread) }
        catch let RvError.Local(message) where message == "nothing-unread" {
            if accountKey == account?.key { notice = L("rooms.nothing_unread") }
        } catch {
            if accountKey == account?.key { notice = L("rooms.mark_failed") }
        }
    }

    /// Shows no room: the open one is left and nothing in the list is selected.
    public func leaveRoom() {
        cancelNotificationNavigation(); pendingRoomLink = nil
        room?.deactivate()
        room = nil
        closeThread(preserveNavigation: true)
        chat?.closeRoom()
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

    /// Waits for `rid` in the room list (the stream lists it), as long as the
    /// account and the selection stay; false when they changed.
    private func waitListed(_ rid: String, account: UUID, selected: UUID) async -> Bool {
        for _ in 0..<40 where !rooms.contains(where: { $0.rid == rid }) {
            guard account == sessionId, selected == selectionId else { return false }
            try? await Task.sleep(nanoseconds: 100_000_000)
        }
        return account == sessionId && selected == selectionId
    }

    /// The Activity view of every running account (`Client.activity`).
    public func activity() async -> ActivityView {
        await client.activity()
    }

    /// An Activity entry picked: its account opens, then its message (in its
    /// thread for a reply) or its room.
    public func openActivity(account target: String, rid: String, message: String?, thread: String?) async {
        if account?.key != target {
            guard let other = accounts.first(where: { $0.key == target }) else {
                notice = L("links.unavailable")
                return
            }
            await switchAccount(other, reopen: false)
            guard account?.key == target else { return }
        }
        if let message, let thread {
            open(rid)
            if room?.rid == rid { openThread(thread, message: message) }
        } else if let message {
            await open(rid, message: message)
        } else {
            open(rid)
        }
    }

    /// Search across rooms, on the device (Rocket.Chat, Mattermost): newest first.
    public var supportsLocalSearch: Bool { chat != nil }
    public func searchLocal(_ text: String) async -> [LocalHit] {
        guard let chat else { return [] }
        return await chat.searchLocal(text: text)
    }

    /// A message found across rooms: its room at the message, or its thread.
    public func open(hit: LocalHit) async {
        let message = hit.message
        if let root = message.threadId {
            open(message.rid)
            if room?.rid == message.rid { openThread(root, message: message.id) }
        } else {
            await open(message.rid, message: message.id)
        }
    }

    /// Creates a discussion of `prid` (from the message `messageId` when given,
    /// with a first message `reply`), then opens it. Nil once done, else what to tell.
    public func createDiscussion(prid: String, name: String, messageId: String?, reply: String?) async -> String? {
        guard let chat, chat.discussionsAvailable() else { return L("discussion.failed") }
        let (account, selected) = (sessionId, UUID())
        selectionId = selected
        let words = reply?.trimmingCharacters(in: .whitespacesAndNewlines)
        do {
            let rid = try await chat.createDiscussion(prid: prid, name: name, messageId: messageId,
                                                      reply: words?.isEmpty == false ? words : nil)
            if await waitListed(rid, account: account, selected: selected) { open(rid) }
            return nil
        } catch {
            return L("discussion.failed")
        }
    }

    /// Whether this account creates channels from the app: a Vibez
    /// server (`createRoom`) or Rocket.Chat (`createChannel`).
    public var createsChannels: Bool { native != nil || chat?.channelsCreatable() == true }

    /// Creates a channel, or a private group with `private`, on a Rocket.Chat
    /// server, then opens it. Nil once done, else what to tell.
    public func createChannel(name: String, private: Bool) async -> String? {
        guard let chat, chat.channelsCreatable() else { return L("new_channel.failed") }
        let (account, selected) = (sessionId, UUID())
        selectionId = selected
        do {
            let rid = try await chat.createChannel(name: name, private: `private`)
            if await waitListed(rid, account: account, selected: selected) { open(rid) }
            return nil
        } catch let RvError.Local(message) {
            return L(message)
        } catch {
            return L("new_channel.failed")
        }
    }

    /// A discussion card's Open: its room, joined first when it belongs to a
    /// public channel; one of a private group is for its members.
    public func openDiscussion(_ drid: String) async {
        if rooms.contains(where: { $0.rid == drid }) { open(drid); return }
        guard let chat else { return }
        let (account, selected) = (sessionId, UUID())
        selectionId = selected
        do {
            switch try await chat.openDiscussion(drid: drid) {
            case .open:
                if await waitListed(drid, account: account, selected: selected) { open(drid) }
            case .membersOnly:
                if account == sessionId { notice = L("discussion.unavailable") }
            }
        } catch {
            if account == sessionId { notice = L("discussion.open_failed") }
        }
    }

    /// Creates a room on a Vibez server (a voice channel with `voice`, which only a
    /// server offering voice takes), then opens it once listed. Nil once done, else what
    /// to tell.
    public func createRoom(name: String, private: Bool, voice: Bool) async -> String? {
        guard let native else { return L("native.error") }
        let expected = sessionId
        let selected = UUID()
        selectionId = selected
        do {
            let rid = try await native.createVoiceRoom(name: name, private: `private`, voice: voice)
            for _ in 0..<40 where !rooms.contains(where: { $0.rid == rid }) {
                guard expected == sessionId, selected == selectionId else { return nil }
                try? await Task.sleep(nanoseconds: 100_000_000)
            }
            if expected == sessionId, selected == selectionId { open(rid) }
            return nil
        } catch {
            switch nativeCode(error) {
            case "offline": return L("native.offline")
            case "session_rejected": return L("login.expired")
            case "server_identity_changed": return L("native.identity_changed")
            default: return L("native.error")
            }
        }
    }

    public func toggle(_ key: String) {
        guard let account else { return }
        collapsed = Set(client.toggleCollapsedSection(account: account.key, section: key))
    }

    /// GTK's convention: the file's presence hides the rail.
    public func setRailHidden(_ hidden: Bool) {
        railHidden = hidden
        let path = client.configDir() + "/hide-server-rail"
        if hidden {
            try? FileManager.default.createDirectory(atPath: client.configDir(), withIntermediateDirectories: true)
            FileManager.default.createFile(atPath: path, contents: Data())
        } else {
            try? FileManager.default.removeItem(atPath: path)
        }
    }
}
