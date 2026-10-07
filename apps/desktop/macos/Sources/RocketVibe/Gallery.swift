import AppKit
import RocketVibeCore
import RocketVibeKit
import SwiftUI

/// `RV_SMOKE_GALLERY=1`: sample messages drawn by the real rows, without a
/// server, for CI's screenshots. `RV_SMOKE_SOAK=<seconds>` churns them and
/// the dock badge, then says it survived; `RV_SMOKE_SCROLL=1` times a long
/// scroll (`ScrollBench`).
enum SmokeGallery {
    static var requested: Bool { ProcessInfo.processInfo.environment["RV_SMOKE_GALLERY"] == "1" }
    static var soakSeconds: Int? { ProcessInfo.processInfo.environment["RV_SMOKE_SOAK"].flatMap(Int.init) }
}

func run(_ text: String, bold: Bool = false, italic: Bool = false, strike: Bool = false, code: Bool = false,
         link: String? = nil, mention: Bool = false, highlight: Bool = false) -> Run
{
    Run(text: text, bold: bold, italic: italic, strike: strike, code: code, link: link, mention: mention,
        highlight: highlight, customEmoji: nil)
}

func sample(_ id: String, _ minutesAgo: Int64, _ author: String, _ body: [BodyBlock], header: Bool = true,
            day: Bool = false, reactions: [Reaction] = [], delivery: Delivery = .sent, edited: Bool = false,
            replies: Int64 = 0, system: String? = nil, param: String = "", marker: Bool = false) -> MessageItem
{
    let ts = Int64(Date().timeIntervalSince1970 * 1000) - minutesAgo * 60_000
    return MessageItem(
        id: id, rid: "gallery", ts: ts, author: author, authorId: author, avatar: "", mine: author == "alice",
        showHeader: header, showDay: day, gutterTime: !header, newMarker: marker, system: system, param: param,
        callId: nil, locked: false, body: body, text: nil, quotes: [], images: [], files: [], cards: [],
        reactions: reactions, edited: edited, delivery: delivery, threadCount: replies, threadId: nil,
        pinned: false, starred: false)
}

let gallerySamples: [MessageItem] = [
    sample("1", 90, "bob", [.paragraph(runs: [run("Hello "), run("everyone", bold: true), run(" 👋🎉🇫🇷")])], day: true),
    sample("2", 89, "bob", [.paragraph(runs: [run("Some "), run("code", code: true), run(", some "), run("italics", italic: true),
                                              run(" and some "), run("strikethrough", strike: true), run(".")])], header: false),
    sample("3", 60, "alice", [.paragraph(runs: [run("@bob", link: "rv-user:bob", mention: true), run(" look at "),
                                                run("rocket.chat", link: "https://rocket.chat")])],
           reactions: [Reaction(shortcode: ":+1:", glyph: "👍", count: 2, mine: true),
                       Reaction(shortcode: ":joy:", glyph: "😂", count: 1, mine: false)]),
    sample("4", 58, "bob", [.list(items: [ListItem(marker: "•", runs: [run("a list")]),
                                          ListItem(marker: "☑", runs: [run("a task done")])])], replies: 3),
    sample("5", 40, "carol", [], system: "uj"),
    sample("6", 30, "carol", [.quote(blocks: [.paragraph(runs: [run("a quote")])]),
                              .code(text: "fn main() {\n    println!(\"hi\");\n}")]),
    sample("7", 5, "alice", [.bigEmoji(runs: [run("🚀✨")])], edited: true, marker: true),
    sample("8", 1, "alice", [.paragraph(runs: [run("sending…")])], delivery: .pending),
    sample("9", 0, "alice", [.paragraph(runs: [run("not sent")])], header: false, delivery: .failed),
]

func sampleRoom(_ rid: String, _ kind: String, _ name: String, _ preview: RoomPreview, minutesAgo: Int64,
                unread: Int64 = 0, mentions: Int64 = 0, encrypted: Bool = false, presence: Presence? = nil) -> Room
{
    Room(rid: rid, kind: kind, name: name, slug: name, preview: preview,
         lastTs: Int64(Date().timeIntervalSince1970 * 1000) - minutesAgo * 60_000, unread: unread, mentions: mentions,
         alert: unread > 0, favorite: false, encrypted: encrypted, readOnly: false, avatar: nil, presence: presence,
         voice: false)
}

let galleryGroups: [RoomGroup] = [
    RoomGroup(section: .unread, rooms: [
        sampleRoom("general", "c", "general", .text(text: "@alice see you at 2 pm?"), minutesAgo: 2, unread: 3, mentions: 1),
        sampleRoom("bob", "d", "bob", .text(text: "Look at this 🚀"), minutesAgo: 9, unread: 1, presence: .online),
    ]),
    RoomGroup(section: .channels, rooms: [
        sampleRoom("random", "c", "random", .system(author: "carol", kind: "uj", param: ""), minutesAgo: 40),
        sampleRoom("laprivitude", "p", "laprivitude", .encrypted, minutesAgo: 300, encrypted: true),
        sampleRoom("test-prive", "p", "test-prive", .text(text: "Some code, some italics and some strikethrough."), minutesAgo: 60 * 30),
    ]),
    RoomGroup(section: .direct, rooms: [
        sampleRoom("carol", "d", "carol", .text(text: "thanks!"), minutesAgo: 60 * 24 * 3, presence: .away),
        sampleRoom("dave", "d", "dave", .empty, minutesAgo: 60 * 24 * 20, presence: .offline),
    ]),
]

/// The chat window as it is signed in, drawn from samples: the real sidebar
/// sections and rows beside the real message rows.
struct GalleryView: View {
    @State var messages = ScrollBench.requested ? ScrollBench.messages : gallerySamples
    @State var selected: String? = "general"
    @State var collapsed: Set<RoomSection> = []
    @State var rounds = 0
    @State var editing: String?
    @State var deleting: MessageItem?

    var body: some View {
        NavigationSplitView {
            List(selection: $selected) {
                RoomSections(groups: galleryGroups, collapsed: collapsed) { section in
                    if collapsed.contains(section) { collapsed.remove(section) } else { collapsed.insert(section) }
                }
            }
            .listStyle(.sidebar)
            .scrollContentBackground(.hidden)
            .background(Vibe.deep.opacity(0.78))
            .safeAreaInset(edge: .top, spacing: 0) {
                VStack(alignment: .leading, spacing: 6) {
                    Wordmark(size: 21)
                    Comet(active: !ScrollBench.requested)
                }
                .padding(.horizontal, 14)
                .padding(.top, 8)
                .padding(.bottom, 4)
            }
            .navigationSplitViewColumnWidth(min: 220, ideal: 280, max: 400)
        } detail: {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0) {
                    ForEach(messages, id: \.id) { message in
                        MessageRow(
                            message: message, model: nil, editing: editing == message.id, revealed: false,
                            setEditing: { editing = $0 }, askDelete: { deleting = $0 }
                        )
                        .equatable()
                    }
                }
                .padding(.vertical, 8)
            }
            .defaultScrollAnchor(.bottom)
            .background(Vibe.night)
            .background {
                if ScrollBench.requested { ScrollDriver().frame(width: 1, height: 1) }
            }
        }
        .navigationTitle(galleryGroups.flatMap(\.rooms).first { $0.rid == selected }.map { "(2) \($0.name) - rocket-vibe" } ?? "rocket-vibe")
        .toolbarBackground(Vibe.night, for: .windowToolbar)
        .frame(minWidth: 900, minHeight: 560)
        .task {
            print("smoke: gallery shows \(galleryGroups.flatMap(\.rooms).count) rooms and \(messages.count) messages")
            fflush(stdout)
            guard let seconds = SmokeGallery.soakSeconds else { return }
            let rids = galleryGroups.flatMap(\.rooms).map(\.rid)
            let end = Date().addingTimeInterval(TimeInterval(seconds))
            while Date() < end {
                rounds += 1
                messages = rounds % 2 == 0 ? gallerySamples : gallerySamples.reversed().map { $0 }
                selected = rids[rounds % rids.count]
                NSApp.dockTile.badgeLabel = String(rounds % 100)
                try? await Task.sleep(nanoseconds: 50_000_000)
            }
            NSApp.dockTile.badgeLabel = nil
            print("smoke: soak survived \(rounds) rounds")
            fflush(stdout)
        }
    }
}
