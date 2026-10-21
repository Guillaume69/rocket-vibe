import RocketVibeCore
import RocketVibeKit
import SwiftUI

/// A direct conversation with several people (Rocket.Chat, Mattermost,
/// kChat): people found by the spotlight are picked into chips, a chip
/// removes them, Start opens the DM for one and the group DM for more.
struct NewGroupSheet: View {
    @Environment(AppModel.self) var app
    @Environment(\.closeModal) var dismiss
    @State private var query = ""
    @State private var people: [Found] = []
    @State private var picked: [String] = []
    @State private var busy = false
    @State private var error: String?

    var body: some View {
        SheetFrame(title: L("group_dm.new")) {
            VStack(alignment: .leading, spacing: 8) {
                TextField(L("spotlight.placeholder"), text: $query)
                    .firstModalField()
                    .textFieldStyle(.roundedBorder)
                if !picked.isEmpty {
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 6) {
                            ForEach(picked, id: \.self) { username in
                                Button {
                                    picked.removeAll { $0 == username }
                                } label: {
                                    HStack(spacing: 4) {
                                        Text(username)
                                        Image(systemName: "xmark").font(.caption2)
                                    }
                                    .padding(.horizontal, 10)
                                    .padding(.vertical, 4)
                                    .background(Capsule().fill(Vibe.faint.opacity(0.25)))
                                }
                                .buttonStyle(.plain)
                                .help(L("group_dm.remove"))
                            }
                        }
                    }
                }
                if let error {
                    Text(error).font(.caption).foregroundStyle(Vibe.pink)
                }
                List(Array(people.enumerated()), id: \.offset) { _, item in
                    if case let .user(_, username, _) = item {
                        HStack {
                            FoundRow(found: item)
                            Spacer()
                            Image(systemName: picked.contains(username) ? "checkmark.circle.fill" : "circle")
                                .foregroundStyle(picked.contains(username) ? Vibe.pink : Vibe.faint)
                        }
                        .contentShape(Rectangle())
                        .onTapGesture { toggle(username) }
                    }
                }
                HStack {
                    if busy { ProgressView().controlSize(.small) }
                    Spacer()
                    Button(L("actions.cancel")) { dismiss() }
                    Button(L("group_dm.start"), action: start)
                        .keyboardShortcut(.defaultAction)
                        .disabled(picked.isEmpty || busy)
                }
            }
            .padding(12)
        }
        .task(id: query) { await search() }
    }

    func toggle(_ username: String) {
        error = nil
        if picked.contains(username) {
            picked.removeAll { $0 == username }
        } else if picked.count >= Int(groupDmMax()) {
            error = L("group_dm.full", ["n": String(groupDmMax())])
        } else {
            picked.append(username)
        }
    }

    func start() {
        guard !picked.isEmpty, !busy else { return }
        busy = true
        error = nil
        let usernames = picked
        Task {
            let failure = await app.startGroup(usernames: usernames)
            busy = false
            if let failure { error = failure } else { dismiss() }
        }
    }

    func search() async {
        let q = query.trimmingCharacters(in: .whitespaces)
        guard !q.isEmpty, let provider = app.provider else {
            people = []
            return
        }
        try? await Task.sleep(nanoseconds: 250_000_000)
        guard !Task.isCancelled else { return }
        let expected = app.account?.key
        do {
            let results = try await provider.spotlight(query: q)
            guard !Task.isCancelled, expected == app.account?.key else { return }
            people = results.filter { if case .user = $0 { return true } else { return false } }
        } catch {
            guard !Task.isCancelled, expected == app.account?.key else { return }
            people = []
            self.error = L("spotlight.failed")
        }
    }
}
