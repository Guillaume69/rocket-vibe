import RocketVibeCore
import RocketVibeKit
import SwiftUI

/// The quick room switcher (Cmd+K): the account's rooms, searched by name in
/// rv-core's order (`switcherMatches`); Return opens the selected one, the
/// arrows move the selection.
struct RoomSwitcher: View {
    @Environment(AppModel.self) var app
    @Environment(\.closeModal) var close
    @State private var search = ""
    @State private var selected = 0

    var body: some View {
        let found = switcherMatches(rooms: app.rooms, query: search)
        VStack(alignment: .leading, spacing: 12) {
            Text(L("switcher.title")).font(.headline)
            TextField(L("switcher.placeholder"), text: $search)
                .firstModalField()
                .onChange(of: search) { selected = 0 }
                .onSubmit { pick(found, at: selected) }
                .onKeyPress(.downArrow) { move(1, in: found) }
                .onKeyPress(.upArrow) { move(-1, in: found) }
            ScrollViewReader { proxy in
                ScrollView {
                    VStack(alignment: .leading, spacing: 2) {
                        if found.isEmpty { Text(L("switcher.none")).foregroundStyle(Vibe.faint) }
                        ForEach(Array(found.enumerated()), id: \.element.rid) { index, room in
                            Button { pick(found, at: index) } label: { row(room, selected: index == selected) }
                                .buttonStyle(.plain)
                                .id(room.rid)
                        }
                    }.frame(maxWidth: .infinity, alignment: .leading)
                }
                .onChange(of: selected) {
                    if found.indices.contains(selected) { proxy.scrollTo(found[selected].rid) }
                }
            }
            Button(L("actions.cancel")) { close() }
        }.padding(20).frame(width: 400, height: 460)
    }

    func row(_ room: Room, selected: Bool) -> some View {
        HStack(spacing: 8) {
            Avatar(path: room.avatar, name: room.name, size: 24)
            Text((room.kind == "c" ? "#" : "") + room.name).lineLimit(1)
                .fontWeight(room.unread > 0 || room.alert ? .bold : .regular)
            Spacer()
            if room.unread > 0 {
                Text(room.mentions > 0 ? "@\(room.unread)" : "\(room.unread)")
                    .font(.vibe(11.5, .heavy))
                    .padding(.horizontal, 7)
                    .frame(minWidth: 22, minHeight: 20)
                    .background(room.mentions > 0 ? Vibe.pink : Vibe.sun, in: Capsule())
                    .foregroundStyle(Vibe.ink)
            }
        }
        .padding(.vertical, 4).padding(.horizontal, 6)
        .background(selected ? Vibe.pink.opacity(0.18) : Color.clear, in: RoundedRectangle(cornerRadius: 6))
        .contentShape(Rectangle())
    }

    func move(_ step: Int, in found: [Room]) -> KeyPress.Result {
        guard !found.isEmpty else { return .handled }
        selected = min(max(selected + step, 0), found.count - 1)
        return .handled
    }

    func pick(_ found: [Room], at index: Int) {
        guard found.indices.contains(index) else { return }
        let rid = found[index].rid
        close()
        app.select(rid)
    }
}
