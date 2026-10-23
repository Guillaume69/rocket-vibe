import RocketVibeCore
import RocketVibeKit
import SwiftUI

/// A channel's or group's members, in its information: "N members" opens
/// the list read from the server.
struct MembersSection: View {
    let model: RoomModel
    let details: RoomDetails?
    @State private var listing = false

    var body: some View {
        Section {
            Button {
                listing = true
            } label: {
                Label(details?.members.map { L("members.count", count: Int($0)) } ?? L("members.title"), systemImage: "person.2")
            }
        }
        .modalOverlay(isPresented: $listing, style: .sheet(width: 480, height: 620)) { MembersView(model: model) }
    }
}

/// The room's editor, offered with what its server lets me change
/// (`editableSettings`): Rocket.Chat the name, texts and read-only switch
/// `edit-room` grants, Mattermost, kChat, Slack and Teams a channel's name.
struct RoomSettingsSection: View {
    let model: RoomModel
    let details: RoomDetails?
    /// The room was saved: its information is read again.
    let saved: () -> Void
    @State private var editing = false
    @State private var editable: EditableSettings?

    var body: some View {
        Section {
            if editable != nil, details != nil {
                Button(L("room_settings.edit")) { editing = true }
            }
        }
        .task(id: model.rid) { editable = await model.editableSettings() }
        .modalOverlay(isPresented: $editing, style: .card) {
            if let details, let editable {
                RoomSettingsEditor(model: model, before: RoomSettings(details), editable: editable, saved: saved)
            }
        }
    }
}

extension RoomSettings {
    init(_ details: RoomDetails) {
        self.init(name: details.name, topic: details.topic ?? "", description: details.description ?? "",
                  announcement: details.announcement ?? "", readOnly: details.readOnly)
    }
}

/// The person a row opens.
private struct MemberProfile: Identifiable {
    let id: String
}

/// The members, owners and moderators first, searched by the server (a
/// pause after the last key), 50 more as the end shows. A row opens the
/// profile; its menu, or a right click, changes a role or removes the
/// person, as my roles allow. Not live: a change made here updates the row.
struct MembersView: View {
    @Environment(AppModel.self) var app
    let model: RoomModel
    @State private var query = ""
    @State private var list: MemberList?
    @State private var failed = false
    @State private var loadingMore = false
    @State private var busy = false
    @State private var rights = MemberRights(moderator: false, owner: false, remove: false)
    @State private var profile: MemberProfile?
    @State private var removing: RoomMember?
    @State private var refusal: String?

    var body: some View {
        SheetFrame(title: title) {
            VStack(spacing: 0) {
                TextField(L("members.search"), text: $query)
                    .textFieldStyle(.roundedBorder)
                    .firstModalField()
                    .padding(12)
                if let refusal { Text(L(refusal)).foregroundStyle(Vibe.pink).padding(.horizontal, 12) }
                if let list {
                    if list.members.isEmpty {
                        Text(L("members.none")).foregroundStyle(.secondary).padding()
                        Spacer()
                    } else {
                        List {
                            ForEach(list.members, id: \.id) { member in
                                row(member)
                                    .onAppear { if member.id == list.members.last?.id { Task { await more() } } }
                            }
                            if loadingMore { ProgressView().frame(maxWidth: .infinity) }
                        }
                        .disabled(busy)
                    }
                } else if failed {
                    Text(L("members.load_failed")).foregroundStyle(.secondary).padding()
                    Spacer()
                } else {
                    ProgressView().padding()
                    Spacer()
                }
            }
        }
        .task(id: query) { await reload() }
        .task(id: model.rid) { rights = await model.memberRights() }
        .modalOverlay(item: $profile) { ProfileView(username: $0.id) }
        .confirmOverlay(
            isPresented: Binding(get: { removing != nil }, set: { if !$0 { removing = nil } }),
            title: L("members.remove_title", ["name": removing.map(shownName) ?? ""]),
            message: L("members.remove_body"),
            actions: [ModalAction(title: L("members.remove"), role: .destructive) {
                if let member = removing { run(.remove, on: member) }
            }]
        )
    }

    var title: String {
        guard let list, query.trimmingCharacters(in: .whitespaces).isEmpty else { return L("members.title") }
        return L("members.count", count: Int(list.total))
    }

    func shownName(_ member: RoomMember) -> String { member.name ?? member.username }

    @ViewBuilder func row(_ member: RoomMember) -> some View {
        let actions = model.memberActions(rights, member)
        HStack(spacing: 10) {
            ZStack(alignment: .bottomTrailing) {
                Avatar(path: member.avatar, name: shownName(member), size: 32)
                if let presence = member.presence { PresenceDot(presence: presence) }
            }
            VStack(alignment: .leading, spacing: 1) {
                Text(shownName(member)).lineLimit(1)
                Text("@\(member.username)").font(.caption).foregroundStyle(.secondary).lineLimit(1)
            }
            Spacer()
            ForEach(member.roleKeys, id: \.self) { AdminBadge(text: L($0), color: Vibe.violet) }
            if !actions.isEmpty {
                Menu {
                    menu(actions, member)
                } label: {
                    Image(systemName: "ellipsis.circle")
                }
                .menuStyle(.button)
                .buttonStyle(.borderless)
                .fixedSize()
                .help(L("members.actions"))
            }
        }
        .contentShape(Rectangle())
        .onTapGesture { profile = MemberProfile(id: member.username) }
        .contextMenu { if !actions.isEmpty { menu(actions, member) } }
    }

    @ViewBuilder func menu(_ actions: [MemberAction], _ member: RoomMember) -> some View {
        ForEach(actions, id: \.self) { action in
            Button(L(memberActionKey(action: action)), role: action == .remove ? .destructive : nil) {
                if action == .remove { removing = member } else { run(action, on: member) }
            }
        }
    }

    /// The first page for the search, after a pause while typing.
    func reload() async {
        let filter = query.trimmingCharacters(in: .whitespaces)
        if !filter.isEmpty {
            try? await Task.sleep(for: .milliseconds(300))
            if Task.isCancelled { return }
        }
        failed = false
        list = nil
        do {
            let first = try await model.members(filter: filter, list: nil)
            if !Task.isCancelled { list = first }
        } catch {
            if !Task.isCancelled { failed = true }
        }
    }

    func more() async {
        guard let shown = list, shown.hasMore, !loadingMore else { return }
        let filter = query.trimmingCharacters(in: .whitespaces)
        loadingMore = true
        defer { loadingMore = false }
        // A search typed meanwhile replaced the list: this page is not its.
        if let next = try? await model.members(filter: filter, list: shown), list == shown {
            list = next
        }
    }

    func run(_ action: MemberAction, on member: RoomMember) {
        guard let shown = list, !busy else { return }
        busy = true
        refusal = nil
        Task {
            let result = await model.runMemberAction(action, on: member, in: shown)
            busy = false
            if let error = result.error { refusal = error } else if list == shown { list = result.list }
        }
    }
}

/// The name, texts and read-only switch the server lets me change; Save
/// sends only what changed, never an emptied name.
struct RoomSettingsEditor: View {
    @Environment(\.closeModal) var close
    let model: RoomModel
    let before: RoomSettings
    let editable: EditableSettings
    let saved: () -> Void
    @State private var draft: RoomSettings?
    @State private var saving = false
    @State private var failure: String?

    var body: some View {
        let current = draft ?? before
        VStack(alignment: .leading, spacing: 10) {
            Text(L("room_settings.edit")).font(.headline)
            if editable.name { field(L("native.room_name"), \.name, lines: 1 ... 1).firstModalField() }
            if editable.texts {
                field(L("info.topic"), \.topic, lines: 1 ... 3)
                field(L("info.description"), \.description, lines: 2 ... 6)
                field(L("info.announcement"), \.announcement, lines: 2 ... 6)
            }
            if editable.readOnly {
                Toggle(isOn: Binding(get: { current.readOnly },
                                     set: { var next = draft ?? before; next.readOnly = $0; draft = next })) {
                    Text(L("room_settings.read_only"))
                    Text(L("room_settings.read_only_hint"))
                }
            }
            if let failure { Text(L(failure)).foregroundStyle(Vibe.pink) }
            HStack {
                Spacer()
                Button(L("actions.cancel")) { close() }
                Button(L("settings.save")) { save(current) }
                    .windowShortcut(.defaultAction)
                    .disabled(saving || current == before || current.name.trimmingCharacters(in: .whitespaces).isEmpty)
            }
        }
        .padding(20)
        .frame(width: 460)
    }

    func field(_ title: String, _ key: WritableKeyPath<RoomSettings, String>, lines: ClosedRange<Int>) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title).font(.subheadline)
            TextField(title, text: Binding(get: { (draft ?? before)[keyPath: key] },
                                           set: { var next = draft ?? before; next[keyPath: key] = $0; draft = next }),
                      axis: .vertical)
                .lineLimit(lines)
                .textFieldStyle(.roundedBorder)
        }
    }

    func save(_ after: RoomSettings) {
        guard !saving, after != before, !after.name.trimmingCharacters(in: .whitespaces).isEmpty else { return }
        saving = true
        failure = nil
        Task {
            let refused = await model.saveRoomSettings(before: before, after: after)
            saving = false
            if let refused { failure = refused } else { close(); saved() }
        }
    }
}
