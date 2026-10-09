import AppKit
import RocketVibeCore
import RocketVibeKit
import SwiftUI

struct ChatView: View {
    @Environment(AppModel.self) var app

    /// "(unread rooms) room - rocket-vibe", as the GTK app titles its window.
    var title: String {
        let name = app.room.map { "\($0.room.name) - rocket-vibe" } ?? "rocket-vibe"
        return app.unreadRooms == 0 ? name : "(\(app.unreadRooms)) \(name)"
    }

    var body: some View {
        HStack(spacing: 0) {
            if !app.railHidden { ServerRail() }
            split
        }
        // Settings > Accounts lists these accounts: they stay fresh with the rail hidden.
        .task(id: app.account?.key) {
            await app.refreshAccounts()
            while !Task.isCancelled {
                await app.pollAccounts()
                try? await Task.sleep(nanoseconds: 60_000_000_000)
            }
        }
    }

    var split: some View {
        NavigationSplitView {
            RoomListView()
                .navigationSplitViewColumnWidth(min: 220, ideal: 280, max: 400)
        } detail: {
            ZStack {
                if let room = app.room, let voice = app.voice, voice.shown == room.rid {
                    VoicePage(voice: voice, room: room.room)
                        .transition(.opacity)
                } else if let room = app.room {
                    RoomView(model: room)
                        .id(ObjectIdentifier(room))
                        .transition(.opacity.combined(with: .offset(y: 8)))
                        .inspector(isPresented: Binding(get: { app.thread != nil }, set: { if !$0 { app.closeThread() } })) {
                            if let thread = app.thread {
                                ThreadView(model: thread)
                                    .inspectorColumnWidth(min: 300, ideal: 380, max: 600)
                            }
                        }
                } else {
                    VStack(spacing: 10) {
                        Sparkle().fill(Vibe.brand).frame(width: 34, height: 34)
                        Text(L("room.pick")).font(.vibeTitle(22, .bold))
                        Text(L("room.synced")).foregroundStyle(Vibe.muted)
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            }
            .animation(.snappy(duration: 0.22), value: app.room?.rid)
            .animation(.snappy(duration: 0.22), value: app.voice?.shown)
            .background(Vibe.night)
        }
        .modifier(IncomingCall())
        .navigationTitle(title)
        .toolbarBackground(Vibe.night, for: .windowToolbar)
        .toolbar {
            ToolbarItemGroup(placement: .navigation) {
                Button { app.goBack() } label: { Image(systemName: "chevron.left") }
                    .disabled(!app.canGoBack)
                    .help(L("nav.back"))
                Button { app.goForward() } label: { Image(systemName: "chevron.right") }
                    .disabled(!app.canGoForward)
                    .help(L("nav.forward"))
            }
        }
        .overlay(alignment: .bottom) { NoticeView().animation(Vibe.spring, value: app.notice) }
    }
}

/// The server rail: a button per signed-in account down the window's left
/// edge, the open one outlined, a dot on another one with unread messages, and
/// "+" to add an account. The others are checked every minute (by `ChatView`,
/// which keeps polling when Settings > Accounts hides the rail).
struct ServerRail: View {
    @Environment(AppModel.self) var app

    /// What the rail shows of a server: its host, without `www.`.
    static func host(_ account: Account) -> String {
        let host = URL(string: account.baseUrl)?.host() ?? account.baseUrl
        return host.hasPrefix("www.") ? String(host.dropFirst(4)) : host
    }

    var body: some View {
        VStack(spacing: 10) {
            ForEach(app.accounts, id: \.key) { account in
                let open = account.key == app.account?.key
                let host = Self.host(account)
                // The open account's tile offers its server administration to
                // an administrator; another one has no menu (a click switches).
                if open && app.administrator {
                    tile(account, open: open, host: host)
                        .contextMenu { Button(L("admin.title")) { app.openAdmin() } }
                } else {
                    tile(account, open: open, host: host)
                }
            }
            Button { app.showLogin(error: nil) } label: {
                Image(systemName: "plus").font(.system(size: 18, weight: .bold)).foregroundStyle(Vibe.mint)
                    .frame(width: 44, height: 44)
                    .background(Vibe.card, in: RoundedRectangle(cornerRadius: 15))
            }
            .buttonStyle(.plain)
            .help(L("rail.add"))
            Spacer()
        }
        .padding(.vertical, 12)
        .padding(.horizontal, 10)
        .frame(maxHeight: .infinity)
        .background(Vibe.ink)
    }

    func tile(_ account: Account, open: Bool, host: String) -> some View {
        Button { Task { await app.switchAccount(account) } } label: {
            Group {
                // The server's own icon when it has one, else its initial.
                if let data = app.serverIcons[account.key], let image = NSImage(data: data) {
                    Image(nsImage: image).resizable().scaledToFill()
                } else {
                    Text(host.prefix(1).uppercased())
                        .font(.vibeTitle(17, .bold))
                        .foregroundStyle(Vibe.ink)
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                        .background(LinearGradient(colors: Vibe.tile(for: account.key), startPoint: .topLeading, endPoint: .bottomTrailing))
                }
            }
                .frame(width: 44, height: 44)
                .clipShape(RoundedRectangle(cornerRadius: 15))
                .overlay(RoundedRectangle(cornerRadius: 15).strokeBorder(open ? Vibe.pink : .clear, lineWidth: 2))
                .overlay(alignment: .topTrailing) {
                    if !open && app.unreadAccounts.contains(account.key) {
                        Circle().fill(Vibe.sun).frame(width: 12, height: 12)
                            .overlay(Circle().strokeBorder(Vibe.ink, lineWidth: 2))
                            .offset(x: 3, y: -3)
                    }
                }
        }
        .buttonStyle(.plain)
        .help("\(host) · @\(account.username)")
    }
}

/// The window's toast.
struct NoticeView: View {
    @Environment(AppModel.self) var app

    var body: some View {
        if let notice = app.notice {
            HStack(spacing: 8) {
                Sparkle().fill(Vibe.pink).frame(width: 10, height: 10)
                Text(notice).font(.vibe(13.5, .bold))
            }
                .padding(.horizontal, 16)
                .padding(.vertical, 9)
                .background(Vibe.raised, in: Capsule())
                .overlay(Capsule().strokeBorder(Vibe.pink.opacity(0.45)))
                .shadow(color: .black.opacity(0.5), radius: 12, y: 6)
                .padding(.bottom, 24)
                .transition(.move(edge: .bottom).combined(with: .opacity))
                .task(id: notice) {
                    try? await Task.sleep(nanoseconds: 3_000_000_000)
                    if app.notice == notice { app.notice = nil }
                }
        }
    }
}

struct RoomListView: View {
    @Environment(AppModel.self) var app
    @State var query = ""
    @State var found: [Found] = []
    @State var searching = false
    @State var creating = false
    /// "New message" puts the cursor in the search, which finds people and channels.
    @FocusState var searchFocused: Bool

    var body: some View {
        let selection = Binding<String?>(get: { app.room?.rid }, set: { if let rid = $0 { app.select(rid) } })
        List(selection: selection) {
            if !query.isEmpty {
                Section {
                    if found.isEmpty {
                        Text(searching ? "…" : L("spotlight.none")).foregroundStyle(.secondary)
                    }
                    ForEach(Array(found.enumerated()), id: \.offset) { _, item in
                        FoundRow(found: item)
                            .contentShape(Rectangle())
                            .onTapGesture {
                                query = ""
                                Task { await app.go(to: item) }
                            }
                    }
                }
            } else {
                RoomSections(groups: app.groups, collapsed: app.collapsed, toggle: app.toggle, add: { section in
                    // Channels: create one where the server allows it, else find one.
                    if section == .channels && app.native != nil { creating = true } else { searchFocused = true }
                })
            }
        }
        .listStyle(.sidebar)
        .scrollContentBackground(.hidden)
        .background(Vibe.deep.opacity(0.78))
        .searchable(text: $query, placement: .sidebar, prompt: L("spotlight.placeholder"))
        .searchFocused($searchFocused)
        .task(id: query) { await search() }
        .task(id: app.account?.key) { query = ""; found = []; creating = false }
        .modalOverlay(isPresented: $creating) { NewRoomSheet() }
        .safeAreaInset(edge: .top, spacing: 0) {
            VStack(alignment: .leading, spacing: 6) {
                HStack {
                    Wordmark(size: 21)
                    Spacer()
                    Menu {
                        Button { searchFocused = true } label: { Label(L("rooms.new_message"), systemImage: "square.and.pencil") }
                        if app.native != nil {
                            Button { creating = true } label: { Label(L("rooms.new_channel"), systemImage: "number") }
                        }
                    } label: {
                        Image(systemName: "plus")
                    }
                    .menuStyle(.borderlessButton)
                    .menuIndicator(.hidden)
                    .fixedSize()
                    .help(L("rooms.new"))
                }
                Comet(active: app.connection != .online)
            }
            .padding(.horizontal, 14)
            .padding(.top, 8)
            .padding(.bottom, 4)
        }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            VStack(spacing: 0) {
                if let voice = app.voice { VoicePanel(voice: voice) }
                AccountBar()
            }
        }
    }

    func search() async {
        let q = query.trimmingCharacters(in: .whitespaces)
        guard !q.isEmpty, let provider = app.provider else {
            found = []
            return
        }
        try? await Task.sleep(nanoseconds: 250_000_000)
        guard !Task.isCancelled else { return }
        searching = true
        defer { searching = false }
        let expected = app.account?.key
        do {
            let results = try await provider.spotlight(query: q)
            guard !Task.isCancelled, expected == app.account?.key else { return }
            found = results
        } catch {
            guard !Task.isCancelled, expected == app.account?.key else { return }
            found = []
            app.notice = L("spotlight.failed")
        }
    }
}

/// The room list's sections, folding when there is more than one: the
/// sidebar's, and the sample gallery's.
struct RoomSections: View {
    let groups: [RoomGroup]
    let collapsed: Set<String>
    let toggle: (String) -> Void
    /// The "+" of the Channels and Direct messages headers; none when absent.
    var add: ((RoomSection) -> Void)? = nil

    var body: some View {
        let titled = groups.count > 1
        ForEach(groups, id: \.key) { group in
            if titled {
                Section(isExpanded: Binding(get: { !collapsed.contains(group.key) }, set: { _ in toggle(group.key) })) {
                    rows(group.rooms)
                } header: {
                    HStack {
                        Text("\(title(group)) · \(group.rooms.count)")
                            .font(.vibe(11.5, .heavy))
                            .textCase(.uppercase)
                            .foregroundStyle(Vibe.muted)
                        Spacer()
                        if let add, group.section == .channels || group.section == .direct {
                            Button { add(group.section) } label: { Image(systemName: "plus") }
                                .buttonStyle(.borderless)
                                .help(L(group.section == .channels ? "rooms.new_channel" : "rooms.new_message"))
                        }
                    }
                }
            } else {
                rows(group.rooms)
            }
        }
    }

    func rows(_ rooms: [Room]) -> some View {
        ForEach(rooms, id: \.rid) { room in
            RoomRow(room: room).tag(room.rid)
        }
    }

    func title(_ group: RoomGroup) -> String {
        switch group.section {
        case .unread: return L("rooms.section_unread")
        case .favorites: return L("rooms.section_favorites")
        case .group: return group.title ?? ""

        case .channels: return L("rooms.section_channels")
        case .direct: return L("rooms.section_direct")
        }
    }
}

struct FoundRow: View {
    @Environment(AppModel.self) var app
    let found: Found

    var body: some View {
        switch found {
        case let .user(_, username, name):
            Label {
                VStack(alignment: .leading) {
                    Text(name ?? username)
                    Text("@\(username)").font(.caption).foregroundStyle(.secondary)
                }
            } icon: {
                Avatar(path: app.media?.avatar(user: username), name: name ?? username, size: 26)
            }
        case let .room(id, name, _):
            Label {
                HStack {
                    Text("#\(name)")
                    Spacer()
                    Text(L("spotlight.join")).font(.caption).foregroundStyle(.secondary)
                }
            } icon: {
                Avatar(path: "/avatar/room/\(id)", name: name, size: 26)
            }
        }
    }
}

struct RoomRow: View {
    @Environment(AppModel.self) var app
    let room: Room

    var unread: Bool { room.unread > 0 || room.alert }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            row
            // Who is in the room's voice session, under its row.
            if let voice = app.voice { VoiceOccupants(voice: voice, room: room.rid) }
        }
    }

    var row: some View {
        HStack(spacing: 10) {
            ZStack(alignment: .bottomTrailing) {
                if room.encrypted && room.avatar == nil {
                    Image(systemName: "lock.fill")
                        .foregroundStyle(Vibe.ink.opacity(0.8))
                        .frame(width: 36, height: 36)
                        .background(LinearGradient(colors: [Vibe.muted, Color(hex: 0x5A5573)], startPoint: .topLeading, endPoint: .bottomTrailing),
                                    in: RoundedRectangle(cornerRadius: 10))
                } else {
                    Avatar(path: room.avatar, name: room.name, size: 36)
                }
                if let presence = room.presence {
                    PresenceDot(presence: presence)
                }
            }
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 5) {
                    if room.voice {
                        Image(systemName: "speaker.wave.2.fill")
                            .font(.system(size: 11, weight: .bold))
                            .foregroundStyle(Vibe.mint)
                            .help(L("voice_session.channel"))
                    }
                    Text(room.name)
                        .font(.vibe(14.5, unread ? .heavy : .bold))
                        .foregroundStyle(unread ? Vibe.text : Vibe.soft)
                        .lineLimit(1)
                    Spacer()
                    Text(Formatting.shortTime(room.lastTs))
                        .font(.vibe(11, .semibold))
                        .foregroundStyle(unread ? Vibe.pinkSoft : Vibe.faint)
                }
                HStack {
                    Text(preview)
                        .font(.vibe(12.5))
                        .foregroundStyle(Vibe.muted)
                        .lineLimit(1)
                    Spacer()
                    if room.unread > 0 {
                        Text(room.mentions > 0 ? "@\(room.unread)" : "\(room.unread)")
                            .font(.vibe(11.5, .heavy))
                            .padding(.horizontal, 7)
                            .frame(minWidth: 22, minHeight: 20)
                            .background(room.mentions > 0 ? Vibe.pink : Vibe.sun, in: Capsule())
                            .foregroundStyle(Vibe.ink)
                            .contentTransition(.numericText())
                            .transition(.scale.combined(with: .opacity))
                    }
                }
            }
        }
        .padding(.vertical, 4)
        .animation(Vibe.spring, value: room.unread)
        .contextMenu {
            let accountKey=app.account?.key
            if let native=app.native, native.supportedFeatures().contains("favorites") {
                NativeFavoriteMenu(native:native,room:room,accountKey:accountKey)
            } else if let chat=app.chat {
                Button(L(room.favorite ? "rooms.favorite_remove" : "rooms.favorite_add")) {
                    Task {
                        guard accountKey == app.account?.key else {return}
                        do {try await chat.setFavorite(rid:room.rid,present:!room.favorite)}
                        catch {if accountKey == app.account?.key {app.notice=L("rooms.failed")}}
                    }
                }
            }
        }
    }

    var preview: String {
        switch room.preview {
        case .empty: return ""
        case let .text(text): return text
        case let .system(author, kind, param):
            return "\(author) \(systemMessage(kind: kind, param: param))".trimmingCharacters(in: .whitespaces)
        case .encrypted: return L("rooms.encrypted")
        }
    }
}

struct PresenceDot: View {
    let presence: Presence

    var body: some View {
        Circle()
            .fill(color)
            .frame(width: 10, height: 10)
            .overlay(Circle().stroke(Vibe.deep, lineWidth: 2))
            .help(L("presence.\(key)"))
    }

    var key: String {
        switch presence {
        case .online: return "online"
        case .away: return "away"
        case .busy: return "busy"
        case .offline: return "offline"
        }
    }

    var color: Color {
        switch presence {
        case .online: return Vibe.mint
        case .away: return Vibe.sun
        case .busy: return Vibe.pink
        case .offline: return Vibe.faint
        }
    }
}

/// Me and the connection; the block opens the account menu: settings, the
/// server administration for an administrator, sign out.
struct AccountBar: View {
    @Environment(AppModel.self) var app

    var body: some View {
        HStack(spacing: 8) {
            Menu {
                Button { app.openSettings() } label: { Label(L("settings.title"), systemImage: "gearshape") }
                if app.administrator {
                    Button { app.openAdmin() } label: { Label(L("admin.title"), systemImage: "server.rack") }
                }
                Divider()
                Button(role: .destructive) { Task { await app.signOut() } } label: {
                    Label(L("rooms.sign_out"), systemImage: "rectangle.portrait.and.arrow.right")
                }
            } label: {
                HStack(spacing: 8) {
                    if let account = app.account {
                        Avatar(path: app.media?.avatar(user: account.username), name: account.username, size: 26)
                        VStack(alignment: .leading, spacing: 0) {
                            Text(account.username).font(.vibe(13.5, .heavy))
                            Text(URL(string: account.baseUrl)?.host() ?? account.baseUrl)
                                .font(.vibe(11.5)).foregroundStyle(Vibe.muted)
                        }
                    }
                    Spacer()
                    Image(systemName: "gearshape").foregroundStyle(Vibe.muted)
                }
                .contentShape(Rectangle())
            }
            .menuStyle(.borderlessButton)
            .menuIndicator(.hidden)
            .help(L("rooms.account_menu"))
            Button { app.reconnect() } label: {
                Circle().fill(connectionColor).frame(width: 9, height: 9)
            }
            .buttonStyle(.plain)
            .help(connectionHelp)
        }
        .padding(10)
        .background(Vibe.deep.opacity(0.9))
        .overlay(alignment: .top) { Rectangle().fill(Vibe.line).frame(height: 1) }
    }

    var connectionColor: Color {
        switch app.connection {
        case .online: return Vibe.mint
        case .connecting: return Vibe.sun
        case .offline: return Vibe.pink
        }
    }

    var connectionHelp: String {
        switch app.connection {
        case .online: return L("rooms.online")
        case .connecting: return L("rooms.connecting")
        case .offline: return L("rooms.offline")
        }
    }
}
