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
            if model.room.encrypted && !app.e2eUnlocked {
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
        .sheet(item: $panel) { PanelView(panel: $0, model: model) }
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
                Button { panel = .marked } label: { Image(systemName: "pin") }.help(L("marked.title"))
                    .disabled(!model.supportsMarks)
                Button { panel = .search } label: { Image(systemName: "magnifyingglass") }.help(L("search.title"))
                    .keyboardShortcut("f", modifiers: .command)
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
        .sheet(isPresented: $asking) { UnlockSheet() }
    }
}

struct UnlockSheet: View {
    @Environment(AppModel.self) var app
    @Environment(\.dismiss) var dismiss
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
            if let error { Text(error).foregroundStyle(.red) }
            HStack {
                Spacer()
                Button(L("actions.cancel")) { dismiss() }.keyboardShortcut(.cancelAction)
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

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0) {
                    if model.hasOlder && model.threadId == nil {
                        ProgressView()
                            .controlSize(.small)
                            .frame(maxWidth: .infinity)
                            .padding(8)
                            .onAppear { older(proxy) }
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
                            guard model.provider.native != nil, message.delivery == .sent else { return }
                            if visible {visibleNative.insert(message.id)} else {visibleNative.remove(message.id)}
                            scheduleObservedRead()
                        }
                    }
                    Color.clear.frame(height: 6).id("bottom")
                }
                .padding(.vertical, 8)
                .animation(settled ? Vibe.spring : nil, value: model.messages.last?.id)
            }
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
                if pinned { proxy.scrollTo("bottom", anchor: .bottom) }
            }
            .onChange(of:pinned) { _,value in
                if value {scheduleObservedRead()} else {cancelObservedRead()}
            }
            .onChange(of:model.supportsObservedReads) { _,value in
                if value {scheduleObservedRead()} else {cancelObservedRead()}
            }
            .onChange(of:readAllowed) { _,value in
                if value {scheduleObservedRead()} else {cancelObservedRead()}
            }
            .onChange(of:controlActive) { _,value in
                if value == .key {scheduleObservedRead()} else {cancelObservedRead()}
            }
            .onReceive(NotificationCenter.default.publisher(for:NSApplication.didBecomeActiveNotification)) { _ in
                windowActive=true;scheduleObservedRead()
            }
            .onReceive(NotificationCenter.default.publisher(for:NSApplication.didResignActiveNotification)) { _ in
                windowActive=false;cancelObservedRead()
            }
            .onDisappear { cancelObservedRead();visibleNative.removeAll() }
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
                if !Task.isCancelled && pinned && NSApp.isActive && model.threadId == nil && (model.room.unread > 0 || model.room.alert) {
                    await model.markLegacyRead()
                    Notifier.shared.withdraw(rid: model.rid)
                }
            }
            .overlay(alignment: .bottomTrailing) {
                if farFromBottom {
                    Button {
                        withAnimation(Vibe.spring) { proxy.scrollTo("bottom", anchor: .bottom) }
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
            .confirmationDialog(L("actions.delete_title"), isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } })) {
                Button(L("actions.delete"), role: .destructive) {
                    if let message = deleting {
                        Task {
                            do { try await model.delete(message) } catch { app.notice = model.mutationError(error) }
                        }
                    }
                    deleting = nil
                }
                Button(L("actions.cancel"), role: .cancel) { deleting = nil }
            } message: {
                Text(L("actions.delete_body"))
            }
        }
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

    func older(_ proxy: ScrollViewProxy) {
        let anchor = model.messages.first?.id
        Task {
            if await model.loadOlder(), let anchor {
                proxy.scrollTo(anchor, anchor: .top)
            }
        }
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
                            Text(Formatting.time(message.ts)).font(.vibe(11, .semibold)).foregroundStyle(Vibe.faint)
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
        }
        .sheet(item: Binding(get: { viewing.map(Viewing.init) }, set: { viewing = $0?.image })) { v in
            ImageViewer(path: v.image.source, title: v.image.title)
        }
    }

    @ViewBuilder var gutter: some View {
        if message.showHeader {
            Avatar(path: message.avatar, name: message.author, size: 34)
        } else {
            Text(message.gutterTime ? Formatting.time(message.ts) : "")
                .font(.vibe(10, .semibold))
                .foregroundStyle(Vibe.faint)
                .frame(width: 34)
        }
    }

    @ViewBuilder var content: some View {
        if let system = message.system {
            if let callId = message.callId {
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
            LinkCard(card: card)
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
                    Button("💬 " + L("message.replies", count: Int(message.threadCount))) { app.openThread(message.id) }
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
                Button(L("actions.save"), action: save).keyboardShortcut(.defaultAction)
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
            Menu("😀") {
                ForEach(model?.quickReactions ?? [], id: \.self) { code in
                    Button(replaceShortcodes(text: code)) {
                        Task { await model?.react(message, shortcode: code, add: !(model?.quickReactionIsMine(message, shortcode: code) ?? false)) }
                    }
                }
            }
        }
        ForEach(actions.filter { $0 != .react }, id: \.self) { action in
            Button(title(action), role: action == .delete ? .destructive : nil) { run(action) }
        }
        if message.delivery == .sent, model?.membershipIsCurrent == true,
           let link = app.native?.permalink(room: message.rid, message: message.id, root: message.threadId) {
            Button(L("actions.copy_link")) {
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString(link, forType: .string)
            }
        }
        if message.delivery == .failed, model?.canAbandon == true {
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
        .sheet(item: Binding(get: { playing.map(Playing.init) }, set: { playing = $0?.url })) { p in
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
        .sheet(isPresented:$viewing){ImageViewer(path:card.url,title:card.title)}
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
        .alert(
            L("call.info"),
            isPresented: Binding(get: { link != nil }, set: { if !$0 { link = nil } }),
            presenting: link
        ) { link in
            Button(L("call.copy_link")) {
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString(link, forType: .string)
            }
            Button(L("call.open_browser")) {
                if let url = URL(string: link) { openURL(url) }
            }
            Button(L("call.close"), role: .cancel) {}
        } message: { link in
            Text(link)
        }
        .padding(10)
        .vibeCard()
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
                    Text(L("upload.waiting")).font(.caption).foregroundStyle(.secondary)
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 4)
        }
    }
}
