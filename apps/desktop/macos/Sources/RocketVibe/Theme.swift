import SwiftUI

/// The Android app's night palette, as the GTK app carries it.
enum Vibe {
    static let night = Color(hex: 0x0C0B16)
    static let deep = Color(hex: 0x0F0E1C)
    static let card = Color(hex: 0x171529)
    static let raised = Color(hex: 0x1E1B33)
    static let line = Color(hex: 0x2C2946)
    static let text = Color(hex: 0xF3F0FF)
    static let soft = Color(hex: 0xC9C3E0)
    static let muted = Color(hex: 0x8F89AB)
    static let faint = Color(hex: 0x6E6890)
    static let pink = Color(hex: 0xFF5FA2)
    static let pinkSoft = Color(hex: 0xFF7AB4)
    static let violet = Color(hex: 0xA78BFA)
    static let sky = Color(hex: 0x5CC8FF)
    static let mint = Color(hex: 0x34E1D0)
    static let sun = Color(hex: 0xFFD34E)
    static let ink = Color(hex: 0x0B0913)

    static let brand = LinearGradient(colors: [pink, violet, mint], startPoint: .leading, endPoint: .trailing)
    static let action = LinearGradient(colors: [pink, violet], startPoint: .topLeading, endPoint: .bottomTrailing)

    /// The seven avatar gradients, in the Android app's order.
    static let tiles: [[Color]] = [
        [pink, violet], [violet, sky], [sky, mint], [sun, Color(hex: 0xFF9BD0)],
        [pink, Color(hex: 0xFF9BD0)], [mint, violet], [sun, pink],
    ]

    /// The Android app's hash (`degradeAvatar`, over UTF-16 units), so a person
    /// keeps the same colours on every client.
    static func tile(for key: String) -> [Color] {
        var h: Int32 = 0
        for unit in key.utf16 { h = h &* 31 &+ Int32(unit) }
        return tiles[Int(abs(Int64(h)) % Int64(tiles.count))]
    }

    static let spring = Animation.spring(response: 0.32, dampingFraction: 0.72)
}

extension Color {
    init(hex: UInt32) {
        self.init(
            red: Double((hex >> 16) & 0xFF) / 255, green: Double((hex >> 8) & 0xFF) / 255,
            blue: Double(hex & 0xFF) / 255)
    }
}

extension Font {
    /// Nunito, the Android app's text face (bundled in the app's Fonts folder).
    static func vibe(_ size: CGFloat, _ weight: Font.Weight = .regular) -> Font {
        .custom("Nunito", size: size).weight(weight)
    }

    /// Baloo 2, its titles.
    static func vibeTitle(_ size: CGFloat, _ weight: Font.Weight = .heavy) -> Font {
        .custom("Baloo 2", size: size).weight(weight)
    }
}

/// The four-pointed sparkle of the "new messages" marker and the brand.
struct Sparkle: Shape {
    func path(in rect: CGRect) -> Path {
        let (cx, cy, r) = (rect.midX, rect.midY, min(rect.width, rect.height) / 2)
        let w = r * 0.28
        var p = Path()
        p.move(to: CGPoint(x: cx, y: cy - r))
        p.addCurve(to: CGPoint(x: cx + r, y: cy), control1: CGPoint(x: cx + w * 0.4, y: cy - w), control2: CGPoint(x: cx + w, y: cy - w * 0.4))
        p.addCurve(to: CGPoint(x: cx, y: cy + r), control1: CGPoint(x: cx + w, y: cy + w * 0.4), control2: CGPoint(x: cx + w * 0.4, y: cy + w))
        p.addCurve(to: CGPoint(x: cx - r, y: cy), control1: CGPoint(x: cx - w * 0.4, y: cy + w), control2: CGPoint(x: cx - w, y: cy + w * 0.4))
        p.addCurve(to: CGPoint(x: cx, y: cy - r), control1: CGPoint(x: cx - w, y: cy - w * 0.4), control2: CGPoint(x: cx - w * 0.4, y: cy - w))
        p.closeSubpath()
        return p
    }
}

/// "rocket-vibe" in Baloo 2 along the brand gradient, a sparkle over its end.
/// It twinkles only where nothing scrolls (the sign-in screen): SwiftUI runs
/// an animation on the main thread, beside the list.
struct Wordmark: View {
    var size: CGFloat = 22
    var twinkles = false
    @State var twinkle = false

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: size * 0.25) {
            Text("🦄").font(.system(size: size * 0.85))
            Text("rocket-vibe")
                .font(.vibeTitle(size))
                .foregroundStyle(Vibe.brand)
                .overlay(alignment: .topTrailing) {
                    Sparkle()
                        .fill(Vibe.mint)
                        .frame(width: size * 0.36, height: size * 0.36)
                        .scaleEffect(twinkle || !twinkles ? 1 : 0.55)
                        .opacity(twinkle || !twinkles ? 1 : 0.5)
                        .offset(x: size * 0.3, y: -size * 0.12)
                }
        }
        .task {
            while twinkles && !Task.isCancelled {
                withAnimation(.easeInOut(duration: 0.7)) { twinkle = true }
                try? await Task.sleep(nanoseconds: 900_000_000)
                withAnimation(.easeInOut(duration: 0.9)) { twinkle = false }
                try? await Task.sleep(nanoseconds: 6_000_000_000)
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("rocket-vibe")
    }
}

/// The sync comet: a streak of the brand gradient crossing while it
/// connects. Once connected it is gone, and nothing animates there.
struct Comet: View {
    let active: Bool

    var body: some View {
        ZStack {
            if active { Streak().transition(.opacity) }
        }
        .frame(maxWidth: .infinity)
        .frame(height: 3)
        .animation(.easeInOut(duration: 0.4), value: active)
        .clipped()
        .allowsHitTesting(false)
    }

    struct Streak: View {
        @State var phase: CGFloat = -0.4

        var body: some View {
            GeometryReader { geometry in
                Capsule()
                    .fill(LinearGradient(colors: [Vibe.pink.opacity(0), Vibe.pink, Vibe.violet, Vibe.mint, Vibe.mint.opacity(0)],
                                         startPoint: .leading, endPoint: .trailing))
                    .frame(width: geometry.size.width * 0.3)
                    .offset(x: geometry.size.width * phase)
            }
            .onAppear {
                withAnimation(.linear(duration: 1.4).repeatForever(autoreverses: false)) { phase = 1.1 }
            }
        }
    }
}

/// The main action: the pink-to-violet gradient capsule with its halo.
struct VibeButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.vibe(13.5, .heavy))
            .foregroundStyle(Vibe.ink)
            .padding(.horizontal, 16)
            .padding(.vertical, 7)
            .background(Vibe.action, in: Capsule())
            .shadow(color: Vibe.pink.opacity(configuration.isPressed ? 0.25 : 0.55), radius: 10, y: 4)
            .scaleEffect(configuration.isPressed ? 0.95 : 1)
            .animation(Vibe.spring, value: configuration.isPressed)
    }
}

/// A round gradient button: send, and the voice message's send.
struct SendButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) var enabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 15, weight: .heavy))
            .foregroundStyle(Vibe.ink)
            .frame(width: 38, height: 38)
            .background(Vibe.action, in: Circle())
            .shadow(color: Vibe.pink.opacity(enabled ? 0.6 : 0), radius: 9, y: 4)
            .opacity(enabled ? 1 : 0.4)
            .scaleEffect(configuration.isPressed ? 0.88 : 1)
            .animation(Vibe.spring, value: configuration.isPressed)
    }
}

/// A card: the night surface, a hairline border, rounded.
struct VibeCard: ViewModifier {
    var radius: CGFloat = 12

    func body(content: Content) -> some View {
        content
            .background(Vibe.card, in: RoundedRectangle(cornerRadius: radius))
            .overlay(RoundedRectangle(cornerRadius: radius).strokeBorder(Vibe.line))
    }
}

extension View {
    func vibeCard(radius: CGFloat = 12) -> some View {
        modifier(VibeCard(radius: radius))
    }
}
