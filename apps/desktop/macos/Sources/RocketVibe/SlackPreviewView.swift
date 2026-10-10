import RocketVibeCore
import RocketVibeKit
import SwiftUI
import AppKit

/// The first Slack increment stays independent of the persistent chat session.
struct SlackPreviewView: View {
    let client: Client
    let onHide: () -> Void
    @State private var key = ""
    @State private var code = ""
    @State private var pairing: SlackPairing?
    @State private var preview: SlackPreview?
    @State private var rooms: [SlackConversation] = []
    @State private var messages: [SlackMessage] = []
    @State private var room: SlackConversation?
    @State private var cursor: String?
    @State private var seen: Set<String> = []
    @State private var busy = false
    @State private var status: String?
    @State private var generation = UUID()
    @State private var request: Task<Void, Never>?

    var body: some View {
        Section(L("slack.title")) {
            Text(L("slack.previewHelp")).font(.caption).foregroundStyle(.secondary)
            if let preview {
                let who = preview.identity()
                Text("\(who.team) · @\(who.user)")
                if let room {
                    Button(L("slack.back")) { self.room = nil; load(more: false) }.disabled(busy)
                    Text(room.name).font(.headline)
                    ForEach(messages, id: \.ts) { message in
                        VStack(alignment: .leading, spacing: 4) {
                            Text("\(message.user) · \(date(message.ts))").font(.caption).foregroundStyle(.secondary)
                            Text(message.text.isEmpty ? L("slack.unsupportedContent") : message.text).textSelection(.enabled)
                        }
                    }
                    if messages.isEmpty { Text(L("slack.empty")).foregroundStyle(.secondary) }
                } else {
                    ForEach(rooms, id: \.id) { room in
                        Button((room.kind == "channel" ? "# " : room.kind == "private" ? "🔒 " : "") + room.name) { self.room = room; load(more: false) }.disabled(busy)
                    }
                    if rooms.isEmpty { Text(L("slack.empty")).foregroundStyle(.secondary) }
                }
                Button(L("slack.refresh")) { load(more: false) }.disabled(busy)
                if cursor != nil { Button(L("slack.more")) { load(more: true) }.disabled(busy) }
            } else {
                SecureField(L("slack.key"), text: .constant(key)).disabled(true)
                Button(L("slack.copyKey")) { NSPasteboard.general.clearContents(); NSPasteboard.general.setString(key, forType: .string) }.disabled(busy || key.isEmpty)
                SecureField(L("slack.response"), text: $code).disabled(busy || key.isEmpty)
                Button(L("slack.import")) { connect() }.disabled(busy || key.isEmpty || code.isEmpty)
            }
            if busy { ProgressView(L("slack.loading")) }
            if let status { Text(status).font(.caption) }
            Button(L("slack.disconnect")) { reset() }
            Button(L("slack.hide")) { reset(); onHide() }
        }
        .onAppear { prepare() }
        .onDisappear { reset(repair: false) }
    }
    private func date(_ ts: String) -> String {
        guard let seconds = Double(ts.split(separator: ".")[0]) else { return ts }
        return Date(timeIntervalSince1970: seconds).formatted(date: .abbreviated, time: .shortened)
    }
    private func prepare() {
        do { let p = try client.slackPairing(); pairing = p; key = try p.pairingCode() }
        catch { status = "Slack: pairing_unavailable" }
    }
    private func reset(repair: Bool = true) {
        generation = UUID(); request?.cancel(); request = nil; preview?.close(); preview = nil
        pairing?.close(); pairing = nil; key = ""; code = ""; rooms = []; messages = []; room = nil; cursor = nil; seen = []; busy = false; status = nil
        if repair { prepare() }
    }
    private func connect() {
        guard !busy, let pairing else { return }
        busy = true; status = nil; let current = generation; let code = code
        request = Task { @MainActor in
            do {
                let found = try await pairing.connect(code: code.trimmingCharacters(in: .whitespacesAndNewlines))
                guard !Task.isCancelled, current == generation else { found.close(); return }
                preview = found; self.key = ""; self.code = ""; busy = false; load(more: false)
            } catch {
                guard !Task.isCancelled, current == generation else { return }
                status = String(describing: error); busy = false
            }
        }
    }
    private func load(more: Bool) {
        guard !busy, let preview else { return }
        let next = more ? cursor : nil
        if let next, seen.contains(next) { status = "Slack: pagination_loop"; return }
        if !more { cursor = nil; seen = []; rooms = []; messages = [] }
        busy = true; status = nil; let current = generation; let selected = room
        request = Task { @MainActor in
            do {
                if let selected {
                    let page = try await preview.history(channel: selected.id, cursor: next)
                    guard !Task.isCancelled, current == generation else { return }
                    var ids = Set(messages.map(\.ts)); messages += page.items.filter { ids.insert($0.ts).inserted }; cursor = page.nextCursor
                } else {
                    let page = try await preview.conversations(cursor: next)
                    guard !Task.isCancelled, current == generation else { return }
                    var ids = Set(rooms.map(\.id)); rooms += page.items.filter { ids.insert($0.id).inserted }; cursor = page.nextCursor
                }
                if let next { seen.insert(next) }; busy = false
            } catch {
                guard !Task.isCancelled, current == generation else { return }
                status = String(describing: error); busy = false
            }
        }
    }
}
