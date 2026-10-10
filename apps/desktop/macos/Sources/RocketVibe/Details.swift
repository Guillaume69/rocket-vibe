import AppKit
import RocketVibeCore
import RocketVibeKit
import SwiftUI

/// What the room header opens.
enum Panel: Identifiable, Equatable {
    case info
    case search
    case marked
    case threads
    case profile(String)
    case profileId(String)

    var id: String {
        switch self {
        case .info: return "info"
        case .search: return "search"
        case .marked: return "marked"
        case .threads: return "threads"
        case let .profile(username): return "profile:\(username)"
        case let .profileId(uid): return "profile-id:\(uid)"
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
        case .threads: ThreadsView(model: model)
        case let .profile(username): ProfileView(username: username)
        case let .profileId(uid): ProfileView(username: uid, byId: true)
        }
    }
}

struct SheetFrame<Content: View>: View {
    @Environment(\.closeModal) var dismiss
    let title: String
    @ViewBuilder let content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text(title).font(.headline)
                Spacer()
                Button { dismiss() } label: { Image(systemName: "xmark") }
                    .buttonStyle(.borderless)
            }
            .padding(14)
            Divider()
            content
        }
        .frame(minWidth: 420, idealWidth: 460, minHeight: 320, idealHeight: 520)
    }
}

struct RoomInfoView: View {
    @Environment(\.closeModal) var dismiss
    @Environment(AppModel.self) var app
    let model: RoomModel
    @State var details: RoomDetails?
    @State var management: NativeRoomManagement?
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
                if model.supportsRoomManagement { NativeRoomControls(model: model, details: management, refreshed: { fresh in management = fresh; details = fresh.info }) }
            if app.native?.cryptoSettingsSupported() == true { CryptoRoomSection(room: model.room.rid) }
            }
            .formStyle(.grouped)
        }
        .task(id: "\(model.roomInformationRevision):\(app.connection)") {
            guard model.supportsRoomInfo else { dismiss(); return }
            details = nil; management = nil; failed = false
            do {
                if model.supportsRoomManagement {
                    let fresh = try await model.roomManagement()
                    if !Task.isCancelled { management = fresh; details = fresh.info }
                } else {
                    let fresh = try await model.roomDetails()
                    if !Task.isCancelled { details = fresh }
                }
            } catch { if !Task.isCancelled { failed = true } }
        }
    }

    func flags(_ d: RoomDetails) -> String {
        var out = [d.kind == "d" ? L("native.direct") : d.kind == "c" ? L("info.public") : L("info.private")]
        if d.readOnly { out.append(L("info.read_only")) }
        if d.encrypted { out.append(L("info.encrypted")) }
        if d.archived { out.append(L("info.archived")) }
        if d.default { out.append(L("info.default")) }
        return out.joined(separator: " · ")
    }
}

struct ProfileView: View {
    @Environment(AppModel.self) var app
    @Environment(\.closeModal) var dismiss
    @Environment(\.openURL) var openURL
    let username: String
    var byId = false
    @State var person: Person?
    @State var failed = false
    @State var shownAccount:UUID?

    var body: some View {
        SheetFrame(title: L("info.profile")) {
            Form {
                if let p = person,shownAccount==app.sessionId,app.provider?.supportsProfiles==true {
                    // A RocketVibe account an administrator deleted: its name only.
                    let deleted = app.deletedAccount(username: p.username)
                    HStack(spacing: 12) {
                        ZStack(alignment: .bottomTrailing) {
                            Avatar(path: p.avatar, name: deleted ? L("user.deleted") : p.name ?? p.username, size: 56)
                            if let presence = p.presence, !deleted { PresenceDot(presence: presence) }
                        }
                        VStack(alignment: .leading) {
                            Text(deleted ? L("user.deleted") : p.name ?? p.username).font(.title3.bold())
                            if !deleted { Text("@\(p.username)").foregroundStyle(.secondary) }
                            if p.bot {
                                HStack(spacing: 6) {
                                    AdminBadge(text: L("bots.badge"), color: Vibe.sky)
                                    if let owner = p.botOwner { Text(L("bots.owner", ["owner": owner])).foregroundStyle(.secondary) }
                                }
                            }
                            if let status = p.statusText, !status.isEmpty { Text(status).italic() }
                        }
                    }
                    if !p.roles.isEmpty { LabeledContent(L("info.roles"), value: p.roles.joined(separator: ", ")) }
                    if let time = p.localTime { LabeledContent(L("info.local_time"), value: time) }
                    if let bio = p.bio, !bio.isEmpty { LabeledContent(L("info.bio"), value: bio) }
                    // A bot never has a crypto device: no identity to compare.
                    if app.native?.cryptoSettingsSupported() == true && !p.bot { PeerIdentitySection(user: p.id) }
                    if p.id != app.account?.userId && !deleted {
                        HStack {
                            Button(L("info.message")) {
                                dismiss()
                                Task { await app.go(to: .user(id: p.id, username: p.username, name: p.name)) }
                            }
                            if app.provider?.supportsCalls == true {Button(L("info.call")) {
                                dismiss()
                                Task { await call(p) }
                            }}
                        }
                        if app.reportsSupported {
                            Button(L("report.user")) {
                                dismiss()
                                app.startReport(.user(p.id))
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
        .task(id:"\(app.sessionId)#\(app.imagesVersion)#\(app.native?.profileVersion() ?? username)") {
            guard let provider=app.provider,provider.supportsProfiles else { return }
            let account=app.sessionId
            do {
                let previous=shownAccount==account ? person : nil
                let loaded=try await provider.person(key:previous?.id ?? username,byId:previous != nil || byId)
                guard app.sessionId==account,!Task.isCancelled else{return}
                person=loaded;shownAccount=account;failed=false
            } catch {if app.sessionId==account,!Task.isCancelled{person=nil;failed=true}}
        }
    }

    func call(_ p: Person) async {
        guard let provider = app.provider else { return }
        let expected = app.sessionId
        let link = try? await provider.startPersonCall(username:p.username,userId:p.id)
        guard expected == app.sessionId, !Task.isCancelled else { return }
        if let link, let url = URL(string: link) {
            CallWindow.show(url, title: L("call.window_title", ["room": p.username]))
        } else {
            app.notice = L("call.failed")
        }
    }
}

struct SearchView: View {
    @Environment(AppModel.self) var app
    @Environment(\.closeModal) var dismiss
    let model: RoomModel
    @State var query = ""
    @State var hits: [SearchHit] = []
    @State var failed = false
    @State var searched = false
    @State var hitsVersion = ""
    @State var requestRevision = 0

    var body: some View {
        SheetFrame(title: L("search.title")) {
            VStack(spacing: 0) {
                TextField(L("search.placeholder"), text: $query)
                    .firstModalField()
                    .onSubmit {requestRevision &+= 1}
                    .textFieldStyle(.roundedBorder)
                    .padding(12)
                List(hitsVersion == model.searchVersion ? hits : [], id: \.id) { hit in
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
                    else if searched && hitsVersion != model.searchVersion {Text(L("search.changed")).foregroundStyle(.secondary)}
                    else if searched && hits.isEmpty { Text(L("search.none")).foregroundStyle(.secondary) }
                }
            }
        }
        .task(id: "\(model.searchContext):\(query):\(requestRevision)") {
            let q = query.trimmingCharacters(in: .whitespaces)
            guard !q.isEmpty, model.supportsSearch else {
                hits = []
                searched = false
                return
            }
            try? await Task.sleep(nanoseconds: 300_000_000)
            guard !Task.isCancelled else { return }
            do {
                let version=model.searchVersion
                let found = try await model.search(text:q)
                guard !Task.isCancelled,query.trimmingCharacters(in:.whitespaces)==q,model.searchVersion==version else {return}
                hits = found
                hitsVersion=version
                failed = false
            } catch {
                guard !Task.isCancelled else {return}
                hits=[]
                failed = true
            }
            searched = true
        }
        .onChange(of:app.connection) { _,state in if app.native != nil && state != .online {hits=[]} }
    }
}

struct MarkedView: View {
    @Environment(AppModel.self) var app
    @Environment(\.closeModal) var dismiss
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
                                    MessageRow(
                                        message: message, model: model, editing: editing == message.id, revealed: false,
                                        setEditing: { editing = $0 }, askDelete: { deleting = $0 }
                                    )
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
            messages = (try? await model.marked(starred: starred)) ?? []
        }
    }
}

/// The room's threads (Rocket.Chat), every one or those I follow, by pages
/// of 50, the most recently answered first. The bell follows or unfollows
/// one; a click opens it beside the room.
struct ThreadsView: View {
    @Environment(AppModel.self) var app
    @Environment(\.closeModal) var dismiss
    let model: RoomModel
    @State var following = false
    @State var entries: [ThreadEntry]?
    @State var total = 0
    @State var failed = false
    @State var loadingMore = false
    @State var busy: Set<String> = []
    @State var editing: String?
    @State var deleting: MessageItem?

    var body: some View {
        SheetFrame(title: L("threads.title")) {
            VStack(spacing: 0) {
                Picker("", selection: $following) {
                    Text(L("threads.all")).tag(false)
                    Text(L("threads.following")).tag(true)
                }
                .pickerStyle(.segmented)
                .labelsHidden()
                .padding(12)
                if failed && entries == nil {
                    VStack(spacing: 10) {
                        Text(L("info.failed")).foregroundStyle(.secondary)
                        Button(L("native.retry")) { Task { await load(reset: true) } }
                    }
                    .frame(maxHeight: .infinity)
                } else if let entries {
                    if entries.isEmpty {
                        Text(L(following ? "threads.none_following" : "threads.none"))
                            .foregroundStyle(.secondary)
                            .frame(maxHeight: .infinity)
                    } else {
                        ScrollView {
                            LazyVStack(alignment: .leading, spacing: 0) {
                                ForEach(entries, id: \.root.id) { entry in row(entry) }
                                if entries.count < total {
                                    Button(L("threads.more")) { Task { await load(reset: false) } }
                                        .disabled(loadingMore)
                                        .frame(maxWidth: .infinity)
                                        .padding(12)
                                        .onAppear { Task { await load(reset: false) } }
                                }
                            }
                        }
                    }
                } else {
                    ProgressView().frame(maxHeight: .infinity)
                }
            }
        }
        .task(id: following) { await load(reset: true) }
    }

    @ViewBuilder func row(_ entry: ThreadEntry) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            MessageRow(
                message: entry.root, model: model, editing: editing == entry.root.id, revealed: false,
                setEditing: { editing = $0 }, askDelete: { deleting = $0 }
            )
            HStack {
                if let last = entry.lastReply {
                    Text(L("threads.summary", [
                        "replies": model.repliesTitle(entry.root.threadCount),
                        "time": Formatting.shortTime(last),
                    ]))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                }
                Spacer()
                Button { Task { await toggle(entry) } } label: {
                    Image(systemName: entry.following ? "bell.fill" : "bell.slash")
                }
                .buttonStyle(.borderless)
                .help(L(entry.following ? "thread.unfollow" : "thread.follow"))
                .disabled(busy.contains(entry.root.id))
            }
            .padding(.horizontal, 14)
            .padding(.bottom, 8)
        }
        .contentShape(Rectangle())
        .onTapGesture {
            dismiss()
            app.openThread(entry.root.id)
        }
    }

    /// The first page (`reset`, also on a tab switch), or the next one.
    func load(reset: Bool) async {
        if !reset && (loadingMore || entries == nil) { return }
        if reset { entries = nil; failed = false; total = 0 }
        loadingMore = true
        defer { loadingMore = false }
        let asked = following
        do {
            let page = try await model.threads(following: asked, offset: reset ? 0 : entries?.count ?? 0)
            guard asked == following else { return }
            let known = Set((entries ?? []).map { $0.root.id })
            let shown = (entries ?? []) + page.threads.filter { !known.contains($0.root.id) }
            entries = shown
            total = page.threads.isEmpty ? shown.count : Int(page.total)
        } catch {
            guard asked == following else { return }
            failed = true
            if entries != nil { app.notice = L("info.failed") }
        }
    }

    func toggle(_ entry: ThreadEntry) async {
        let (root, on) = (entry.root.id, !entry.following)
        busy.insert(root)
        defer { busy.remove(root) }
        do {
            try await model.followThread(root, on)
            if let i = entries?.firstIndex(where: { $0.root.id == root }) { entries?[i].following = on }
            app.notice = L(on ? "thread.followed" : "thread.unfollowed")
        } catch {
            app.notice = L("thread.follow_failed")
        }
    }
}

/// The picker's pages, then search by shortcode. Without `custom` (a
/// reaction in a private conversation), no server emoji; with `pickable`
/// (a reaction on Rocket.Chat), only the standard emoji it accepts.
struct EmojiPicker: View {
    @Environment(AppModel.self) var app
    let pick: (String, String) -> Void
    var custom = true
    var pickable: ((String) -> Bool)? = nil
    @State var category = 0
    @State var query = ""
    let categories = emojiCategories()
    var customs:[String]{_ = app.imagesVersion;guard custom else {return []};return app.chat?.customEmojiNames() ?? app.native?.customEmojiNames() ?? []}

    var shown: [(String, String)] {
        if query.isEmpty {
            if category==categories.count{return customs.map{(":\($0):", ":\($0):")}}
            let c = categories[category]
            return Array(zip(c.shortcodes, c.glyphs)).filter { pickable?($0.0) ?? true }
        }
        return customs.filter{$0.hasPrefix(query.lowercased())}.map{(":\($0):", ":\($0):")}
            + completeEmoji(prefix: query, limit: 180).filter { pickable?($0.shortcode) ?? true }.map { (":\($0.shortcode):", $0.glyph) }
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
                    if !customs.isEmpty{Text("⭐").tag(categories.count)}
                }
                .pickerStyle(.segmented)
                .labelsHidden()
            }
            ScrollView {
                LazyVGrid(columns: Array(repeating: GridItem(.fixed(30), spacing: 4), count: 9), spacing: 4) {
                    ForEach(shown, id: \.0) { code, glyph in
                        Button { pick(code, glyph) } label: {
                            if let path=app.media?.customEmoji(code){RemoteImage(path:path,width:22,height:22)}
                            else{Text(glyph).font(.system(size: 22))}
                        }
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
