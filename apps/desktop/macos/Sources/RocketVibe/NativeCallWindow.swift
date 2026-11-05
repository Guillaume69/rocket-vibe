import AppKit
import RocketVibeCore
import RocketVibeKit
import SwiftUI

/// A Jitsi Meet call (Rocket.Chat's Jitsi provider, kChat's kMeet) carried by
/// the voice sidecar, audio only, as GTK's `native_call.rs`, drawn with the Vibez
/// voice page's parts: a tile per person with the speaking ring, and the same
/// control bar. A lost call shows "Reconnecting…" while the sidecar joins again;
/// one that ends stays on screen with the reason. `CallWindow.show` tries it
/// first and keeps the meeting's page for anything else.
@MainActor
final class NativeCallWindow: NSObject, NSWindowDelegate {
    private static var windows: [NativeCallWindow] = []
    private let window: NSWindow
    private let call: JitsiCallSession

    static func show(_ call: JitsiCallSession, title: String) {
        let native = NativeCallWindow(call: call, title: title)
        windows.append(native)
        native.window.makeKeyAndOrderFront(nil)
    }

    private init(call: JitsiCallSession, title: String) {
        self.call = call
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 560, height: 520),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        super.init()
        window.title = title
        window.isReleasedWhenClosed = false
        window.center()
        window.delegate = self
        window.contentView = NSHostingView(rootView: NativeCallView(call: call, title: title, close: { [weak self] in self?.window.close() }))
    }

    func windowWillClose(_ notification: Notification) {
        let call = self.call
        Task { await call.leave() }
        Self.windows.removeAll { $0 === self }
    }
}

private struct NativeCallView: View {
    let call: JitsiCallSession
    let title: String
    let close: () -> Void
    @State private var state: JitsiCallState?
    @State private var connectedAt: Date?
    private let tick = Timer.publish(every: 0.3, on: .main, in: .common).autoconnect()

    var body: some View {
        VStack(spacing: 14) {
            HStack(spacing: 8) {
                Image(systemName: "phone.fill")
                Text(title).font(.vibe(17, .heavy)).lineLimit(1)
            }
            Text(status)
                .font(.vibe(13, .bold))
                .foregroundStyle(state?.connected == true && state?.ended != true ? Vibe.mint : Vibe.muted)
            if state?.ended == true {
                Spacer()
                Button(L("call.close"), action: close).buttonStyle(.borderedProminent)
                Spacer()
            } else {
                let members = state?.members ?? []
                GeometryReader { geometry in
                    let arranged = arrangeTiles(members.count, in: geometry.size)
                    let columns = max(1, arranged.columns), tile = arranged.tile
                    let rows = stride(from: 0, to: members.count, by: columns)
                        .map { Array(members[$0..<min($0 + columns, members.count)]) }
                    VStack(spacing: 12) {
                        ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
                            HStack(spacing: 12) {
                                ForEach(row, id: \.id) { member in
                                    VoiceTileFace(member: member, named: true) {
                                        SpeakingAvatar(member: member, size: 96)
                                            .frame(maxWidth: .infinity, maxHeight: .infinity)
                                    }
                                    .frame(width: tile.width, height: tile.height)
                                }
                            }
                        }
                    }
                    .frame(width: geometry.size.width, height: geometry.size.height)
                }
                HStack(spacing: 14) {
                    let muted = !(state?.microphone ?? true)
                    let deafened = state?.deafened ?? false
                    VoiceControlButton(icon: muted ? "mic.slash.fill" : "mic.fill", off: muted,
                                       help: muted ? "voice_session.unmute" : "voice_session.mute") {
                        Task { await call.setMicrophone(enabled: muted) }
                    }
                    VoiceControlButton(icon: deafened ? "speaker.slash.fill" : "headphones", off: deafened,
                                       help: deafened ? "voice_session.undeafen" : "voice_session.deafen") {
                        Task { await call.setDeafened(deafened: !deafened) }
                    }
                    VoiceHangUpButton(help: "call.hang_up", action: close)
                }
            }
        }
        .padding(18)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Vibe.ink)
        .onReceive(tick) { _ in
            let next = call.state()
            if next.connected && connectedAt == nil { connectedAt = Date() }
            state = next
            // Hung up here: nothing to show. Lost for good: the reason stays until closed.
            if next.ended && next.endedReason == nil { close() }
        }
    }

    private var status: String {
        if let reason = state?.endedReason { return L("call.ended", ["reason": reason]) }
        if state?.reconnecting == true { return L("voice_session.reconnecting") }
        guard state?.connected == true, let at = connectedAt else { return L("call.connecting") }
        if (state?.members ?? []).allSatisfy(\.local) { return L("call.waiting") }
        let seconds = Int(Date().timeIntervalSince(at))
        return String(format: "%d:%02d", seconds / 60, seconds % 60)
    }
}
