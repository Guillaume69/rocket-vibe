import AppKit
import RocketVibeCore
import RocketVibeKit
import SwiftUI

/// A discussion born in the room (Rocket.Chat `discussion-created`): its name
/// when it has one, how many messages and when the last came, Open.
struct DiscussionCardView: View {
    @Environment(AppModel.self) var app
    let name: String
    let author: String
    let card: DiscussionCard
    @State private var opening = false

    var body: some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                Label(L("discussion.kind") + (author.isEmpty ? "" : " · \(author)"), systemImage: "bubble.left.and.bubble.right")
                    .font(.vibe(11.5, .semibold))
                    .foregroundStyle(Vibe.faint)
                let title = name.trimmingCharacters(in: .whitespacesAndNewlines)
                if !title.isEmpty { Text(title).font(.vibe(13.5, .bold)) }
                Text(summary).font(.vibe(11.5)).foregroundStyle(Vibe.faint)
            }
            Button(L("discussion.open")) {
                opening = true
                Task {
                    await app.openDiscussion(card.rid)
                    opening = false
                }
            }
            .buttonStyle(VibeButtonStyle())
            .disabled(opening)
        }
        .padding(10)
        .vibeCard()
    }

    var summary: String {
        let messages = L("discussion.messages", count: Int(card.count))
        guard let last = card.last else { return messages }
        return "\(messages) · \(Formatting.shortTime(last))"
    }
}

/// "Start a discussion" (from `source`) or "New discussion": a name, required
/// and suggested from the message's first line, and an optional first
/// message. A click outside closes it, as Cancel, keeping nothing.
struct NewDiscussionSheet: View {
    @Environment(AppModel.self) var app
    @Environment(\.closeModal) var close
    let model: RoomModel?
    let source: MessageItem?
    @State private var name = ""
    @State private var reply = ""
    @State private var creating = false
    @State private var failure: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(L("discussion.new")).font(.headline)
            Text(L("discussion.name")).font(.subheadline)
            TextField(L("discussion.name"), text: $name).firstModalField().textFieldStyle(.roundedBorder)
            Text(L("discussion.first_message")).font(.subheadline)
            TextField(L("discussion.first_message"), text: $reply, axis: .vertical)
                .lineLimit(3...6)
                .textFieldStyle(.roundedBorder)
            if let failure { Text(failure).foregroundStyle(Vibe.pink) }
            HStack {
                Spacer()
                Button(L("actions.cancel")) { close() }
                Button(L("discussion.create")) { Task { await create() } }
                    .windowShortcut(.defaultAction)
                    .disabled(creating || name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }
        .padding(20)
        .frame(width: 420)
        .onAppear { name = suggestedDiscussionName(text: source?.text) }
    }

    func create() async {
        guard let model, !creating else { return }
        let title = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !title.isEmpty else { return }
        creating = true
        failure = nil
        let refused = await app.createDiscussion(prid: model.rid, name: title, messageId: source?.id, reply: reply)
        creating = false
        if let refused { failure = refused } else { close() }
    }
}

/// The room's invite link (Rocket.Chat), for those whose roles allow it:
/// made on demand (7 days, any number of uses), then copied.
struct InviteSection: View {
    @Environment(AppModel.self) var app
    let model: RoomModel
    @State private var allowed = false
    @State private var link: String?
    @State private var busy = false

    var body: some View {
        Group {
            if allowed {
                Section {
                    if let link {
                        LabeledContent(L("invite.title")) {
                            Text(link).textSelection(.enabled).lineLimit(1).truncationMode(.middle)
                        }
                        Button(L("invite.copy")) { copy(link) }
                    } else {
                        Button(L("invite.create")) { Task { await create() } }.disabled(busy)
                    }
                    Text(L("invite.hint")).font(.caption).foregroundStyle(.secondary)
                }
            }
        }
        .task(id: model.rid) { allowed = await model.canInvite() }
    }

    func create() async {
        busy = true
        defer { busy = false }
        do {
            let made = try await model.inviteLink()
            link = made
            copy(made)
        } catch {
            app.notice = L("invite.failed")
        }
    }

    func copy(_ link: String) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(link, forType: .string)
        app.notice = L("invite.copied")
    }
}
