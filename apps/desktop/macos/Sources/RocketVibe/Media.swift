import AppKit
import RocketVibeCore
import RocketVibeKit
import SwiftUI

/// A photo, or a gradient tile of initials when there is none.
struct Avatar: View {
    @Environment(AppModel.self) var app
    let path: String?
    let name: String
    let size: CGFloat
    var symbol: String? = nil
    var glyph: String? = nil
    @State var image: NSImage?

    var body: some View {
        ZStack {
            if let shown {
                AnimatedImage(image: shown)
            } else {
                LinearGradient(colors: Vibe.tile(for: name), startPoint: .topLeading, endPoint: .bottomTrailing)
                if let symbol {
                    Image(systemName: symbol)
                        .font(.system(size: size * 0.42, weight: .bold))
                        .foregroundStyle(Vibe.ink.opacity(0.85))
                } else {
                    Text(glyph ?? initial)
                        .font(.vibeTitle(size * 0.5))
                        .foregroundStyle(Vibe.ink.opacity(0.85))
                }
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

/// A room's tile, as GTK's `room_tile` draws it: a neutral lock for an
/// encrypted room without a photo, a lock for a private one, `#` for a
/// channel, the initial for a direct conversation; its photo instead when set.
struct RoomTile: View {
    let room: Room
    let size: CGFloat

    var body: some View {
        if room.encrypted && room.avatar == nil {
            Image(systemName: "lock.fill")
                .font(.system(size: size * 0.42, weight: .bold))
                .foregroundStyle(Vibe.ink.opacity(0.8))
                .frame(width: size, height: size)
                .background(LinearGradient(colors: [Vibe.muted, Color(hex: 0x5A5573)], startPoint: .topLeading, endPoint: .bottomTrailing),
                            in: RoundedRectangle(cornerRadius: size * 0.28))
        } else {
            Avatar(path: room.avatar, name: room.name, size: size, symbol: room.kind == "p" ? "lock.fill" : nil,
                   glyph: room.kind == "d" ? nil : "#")
        }
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
    @State var authority:String?

    var pixels: Int {
        guard width != nil || height != nil else { return 0 }
        return Pictures.pixels(max(width ?? 0, height ?? 0))
    }

    var body: some View {
        Group {
            if app.media?.current(path) != false,(!path.hasPrefix("rv-preview:")||authority==app.media?.scope(path)), let shown = image ?? Pictures.cached(path, pixels: pixels) {
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
        .task(id: "\(path)#\(app.imagesVersion)#\(app.media?.scope(path) ?? "")") {
            guard let media = app.media else { return }
            let scope=media.scope(path)
            if let loaded = await Pictures.load(path, pixels: pixels, media: media) {
                guard scope==media.scope(path),!Task.isCancelled else{return}
                authority=scope
                image = loaded
                failed=false
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

/// Full size over the window; a click outside the picture closes it.
struct ImageViewer: View {
    let path: String
    let title: String?
    @Environment(\.closeModal) var dismiss
    @Environment(AppModel.self) var app

    var body: some View {
        ZStack {
            Color.black.opacity(0.85)
                .onTapGesture { dismiss() }
            RemoteImage(path: path)
                .scaledToFit()
                .padding(24)
        }
        .overlay(alignment: .topLeading) {
            if let title { Text(title).foregroundStyle(.white).padding() }
        }
        .onChange(of:app.imagesVersion){if app.media?.current(path)==false{dismiss()}}
    }
}

/// Native image view preserves GIF animation in Rocket.Chat image attachments.
struct AnimatedImage: NSViewRepresentable {
    let image: NSImage
    func makeNSView(context: Context) -> NSImageView { let view=NSImageView(); view.animates=true; view.imageScaling = .scaleProportionallyUpOrDown; return view }
    func updateNSView(_ view: NSImageView, context: Context) { if view.image !== image { view.image=image } }
}
