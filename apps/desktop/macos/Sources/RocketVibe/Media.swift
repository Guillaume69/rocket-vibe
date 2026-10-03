import AppKit
import RocketVibeCore
import RocketVibeKit
import SwiftUI

/// A photo over a gradient tile of initials; the tile stays when there is no photo.
struct Avatar: View {
    @Environment(AppModel.self) var app
    let path: String?
    let name: String
    let size: CGFloat
    @State var image: NSImage?

    var body: some View {
        ZStack {
            LinearGradient(colors: Vibe.tile(for: name), startPoint: .topLeading, endPoint: .bottomTrailing)
            Text(initial)
                .font(.vibeTitle(size * 0.5))
                .foregroundStyle(Vibe.ink.opacity(0.85))
            if let shown {
                Image(nsImage: shown).resizable().scaledToFill()
            }
        }
        .frame(width: size, height: size)
        .clipShape(RoundedRectangle(cornerRadius: size * 0.28))
        .task(id: "\(path ?? "")#\(app.imagesVersion)") { await load() }
    }

    /// The decoded photo, or the one already in the cache when the row is new.
    var shown: NSImage? {
        if let path,app.media?.current(path)==false{return nil}
        return image ?? path.flatMap { Pictures.cached($0, pixels: Pictures.pixels(size)) }
    }

    var initial: String {
        String(name.trimmingCharacters(in: CharacterSet(charactersIn: "@#")).prefix(1)).uppercased()
    }

    func load() async {
        guard let path, let media = app.media else {
            image = nil
            return
        }
        image = await Pictures.load(path, pixels: Pictures.pixels(size), media: media)
    }
}

/// A server image (an upload, a card's picture), fetched with the session.
struct RemoteImage: View {
    @Environment(AppModel.self) var app
    let path: String
    var width: CGFloat? = nil
    var height: CGFloat? = nil
    @State var image: NSImage?
    @State var failed = false

    var pixels: Int {
        guard width != nil || height != nil else { return 0 }
        return Pictures.pixels(max(width ?? 0, height ?? 0))
    }

    var body: some View {
        Group {
            if app.media?.current(path) != false, let shown = image ?? Pictures.cached(path, pixels: pixels) {
                Image(nsImage: shown).resizable().scaledToFill()
            } else if failed {
                Image(systemName: "photo").foregroundStyle(.secondary)
            } else {
                ProgressView().controlSize(.small)
            }
        }
        .frame(width: width, height: height)
        .background(Vibe.card)
        .clipShape(RoundedRectangle(cornerRadius: 12))
        .task(id: "\(path)#\(app.imagesVersion)") {
            guard let media = app.media else { return }
            if let loaded = await Pictures.load(path, pixels: pixels, media: media) {
                image = loaded
            } else {
                failed = true
            }
        }
    }
}

/// The Android layout: natural width clamped, height at the original's ratio, capped.
func displaySize(width: Int64?, height: Int64?, minWidth: CGFloat = 120, maxWidth: CGFloat = 360, maxHeight: CGFloat = 300)
    -> CGSize
{
    let w = min(max(CGFloat(width ?? Int64(maxWidth)), minWidth), maxWidth)
    let ratio = CGFloat(height ?? Int64(w)) / max(CGFloat(width ?? Int64(w)), 1)
    return CGSize(width: w, height: min(max((w * ratio).rounded(), 1), maxHeight))
}

/// Full size in a window of its own; a click outside the picture closes it.
struct ImageViewer: View {
    let path: String
    let title: String?
    @Environment(\.dismiss) var dismiss
    @Environment(AppModel.self) var app

    var body: some View {
        ZStack {
            Color.black.opacity(0.85)
                .onTapGesture { dismiss() }
            RemoteImage(path: path)
                .scaledToFit()
                .padding(24)
        }
        .frame(minWidth: 500, minHeight: 400)
        .overlay(alignment: .topLeading) {
            if let title { Text(title).foregroundStyle(.white).padding() }
        }
        .onExitCommand { dismiss() }
        .onChange(of:app.imagesVersion){if app.media?.current(path)==false{dismiss()}}
    }
}
