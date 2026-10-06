import AppKit
import RocketVibeCore
import RocketVibeKit
import SwiftUI

enum Palette {
    static let mention = Vibe.pinkSoft
    static let channel = Vibe.violet
    static let highlight = Color(hex: 0x4A2140)
}

func attributed(_ runs: [Run]) -> AttributedString {
    var out = AttributedString()
    for run in runs {
        var piece = AttributedString(run.text)
        var intent: InlinePresentationIntent = []
        if run.bold { intent.insert(.stronglyEmphasized) }
        if run.italic { intent.insert(.emphasized) }
        if run.strike { intent.insert(.strikethrough) }
        if run.code { intent.insert(.code) }
        if !intent.isEmpty { piece.inlinePresentationIntent = intent }
        if let link = run.link, let url = URL(string: link) { piece.link = url }
        if run.mention {
            let room = run.link?.hasPrefix("rv-room:") ?? false
            piece.foregroundColor = room ? Palette.channel : Palette.mention
            if run.highlight { piece.backgroundColor = Palette.highlight }
        }
        out.append(piece)
    }
    return out
}

/// Styled text by its runs, built once: rows scrolled back into view reuse it.
@MainActor
enum StyledText {
    final class Key: NSObject {
        let runs: [Run]
        init(_ runs: [Run]) { self.runs = runs }
        override var hash: Int { runs.hashValue }
        override func isEqual(_ other: Any?) -> Bool { (other as? Key)?.runs == runs }
    }

    final class Box: NSObject {
        let value: AttributedString
        init(_ value: AttributedString) { self.value = value }
    }

    static let cache: NSCache<Key, Box> = {
        let cache = NSCache<Key, Box>()
        cache.countLimit = 3000
        return cache
    }()

    static func of(_ runs: [Run]) -> AttributedString {
        let key = Key(runs)
        if let hit = cache.object(forKey: key) { return hit.value }
        let value = attributed(runs)
        cache.setObject(Box(value), forKey: key)
        return value
    }
}

/// Runs as one text, a server emoji drawn as its picture once loaded.
struct RunsText: View {
    @Environment(AppModel.self) var app
    let runs: [Run]
    var size: CGFloat = 18
    @State var loaded = 0

    var body: some View {
        if runs.allSatisfy({ $0.customEmoji == nil }) {
            Text(StyledText.of(runs))
        } else {
            runs.reduce(Text("")) { text, run in
                if let code = run.customEmoji, let image = picture(code) {
                    return text + Text(Image(nsImage: image)).baselineOffset(-3)
                }
                return text + Text(StyledText.of([run]))
            }
            .task(id: "\(app.sessionId)#\(app.imagesVersion)#\(runs.compactMap(\.customEmoji).joined(separator: ","))") { await load() }
        }
    }

    func picture(_ code: String) -> NSImage? {
        _ = loaded
        guard let media=app.media,let path = media.customEmoji(code),media.current(path) else { return nil }
        return Pictures.cached(path, pixels: Pictures.pixels(size))
    }

    func load() async {
        guard let media = app.media else { return }
        for code in runs.compactMap(\.customEmoji) {
            guard let path = media.customEmoji(code), Pictures.cached(path, pixels: Pictures.pixels(size)) == nil else {
                continue
            }
            if await Pictures.load(path, pixels: Pictures.pixels(size), media: media) != nil { loaded += 1 }
        }
    }
}

/// A message body, block by block.
struct BodyView: View {
    let blocks: [BodyBlock]
    var dimmed = false

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { _, block in
                BlockView(block: block)
            }
        }
        .opacity(dimmed ? 0.55 : 1)
    }
}

struct BlockView: View {
    let block: BodyBlock

    var body: some View {
        switch block {
        case let .paragraph(runs):
            RunsText(runs: runs).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
        case let .heading(level, runs):
            RunsText(runs: runs)
                .font(.vibeTitle(level <= 1 ? 22 : level == 2 ? 19 : 16, .bold))
                .textSelection(.enabled)
        case let .quote(blocks):
            HStack(alignment: .top, spacing: 8) {
                RoundedRectangle(cornerRadius: 2).fill(Vibe.violet.opacity(0.7)).frame(width: 3)
                BodyView(blocks: blocks)
            }
            .fixedSize(horizontal: false, vertical: true)
        case let .code(text):
            ScrollView(.horizontal) {
                Text(text)
                    .font(.system(.callout, design: .monospaced))
                    .textSelection(.enabled)
                    .padding(8)
            }
            .vibeCard(radius: 8)
        case let .list(items):
            VStack(alignment: .leading, spacing: 2) {
                ForEach(Array(items.enumerated()), id: \.offset) { _, item in
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        Text(item.marker).foregroundStyle(Vibe.pinkSoft)
                        RunsText(runs: item.runs).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
        case let .bigEmoji(runs):
            RunsText(runs: runs, size: 44).font(.system(size: 40))
        case .break:
            Spacer().frame(height: 4)
        }
    }
}
