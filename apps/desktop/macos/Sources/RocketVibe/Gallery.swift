import AppKit
import RocketVibeCore
import RocketVibeKit
import SwiftUI

/// `RV_SMOKE_GALLERY=1`: sample messages drawn by the real rows, without a
/// server, for CI's screenshots. `RV_SMOKE_SOAK=<seconds>` churns them and
/// the dock badge, then says it survived.
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
            replies: Int64 = 0, system: String? = nil, param: String = "") -> MessageItem
{
    let ts = Int64(Date().timeIntervalSince1970 * 1000) - minutesAgo * 60_000
    return MessageItem(
        id: id, rid: "gallery", ts: ts, author: author, authorId: author, avatar: "", mine: author == "alice",
        showHeader: header, showDay: day, gutterTime: !header, newMarker: false, system: system, param: param,
        callId: nil, locked: false, body: body, text: nil, quotes: [], images: [], files: [], cards: [],
        reactions: reactions, edited: edited, delivery: delivery, threadCount: replies, threadId: nil,
        pinned: false, starred: false)
}

let gallerySamples: [MessageItem] = [
    sample("1", 90, "bob", [.paragraph(runs: [run("Bonjour "), run("tout le monde", bold: true), run(" 👋🎉🇫🇷")])], day: true),
    sample("2", 89, "bob", [.paragraph(runs: [run("Du "), run("code", code: true), run(", de l'"), run("italique", italic: true),
                                              run(" et du "), run("barré", strike: true), run(".")])], header: false),
    sample("3", 60, "alice", [.paragraph(runs: [run("@bob", link: "rv-user:bob", mention: true), run(" regarde "),
                                                run("rocket.chat", link: "https://rocket.chat")])],
           reactions: [Reaction(shortcode: ":+1:", glyph: "👍", count: 2, mine: true),
                       Reaction(shortcode: ":joy:", glyph: "😂", count: 1, mine: false)]),
    sample("4", 58, "bob", [.list(items: [ListItem(marker: "•", runs: [run("une liste")]),
                                          ListItem(marker: "☑", runs: [run("une tâche faite")])])], replies: 3),
    sample("5", 40, "carol", [], system: "uj"),
    sample("6", 30, "carol", [.quote(blocks: [.paragraph(runs: [run("une citation")])]),
                              .code(text: "fn main() {\n    println!(\"hi\");\n}")]),
    sample("7", 5, "alice", [.bigEmoji(runs: [run("🚀✨")])], edited: true),
    sample("8", 1, "alice", [.paragraph(runs: [run("en cours d'envoi…")])], delivery: .pending),
    sample("9", 0, "alice", [.paragraph(runs: [run("pas parti")])], header: false, delivery: .failed),
]

struct GalleryView: View {
    @State var messages = gallerySamples
    @State var rounds = 0
    @State var editing: String?
    @State var deleting: MessageItem?

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                ForEach(messages, id: \.id) { message in
                    MessageRow(message: message, model: nil, editing: $editing, deleting: $deleting)
                }
            }
            .padding(.vertical, 8)
        }
        .defaultScrollAnchor(.bottom)
        .frame(minWidth: 640, minHeight: 520)
        .task {
            print("smoke: gallery shows \(messages.count) messages")
            fflush(stdout)
            guard let seconds = SmokeGallery.soakSeconds else { return }
            let end = Date().addingTimeInterval(TimeInterval(seconds))
            while Date() < end {
                rounds += 1
                messages = rounds % 2 == 0 ? gallerySamples : gallerySamples.reversed().map { $0 }
                NSApp.dockTile.badgeLabel = String(rounds % 100)
                try? await Task.sleep(nanoseconds: 50_000_000)
            }
            NSApp.dockTile.badgeLabel = nil
            print("smoke: soak survived \(rounds) rounds")
            fflush(stdout)
        }
    }
}
