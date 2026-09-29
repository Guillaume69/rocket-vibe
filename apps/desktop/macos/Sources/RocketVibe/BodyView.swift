import AppKit
import RocketVibeCore
import RocketVibeKit
import SwiftUI

enum Palette {
    static let mention = Color(red: 1.0, green: 0.478, blue: 0.706)
    static let channel = Color(red: 0.655, green: 0.545, blue: 0.980)
    static let highlight = Color(red: 0.29, green: 0.129, blue: 0.251)
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

/// Runs as one text, a server emoji drawn as its picture once loaded.
struct RunsText: View {
    @Environment(AppModel.self) var app
    let runs: [Run]
    var size: CGFloat = 18
    @State var loaded = 0

    var body: some View {
        runs.reduce(Text("")) { text, run in
            if let code = run.customEmoji, let image = picture(code) {
                return text + Text(Image(nsImage: image)).baselineOffset(-3)
            }
            return text + Text(attributed([run]))
        }
        .task(id: runs.compactMap(\.customEmoji).joined(separator: ",")) { await load() }
    }

    func picture(_ code: String) -> NSImage? {
        _ = loaded
        guard let media = app.media, let path = media.customEmoji(code), let data = media.cached(path),
              let image = NSImage(data: data.bytes) else { return nil }
        image.size = NSSize(width: size, height: size * image.size.height / max(image.size.width, 1))
        return image
    }

    func load() async {
        guard let media = app.media else { return }
        for code in runs.compactMap(\.customEmoji) {
            if let path = media.customEmoji(code), media.cached(path) == nil, await media.load(path) != nil {
                loaded += 1
            }
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
                .font(level <= 1 ? .title2.bold() : level == 2 ? .title3.bold() : .headline)
                .textSelection(.enabled)
        case let .quote(blocks):
            HStack(alignment: .top, spacing: 8) {
                RoundedRectangle(cornerRadius: 2).fill(.secondary.opacity(0.5)).frame(width: 3)
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
            .background(Color(nsColor: .textBackgroundColor).opacity(0.6), in: RoundedRectangle(cornerRadius: 6))
        case let .list(items):
            VStack(alignment: .leading, spacing: 2) {
                ForEach(Array(items.enumerated()), id: \.offset) { _, item in
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        Text(item.marker).foregroundStyle(.secondary)
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
