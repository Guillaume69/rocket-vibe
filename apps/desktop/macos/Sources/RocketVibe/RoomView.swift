import AppKit
import RocketVibeCore
import RocketVibeKit
import SwiftUI
import UniformTypeIdentifiers

struct RoomView: View {
    @Environment(AppModel.self) var app
    @Environment(\.openURL) var openURL
    let model: RoomModel
    @State var staged: [URL] = []
    @State var panel: Panel?
    @State var callable = false

    var body: some View {
        VStack(spacing: 0) {
            MessageList(model: model,readAllowed:panel == nil)
            if !model.typing.isEmpty {
                Text(typingLine)
                    .font(.vibe(11.5, .semibold))
                    .foregroundStyle(Vibe.pinkSoft)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 16)
                    .padding(.bottom, 2)
            }
            UploadsView(model: model)
            if model.room.encrypted && !app.e2eUnlocked && !model.privateReady {
                LockedBanner()
            } else if model.room.readOnly {
                Text(L("room.read_only"))
                    .foregroundStyle(.secondary)
                    .padding(12)
            } else {
                Composer(model: model, staged: $staged)
            }
        }
        .onDrop(of: [.fileURL, .plainText], isTargeted: nil) { providers in
            for provider in providers {
                if provider.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier) && model.supportsFiles {
                    _ = provider.loadObject(ofClass: URL.self) { url, _ in
                        if let url { DispatchQueue.main.async { staged.append(url) } }
                    }
                } else {
                    _ = provider.loadObject(ofClass: String.self) { text, _ in
                        if let text { DispatchQueue.main.async { model.draft += text } }
                    }
                }
            }
            return true
        }
        .environment(\.openURL, OpenURLAction { url in handle(url) })
        .modalOverlay(item: $panel, style: .sheet(width: 520, height: 640)) { PanelView(panel: $0, model: model) }
        .navigationSubtitle(subtitle)
        .onChange(of: model.error) { _, error in if let error { app.notice = error } }
        .toolbar {
            ToolbarItemGroup(placement: .primaryAction) {
                if model.loading || app.connection != .online {
                    ProgressView().controlSize(.small)
                }
                if callable {
                    Button(action: call) { Image(systemName: "video") }.help(L("room.call"))
                }
                VoiceCallButton(room: model.room)
                Button { panel = .marked } label: { Image(systemName: "pin") }.help(L("marked.title"))
                    .disabled(!model.supportsMarks)
                Button { panel = .search } label: { Image(systemName: "magnifyingglass") }.help(L("search.title"))
                    .windowShortcut(KeyboardShortcut("f", modifiers: .command))
                    .disabled(!model.supportsSearch)
                Button {
                    if let uid = model.directPeerId { panel = .profileId(uid) }
                    else { panel = .info }
                } label: { Image(systemName: "info.circle") }.help(L("info.room"))
                    .disabled(!model.supportsRoomInfo)
            }
        }
        .task(id: model.rid) {
            callable = false
            let expected = app.account?.key
            let available = await model.callAvailable()
            if !Task.isCancelled, expected == app.account?.key { callable = available }
        }
    }

    /// A direct room's partner: their presence.
    var subtitle: String {
        guard let presence = model.room.presence else { return "" }
        switch presence {
        case .online: return L("presence.online")
        case .away: return L("presence.away")
        case .busy: return L("presence.busy")
        case .offline: return L("presence.offline")
        }
    }

    func call() {
        Task {
            let expected = app.sessionId
            let link = try? await model.startCall()
            guard !Task.isCancelled, app.sessionId == expected, model.membershipIsCurrent else { return }
            if let link, let url = URL(string: link) {
                CallWindow.show(url, title: L("call.window_title", ["room": model.room.name]))
            } else {
                app.notice = L("call.failed")
            }
        }
    }

    var typingLine: String {
        let who = model.typing
        switch who.count {
        case 1: return L("typing.one", ["a": who[0]])
        case 2: return L("typing.two", ["a": who[0], "b": who[1]])
        default: return L("typing.many", ["n": String(who.count)])
        }
    }

    /// Mentions open a direct room, channel links the channel; the rest goes to the browser.
    func handle(_ url: URL) -> OpenURLAction.Result {
        let text = url.absoluteString
        if text.hasPrefix("rv-user:") {
            guard app.provider?.supportsProfiles == true else { return .handled }
            panel = .profile(String(text.dropFirst("rv-user:".count)))
            return .handled
        }
        if text.hasPrefix("rv-room:") {
            let name = String(text.dropFirst("rv-room:".count))
            if let room = app.rooms.first(where: { $0.slug == name || $0.name == name }) {
                app.open(room.rid)
            } else {
                Task {
                    guard let details = try? await app.chat?.roomNamed(name: name) else {
                        app.notice = L("spotlight.open_failed")
                        return
                    }
                    await app.go(to: .room(id: details.id, name: details.name, kind: details.kind))
                }
            }
            return .handled
        }
        return .systemAction
    }
}

/// An encrypted room while my key is locked: nothing to read or write yet.
struct LockedBanner: View {
    @Environment(AppModel.self) var app
    @State var asking = false

    var body: some View {
        HStack {
            Image(systemName: "lock.fill")
            Text(L("e2e.read_only"))
            Spacer()
            if app.chat != nil {
                Button(L("e2e.unlock")) { asking = true }.buttonStyle(VibeButtonStyle())
            }
        }
        .padding(12)
        .background(Vibe.card)
        .modalOverlay(isPresented: $asking) { UnlockSheet() }
    }
}

struct UnlockSheet: View {
    @Environment(AppModel.self) var app
    @Environment(\.closeModal) var dismiss
    @State var password = ""
    @State var error: String?
    @State var busy = false

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(L("e2e.title")).font(.headline)
            Text(L("e2e.body")).fixedSize(horizontal: false, vertical: true)
            SecureField(L("e2e.password"), text: $password)
                .textFieldStyle(.roundedBorder)
                .onSubmit(unlock)
                .firstModalField()
            if let error { Text(error).foregroundStyle(.red) }
            HStack {
                Spacer()
                Button(L("actions.cancel")) { dismiss() }
                Button(L("e2e.unlock"), action: unlock).keyboardShortcut(.defaultAction).disabled(busy || password.isEmpty)
            }
        }
        .padding()
        .frame(width: 420)
    }

    func unlock() {
        busy = true
        Task {
            error = await app.unlock(password: password)
            busy = false
            if error == nil { dismiss() }
        }
    }
}

struct MessageList: View {
    @Environment(AppModel.self) var app
    @Environment(\.controlActiveState) private var controlActive
    let model: RoomModel
    var readAllowed = true
    @State var pinned = true
    @State var farFromBottom = false
    @State var editing: String?
    @State var deleting: MessageItem?
    /// Once the room has loaded, new messages arrive with a spring.
    @State var settled = false
    @State private var visibleNative:Set<String> = []
    @State private var lastObserved:String?
    @State private var readTask:Task<Void,Never>?
    @State private var windowActive = NSApp.isActive
    /// The "new messages" marker has been on screen, or its pill clicked.
    @State private var markerSeen = false
    /// The row at the top of the view: the scroll view keeps it in place when
    /// an older page is inserted above it.
    @State private var topRow: String?

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0) {
                    if model.hasOlder && model.threadId == nil {
                        ProgressView()
                            .controlSize(.small)
                            .frame(maxWidth: .infinity)
                            .padding(8)
                            .onAppear { older() }
                    }
                    ForEach(model.messages, id: \.id) { message in
                        MessageRow(
                            message: message, model: model, editing: editing == message.id,
                            revealed: model.reveal == message.id,
                            setEditing: { editing = $0 }, askDelete: { deleting = $0 }
                        )
                        .equatable()
                        .id(message.id)
                        .onScrollVisibilityChange(threshold:0.01) { visible in
                            if visible && message.newMarker { markerSeen = true }
                            guard model.provider.native != nil, message.delivery == .sent else { return }
                            if visible {visibleNative.insert(message.id)} else {visibleNative.remove(message.id)}
                            scheduleObservedRead()
                        }
                    }
                    if model.hasNewer {
                        ProgressView()
                            .controlSize(.small)
                            .frame(maxWidth: .infinity)
                            .padding(8)
                            .onAppear { Task { await model.loadNewer() } }
                    }
                    Color.clear.frame(height: 6).id("bottom")
                }
                .scrollTargetLayout()
                .padding(.vertical, 8)
                .animation(settled ? Vibe.spring : nil, value: model.messages.last?.id)
            }
            .scrollPosition(id: $topRow, anchor: .top)
            .defaultScrollAnchor(.bottom)
            .task {
                try? await Task.sleep(nanoseconds: 800_000_000)
                settled = true
            }
            .onScrollGeometryChange(for: [Bool].self) { geometry in
                let fromBottom = geometry.contentSize.height - geometry.contentOffset.y - geometry.containerSize.height
                return [fromBottom < 48, fromBottom > geometry.containerSize.height]
            } action: { _, state in
                pinned = state[0]
                if farFromBottom != state[1] {
                    withAnimation(Vibe.spring) { farFromBottom = state[1] }
                }
            }
            .onChange(of: model.messages.last?.id) { _, _ in
                if pinned && model.context == nil { proxy.scrollTo("bottom", anchor: .bottom) }
            }
            .onChange(of:pinned) { _,value in
                if value {scheduleObservedRead()} else {cancelObservedRead()}
            }
            .onChange(of:model.supportsObservedReads) { _,value in
                if value {scheduleObservedRead()} else {cancelObservedRead()}
            }
            .onChange(of:readAllowed) { _,value in
                if value {scheduleObservedRead()} else {cancelObservedRead()}
                updateQuoteActivity()
            }
            .onChange(of:controlActive) { _,value in
                if value == .key {scheduleObservedRead()} else {cancelObservedRead()}
                updateQuoteActivity()
            }
            .onReceive(NotificationCenter.default.publisher(for:NSApplication.didBecomeActiveNotification)) { _ in
                windowActive=true;scheduleObservedRead()
                updateQuoteActivity()
            }
            .onReceive(NotificationCenter.default.publisher(for:NSApplication.didResignActiveNotification)) { _ in
                windowActive=false;cancelObservedRead()
                updateQuoteActivity()
            }
            .onAppear { updateQuoteActivity() }
            .onDisappear { cancelObservedRead();visibleNative.removeAll();model.quoteActivity(false) }
            .onChange(of: model.reveal) { _, id in
                guard let id else { return }
                withAnimation { proxy.scrollTo(id, anchor: .center) }
                Task {
                    try? await Task.sleep(nanoseconds: 2_000_000_000)
                    model.reveal = nil
                }
            }
            .task(id: model.messages.last?.id) {
                guard model.provider.legacy != nil else {return}
                try? await Task.sleep(nanoseconds: 1_500_000_000)
                if !Task.isCancelled && pinned && model.context == nil && NSApp.isActive && model.threadId == nil
                    && (model.room.unread > 0 || model.room.alert) {
                    await model.markLegacyRead()
                    Notifier.shared.withdraw(rid: model.rid)
                }
            }
            .overlay(alignment: .top) { newMessagesPill }
            .overlay(alignment: .bottomTrailing) {
                if farFromBottom || model.context != nil {
                    Button {
                        model.leaveContext()
                        Task {
                            await Task.yield()
                            withAnimation(Vibe.spring) { proxy.scrollTo("bottom", anchor: .bottom) }
                        }
                    } label: {
                        Image(systemName: "arrow.down")
                            .font(.system(size: 14, weight: .bold))
                            .foregroundStyle(Vibe.text)
                            .frame(width: 40, height: 40)
                            .background(Vibe.line, in: Circle())
                            .shadow(color: .black.opacity(0.6), radius: 10, y: 5)
                    }
                    .buttonStyle(.plain)
                    .help(L("room.latest"))
                    .padding(16)
                    .transition(.scale.combined(with: .opacity))
                }
            }
            .confirmOverlay(
                isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } }),
                title: L("actions.delete_title"),
                message: L("actions.delete_body"),
                actions: [ModalAction(title: L("actions.delete"), role: .destructive) {
                    if let message = deleting {
                        Task {
                            do { try await model.delete(message) } catch { app.notice = model.mutationError(error) }
                        }
                    }
                    deleting = nil
                }]
            )
        }
    }

    private func updateQuoteActivity() {
        model.quoteActivity(readAllowed && controlActive == .key && windowActive)
    }
    var visibleObservedId:String? {
        model.messages.last(where:{$0.delivery == .sent && visibleNative.contains($0.id)})?.id
    }
    /// The pending task retains its original displayed ID while newer visible
    /// messages wait for the next task, rather than rearming this delay.
    func scheduleObservedRead() {
        guard model.supportsObservedReads, readAllowed, controlActive == .key, pinned, windowActive, readTask == nil,
              let id=visibleObservedId, id != lastObserved else {return}
        let account=app.account?.key
        readTask=Task {
            try? await Task.sleep(nanoseconds:1_500_000_000)
            guard !Task.isCancelled else {return}
            if readAllowed && controlActive == .key && pinned && windowActive && account == app.account?.key {
                do {try model.markObservedRead(messageId:id);lastObserved=id}
                catch {}
            }
            readTask=nil
            if visibleObservedId != id {scheduleObservedRead()}
        }
    }
    func cancelObservedRead() {
        readTask?.cancel();readTask=nil
    }

    /// Over the top of the list while the "new messages" marker is above it.
    @ViewBuilder var newMessagesPill: some View {
        if let marker = model.messages.first(where: \.newMarker), settled, !markerSeen, model.context == nil {
            Button {
                markerSeen = true
                model.reveal = marker.id
            } label: {
                Text("↑ " + L("room.new_since", count: unreadCount)
                    .replacingOccurrences(of: "{time}", with: Formatting.time(model.unreadAfter ?? marker.ts)))
                    .font(.vibe(12, .heavy))
                    .foregroundStyle(Vibe.ink)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 6)
                    .background(Vibe.pink, in: Capsule())
                    .shadow(color: .black.opacity(0.6), radius: 10, y: 5)
            }
            .buttonStyle(.plain)
            .padding(.top, 10)
            .transition(.opacity)
        }
    }

    /// Messages from someone else from the marker down.
    var unreadCount: Int {
        guard let at = model.messages.firstIndex(where: \.newMarker) else { return 0 }
        return model.messages[at...].filter { !$0.mine && $0.delivery == .sent }.count
    }

    func older() {
        Task { await model.loadOlder() }
    }
}

/// A message. It compares by what it shows, so a list reloaded around it
/// leaves it as it is.
struct MessageRow: View, Equatable {
    @Environment(AppModel.self) var app
    let message: MessageItem
    /// None in the sample gallery: no actions there.
    let model: RoomModel?
    let editing: Bool
    let revealed: Bool
    let setEditing: (String?) -> Void
    let askDelete: (MessageItem) -> Void
    @State var draft = ""
    @State var viewing: ImageItem?
    @State private var choosingQuote = false
    /// The emoji picker, to react with any emoji.
    @State private var reacting = false

    nonisolated static func == (a: MessageRow, b: MessageRow) -> Bool {
        a.message == b.message && a.editing == b.editing && a.revealed == b.revealed && a.model === b.model
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if message.showDay {
                DaySeparator(ts: message.ts)
            }
            if message.newMarker {
                HStack(spacing: 8) {
                    Sparkle().fill(Vibe.pink).frame(width: 12, height: 12)
                    Text(L("room.new_messages")).font(.vibe(12, .heavy)).foregroundStyle(Vibe.pink)
                    Capsule()
                        .fill(LinearGradient(colors: [Vibe.pink, Vibe.violet, Vibe.mint.opacity(0)], startPoint: .leading, endPoint: .trailing))
                        .frame(height: 1.5)
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 8)
            }
            HStack(alignment: .top, spacing: 10) {
                gutter
                VStack(alignment: .leading, spacing: 4) {
                    if message.showHeader {
                        HStack(alignment: .firstTextBaseline, spacing: 7) {
                            Text(message.author)
                                .font(.vibe(13.5, .heavy))
                                .foregroundStyle(message.mine ? Vibe.pink : Vibe.text)
                            if message.authorBot { AdminBadge(text: L("bots.badge"), color: Vibe.sky) }
                            Text(Formatting.time(message.ts)).font(.vibe(11, .semibold)).foregroundStyle(Vibe.faint)
                                .help(model?.messageTimeHelp ?? "")
                        }
                    }
                    content
                }
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 16)
            .padding(.top, message.showHeader ? 8 : 1)
            .padding(.bottom, 1)
            .background(revealed ? Vibe.pink.opacity(0.14) : .clear)
            .animation(.easeOut(duration: 0.3), value: revealed)
            .contextMenu { menu }
            // A context menu cannot hold the picker: its item opens it here.
            .popover(isPresented: $reacting, arrowEdge: .bottom) {
                EmojiPicker(pick: { code, _ in
                    reacting = false
                    Task { await model?.reactWithPick(message, code: code) }
                }, custom: model?.customReactionsAllowed ?? false, pickable: model?.reactionPickable)
            }
        }
        .modalOverlay(item: Binding(get: { viewing.map(Viewing.init) }, set: { viewing = $0?.image }), style: .fullWindow) { v in
            ImageViewer(path: v.image.source, title: v.image.title)
        }
        .modalOverlay(isPresented: $choosingQuote) {
            QuoteDestinations(model: model, messageId: message.id)
        }
    }

    @ViewBuilder var gutter: some View {
        if message.showHeader {
            Avatar(path: message.avatar, name: message.author, size: 34)
        } else {
            Text(message.gutterTime ? Formatting.time(message.ts) : "")
                .help(model?.messageTimeHelp ?? "")
                .font(.vibe(10, .semibold))
                .foregroundStyle(Vibe.faint)
                .frame(width: 34)
        }
    }

    @ViewBuilder var content: some View {
        if let system = message.system {
            if system.hasPrefix("rv-call"), let model {
                VoiceCallCard(rid: model.rid, kind: system, param: message.param)
            } else if let callId = message.callId {
                CallCard(callId: callId, model: model)
            } else {
                Text("\(message.author) \(systemMessage(kind: system, param: message.param))")
                    .italic()
                    .foregroundStyle(.secondary)
            }
        } else if message.locked {
            Text(L("message.encrypted_locked")).italic().foregroundStyle(.secondary)
        }
        ForEach(Array(message.quotes.enumerated()), id: \.offset) { _, quote in
            QuoteCard(quote: quote)
        }
        if editing {
            editor
        } else if !message.body.isEmpty {
            BodyView(blocks: message.body, dimmed: message.delivery != .sent)
        }
        ForEach(Array(message.images.enumerated()), id: \.offset) { _, image in
            let size = displaySize(width: image.width, height: image.height)
            RemoteImage(path: image.source, width: size.width, height: size.height)
                .onTapGesture { viewing = image }
            if let caption = image.description {
                Text(caption).textSelection(.enabled)
            }
        }
        ForEach(Array(message.files.enumerated()), id: \.offset) { _, file in
            FileCard(file: file)
        }
        ForEach(Array(message.cards.enumerated()), id: \.offset) { _, card in
            if let page = card.player {
                VideoCard(card: card, page: page)
            } else {
                LinkCard(card: card)
            }
        }
        if let form = message.form {
            WorkflowFormCard(messageId: message.id, rid: message.rid, form: form, model: model)
        }
        if !message.reactions.isEmpty {
            HStack(spacing: 6) {
                ForEach(message.reactions, id: \.shortcode) { reaction in
                    Button {
                        Task { await model?.react(message, shortcode: reaction.shortcode, add: !reaction.mine) }
                    } label: {
                        HStack(spacing: 0) {
                            if reaction.glyph != nil {
                                Text("\(reaction.glyph!) \(reaction.count)")
                            } else {
                                RunsText(runs: [Run(text: reaction.shortcode, bold: false, italic: false, strike: false, code: false,
                                                    link: nil, mention: false, highlight: false,
                                                    customEmoji: reaction.shortcode.trimmingCharacters(in: CharacterSet(charactersIn: ":"))),
                                                Run(text: " \(reaction.count)", bold: false, italic: false, strike: false, code: false,
                                                    link: nil, mention: false, highlight: false, customEmoji: nil)])
                            }
                        }
                            .font(.vibe(12.5, .bold))
                            .contentTransition(.numericText())
                            .padding(.horizontal, 9)
                            .padding(.vertical, 3)
                            .background(reaction.mine ? Vibe.pink.opacity(0.14) : Vibe.card, in: Capsule())
                            .overlay(Capsule().strokeBorder(reaction.mine ? Vibe.pink : Vibe.line))
                            .animation(Vibe.spring, value: reaction.count)
                    }
                    .buttonStyle(ReactionPress())
                }
            }
        }
        footer
    }

    @ViewBuilder var footer: some View {
        if message.edited || message.delivery != .sent || message.threadCount > 0 {
            HStack(spacing: 10) {
                if message.threadCount > 0 {
                    Button("💬 " + (model?.repliesTitle(message.threadCount) ?? L("message.replies", count: Int(message.threadCount)))) { app.openThread(message.id) }
                        .buttonStyle(.link)
                        .foregroundStyle(Vibe.pinkSoft)
                }
                if message.edited { Text(L("message.edited")).font(.vibe(11)).foregroundStyle(Vibe.faint) }
                switch message.delivery {
                case .pending:
                    Text(L("message.sending")).font(.vibe(11)).foregroundStyle(Vibe.faint)
                case .failed:
                    Button(L("message.failed")) { Task { await model?.retry(message.id) } }
                        .buttonStyle(.link)
                        .foregroundStyle(Vibe.pink)
                case .sent:
                    EmptyView()
                }
            }
        }
    }

    var editor: some View {
        VStack(alignment: .leading, spacing: 6) {
            TextField("", text: $draft, axis: .vertical)
                .textFieldStyle(.roundedBorder)
                .lineLimit(1...10)
                .onSubmit(save)
                .onExitCommand { setEditing(nil) }
            HStack {
                Text(L("edit.hint")).font(.caption).foregroundStyle(.secondary)
                Spacer()
                Button(L("actions.cancel")) { setEditing(nil) }
                Button(L("actions.save"), action: save).windowShortcut(.defaultAction)
            }
        }
        .onAppear { draft = model?.editingText(message) ?? message.text ?? "" }
    }

    func save() {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        setEditing(nil)
        guard !text.isEmpty, text != (model?.editingOriginalText(message) ?? message.text) else { return }
        Task {
            do { try await model?.edit(message, text: text) } catch { app.notice = model?.mutationError(error) ?? L("actions.refused") }
        }
    }

    @ViewBuilder var menu: some View {
        let actions = model?.actions(for: message) ?? []
        if actions.contains(.react) {
            // The emoji I react with most, mine ticked (choosing one withdraws it).
            Menu("😀") {
                ForEach(model?.quickReactions ?? [], id: \.self) { code in
                    Toggle(replaceShortcodes(text: code), isOn: Binding(
                        get: { model?.quickReactionIsMine(message, shortcode: code) ?? false },
                        set: { _ in Task { await model?.quickReact(message, shortcode: code) } }
                    ))
                }
            }
            Button(L("actions.react_more") + "…") { reacting = true }
        }
        ForEach(actions.filter { $0 != .react }, id: \.self) { action in
            Button(title(action), role: action == .delete ? .destructive : nil) { run(action) }
        }
        if actions.contains(.reply), model?.provider.native != nil {
            Button(L("quote.elsewhere")) { choosingQuote = true }
        }
        if message.delivery == .sent, model?.membershipIsCurrent == true,
           let link = app.native?.permalink(room: message.rid, message: message.id, root: message.threadId) {
            Button(L("actions.copy_link")) {
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString(link, forType: .string)
            }
        }
        if model?.canReport(message) == true {
            Button(L("report.action")) { app.startReport(.message(message.id)) }
        }
        if model?.canResumePrivate(message.id) == true {
            Button(L("native.retry")) { Task { await model?.retry(message.id) } }
            Button(L("native.abandon")) { model?.abandon(message.id) }
        } else if message.delivery == .failed, model?.canAbandon == true {
            Button(L("native.abandon")) { model?.abandon(message.id) }
        }
    }

    func title(_ action: MessageAction) -> String {
        switch action {
        case .react: return "😀"
        case .reply: return L("actions.reply")
        case .replyInThread: return L("actions.reply_thread")
        case .copy: return L("actions.copy")
        case .download: return L("actions.download")
        case .edit: return L("actions.edit")
        case .delete: return L("actions.delete")
        case .pin: return L("actions.pin")
        case .unpin: return L("actions.unpin")
        case .star: return L("actions.star")
        case .unstar: return L("actions.unstar")
        }
    }

    func run(_ action: MessageAction) {
        switch action {
        case .react: break
        case .reply: Task { await model?.quote(message) }
        case .replyInThread: app.openThread(message.threadId ?? message.id)
        case .copy:
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(message.text ?? "", forType: .string)
            app.notice = L("actions.copied")
        case .download:
            if let path = message.files.first?.url ?? message.images.first?.source {
                let name = message.files.first?.title ?? message.images.first?.title ?? "file"
                Task { await download(path: path, name: name, app: app) }
            }
        case .edit, .delete:
            Task {
                do {
                    try await model?.prepareMutation(message, editing: action == .edit)
                    if action == .edit { setEditing(message.id) } else { askDelete(message) }
                } catch { app.notice = L("actions.refused") }
            }
        case .pin, .unpin:
            Task {
                do {
                    try await model?.pin(message, action == .pin)
                    app.notice = L(action == .pin ? "actions.pinned" : "actions.unpinned")
                } catch { app.notice = L("actions.refused") }
            }
        case .star, .unstar:
            Task {
                do {
                    try await model?.star(message, action == .star)
                    app.notice = L(action == .star ? "actions.starred" : "actions.unstarred")
                } catch { app.notice = L("actions.refused") }
            }
        }
    }
}

/// Where to quote a message: another room I am in, by name.
struct QuoteDestinations: View {
    @Environment(AppModel.self) var app
    @Environment(\.closeModal) var close
    let model: RoomModel?
    let messageId: String
    @State private var search = ""

    var body: some View {
        VStack(alignment:.leading, spacing:12) {
            Text(L("quote.destination")).font(.headline)
            TextField(L("spotlight.placeholder"), text:$search).firstModalField()
            ScrollView {
                VStack(alignment:.leading, spacing:4) {
                    let joined = Set((try? app.native?.quoteDestinations()) ?? [])
                    let candidates = app.rooms.filter { room in
                        room.rid != model?.rid && joined.contains(room.rid)
                            && (search.isEmpty || room.name.localizedCaseInsensitiveContains(search))
                    }
                    if candidates.isEmpty { Text(L("quote.destination_empty")).foregroundStyle(Vibe.faint) }
                    ForEach(candidates, id: \.rid) { destination in
                        Button(destination.name) {
                            close()
                            let id = messageId
                            if let model { Task { await app.quoteElsewhere(source:model,message:id,destination:destination.rid) } }
                        }.buttonStyle(.plain).padding(.vertical,6)
                    }
                }.frame(maxWidth:.infinity,alignment:.leading)
            }
            Button(L("actions.cancel")) { close() }
        }.padding(20).frame(width:380,height:360)
    }
}

struct Viewing: Identifiable {
    let image: ImageItem
    var id: String { image.source }
}

/// Into Downloads, under a name not taken yet.
@MainActor
func download(path: String, name: String, app: AppModel) async {
    guard let media = app.media,
          let folder = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask).first else { return }
    var target = folder.appendingPathComponent(name)
    let base = target.deletingPathExtension().lastPathComponent
    let ext = target.pathExtension
    var n = 1
    while FileManager.default.fileExists(atPath: target.path) {
        n += 1
        target = folder.appendingPathComponent(ext.isEmpty ? "\(base) (\(n))" : "\(base) (\(n)).\(ext)")
    }
    do {
        try await media.download(path, to: target.path)
        app.notice = L("actions.saved")
    } catch {
        app.notice = L("actions.save_failed")
    }
}

struct DaySeparator: View {
    let ts: Int64

    var body: some View {
        HStack(spacing: 10) {
            Capsule().fill(Vibe.line).frame(height: 1)
            Text(Formatting.day(ts))
                .font(.vibe(11.5, .bold))
                .foregroundStyle(Vibe.muted)
                .padding(.horizontal, 10)
                .padding(.vertical, 3)
                .background(Vibe.card, in: Capsule())
                .overlay(Capsule().strokeBorder(Vibe.line))
            Capsule().fill(Vibe.line).frame(height: 1)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
    }
}

/// A reaction pressed: a small bounce.
struct ReactionPress: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed ? 0.86 : 1)
            .animation(Vibe.spring, value: configuration.isPressed)
    }
}

struct QuoteCard: View {
    let quote: Quote

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            RoundedRectangle(cornerRadius: 2).fill(LinearGradient(colors: [Vibe.violet, Vibe.pink], startPoint: .top, endPoint: .bottom)).frame(width: 3)
            VStack(alignment: .leading, spacing: 3) {
                if quote.unavailable { Text(L("quote.unavailable")).foregroundStyle(Vibe.muted) }
                if let author = quote.author { Text(author).font(.vibe(13, .heavy)) }
                BodyView(blocks: quote.body)
                ForEach(Array(quote.images.enumerated()), id: \.offset) { _, image in
                    let size = displaySize(width: image.width, height: image.height, maxWidth: 240, maxHeight: 180)
                    RemoteImage(path: image.source, width: size.width, height: size.height)
                }
                ForEach(Array(quote.files.enumerated()), id: \.offset) { _, file in
                    Text("\(file.kind == .audio ? "🎵" : file.kind == .video ? "🎬" : "📎") \(file.title)")
                        .font(.vibe(12)).foregroundStyle(Vibe.muted).lineLimit(1)
                }
                ForEach(Array(quote.quotes.enumerated()), id: \.offset) { _, inner in
                    AnyView(QuoteCard(quote: inner))
                }
            }
        }
        .padding(9)
        .vibeCard(radius: 10)
        .fixedSize(horizontal: false, vertical: true)
    }
}

struct FileCard: View {
    @Environment(AppModel.self) var app
    let file: FileItem
    @State var playing: URL?
    @State var loading = false

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: icon).font(.title2).foregroundStyle(Vibe.brand).frame(width: 30)
            VStack(alignment: .leading, spacing: 2) {
                Text(file.title).font(.vibe(13.5, .bold)).lineLimit(1)
                Text([file.size, file.mime].compactMap { $0 }.joined(separator: " · "))
                    .font(.vibe(11.5)).foregroundStyle(Vibe.muted)
            }
            Spacer()
            if file.kind != .other {
                Button { Task { await play() } } label: { Image(systemName: loading ? "hourglass" : "play.fill") }
                    .help(L("file.play"))
            }
            Button { Task { await download(path: file.url, name: file.title, app: app) } } label: {
                Image(systemName: "arrow.down.circle")
            }
            .help(L("actions.download"))
        }
        .padding(10)
        .frame(maxWidth: 380)
        .vibeCard()
        .modalOverlay(item: Binding(get: { playing.map(Playing.init) }, set: { playing = $0?.url }), style: .media) { p in
            PlayerView(url: p.url)
        }
        .onChange(of:app.imagesVersion){if app.media?.current(file.url)==false{playing=nil}}
    }

    var icon: String {
        switch file.kind {
        case .audio: return "waveform"
        case .video: return "film"
        case .other: return "doc"
        }
    }

    /// Protected files cannot be streamed without the token: a local copy first.
    func play() async {
        guard let media = app.media else { return }
        loading = true
        defer { loading = false }
        do {playing=try await media.localCopy(file.url,name:file.title)}
        catch{app.notice=L("file.failed")}
    }
}

struct Playing: Identifiable {
    let url: URL
    var id: URL { url }
}

struct LinkCard: View {
    @Environment(\.openURL) var openURL
    let card: Card
    @State private var viewing=false

    var body: some View {
        Button {
            if card.url.hasPrefix("rv-preview:"){viewing=true}
            else if !card.url.isEmpty, let url = URL(string: card.url) { openURL(url) }
        } label: {
            HStack(alignment: .top, spacing: 10) {
                if let image = card.image {
                    ZStack {
                        RemoteImage(path: image, width: card.title == nil ? 320 : 96, height: card.title == nil ? 200 : 72)
                        if card.video {
                            Image(systemName: "play.circle.fill").font(.largeTitle).foregroundStyle(.white)
                        }
                    }
                }
                if card.title != nil || card.description != nil || !card.fields.isEmpty {
                    VStack(alignment: .leading, spacing: 3) {
                        if let site = card.site { Text(site).font(.vibe(11.5, .bold)).foregroundStyle(Vibe.muted) }
                        if let title = card.title { Text(title).font(.vibe(13.5, .heavy)).lineLimit(card.integration ? nil : 2) }
                        if let description = card.description {
                            Text(description).font(.vibe(12)).foregroundStyle(Vibe.soft).lineLimit(card.integration ? nil : 3)
                        }
                        Grid(alignment: .leading, horizontalSpacing: 12, verticalSpacing: 8) {
                            ForEach(Array(fieldRows.enumerated()),id: \.offset) { _, fields in
                                GridRow {
                                    ForEach(Array(fields.enumerated()),id: \.offset) { _, field in
                                        VStack(alignment: .leading,spacing: 2) {
                                            Text(field.title).font(.vibe(11,.bold)).foregroundStyle(Vibe.muted)
                                            Text(field.value).font(.vibe(12)).foregroundStyle(Vibe.soft)
                                        }.gridCellColumns(field.short ? 1 : 2)
                                    }
                                }
                            }
                        }
                    }
                    .multilineTextAlignment(.leading)
                }
            }
            .padding(8)
            .frame(maxWidth: 420, alignment: .leading)
            .vibeCard()
            .overlay(alignment: .leading) {
                if card.integration {
                    RoundedRectangle(cornerRadius: 2).fill(card.color.flatMap{UInt32($0.dropFirst(),radix:16)}.map{Color(hex:$0)} ?? Vibe.pink)
                        .frame(width: 3).padding(.vertical,8)
                }
            }
        }
        .buttonStyle(.plain)
        .modalOverlay(isPresented: $viewing, style: .fullWindow) { ImageViewer(path: card.url, title: card.title) }
    }

    var fieldRows:[[CardField]] {
        var rows:[[CardField]]=[]
        for field in card.fields {
            if field.short,let last=rows.last,last.count==1,last[0].short { rows[rows.count-1].append(field) }
            else { rows.append([field]) }
        }
        return rows
    }
}

struct CallCard: View {
    @Environment(AppModel.self) var app
    @Environment(\.openURL) var openURL
    let callId: String
    let model: RoomModel?
    @State var link: String?

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: "video.fill").foregroundStyle(Vibe.mint)
            Text(L("message.call")).font(.vibe(13.5, .bold))
            Button(L("message.join")) {
                Task {
                    guard let model else { return }
                    let expected = app.sessionId
                    let link = try? await model.joinCall(callId:callId)
                    guard !Task.isCancelled, expected == app.sessionId, model.membershipIsCurrent else { return }
                    if let link, let url = URL(string: link) {
                        CallWindow.show(url, title: L("message.call"))
                    } else {
                        app.notice = L("call.failed")
                    }
                }
            }
            .buttonStyle(VibeButtonStyle())
            Button {
                Task {
                    guard let model else { return }
                    let expected = app.sessionId
                    let found = try? await model.callLink(callId:callId)
                    guard !Task.isCancelled, expected == app.sessionId, model.membershipIsCurrent else { return }
                    if let found {
                        link = found
                    } else {
                        app.notice = L("call.failed")
                    }
                }
            } label: {
                Image(systemName: "info.circle")
            }
            .buttonStyle(.borderless)
            .help(L("call.info"))
        }
        .confirmOverlay(
            isPresented: Binding(get: { link != nil }, set: { if !$0 { link = nil } }),
            title: L("call.info"),
            message: link,
            cancel: L("call.close"),
            actions: link.map { link in
                [
                    ModalAction(title: L("call.copy_link")) {
                        NSPasteboard.general.clearContents()
                        NSPasteboard.general.setString(link, forType: .string)
                    },
                    ModalAction(title: L("call.open_browser")) {
                        if let url = URL(string: link) { openURL(url) }
                    },
                ]
            } ?? []
        )
        .padding(10)
        .vibeCard()
    }
}

/// The form a workflow's message carries (RFC 0004): its title, who answers,
/// then Answer while it is mine to answer, who answered, or that it expired.
struct WorkflowFormCard: View {
    let messageId: String
    let rid: String
    let form: FormItem
    /// None in the sample gallery: no answering there.
    let model: RoomModel?
    @State private var answering = false

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                Image(systemName: "list.bullet.rectangle").foregroundStyle(Vibe.violet)
                Text(form.title).font(.vibe(13.5, .bold))
            }
            Text(form.recipient.map { L("workflows.form_for", ["user": $0]) } ?? L("workflows.form_anyone"))
                .font(.vibe(12, .semibold))
                .foregroundStyle(.secondary)
            if let name = form.answeredBy {
                Label(L("workflows.form_answered_by", ["name": name]), systemImage: "checkmark.circle")
                    .foregroundStyle(Vibe.mint)
            } else if form.expired {
                Label(L("workflows.form_expired"), systemImage: "clock").foregroundStyle(.secondary)
            } else if form.canAnswer, model != nil {
                Button(L("workflows.form_answer")) { answering = true }
                    .buttonStyle(VibeButtonStyle())
            }
        }
        .padding(10)
        .frame(maxWidth: 420, alignment: .leading)
        .vibeCard()
        .modalOverlay(isPresented: $answering, style: .sheet(width: 520, height: 560)) {
            if let model { WorkflowFormSheet(messageId: messageId, rid: rid, form: form, model: model) }
        }
    }
}

/// One option of a form field: what is sent, and its words.
struct WorkflowPick: Identifiable {
    let id: String
    let name: String
}

/// Answering a workflow's form: each field as its kind asks, the required
/// ones marked. Submit sends it; a refusal shows here, worded; once sent it
/// closes. A click outside closes it, nothing sent.
struct WorkflowFormSheet: View {
    @Environment(AppModel.self) var app
    @Environment(\.closeModal) var dismiss
    let messageId: String
    let rid: String
    let form: FormItem
    let model: RoomModel
    /// Each field's values: one for most, the ticked ones for a multiple field.
    @State private var values: [String: [String]] = [:]
    @State private var error: String?
    @State private var busy = false
    /// The room's members, for a person field that lists nobody; read on open.
    @State private var members: [NativeWorkflowUser]?
    /// Each such field's search, by field id.
    @State private var searches: [String: String] = [:]

    var body: some View {
        SheetFrame(title: form.title) {
            Form {
                ForEach(form.fields, id: \.id) { field in
                    fieldView(field)
                }
                if let error { Text(error).foregroundStyle(.red) }
                HStack {
                    Spacer()
                    Button(L("actions.cancel")) { dismiss() }
                    Button(L("workflows.form_submit"), action: submit)
                        .keyboardShortcut(.defaultAction)
                        .disabled(busy)
                }
            }
            .formStyle(.grouped)
            .scrollContentBackground(.hidden)
        }
        .task {
            guard form.fields.contains(where: { $0.kind == "person" && $0.people.isEmpty }) else { return }
            switch await model.formMembers(rid: rid) {
            case let .success(found): members = found
            case let .failure(failure): members = []; error = failure.text
            }
        }
        .onAppear {
            // A required single choice starts on its first option: it has no empty entry.
            for field in form.fields where field.kind == "choice" && field.required && !field.multiple && values[field.id] == nil {
                values[field.id] = field.options.first.map { [$0] } ?? []
            }
        }
    }

    private func label(_ field: NativeFormField) -> String {
        field.required ? field.label + " *" : field.label
    }

    /// A field's one value.
    private func value(_ id: String) -> Binding<String> {
        Binding(get: { values[id]?.first ?? "" }, set: { values[id] = $0.isEmpty ? [] : [$0] })
    }

    /// Whether `item` is ticked among a multiple field's values.
    private func ticked(_ id: String, _ item: String) -> Binding<Bool> {
        Binding(get: { values[id]?.contains(item) ?? false },
                set: { values[id] = workflowTick(values[id] ?? [], item, $0) })
    }

    /// A choice among `items`: radios for one answer,
    /// checkboxes for several.
    @ViewBuilder func pick(_ field: NativeFormField, _ items: [WorkflowPick]) -> some View {
        if field.multiple {
            VStack(alignment: .leading, spacing: 4) {
                ForEach(items) { item in
                    Toggle(item.name, isOn: ticked(field.id, item.id)).toggleStyle(.checkbox)
                }
            }
        } else {
            Picker("", selection: value(field.id)) {
                if !field.required { Text(L("workflows.form_choose")).tag("") }
                ForEach(items) { item in Text(item.name).tag(item.id) }
            }
            .pickerStyle(.radioGroup)
            .labelsHidden()
        }
    }

    @ViewBuilder func fieldView(_ field: NativeFormField) -> some View {
        switch field.kind {
        case "long_text":
            VStack(alignment: .leading, spacing: 4) {
                Text(label(field))
                TextEditor(text: value(field.id))
                    .frame(minHeight: 80, maxHeight: 200)
                    .scrollContentBackground(.hidden)
                    .padding(4)
                    .background(Vibe.deep, in: RoundedRectangle(cornerRadius: 6))
                    .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(Vibe.line))
            }
        case "choice":
            if field.multiple {
                VStack(alignment: .leading, spacing: 4) {
                    Text(label(field))
                    pick(field, field.options.map { WorkflowPick(id: $0, name: $0) })
                }
            } else {
                Picker(label(field), selection: value(field.id)) {
                    if !field.required { Text(L("workflows.form_choose")).tag("") }
                    ForEach(field.options, id: \.self) { option in Text(option).tag(option) }
                }
            }
        case "person":
            person(field)
        default:
            // Text and numbers: one line, a number checked by the server.
            TextField(label(field), text: value(field.id))
        }
    }

    /// A person field: its fixed people, or the room's members to search;
    /// one or several are chosen, the answer being their user ids.
    @ViewBuilder func person(_ field: NativeFormField) -> some View {
        let chosen = values[field.id] ?? []
        VStack(alignment: .leading, spacing: 4) {
            Text(label(field))
            if !field.people.isEmpty {
                pick(field, field.people.map { WorkflowPick(id: $0, name: workflowPersonName($0, in: form.people)) })
            } else if let members {
                TextField(L("workflows.people_search"), text: Binding(
                    get: { searches[field.id] ?? "" }, set: { searches[field.id] = $0 }
                ))
                let matching = Array(workflowPeopleMatching(members, searches[field.id] ?? "").prefix(50))
                // Those chosen stay shown while the search hides them.
                let shown = members.filter { member in chosen.contains(member.id) && !matching.contains { $0.id == member.id } }
                    + matching
                if shown.isEmpty {
                    Text(L("workflows.people_none")).foregroundStyle(.secondary)
                } else {
                    pick(field, shown.map { WorkflowPick(id: $0.id, name: workflowPersonName($0)) })
                }
            } else {
                ProgressView().controlSize(.small)
            }
        }
    }

    func submit() {
        guard let answers = workflowFormAnswers(form.fields, values) else {
            error = L("workflows.error_form_required")
            return
        }
        busy = true
        error = nil
        Task {
            let failure = await model.answerForm(message: messageId, answers: answers)
            busy = false
            if let failure {
                error = failure
            } else {
                app.notice = L("workflows.form_sent")
                dismiss()
            }
        }
    }
}

struct UploadsView: View {
    let model: RoomModel

    var body: some View {
        ForEach(model.uploads, id: \.id) { upload in
            HStack(spacing: 8) {
                Image(systemName: "arrow.up.doc")
                Text(upload.name).lineLimit(1)
                Spacer()
                if upload.failed {
                    Text(L("upload.failed")).foregroundStyle(.red).font(.caption)
                    Button(L("upload.retry")) { Task { await model.retryUpload(upload.id) } }
                    Button(L("upload.discard")) { model.discardUpload(upload.id) }
                } else if let progress = upload.progress {
                    ProgressView(value: progress).frame(width: 120)
                } else {
                    Text(L(upload.retrying ? "upload.retrying" : "upload.waiting")).font(.caption).foregroundStyle(.secondary)
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 4)
        }
    }
}
