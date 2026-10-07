import Foundation
import Observation
import RocketVibeCore

let historyPage: Int64 = 50

/// Only source authority crosses navigation. The destination resolves its own
/// preview after checking this exact selection again.
enum QuoteTransfer {
    case ordinary(NativeQuoteSelection, thread: String?, limit: Int64)
    case encrypted(NativePrivateQuoteSelection)
    var room: String { switch self { case let .ordinary(s, _, _): return s.roomId; case let .encrypted(s): return s.roomId } }
    var message: String { switch self { case let .ordinary(s, _, _): return s.messageId; case let .encrypted(s): return s.messageId } }
    func matches(_ s: NativePrivateQuoteSelection) -> Bool {
        switch self {
        case let .encrypted(original): return s == original
        case let .ordinary(original, _, _):
            return s.admission.isEmpty && s.roomId == original.roomId && s.messageId == original.messageId
                && s.revision == original.revision && s.instance == original.instanceId
                && s.dataEpoch == original.dataEpoch && s.membership == original.membershipVersion
        }
    }
}

/// One open room, or one thread: its messages as the store holds them,
/// paged back on demand; or, after a jump to an old message, the history
/// around it (`context`) until that reaches the local one.
@MainActor @Observable
public final class RoomModel {
    public private(set) var room: Room
    /// The thread's root message id, None for the room itself.
    public let threadId: String?
    public let provider: ChatProvider
    var chat: Chat? { provider.legacy }
    /// Encrypted rooms send files sealed on the device (E2EE_FILES.md), in the room itself.
    public var supportsFiles: Bool { privateMode ? privateReady && privateHandle?.filesAvailable() == true : provider.supportsFiles }
    public var supportsEditing: Bool { privateMode ? privateReady : provider.supportsEditing }
    public var supportsRoomInfo: Bool { active && provider.supportsRoomInfo }
    public var supportsCalls: Bool { active && membershipIsCurrent && provider.supportsCalls }
    public func callAvailable() async -> Bool {
        guard active, membershipIsCurrent, !Task.isCancelled else { return false }
        if provider.legacy != nil && room.readOnly { return false }
        let available = await provider.callAvailable(rid:rid,membership:nativeMembership)
        return available && active && membershipIsCurrent && !Task.isCancelled
    }
    public func startCall() async throws -> String {
        guard active, membershipIsCurrent, !Task.isCancelled else { throw CancellationError() }
        let link = try await provider.startCall(rid:rid,membership:nativeMembership)
        guard active, membershipIsCurrent, !Task.isCancelled else { throw CancellationError() }
        return link
    }
    public func joinCall(callId:String) async throws -> String {
        guard active, membershipIsCurrent, !Task.isCancelled else { throw CancellationError() }
        let link = try await provider.joinCall(rid:rid,callId:callId,membership:nativeMembership)
        guard active, membershipIsCurrent, !Task.isCancelled else { throw CancellationError() }
        return link
    }
    public func callLink(callId:String) async throws -> String {
        guard active, membershipIsCurrent, !Task.isCancelled else { throw CancellationError() }
        let link = try await provider.callLink(rid:rid,callId:callId,membership:nativeMembership)
        guard active, membershipIsCurrent, !Task.isCancelled else { throw CancellationError() }
        return link
    }
    public var directPeerId: String? {
        guard active, provider.supportsProfiles, room.kind == "d", membershipIsCurrent, let native = provider.native else { return nil }
        return try? native.directPeerId(room: room.rid)
    }
    public var supportsRoomManagement: Bool { active && provider.native != nil && provider.supportsRoomInfo }
    public var supportsRoomFavorite: Bool { active && provider.native?.supportedFeatures().contains("favorites") == true }
    public func readState() throws -> NativeRoomReadState? {
        guard active, threadId == nil, let native=provider.native else { throw CancellationError() }
        let state=try native.roomReadState(room:room.rid)
        guard state?.membership == nativeMembership else { throw CancellationError() }
        return state
    }
    /// The view supplies an actually displayed, confirmed ID before its delay.
    public func markObservedRead(messageId:String) throws {
        guard active, !Task.isCancelled, let native=provider.native,
              let membership=nativeMembership,
              messages.contains(where:{$0.id == messageId && $0.delivery == .sent}) else { throw CancellationError() }
        if let threadId { _ = try native.markObservedThreadRead(root:threadId,message:messageId,membership:membership) }
        else { _ = try native.markObservedRead(room:room.rid,message:messageId,membership:membership) }
    }
    public var supportsObservedReads:Bool { active && nativeReadEnabled && (threadId == nil || provider.native?.supportedFeatures().contains("threads") == true) }
    private var nativeReadEnabled = false
    public func markLegacyRead() async {
        guard active, threadId == nil, !Task.isCancelled, let chat else { return }
        await chat.markRead(rid:room.rid)
    }
    public func favoriteState() throws -> NativeFavoriteState? {
        guard active, let native=provider.native else { throw CancellationError() }
        let state=try native.favoriteState(room: room.rid)
        guard state?.membership == nativeMembership else { throw CancellationError() }
        return state
    }
    public func changeFavorite(present:Bool,state:NativeFavoriteState) throws {
        guard active, let native=provider.native, state.membership == nativeMembership else { throw CancellationError() }
        try native.setFavoriteFromState(room:room.rid,present:present,membership:state.membership,revision:state.revision)
    }
    public func resumeFavorite(key:String) throws {
        guard active, membershipIsCurrent, let native=provider.native else { throw CancellationError() }
        try native.resumeFavorite(room:room.rid,key:key)
    }
    public func dismissFavorite(key:String) throws {
        guard active, membershipIsCurrent, let native=provider.native else { throw CancellationError() }
        _ = try native.dismissFailedFavorite(room:room.rid,key:key)
    }
    public private(set) var roomInformationRevision = ""
    public private(set) var roomOperationRevision = 0
    public func roomDetails() async throws -> RoomDetails {
        guard active else { throw CancellationError() }
        let result = try await provider.roomDetails(rid: room.rid)
        guard active, !Task.isCancelled else { throw CancellationError() }
        return result
    }
    public func roomManagement() async throws -> NativeRoomManagement {
        guard active, !Task.isCancelled, let native = provider.native else { throw CancellationError() }
        let result = try await native.roomManagement(room: room.rid)
        guard active, !Task.isCancelled else { throw CancellationError() }
        return result
    }
    public func roomMembers(after: String?, revision: String) async throws -> NativeRoomMemberPage {
        guard active, !Task.isCancelled, let native = provider.native else { throw CancellationError() }
        let result = try await native.roomMembers(room: room.rid, after: after, revision: revision)
        guard active, !Task.isCancelled else { throw CancellationError() }
        return result
    }
    public func roomIntention() throws -> NativeRoomIntention? {
        guard active, !Task.isCancelled, let native = provider.native else { throw CancellationError() }
        return try native.roomIntention(room: room.rid)
    }
    public func updateRoom(fields: NativeRoomFields, revision: String) async throws {
        guard active, !Task.isCancelled, let native = provider.native else { throw CancellationError() }
        try await native.updateRoom(room: room.rid, revision: revision, fields: fields)
        guard active, !Task.isCancelled else { throw CancellationError() }
    }
    public func changeRoomRole(target: String, role: String, revision: String) async throws {
        guard active, !Task.isCancelled, let native = provider.native else { throw CancellationError() }
        try await native.changeRoomRole(room: room.rid, revision: revision, target: target, role: role)
        guard active, !Task.isCancelled else { throw CancellationError() }
    }
    public func leaveRoom(revision: String) async throws {
        guard active, !Task.isCancelled, let native = provider.native else { throw CancellationError() }
        try await native.leaveRoom(room: room.rid, revision: revision)
        guard active, !Task.isCancelled else { throw CancellationError() }
    }
    public func resumeRoomIntention() async throws {
        guard active, !Task.isCancelled, let native = provider.native else { throw CancellationError() }
        try await native.resumeRoomIntention(room: room.rid)
        guard active, !Task.isCancelled else { throw CancellationError() }
    }
    public func dismissRoomIntention(key: String) async throws -> Bool {
        guard active, !Task.isCancelled, let native = provider.native else { throw CancellationError() }
        let result = try await native.dismissRoomIntention(room: room.rid, key: key)
        guard active, !Task.isCancelled else { throw CancellationError() }
        return result
    }
    public var supportsMarks: Bool { chat != nil || (provider.native?.supportedFeatures().contains("pins") == true && provider.native?.supportedFeatures().contains("stars") == true) }
    public var supportsSearch:Bool { active && (privateMode ? privateReady : (chat != nil || provider.native?.supportedFeatures().contains("search") == true)) }
    public let searchContext=UUID().uuidString
    public var searchVersion:String { guard active else {return "closed"};return searchContext+":"+(provider.native.map{(try? $0.searchVersion()) ?? "offline"} ?? "rc") }
    public func search(text:String) async throws -> [SearchHit] {
        guard supportsSearch, !Task.isCancelled else {throw CancellationError()}
        let version=searchVersion
        let hits:[SearchHit]
        // An encrypted room is searched on this device only.
        if privateMode {guard let privateHandle else {throw CancellationError()};hits=try await privateHandle.search(text:text)}
        else if let native=provider.native {hits=try await native.search(room:room.rid,text:text)}
        else if let chat {hits=try await chat.search(rid:room.rid,text:text)}
        else {throw CancellationError()}
        guard active,!Task.isCancelled,version==searchVersion else {throw CancellationError()}
        return hits
    }
    public var canAbandon: Bool { provider.native != nil }
    public private(set) var error: String?
    var active = true
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
    /// The decrypted quote cards last projected, by message: a reload keeps
    /// them until the next projection, or they would blink out each time.
    private var projectedQuotes: [String: [Quote]] = [:]
    private let nativeReadBoundary: NativeRoomReadState?
    var limit = historyPage
    var draftSave: Task<Void, Never>?
    /// Each message's actions, asked of rv-ffi once per version of the list.
    @ObservationIgnored var actionsOf: [String: [MessageAction]] = [:]
    private var nativeActions: [String: NativeMessageActions] = [:]
    private var roomAccessTask: Task<Void, Never>?
    private let nativeMembership: String?
    @ObservationIgnored private var nativeQuote: NativeQuoteSelection?
    @ObservationIgnored private var privateQuote: NativePrivateQuoteSelection?
    public private(set) var pendingQuote: Quote?
    private var privateMode: Bool { provider.native != nil && room.encrypted }
    public private(set) var privateReady = false
    @ObservationIgnored private var privateHandle: NativeCryptoMessages?
    @ObservationIgnored private var privateMessages: [NativePrivateMessage] = []
    @ObservationIgnored private var privateBusy = false
    @ObservationIgnored private var privateRestored = false
    @ObservationIgnored private var privateRestoring = false
    @ObservationIgnored private var privateDraftRevision = UUID()
    @ObservationIgnored private var privateGeneration = UUID()
    @ObservationIgnored private var quoteVisible = true
    @ObservationIgnored private var quoteGeneration = UUID()
    @ObservationIgnored private var quoteReader: NativeCryptoQuoteReader?
    @ObservationIgnored private var quoteTask: Task<Void, Never>?
    @ObservationIgnored private var quotePoll: Task<Void, Never>?
    @ObservationIgnored private var quoteAuthor: NativeCryptoQuoteComposer?
    @ObservationIgnored private var quoteAuthorGeneration = UUID()
    private var quoteAuthorBusy = false
    private var quoteSendingDraft: String?
    @ObservationIgnored private var quoteAuthorPoll: Task<Void, Never>?
    public var canSend: Bool { threadWriteAllowed && quoteSendingDraft == nil && (!privateMode || privateReady)
        && (privateMode || privateQuote == nil || (quoteVisible && quoteAuthor != nil && !quoteAuthorBusy))
        && (!draft.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty || nativeQuote != nil || privateQuote != nil) }
    public private(set) var threadWriteAllowed = true
    @ObservationIgnored private var actionLoads: Set<String> = []
    @ObservationIgnored private var mutations: [String: NativeMessageActions] = [:]

    public var draft: String {
        didSet {
            guard active else { return }
            if privateMode {
                guard !privateRestoring else { return }
                privateDraftRevision = UUID()
                draftSave?.cancel()
                let (handle, text, generation) = (privateHandle, draft, privateGeneration)
                draftSave = Task { [weak self] in
                    guard !Task.isCancelled, self?.active == true, self?.privateGeneration == generation else { return }
                    do { try await handle?.setDraft(text: text) }
                    catch { if self?.active == true { self?.error = L("crypto.failed") } }
                }
                return
            }
            let (provider, rid, thread, text, membership) = (provider, room.rid, threadId, draft, nativeMembership)
            if let native=provider.native {
                Task { try? await native.setTyping(room:rid,root:thread,active:!text.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty,membership:membership) }
            }
            draftSave?.cancel()
            draftSave = Task {
                try? await Task.sleep(nanoseconds: 400_000_000)
                if !Task.isCancelled {
                    if let native = provider.native {
                        if let thread { try? native.setThreadDraftFromMembership(room:rid,root:thread,text:text,membership:membership) }
                        else { try? native.setDraftFromMembership(room: rid, text: text, membership: membership) }
                    }
                    else { try? provider.setDraft(rid: rid, thread: thread, text: text) }
                }
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
        nativeMembership = (try? provider.native?.membershipVersion(room: room.rid)) ?? nil
        nativeReadBoundary = threadId == nil ? ((try? provider.native?.roomReadState(room:room.rid)) ?? nil) : nil
        nativeReadEnabled = provider.native?.supportedFeatures().contains("read_markers") == true
        let unread = room.unread > 0 || room.alert
        unreadAfter = unread && threadId == nil ? provider.legacy?.lastSeen(rid: room.rid) : nil
        if let native = provider.native {
            if room.encrypted { draft = "" }
            else if let threadId { draft = (try? native.threadDraftFromMembership(room:room.rid,root:threadId,membership:nativeMembership)) ?? "" }
            else { draft = (try? native.draftFromMembership(room: room.rid, membership: nativeMembership)) ?? "" }
        }
        else { draft = (try? provider.draft(rid: room.rid, thread: threadId)) ?? "" }
        roomInformationRevision = (try? provider.native?.roomRevision(room: room.rid)) ?? "\(room.rid):\(room.name):\(room.kind)"
    }

    /// Flush before leaving; a delayed save must not outlive this visible room.
    func deactivate() {
        guard active else { return }
        closeQuoteReader()
        quotePoll?.cancel(); quotePoll = nil
        closeQuoteAuthor()
        if let native=provider.native {
            let (rid,root,membership)=(room.rid,threadId,nativeMembership)
            Task {try? await native.setTyping(room:rid,root:root,active:false,membership:membership)}
        }
        draftSave?.cancel()
        roomAccessTask?.cancel()
        if privateMode {
            privateGeneration = UUID(); privateHandle?.close(); privateHandle = nil
            privateMessages = []; privateReady = false
        } else if quoteSendingDraft != draft { try? saveDraft(draft) }
        active = false
        cancelQuote()
        draft = ""
        roomOperationRevision &+= 1
        roomInformationRevision = "closed"
        messages = []
        actionsOf.removeAll()
        nativeActions.removeAll()
        mutations.removeAll()
    }

    public var rid: String { room.rid }
    public var membershipIsCurrent: Bool {
        guard let native = provider.native else { return true }
        do { return try native.membershipVersion(room: room.rid) == nativeMembership }
        catch { return false }
    }
    private func saveDraft(_ text: String) throws {
        guard !privateMode else { return }
        if let native = provider.native {
            if let threadId { try native.setThreadDraftFromMembership(room:room.rid,root:threadId,text:text,membership:nativeMembership) }
            else { try native.setDraftFromMembership(room: room.rid, text: text, membership: nativeMembership) }
        }
        else { try provider.setDraft(rid: room.rid, thread: threadId, text: text) }
    }

    func update(room: Room) {
        if provider.native != nil, room.encrypted != self.room.encrypted {
            deactivate()
            return
        }
        nativeReadEnabled = provider.native?.supportedFeatures().contains("read_markers") == true
        roomOperationRevision &+= 1
        if room != self.room { self.room = room }
        roomInformationRevision = (try? provider.native?.roomRevision(room: room.rid)) ?? "\(room.rid):\(room.name):\(room.kind)"
        refreshRoomAccess()
    }
    private func refreshRoomAccess() {
        guard active, roomAccessTask == nil, let native = provider.native,
              native.supportedFeatures().contains("room_info") else { return }
        let rid = room.rid
        roomAccessTask = Task { [weak self] in
            defer { self?.roomAccessTask = nil }
            guard !Task.isCancelled, self?.active == true else { return }
            try? await native.refreshRoomAccess(room: rid)
        }
    }

    /// Publishes only what changed: an equal list leaves every row alone.
    public func reload() {
        if privateMode {
            guard active else { return }
            Task { [weak self] in await self?.refreshPrivate() }
            return
        }
        if let native = provider.native, let selection = nativeQuote,
           (try? native.quoteSelection(room:selection.roomId,messageId:selection.messageId)) != selection {
            pendingQuote = Quote(unavailable:true,link:"",author:nil,body:[],images:[],files:[],quotes:[])
        }
        if let native = provider.native, let threadId {
            threadWriteAllowed = (try? native.threadWritable(room:room.rid,root:threadId)) == true
        }
        closeQuoteReader()
        // A context window shows the stretch around an old message, not the latest page.
        let window = threadId == nil ? context?.messages(unreadAfter: unreadAfter) : nil
        guard active, let fresh = window ?? cachedOrdinaryMessages() else {
            if provider.native != nil { messages = [] }
            return
        }
        let shown = withProjectedQuotes(fresh)
        if shown != messages {
            let changed = shown.filter { item in messages.first { $0.id == item.id } != item }
            messages = shown
            actionsOf.removeAll()
            for item in changed { nativeActions.removeValue(forKey: item.id) }
            if provider.native != nil {
                for item in shown where item.delivery == .sent { loadNativeActions(item) }
            }
        }
        refreshUploads()
        projectQuoteCards(fresh)
        if privateQuote != nil { Task { [weak self] in await self?.refreshQuoteAuthor() } }
    }

    private func withProjectedQuotes(_ items: [MessageItem]) -> [MessageItem] {
        guard !projectedQuotes.isEmpty else { return items }
        return items.map { item in
            guard let quotes = projectedQuotes[item.id] else { return item }
            var projected = item
            projected.quotes = quotes
            return projected
        }
    }

    private func cachedOrdinaryMessages() -> [MessageItem]? {
        try? provider.messages(rid: room.rid, limit: limit, thread: threadId, unreadAfter: unreadAfter, nativeBoundary:nativeReadBoundary, nativeMembership:nativeMembership)
    }
    private func closeQuoteReader() {
        quoteGeneration = UUID()
        quoteTask?.cancel(); quoteTask = nil
        quoteReader?.close(); quoteReader = nil
    }
    var hasPrivateQuoteProjection: Bool { quoteReader != nil || quoteTask != nil || quoteAuthor != nil || quoteAuthorBusy }
    /// The list owns its activity gate. Ordinary bodies and drafts remain in
    /// their existing cache; decrypted quote cards disappear on blur or cover.
    public func quoteActivity(_ visible: Bool) {
        guard quoteVisible != visible else { return }
        quoteVisible = visible
        guard !privateMode else { return }
        if !visible {
            closeQuoteReader()
            quotePoll?.cancel(); quotePoll = nil
            if privateQuote != nil || quoteAuthorBusy { cancelQuote() }
            projectedQuotes = [:]
            if active, provider.native != nil { messages = cachedOrdinaryMessages() ?? [] }
        } else if active { reload() }
    }
    private func projectQuoteCards(_ baseline: [MessageItem]) {
        guard active, quoteVisible, let native = provider.native, native.cryptoSettingsSupported(),
              baseline.contains(where: { !$0.quotes.isEmpty }) else {
            quotePoll?.cancel(); quotePoll = nil
            return
        }
        let generation = quoteGeneration
        quoteTask = Task { [weak self] in
            guard let self, self.active, self.quoteVisible, !Task.isCancelled else { return }
            defer { if self.quoteGeneration == generation { self.quoteTask = nil } }
            do {
                let reader = try await native.cryptoQuoteReader(room: self.room.rid)
                guard self.active, self.quoteVisible, self.quoteGeneration == generation, !Task.isCancelled else { reader.close(); return }
                self.quoteReader = reader
                let cards = try await reader.refresh(limit: UInt32(self.limit), root: self.threadId)
                guard self.active, self.quoteVisible, self.quoteGeneration == generation,
                      !Task.isCancelled, self.membershipIsCurrent, !reader.isClosed(),
                      self.cachedOrdinaryMessages() == baseline else { reader.close(); return }
                let byId = Dictionary(uniqueKeysWithValues: cards.map { ($0.messageId, $0.quotes) })
                self.projectedQuotes = byId
                self.messages = baseline.map { item in
                    var projected = item
                    if let quotes = byId[item.id] { projected.quotes = quotes }
                    return projected
                }
            } catch {
                guard self.quoteGeneration == generation else { return }
                self.quoteReader?.close(); self.quoteReader = nil
                self.projectedQuotes = [:]
            }
        }
        if quotePoll == nil {
            quotePoll = Task { [weak self] in
                while !Task.isCancelled {
                    do { try await Task.sleep(nanoseconds: 10_000_000_000) } catch { return }
                    guard let self, self.active, self.quoteVisible, !Task.isCancelled else { return }
                    self.reload()
                }
            }
        }
    }

    func refreshTyping() {
        let fresh = provider.native?.typing(room:room.rid,root:threadId) ?? (threadId == nil ? (chat?.typing(rid:room.rid) ?? []) : [])
        if fresh != typing { typing = fresh }
    }

    /// The room shows all its files waiting to go, a thread only its own.
    func refreshUploads() {
        let all = chat?.uploads(rid: room.rid) ?? (try? provider.native?.uploads(rid: room.rid)) ?? []
        let fresh = threadId == nil ? all : all.filter { $0.thread == threadId }
        if fresh != uploads { uploads = fresh }
    }

    /// Shows what the store has, then the server's newest page.
    private func refreshPrivate(before: String? = nil) async {
        guard active, !privateBusy, let native = provider.native, native.cryptoSettingsSupported() else { return }
        let generation = privateGeneration
        let draftRevision = privateDraftRevision
        let selected = privateQuote
        privateBusy = true
        defer { if generation == privateGeneration { privateBusy = false } }
        do {
            let handle: NativeCryptoMessages
            if let privateHandle { handle = privateHandle }
            else {
                let opened = try await native.cryptoMessages(room: room.rid, thread: threadId)
                guard active, generation == privateGeneration, !Task.isCancelled else { opened.close(); return }
                privateHandle = opened; handle = opened
            }
            // Rebuild the whole bounded retained window so no older quote card
            // survives a source withdrawal outside this conversation.
            let value = try await handle.refresh(before: nil, limit: 200)
            guard active, generation == privateGeneration, !Task.isCancelled, membershipIsCurrent else { return }
            messages = value.items
            privateMessages = value.messages
            if selected != nil, privateQuote == selected {
                if let preview = value.selectedQuote, preview.selection == selected {
                    pendingQuote = preview.quote
                } else { cancelQuote() }
            }
            if !privateRestored {
                if draftRevision == privateDraftRevision {
                    privateRestoring = true; draft = value.draft; privateRestoring = false
                } else { try await handle.setDraft(text: draft) }
                privateRestored = true
            }
            privateReady = value.canSend && !value.catchingUp
            hasOlder = value.hasOlder
            if value.catchingUp {
                Task { [weak self] in
                    try? await Task.sleep(nanoseconds: 150_000_000)
                    guard !Task.isCancelled, self?.privateGeneration == generation else { return }
                    await self?.refreshPrivate()
                }
            }
        } catch {
            guard active, generation == privateGeneration else { return }
            privateReady = false; self.error = L("crypto.failed")
            if privateHandle?.isClosed() == true {
                privateHandle?.close(); privateHandle = nil
                messages = []; privateMessages = []; privateRestored = false
                privateRestoring = true; draft = ""; privateRestoring = false
                cancelQuote()
            }
        }
    }

    func load() async {
        guard active, !loading else { return }
        if let native = provider.native { Task { await native.prepareCommands() } }
        if privateMode { await refreshPrivate(); return }
        refreshRoomAccess()
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
        if privateMode {
            guard active, !privateBusy, hasOlder,
                  let oldest = privateMessages.first(where: { $0.delivery == .journaled })?.position else { return false }
            await refreshPrivate(before: oldest)
            return true
        }
        guard active, !loading, hasOlder, threadId == nil, let oldest = messages.first?.ts else { return false }
        loading = true
        defer { loading = false }
        if let context {
            guard (try? await context.older()) != nil else { return false }
            show(context)
            return true
        }
        guard let page = try? await provider.loadOlder(room: room, oldestTs: oldest), active else {
            return false
        }
        hasOlder = page.more
        if let shown = page.limit { limit = shown } else { limit += historyPage }
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
        if let native = provider.native {
            // RocketVibe: its rank says how far back to read, then pages to it.
            if active, threadId == nil, let rank = try? native.messageRank(room: room.rid, message: id) {
                limit = max(limit, Int64(rank) + historyPage)
                reload()
            }
            for _ in 0..<30 where !messages.contains(where: { $0.id == id }) {
                if !(await loadOlder()) { break }
            }
        } else if !messages.contains(where: { $0.id == id }), let chat {
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
        chat?.localOldest(rid: room.rid, limit: limit)
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
    /// command stays in the draft, and the refusal is returned.
    @discardableResult
    public func send() async -> String? {
        guard active else { return nil }
        // RocketVibe: a server command runs; a text command (`/shrug`) is
        // written here and goes out like the draft, encrypted or not. A quote
        // leads the message, so what follows it is text.
        if let native = provider.native, privateQuote == nil, nativeQuote == nil {
            let typed = draft.trimmingCharacters(in: .whitespacesAndNewlines)
            if typed.hasPrefix("/") {
                let run: CommandRun
                do { run = try await native.runCommand(room: room.rid, text: typed) }
                catch { return L("command.failed", ["error": error.localizedDescription]) }
                guard active else { return nil }
                switch run {
                case .notCommand: break
                case .done:
                    if draft.trimmingCharacters(in: .whitespacesAndNewlines) == typed { draft = "" }
                    return nil
                case let .message(text): draft = text
                }
            }
        }
        if privateMode {
            guard privateReady, !privateBusy, let privateHandle else { return nil }
            let text = draft
            let selected = privateQuote
            guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || selected != nil else { return nil }
            let generation = privateGeneration
            privateBusy = true
            do {
                try await privateHandle.setDraft(text: text)
                try await privateHandle.sendQuotes(operation: "v1_" + UUID().uuidString.replacingOccurrences(of: "-", with: ""), text: text, quotes: selected.map { [$0] } ?? [])
                guard active, generation == privateGeneration else { return nil }
                if draft == text { privateRestoring = true; draft = ""; privateRestoring = false }
                if privateQuote == selected { cancelQuote() }
            } catch { if active, generation == privateGeneration { self.error = L("crypto.failed") } }
            privateBusy = false
            if active, generation == privateGeneration { await refreshPrivate() }
            return nil
        }
        if let selected = privateQuote {
            guard canSend, let author = quoteAuthor, !quoteAuthorBusy else { return nil }
            let (text, generation) = (draft, quoteAuthorGeneration)
            quoteAuthorBusy = true
            quoteSendingDraft = text
            draftSave?.cancel()
            do {
                // Keep the field and its ordinary draft until preflight accepts
                // an intention. SQL consumes only this exact caption on commit.
                try saveDraft(text)
                _ = try await author.send(text: text, quotes: [selected])
                if active, draft == text { draft = ""; draftSave?.cancel() }
                if active, generation == quoteAuthorGeneration, privateQuote == selected { cancelQuote() }
                if active { reload() }
            } catch {
                if active, generation == quoteAuthorGeneration { self.error = error.localizedDescription }
            }
            if generation == quoteAuthorGeneration { quoteAuthorBusy = false }
            quoteSendingDraft = nil
            return nil
        }
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard canSend, !text.isEmpty || nativeQuote != nil || privateQuote != nil else { return nil }
        if threadId == nil { leaveContext() }
        draft = ""
        draftSave?.cancel()
        if let chat, text.hasPrefix("/") {
            chat.setDraft(rid: room.rid, threadId: threadId, text: "")
            do {
                if try await chat.runCommand(rid: room.rid, text: text, threadId: threadId) { return nil }
            } catch {
                if draft.isEmpty { draft = text }
                let reason: String
                if case let RvError.Server(_, message, _, _, _, _) = error { reason = message } else { reason = error.localizedDescription }
                return L("command.failed", ["error": reason])
            }
        }
        do {
            // Clear before awaiting the transport: words typed during an RC send must survive.
            try saveDraft("")
            if let native = provider.native {
                if let threadId { _ = try native.sendReplyFromMembership(room:room.rid,root:threadId,text:text,membership:nativeMembership,quotes:nativeQuote.map { [$0] } ?? []) }
                else { _ = try native.sendQuotesFromMembership(room:room.rid,text:text,membership:nativeMembership,quotes:nativeQuote.map { [$0] } ?? []) }
                cancelQuote()
            }
            else { try await provider.send(rid: room.rid, text: text, thread: threadId) }
            reload()
        } catch {
            if active {
                draft = draft.isEmpty ? text : text + "\n" + draft
                self.error = error.localizedDescription
            }
        }
        return nil
    }

    public func retry(_ id: String) async {
        guard active else { return }
        if privateMode {
            guard let privateHandle, let original = privateMessages.first(where: { $0.id == id }) else { return }
            do { try await privateHandle.resume(operation: original.operation); await refreshPrivate() }
            catch { if active { self.error = L("crypto.failed") } }
            return
        }
        do { try await provider.retry(id); reload() }
        catch { self.error = error.localizedDescription }
    }

    public func abandon(_ id: String) {
        if privateMode {
            guard active, let privateHandle, let original = privateMessages.first(where: { $0.id == id }) else { return }
            Task { [weak self] in
                do { try await privateHandle.cancel(operation: original.operation); await self?.refreshPrivate() }
                catch { if self?.active == true { self?.error = L("crypto.failed") } }
            }
            return
        }
        guard active, !Task.isCancelled, let native = provider.native else { return }
        do { try native.abandon(id: id); reload() }
        catch { self.error = error.localizedDescription }
    }

    public func react(_ message: MessageItem, shortcode: String, add: Bool) async {
        guard active else { return }
        do {
            if privateMode {
                guard let privateHandle, privateJournaled(message.id) else { return }
                try await privateHandle.react(messageId: message.id, emoji: shortcode, present: add)
                await refreshPrivate()
            } else if let native = provider.native {
                try await native.react(room: room.rid, messageId: message.id, emoji: shortcode, present: add)
                if active { reload() }
            } else if let chat {
                try await chat.react(messageId: message.id, shortcode: shortcode, add: add)
            }
        } catch { if active { self.error = mutationError(error) } }
    }

    public func actions(for message: MessageItem) -> [MessageAction] {
        guard active else { return [] }
        if privateMode {
            var result: [MessageAction] = [.copy]
            if privateReady, privateMessages.contains(where: { $0.id == message.id && $0.delivery == .journaled }) {
                result.append(.reply)
            }
            if threadId == nil, message.threadId == nil,
               privateMessages.contains(where: { $0.id == message.id && $0.delivery == .journaled }),
               provider.native?.supportedFeatures().contains("threads") == true {
                result.append(.replyInThread)
            }
            if privateReady, privateJournaled(message.id) {
                result.append(.react)
                if message.mine { result += [.edit, .delete] }
            }
            return result
        }
        if provider.native != nil && message.system != nil { return [] }
        guard let chat else {
            loadNativeActions(message)
            guard let rights = nativeActions[message.id] else { return [.copy] }
            var result: [MessageAction] = [.copy]
            if message.delivery == .sent && provider.native?.supportedFeatures().contains("quotes") == true { result.append(.reply) }
            if threadId == nil && message.delivery == .sent && message.threadId == nil && !room.readOnly && provider.native?.supportedFeatures().contains("threads") == true { result.append(.replyInThread) }
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
    private func privateJournaled(_ id: String) -> Bool {
        privateMessages.contains { $0.id == id && $0.delivery == .journaled }
    }
    public func canResumePrivate(_ id: String) -> Bool {
        active && privateMode && privateMessages.contains { $0.id == id && $0.delivery != .journaled && $0.delivery != .cancelled }
    }
    public var messageTimeHelp: String { privateMode ? L("crypto.observed_time") : "" }
    public func repliesTitle(_ count: Int64) -> String {
        L(privateMode ? "crypto.retained_replies" : "message.replies", count: Int(count))
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
        if privateMode {
            guard privateReady, message.mine, privateJournaled(message.id) else { throw RvError.Local(message: L("actions.refused")) }
            return
        }
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

    /// The menu's quick reactions (`:code:`): the emoji I react with most on
    /// this account, counted by rv-ffi on every reaction added.
    public var quickReactions: [String] {
        if let chat { return chat.quickReactions() }
        guard let native = provider.native, native.supportedFeatures().contains("reactions") else { return [] }
        return native.quickReactions(custom: customReactionsAllowed)
    }
    /// Report: someone else's message, sent, not a system line; on RocketVibe
    /// when the server takes reports, never in a private conversation.
    public func canReport(_ message: MessageItem) -> Bool {
        guard active, !message.mine, message.system == nil, message.delivery == .sent else { return false }
        return !privateMode && provider.supportsReports
    }
    /// A private conversation reacts with standard emoji only.
    public var customReactionsAllowed: Bool { !privateMode }
    /// The standard emoji the reaction picker offers: on Rocket.Chat, those
    /// it has a name for (`chat.react` refuses the others); all elsewhere.
    public var reactionPickable: ((String) -> Bool)? {
        chat != nil ? { rocketChatReactsWith(code: $0) } : nil
    }
    /// My reaction naming the same emoji as `shortcode`, under the code the
    /// server keyed it (maybe an alias), to withdraw it.
    public func myReaction(_ message: MessageItem, shortcode: String) -> String? {
        message.reactions.first { $0.mine && sameEmoji(a: $0.shortcode, b: shortcode) }?.shortcode
    }
    public func quickReactionIsMine(_ message: MessageItem, shortcode: String) -> Bool {
        myReaction(message, shortcode: shortcode) != nil
    }
    /// A quick reaction of the menu: withdraws mine, adds it otherwise.
    public func quickReact(_ message: MessageItem, shortcode: String) async {
        if let own = myReaction(message, shortcode: shortcode) { await react(message, shortcode: own, add: false) }
        else { await react(message, shortcode: shortcode, add: true) }
    }
    /// A pick in the emoji picker (`:code:`): a standard emoji under its
    /// canonical shortcode, a server emoji where they are allowed.
    public func reactWithPick(_ message: MessageItem, code: String) async {
        guard let emoji = reactionEmoji(code: code, custom: customReactionsAllowed, rocketChat: chat != nil) else { return }
        await react(message, shortcode: emoji, add: true)
    }

    private func editableChat() throws -> Chat {
        guard active, let chat else { throw RvError.Local(message: L("native.error")) }
        return chat
    }

    public func edit(_ message: MessageItem, text: String) async throws {
        if privateMode { return try await amendPrivate(message, text: text) }
        if let native = provider.native {
            guard active, let context = mutations[message.id] else { throw RvError.Local(message: "revision_required") }
            try await native.edit(room: room.rid, messageId: message.id, revision: context.revision, text: text)
            mutations.removeValue(forKey: message.id)
            reload()
            return
        }
        try await editableChat().edit(rid: room.rid, messageId: message.id, text: text)
    }

    /// An encrypted edit (`text`) or deletion (`nil`), applied once journaled.
    private func amendPrivate(_ message: MessageItem, text: String?) async throws {
        guard active, let privateHandle, privateJournaled(message.id) else { throw RvError.Local(message: L("crypto.failed")) }
        try await privateHandle.amend(messageId: message.id, text: text)
        await refreshPrivate()
    }

    public func delete(_ message: MessageItem) async throws {
        if privateMode { return try await amendPrivate(message, text: nil) }
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
        guard active, membershipIsCurrent else { return }
        cancelQuote()
        let quoteGeneration = quoteAuthorGeneration
        if privateMode {
            guard privateReady, let privateHandle else { return }
            let generation = privateGeneration
            do {
                let preview = try await privateHandle.selectQuote(messageId: message.id)
                guard active, generation == privateGeneration, quoteGeneration == quoteAuthorGeneration, membershipIsCurrent else { return }
                privateQuote = preview.selection
                pendingQuote = preview.quote
            } catch { if active, generation == privateGeneration { self.error = L("quote.unavailable") } }
            return
        }
        if let native = provider.native {
            do {
                let selected = try native.quoteSelection(room:room.rid,messageId:message.id)
                guard let source = try provider.messages(rid:room.rid,limit:limit,thread:threadId,unreadAfter:unreadAfter,nativeBoundary:nativeReadBoundary,nativeMembership:nativeMembership).first(where: { $0.id == message.id }),
                      try native.quoteSelection(room:room.rid,messageId:message.id) == selected else { throw CancellationError() }
                nativeQuote = selected
                pendingQuote = Quote(unavailable:false,link:"",author:source.author,body:source.body,images:source.images,files:source.files,quotes:[])
            } catch { self.error = L("quote.unavailable") }
            return
        }
        guard let chat else { return }
        let q = await chat.quote(
            kind: room.kind, slug: room.slug, rid: room.rid, messageId: message.id, text: message.text ?? "")
        draft = q + draft
    }

    public func cancelQuote() {
        closeQuoteAuthor()
        privateHandle?.cancelQuote()
        privateQuote = nil
        nativeQuote = nil
        pendingQuote = nil
    }

    private func closeQuoteAuthor() {
        quoteAuthorGeneration = UUID(); quoteAuthorBusy = false
        quoteAuthor?.close(); quoteAuthor = nil
        quoteAuthorPoll?.cancel(); quoteAuthorPoll = nil
    }
    func transferQuote(_ id: String) async throws -> QuoteTransfer {
        guard active, membershipIsCurrent, let native = provider.native,
              messages.contains(where: { $0.id == id && $0.delivery == .sent && $0.system == nil }) else { throw CancellationError() }
        if privateMode {
            guard privateReady, let privateHandle else { throw CancellationError() }
            let generation = privateGeneration
            let value = try await privateHandle.selectQuote(messageId: id)
            guard active, generation == privateGeneration, membershipIsCurrent else { throw CancellationError() }
            return .encrypted(value.selection)
        }
        return .ordinary(try native.quoteSelection(room: rid, messageId: id), thread: threadId, limit: limit)
    }
    func acceptQuote(_ transfer: QuoteTransfer) async throws {
        guard active, membershipIsCurrent, let native = provider.native else { throw CancellationError() }
        cancelQuote()
        if privateMode {
            let generation = privateGeneration
            let quoteGeneration = quoteAuthorGeneration
            await refreshPrivate()
            guard active, generation == privateGeneration, quoteGeneration == quoteAuthorGeneration, privateReady, let privateHandle else { throw CancellationError() }
            let value = try await privateHandle.selectSourceQuote(roomId: transfer.room, messageId: transfer.message)
            guard active, generation == privateGeneration, quoteGeneration == quoteAuthorGeneration, membershipIsCurrent, transfer.matches(value.selection) else { throw CancellationError() }
            privateQuote = value.selection; pendingQuote = value.quote
            return
        }
        if case let .ordinary(selected, root, sourceLimit) = transfer {
            guard try native.quoteSelection(room: selected.roomId, messageId: selected.messageId) == selected,
                  let source = try provider.messages(rid: selected.roomId, limit: sourceLimit, thread: root,
                    unreadAfter: nil, nativeMembership: selected.membershipVersion).first(where: { $0.id == selected.messageId }),
                  try native.quoteSelection(room: selected.roomId, messageId: selected.messageId) == selected else { throw CancellationError() }
            nativeQuote = selected
            pendingQuote = Quote(unavailable:false,link:"",author:source.author,body:source.body,images:source.images,files:source.files,quotes:[])
            return
        }
        guard quoteVisible else { throw CancellationError() }
        let generation = quoteAuthorGeneration
        quoteAuthorBusy = true
        defer { if generation == quoteAuthorGeneration { quoteAuthorBusy = false } }
        let author = try await native.cryptoQuoteComposer(room: rid, thread: threadId)
        guard active, quoteVisible, generation == quoteAuthorGeneration else { author.close(); throw CancellationError() }
        quoteAuthor = author
        do {
            let value = try await author.selectSourceQuote(roomId: transfer.room, messageId: transfer.message)
            guard active, quoteVisible, generation == quoteAuthorGeneration, membershipIsCurrent,
                  transfer.matches(value.selection) else { author.close(); throw CancellationError() }
            privateQuote = value.selection; pendingQuote = value.quote
            quoteAuthorPoll = Task { [weak self] in
                while !Task.isCancelled {
                    do { try await Task.sleep(nanoseconds:10_000_000_000) } catch { return }
                    guard let self, self.active, self.quoteVisible, self.quoteAuthorGeneration == generation else { return }
                    await self.refreshQuoteAuthor()
                }
            }
        } catch {
            if generation == quoteAuthorGeneration { cancelQuote() }
            throw error
        }
    }
    private func refreshQuoteAuthor() async {
        guard active, quoteVisible, !quoteAuthorBusy, let author = quoteAuthor, let selected = privateQuote else { return }
        let generation = quoteAuthorGeneration
        quoteAuthorBusy = true
        pendingQuote = Quote(unavailable:true,link:"",author:nil,body:[],images:[],files:[],quotes:[])
        defer { if generation == quoteAuthorGeneration { quoteAuthorBusy = false } }
        do {
            let value = try await author.refresh()
            guard active, quoteVisible, generation == quoteAuthorGeneration, privateQuote == selected else { return }
            if let value, value.selection == selected, membershipIsCurrent { pendingQuote = value.quote }
            else { cancelQuote() }
        } catch { if generation == quoteAuthorGeneration { cancelQuote() } }
    }

    /// My latest message still editable, for the Up arrow in an empty composer.
    public func lastMine() -> MessageItem? {
        guard active, supportsEditing else { return nil }
        return messages.last { $0.mine && $0.system == nil && $0.delivery == .sent }
    }

    public func attach(path: String, name: String, mime: String, caption: String?, temporary: Bool) async -> String? {
        guard active, membershipIsCurrent else { return L("native.error") }
        do {
            if privateMode {
                guard let privateHandle else { return L("crypto.failed") }
                try await privateHandle.sendFile(path: path, name: name, mime: mime, caption: caption ?? "", temporary: temporary)
                await refreshPrivate()
                return nil
            }
            if let chat {
                try await chat.attach(rid: room.rid, thread: threadId, path: path, name: name, mime: mime, caption: caption, temporary: temporary)
            } else if let native=provider.native, let nativeMembership {
                try await native.attach(rid: room.rid, thread: threadId, path: path, name: name, mime: mime, caption: caption, temporary: temporary, membership: nativeMembership)
            } else { return L("native.error") }
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
        try? await provider.native?.retryUpload(id: id)
    }

    public func discardUpload(_ id: String) {
        guard active else { return }
        chat?.discardUpload(id: id)
        try? provider.native?.discardUpload(id: id)
        refreshUploads()
    }
}
