import RocketVibeCore
import RocketVibeKit
import SwiftUI

struct ChatView: View {
    @Environment(AppModel.self) var app

    var body: some View {
        NavigationSplitView {
            RoomListView()
                .navigationSplitViewColumnWidth(min: 220, ideal: 280, max: 400)
        } detail: {
            if let room = app.room {
                RoomView(model: room)
                    .id(room.rid)
                    .inspector(isPresented: Binding(get: { app.thread != nil }, set: { if !$0 { app.closeThread() } })) {
                        if let thread = app.thread {
                            ThreadView(model: thread)
                                .inspectorColumnWidth(min: 300, ideal: 380, max: 600)
                        }
                    }
            } else {
                VStack(spacing: 8) {
                    Text(L("room.pick")).font(.title3)
                    Text(L("room.synced")).foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .navigationTitle(app.room?.room.name ?? "rocket-vibe")
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
        .overlay(alignment: .bottom) { NoticeView() }
    }
}

/// The window's toast.
struct NoticeView: View {
    @Environment(AppModel.self) var app

    var body: some View {
        if let notice = app.notice {
            Text(notice)
                .padding(.horizontal, 14)
                .padding(.vertical, 8)
                .background(.regularMaterial, in: Capsule())
                .padding(.bottom, 24)
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

    var body: some View {
        let selection = Binding<String?>(get: { app.room?.rid }, set: { if let rid = $0 { app.open(rid) } })
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
                let titled = app.groups.count > 1
                ForEach(app.groups, id: \.section) { group in
                    if titled {
                        Section(isExpanded: Binding(get: { !app.collapsed.contains(group.section) },
                                                    set: { _ in app.toggle(group.section) })) {
                            rows(group.rooms)
                        } header: {
                            Text("\(title(group.section)) · \(group.rooms.count)")
                        }
                    } else {
                        rows(group.rooms)
                    }
                }
            }
        }
        .listStyle(.sidebar)
        .searchable(text: $query, placement: .sidebar, prompt: L("spotlight.placeholder"))
        .task(id: query) { await search() }
        .safeAreaInset(edge: .bottom) { AccountBar() }
    }

    func rows(_ rooms: [Room]) -> some View {
        ForEach(rooms, id: \.rid) { room in
            RoomRow(room: room).tag(room.rid)
        }
    }

    func title(_ section: RoomSection) -> String {
        switch section {
        case .unread: return L("rooms.section_unread")
        case .channels: return L("rooms.section_channels")
        case .direct: return L("rooms.section_direct")
        }
    }

    func search() async {
        let q = query.trimmingCharacters(in: .whitespaces)
        guard !q.isEmpty, let chat = app.chat else {
            found = []
            return
        }
        try? await Task.sleep(nanoseconds: 250_000_000)
        guard !Task.isCancelled else { return }
        searching = true
        defer { searching = false }
        do {
            found = try await chat.spotlight(query: q)
        } catch {
            found = []
            app.notice = L("spotlight.failed")
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
        HStack(spacing: 10) {
            ZStack(alignment: .bottomTrailing) {
                if room.encrypted && room.avatar == nil {
                    Image(systemName: "lock.fill")
                        .frame(width: 34, height: 34)
                        .background(.quaternary, in: RoundedRectangle(cornerRadius: 8))
                } else {
                    Avatar(path: room.avatar, name: room.name, size: 34)
                }
                if let presence = room.presence {
                    PresenceDot(presence: presence)
                }
            }
            VStack(alignment: .leading, spacing: 2) {
                HStack {
                    Text(room.name)
                        .fontWeight(unread ? .semibold : .regular)
                        .lineLimit(1)
                    Spacer()
                    Text(Formatting.shortTime(room.lastTs))
                        .font(.caption)
                        .foregroundStyle(unread ? .primary : .secondary)
                }
                HStack {
                    Text(preview)
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                    Spacer()
                    if room.unread > 0 {
                        Text(room.mentions > 0 ? "@\(room.unread)" : "\(room.unread)")
                            .font(.caption2.weight(.bold))
                            .padding(.horizontal, 6)
                            .padding(.vertical, 2)
                            .background(Color.yellow, in: Capsule())
                            .foregroundStyle(.black)
                    }
                }
            }
        }
        .padding(.vertical, 3)
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
            .overlay(Circle().stroke(Color(nsColor: .windowBackgroundColor), lineWidth: 2))
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
        case .online: return .green
        case .away: return .orange
        case .busy: return .red
        case .offline: return .gray
        }
    }
}

/// Me, the connection, the way to settings.
struct AccountBar: View {
    @Environment(AppModel.self) var app
    @Environment(\.openSettings) var openSettings

    var body: some View {
        HStack(spacing: 8) {
            if let account = app.account {
                Avatar(path: app.media?.avatar(user: account.username), name: account.username, size: 26)
                VStack(alignment: .leading, spacing: 0) {
                    Text(account.username).font(.callout.weight(.medium))
                    Text(URL(string: account.baseUrl)?.host() ?? account.baseUrl)
                        .font(.caption).foregroundStyle(.secondary)
                }
            }
            Spacer()
            Button { app.reconnect() } label: {
                Circle().fill(connectionColor).frame(width: 9, height: 9)
            }
            .buttonStyle(.plain)
            .help(connectionHelp)
            Button { openSettings() } label: { Image(systemName: "gearshape") }
                .buttonStyle(.borderless)
                .help(L("settings.title"))
        }
        .padding(10)
        .background(.bar)
    }

    var connectionColor: Color {
        switch app.connection {
        case .online: return .green
        case .connecting: return .orange
        case .offline: return .red
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
