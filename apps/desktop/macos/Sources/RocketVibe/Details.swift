import AppKit
import RocketVibeCore
import RocketVibeKit
import SwiftUI

/// What the room header opens.
enum Panel: Identifiable, Equatable {
    case info
    case search
    case marked
    case profile(String)

    var id: String {
        switch self {
        case .info: return "info"
        case .search: return "search"
        case .marked: return "marked"
        case let .profile(username): return "profile:\(username)"
        }
    }
}

struct PanelView: View {
    let panel: Panel
    let model: RoomModel

    var body: some View {
        switch panel {
        case .info: RoomInfoView(model: model)
        case .search: SearchView(model: model)
        case .marked: MarkedView(model: model)
        case let .profile(username): ProfileView(username: username)
        }
    }
}

struct SheetFrame<Content: View>: View {
    @Environment(\.dismiss) var dismiss
    let title: String
    @ViewBuilder let content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text(title).font(.headline)
                Spacer()
                Button { dismiss() } label: { Image(systemName: "xmark") }
                    .buttonStyle(.borderless)
                    .keyboardShortcut(.cancelAction)
            }
            .padding(14)
            Divider()
            content
        }
        .frame(minWidth: 420, idealWidth: 460, minHeight: 320, idealHeight: 520)
    }
}

struct RoomInfoView: View {
    @Environment(AppModel.self) var app
    let model: RoomModel
    @State var details: RoomDetails?
    @State var failed = false

    var body: some View {
        SheetFrame(title: L("info.room")) {
            Form {
                if let d = details {
                    HStack(spacing: 12) {
                        Avatar(path: model.room.avatar, name: d.name, size: 48)
                        VStack(alignment: .leading) {
                            Text(d.name).font(.title3.bold())
                            Text(flags(d)).foregroundStyle(.secondary)
                        }
                    }
                    if let members = d.members { LabeledContent(L("info.members"), value: String(members)) }
                    if let topic = d.topic, !topic.isEmpty { LabeledContent(L("info.topic"), value: topic) }
                    if let a = d.announcement, !a.isEmpty { LabeledContent(L("info.announcement"), value: a) }
                    if let desc = d.description, !desc.isEmpty { LabeledContent(L("info.description"), value: desc) }
                    if (d.topic ?? "").isEmpty && (d.announcement ?? "").isEmpty && (d.description ?? "").isEmpty {
                        Text(L("info.nothing")).foregroundStyle(.secondary)
                    }
                } else if failed {
                    Text(L("info.failed")).foregroundStyle(.secondary)
                } else {
                    ProgressView()
                }
            }
            .formStyle(.grouped)
        }
        .task {
            guard let chat = app.chat else { return }
            do { details = try await chat.roomDetails(rid: model.rid) } catch { failed = true }
        }
    }

    func flags(_ d: RoomDetails) -> String {
        var out = [d.kind == "c" ? L("info.public") : L("info.private")]
        if d.readOnly { out.append(L("info.read_only")) }
        if d.encrypted { out.append(L("info.encrypted")) }
        if d.archived { out.append(L("info.archived")) }
        if d.default { out.append(L("info.default")) }
        return out.joined(separator: " · ")
    }
}

struct ProfileView: View {
    @Environment(AppModel.self) var app
    @Environment(\.dismiss) var dismiss
    @Environment(\.openURL) var openURL
    let username: String
    @State var person: Person?
    @State var failed = false

    var body: some View {
        SheetFrame(title: L("info.profile")) {
            Form {
                if let p = person {
                    HStack(spacing: 12) {
                        ZStack(alignment: .bottomTrailing) {
                            Avatar(path: p.avatar, name: p.name ?? p.username, size: 56)
                            if let presence = p.presence { PresenceDot(presence: presence) }
                        }
                        VStack(alignment: .leading) {
                            Text(p.name ?? p.username).font(.title3.bold())
                            Text("@\(p.username)").foregroundStyle(.secondary)
                            if let status = p.statusText, !status.isEmpty { Text(status).italic() }
                        }
                    }
                    if !p.roles.isEmpty { LabeledContent(L("info.roles"), value: p.roles.joined(separator: ", ")) }
                    if let time = p.localTime { LabeledContent(L("info.local_time"), value: time) }
                    if let bio = p.bio, !bio.isEmpty { LabeledContent(L("info.bio"), value: bio) }
                    if p.username != app.account?.username {
                        HStack {
                            Button(L("info.message")) {
                                dismiss()
                                Task { await app.go(to: .user(id: p.id, username: p.username, name: p.name)) }
                            }
                            Button(L("info.call")) {
                                dismiss()
                                Task { await call(p) }
                            }
                        }
                    }
                } else if failed {
                    Text(L("info.failed")).foregroundStyle(.secondary)
                } else {
                    ProgressView()
                }
            }
            .formStyle(.grouped)
        }
        .task {
            guard let chat = app.chat else { return }
            do { person = try await chat.person(key: username, byId: false) } catch { failed = true }
        }
    }

    func call(_ p: Person) async {
        guard let chat = app.chat, let rid = try? await chat.openDm(username: p.username) else {
            app.notice = L("call.failed")
            return
        }
        if let link = try? await chat.startCall(rid: rid), let url = URL(string: link) {
            CallWindow.show(url, title: L("call.window_title", ["room": p.username]))
        } else {
            app.notice = L("call.failed")
        }
    }
}

struct SearchView: View {
    @Environment(AppModel.self) var app
    @Environment(\.dismiss) var dismiss
    let model: RoomModel
    @State var query = ""
    @State var hits: [SearchHit] = []
    @State var failed = false
    @State var searched = false

    var body: some View {
        SheetFrame(title: L("search.title")) {
            VStack(spacing: 0) {
                TextField(L("search.placeholder"), text: $query)
                    .textFieldStyle(.roundedBorder)
                    .padding(12)
                List(hits, id: \.id) { hit in
                    VStack(alignment: .leading, spacing: 3) {
                        HStack {
                            Text(hit.author).fontWeight(.semibold)
                            Text("\(Formatting.day(hit.ts)) \(Formatting.time(hit.ts))").font(.caption).foregroundStyle(.secondary)
                        }
                        BodyView(blocks: hit.body)
                    }
                    .contentShape(Rectangle())
                    .onTapGesture {
                        dismiss()
                        Task { if !(await model.jump(to: hit.id)) { app.notice = L("marked.not_loaded") } }
                    }
                }
                .overlay {
                    if failed { Text(L("search.failed")).foregroundStyle(.secondary) }
                    else if searched && hits.isEmpty { Text(L("search.none")).foregroundStyle(.secondary) }
                }
            }
        }
        .task(id: query) {
            let q = query.trimmingCharacters(in: .whitespaces)
            guard !q.isEmpty, let chat = app.chat else {
                hits = []
                searched = false
                return
            }
            try? await Task.sleep(nanoseconds: 300_000_000)
            guard !Task.isCancelled else { return }
            do {
                hits = try await chat.search(rid: model.rid, text: q)
                failed = false
            } catch {
                failed = true
            }
            searched = true
        }
    }
}

struct MarkedView: View {
    @Environment(AppModel.self) var app
    @Environment(\.dismiss) var dismiss
    let model: RoomModel
    @State var starred = false
    @State var messages: [MessageItem]?
    @State var editing: String?
    @State var deleting: MessageItem?

    var body: some View {
        SheetFrame(title: L("marked.title")) {
            VStack(spacing: 0) {
                Picker("", selection: $starred) {
                    Text(L("marked.pinned")).tag(false)
                    Text(L("marked.starred")).tag(true)
                }
                .pickerStyle(.segmented)
                .labelsHidden()
                .padding(12)
                if let messages {
                    if messages.isEmpty {
                        Text(L(starred ? "marked.no_starred" : "marked.no_pinned"))
                            .foregroundStyle(.secondary)
                            .frame(maxHeight: .infinity)
                    } else {
                        ScrollView {
                            LazyVStack(alignment: .leading, spacing: 0) {
                                ForEach(messages, id: \.id) { message in
                                    MessageRow(message: message, model: model, editing: $editing, deleting: $deleting)
                                        .contentShape(Rectangle())
                                        .onTapGesture {
                                            dismiss()
                                            Task { if !(await model.jump(to: message.id)) { app.notice = L("marked.not_loaded") } }
                                        }
                                }
                            }
                        }
                    }
                } else {
                    ProgressView().frame(maxHeight: .infinity)
                }
            }
        }
        .task(id: starred) {
            messages = nil
            messages = (try? await app.chat?.marked(rid: model.rid, starred: starred)) ?? []
        }
    }
}

/// The picker's pages, then search by shortcode.
struct EmojiPicker: View {
    let pick: (String, String) -> Void
    @State var category = 0
    @State var query = ""
    let categories = emojiCategories()

    var shown: [(String, String)] {
        if query.isEmpty {
            let c = categories[category]
            return Array(zip(c.shortcodes, c.glyphs))
        }
        return completeEmoji(prefix: query, limit: 180).map { (":\($0.shortcode):", $0.glyph) }
    }

    var body: some View {
        VStack(spacing: 8) {
            TextField(L("spotlight.placeholder"), text: $query)
                .textFieldStyle(.roundedBorder)
            if query.isEmpty {
                Picker("", selection: $category) {
                    ForEach(Array(categories.enumerated()), id: \.offset) { i, c in
                        Text(c.glyphs.first ?? c.name).tag(i)
                    }
                }
                .pickerStyle(.segmented)
                .labelsHidden()
            }
            ScrollView {
                LazyVGrid(columns: Array(repeating: GridItem(.fixed(30), spacing: 4), count: 9), spacing: 4) {
                    ForEach(shown, id: \.0) { code, glyph in
                        Button { pick(code, glyph) } label: { Text(glyph).font(.system(size: 22)) }
                            .buttonStyle(.plain)
                            .help(code)
                    }
                }
            }
            .frame(height: 240)
        }
        .padding(10)
        .frame(width: 330)
    }
}
