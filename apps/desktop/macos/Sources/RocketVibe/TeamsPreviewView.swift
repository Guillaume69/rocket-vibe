import AppKit
import RocketVibeCore
import RocketVibeKit
import SwiftUI

struct TeamsPreviewView: View {
    let client: Client
    let onHide: () -> Void
    @State private var preview: TeamsPreview?
    @State private var key = ""
    @State private var code = ""
    @State private var connected = false
    @State private var rooms: [TeamsConversation] = []
    @State private var messages: [TeamsMessage] = []
    @State private var room: TeamsConversation?
    @State private var cursor: String?
    @State private var seen: Set<String> = []
    @State private var busy = false
    @State private var status: String?
    @State private var generation = UUID()
    @State private var request: Task<Void, Never>?
    var body: some View {
        Section(L("teams.title")) {
            Text(L("teams.previewHelp")).font(.caption).foregroundStyle(.secondary)
            if connected {
                Text(L("teams.connected")).font(.caption).foregroundStyle(.secondary)
                if let room {
                    Button(L("slack.back")) { self.room = nil; messages = []; cursor = nil; seen = [] }.disabled(busy)
                    Text(verbatim: room.name).font(.headline)
                    ForEach(messages, id: \.key) { message in
                        VStack(alignment: .leading, spacing: 4) {
                            Text(verbatim: "\(message.author) · \(message.arrivedAt)").font(.caption).foregroundStyle(.secondary)
                            Text(verbatim: message.unsupported ? L("teams.unsupported") : message.text.isEmpty ? L("slack.unsupportedContent") : message.text).textSelection(.enabled)
                        }
                    }
                    if messages.isEmpty { Text(L("slack.empty")).foregroundStyle(.secondary) }
                } else {
                    ForEach(rooms, id: \.id) { room in
                        Button(room.name) { self.room = room; load(more: false) }.disabled(busy || room.kind == "unsupported")
                        if room.kind == "unsupported" { Text(L("teams.unsupported")).font(.caption) }
                    }
                    if rooms.isEmpty { Text(L("slack.empty")).foregroundStyle(.secondary) }
                }
                Button(L("slack.refresh")) { load(more: false) }.disabled(busy)
                if cursor != nil { Button(L("slack.more")) { load(more: true) }.disabled(busy) }
            } else {
                SecureField(L("teams.key"), text: $key).disabled(true)
                Button(L("teams.copyKey")) { NSPasteboard.general.clearContents(); NSPasteboard.general.setString(key, forType: .string); status = L("teams.copied") }.disabled(key.isEmpty || busy)
                SecureField(L("teams.response"), text: $code).disabled(busy || key.isEmpty)
                Button(L("teams.connect")) { connect() }.disabled(busy || code.isEmpty || key.isEmpty)
            }
            if busy { ProgressView(L("slack.loading")) }
            if let status { Text(verbatim: status).font(.caption) }
            Button(L("slack.disconnect")) { reset(); prepare() }
            Button(L("slack.hide")) { reset(); onHide() }
        }
        .onAppear { prepare() }
        .onDisappear { reset() }
    }
    private func prepare() {
        guard preview == nil else { return }
        do { let created = try client.teamsPreview(); key = try created.pairingCode(); preview = created }
        catch { status = String(describing: error) }
    }
    private func reset() {
        generation = UUID(); request?.cancel(); request = nil; preview?.close(); preview = nil
        key = ""; code = ""; connected = false; rooms = []; messages = []; room = nil; cursor = nil; seen = []; busy = false; status = nil
    }
    private func connect() {
        guard !busy, let preview else { return }
        busy = true; status = nil; let current = generation; let code = code.trimmingCharacters(in: .whitespacesAndNewlines)
        request = Task { @MainActor in
            do {
                try await preview.connect(code: code)
                guard !Task.isCancelled, current == generation else { preview.close(); return }
                key = ""; self.code = ""; connected = true; busy = false; load(more: false)
            } catch {
                guard !Task.isCancelled, current == generation else { return }
                status = String(describing: error); busy = false
            }
        }
    }
    private func load(more: Bool) {
        guard !busy, let preview else { return }
        let next = more ? cursor : nil
        if let next, seen.contains(next) { status = "Teams: pagination_loop"; return }
        if !more { cursor = nil; seen = []; rooms = []; messages = [] }
        busy = true; status = nil; let current = generation; let selected = room
        request = Task { @MainActor in
            do {
                if let selected {
                    let page = try await preview.history(conversation: selected.id, backward: next)
                    guard !Task.isCancelled, current == generation else { return }
                    var ids = Set(messages.map(\.key)); messages += page.items.filter { ids.insert($0.key).inserted }; cursor = page.backwardLink
                } else {
                    let found = try await preview.conversations()
                    guard !Task.isCancelled, current == generation else { return }; rooms = found
                }
                if let next { seen.insert(next) }; busy = false
            } catch {
                guard !Task.isCancelled, current == generation else { return }
                status = String(describing: error); busy = false
            }
        }
    }
}

struct ExperimentalPreviewView: View {
    let client: Client
    let onHide: () -> Void
    @State private var provider = "slack"
    var body: some View {
        Section {
            Picker("", selection: $provider) { Text("Slack").tag("slack"); Text("Teams").tag("teams") }.pickerStyle(.segmented)
        }
        if provider == "slack" { SlackPreviewView(client: client, onHide: onHide) }
        else { TeamsPreviewView(client: client, onHide: onHide) }
    }
}
