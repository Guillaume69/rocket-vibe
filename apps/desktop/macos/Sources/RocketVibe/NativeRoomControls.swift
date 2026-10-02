import RocketVibeCore
import RocketVibeKit
import SwiftUI

/// Additional controls in the existing room information form.
struct NativeRoomControls: View {
    let model: RoomModel
    let details: NativeRoomManagement?
    let refreshed: (NativeRoomManagement) -> Void
    @State private var intention: NativeRoomIntention?
    @State private var edit: NativeRoomFields?
    @State private var editingRevision = ""
    @State private var members: NativeRoomMemberPage?
    @State private var busy = false
    @State private var error: String?
    @State private var leaving = false
    @State private var task: Task<Void, Never>?

    var body: some View {
        Section {
            if let error { Text(error).foregroundStyle(.red) }
            if let intention {
                Text(L(intention.failed ? "rooms.rejected" : "rooms.pending")).foregroundStyle(.secondary)
                if intention.failed {
                    if let code = intention.error { Text(roomError(code)).foregroundStyle(.red) }
                    if let fields = intention.fields, details?.canEdit == true {
                        Button(L("rooms.review")) { run {
                            let fresh = try await model.roomManagement()
                            guard fresh.canEdit, !Task.isCancelled else { return }
                            if try await model.dismissRoomIntention(key: intention.key) {
                                guard !Task.isCancelled else { return }
                                edit = fields; editingRevision = fresh.revision; refreshed(fresh)
                            }
                        } }
                    }
                    Button(L("rooms.clear")) { run { _ = try await model.dismissRoomIntention(key: intention.key) } }
                } else { Button(L("rooms.resume")) { run { try await model.resumeRoomIntention() } } }
            }
            if edit != nil {
                Text(L("rooms.revision")).foregroundStyle(.secondary)
                TextField(L("native.room_name"), text: field(\.name))
                TextField(L("info.topic"), text: field(\.topic), axis: .vertical).lineLimit(2 ... 5)
                TextField(L("info.description"), text: field(\.description), axis: .vertical).lineLimit(2 ... 8)
                TextField(L("info.announcement"), text: field(\.announcement), axis: .vertical).lineLimit(2 ... 8)
                Toggle(L("native.private"), isOn: flag(\.privateRoom))
                Toggle(L("info.read_only"), isOn: flag(\.readOnly))
                Button(L("settings.save")) { guard let fields = edit else { return }; let revision = editingRevision
                    run { try await model.updateRoom(fields: fields, revision: revision); if !Task.isCancelled { edit = nil } }
                }.disabled(details?.canEdit != true || intention != nil)
                Button(L("actions.cancel")) { edit = nil }
            } else if let details, details.canEdit {
                Button(L("rooms.edit")) { edit = details.fields; editingRevision = details.revision }.disabled(intention != nil)
            }
            if let details {
                Button(L("rooms.members")) { loadMembers(after: nil, revision: details.revision) }
                if let members, members.revision == details.revision {
                    ForEach(members.members, id: \.id) { member in
                        VStack(alignment: .leading, spacing: 6) {
                            Text("\(member.name.isEmpty ? member.username : member.name) · @\(member.username)")
                            Text(L("rooms.\(member.role)")).foregroundStyle(.secondary)
                            if member.disabled { Text(L("rooms.disabled")).foregroundStyle(.secondary) }
                            if details.canChangeRoles && !member.disabled {
                                HStack {
                                    ForEach(["member", "moderator", "owner"], id: \.self) { role in
                                        Button(L("rooms.\(role)")) { run {
                                            try await model.changeRoomRole(target: member.id, role: role, revision: members.revision)
                                            if !Task.isCancelled { self.members = nil }
                                        } }.disabled(member.role == role || intention != nil)
                                    }
                                }
                            }
                        }
                    }
                    if let next = members.next { Button(L("rooms.more")) { loadMembers(after: next, revision: members.revision) } }
                }
                if details.canLeave { Button(L("rooms.leave"), role: .destructive) { leaving = true }.disabled(intention != nil) }
            }
        }
        .disabled(busy)
        .confirmationDialog(L("rooms.leave"), isPresented: $leaving) {
            Button(L("rooms.leave"), role: .destructive) { guard let details else { return }; run { try await model.leaveRoom(revision: details.revision) } }
            Button(L("actions.cancel"), role: .cancel) {}
        } message: { Text(L("rooms.leave_body")) }
        .task(id: model.roomOperationRevision) { intention = try? model.roomIntention() }
        .onDisappear { task?.cancel(); task = nil; edit = nil; intention = nil; members = nil }
    }
    func field(_ key: WritableKeyPath<NativeRoomFields, String>) -> Binding<String> { Binding(get: { edit?[keyPath: key] ?? "" }, set: { edit?[keyPath: key] = $0 }) }
    func flag(_ key: WritableKeyPath<NativeRoomFields, Bool>) -> Binding<Bool> { Binding(get: { edit?[keyPath: key] ?? false }, set: { edit?[keyPath: key] = $0 }) }
    func roomError(_ code: String) -> String {
        L(code == "last_room_owner" ? "rooms.last_owner" : code == "revision_conflict" ? "rooms.conflict" : code == "room_action_pending" ? "rooms.pending" : code == "offline" ? "rooms.command_offline" : "rooms.failed")
    }
    func run(_ operation: @escaping @MainActor () async throws -> Void) {
        guard !busy, model.supportsRoomManagement else { return }
        busy = true; error = nil
        task = Task { @MainActor in
            guard !Task.isCancelled else { return }
            do { try await operation() }
            catch { if !Task.isCancelled, model.supportsRoomManagement {
                if case let RvError.Server(_, _, code, _, _, _) = error { self.error = roomError(code ?? "") }
                else { self.error = L("rooms.failed") }
            } }
            guard !Task.isCancelled, model.supportsRoomManagement else { return }
            intention = try? model.roomIntention()
            if let fresh = try? await model.roomManagement(), !Task.isCancelled { refreshed(fresh) }
            if !Task.isCancelled { busy = false; task = nil }
        }
    }
    func loadMembers(after: String?, revision: String) {
        run {
            let page = try await model.roomMembers(after: after, revision: revision)
            guard !Task.isCancelled else { return }
            if after != nil, let previous = members, previous.revision == page.revision {
                members = NativeRoomMemberPage(revision: page.revision, members: previous.members + page.members, next: page.next)
            } else { members = page }
        }
    }
}
