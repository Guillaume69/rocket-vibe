import AppKit
import RocketVibeCore
import RocketVibeKit
import SwiftUI

/// A Jitsi Meet call (Rocket.Chat's Jitsi provider, kChat's kMeet) carried by
/// the voice sidecar, audio only, as GTK's `native_call.rs`: who is in the call
/// and who speaks, mute, deafen, hang up. `CallWindow.show` tries it first and
/// keeps the meeting's page for anything else.
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
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 360, height: 420),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        super.init()
        window.title = title
        window.isReleasedWhenClosed = false
        window.center()
        window.delegate = self
        window.contentView = NSHostingView(rootView: NativeCallView(call: call, close: { [weak self] in self?.window.close() }))
    }

    func windowWillClose(_ notification: Notification) {
        let call = self.call
        Task { await call.leave() }
        Self.windows.removeAll { $0 === self }
    }
}

private struct NativeCallView: View {
    let call: JitsiCallSession
    let close: () -> Void
    @State private var state: JitsiCallState?
    @State private var connectedAt: Date?
    private let tick = Timer.publish(every: 0.3, on: .main, in: .common).autoconnect()

    var body: some View {
        VStack(spacing: 12) {
            Text(status).font(.headline).foregroundStyle(.secondary)
            List(state?.people ?? [], id: \.id) { person in
                HStack {
                    Text(person.local ? L("call.you") : (person.name ?? person.id))
                    Spacer()
                    if person.muted {
                        Image(systemName: "mic.slash")
                    } else if person.speaking {
                        Image(systemName: "speaker.wave.2.fill").foregroundStyle(Color.accentColor)
                    }
                }
            }
            HStack(spacing: 12) {
                let muted = !(state?.microphone ?? true) || (state?.deafened ?? false)
                Button(L("call.mute")) {
                    Task { await call.setMicrophone(enabled: muted) }
                }
                Button(L("call.deafen")) {
                    let deafened = state?.deafened ?? false
                    Task { await call.setDeafened(deafened: !deafened) }
                }
                Button(L("call.hang_up"), role: .destructive, action: close)
            }
            .padding(.bottom, 12)
        }
        .padding(.top, 12)
        .onReceive(tick) { _ in
            let next = call.state()
            if next.connected && connectedAt == nil { connectedAt = Date() }
            state = next
            if next.ended { close() }
        }
    }

    private var status: String {
        guard let at = connectedAt else { return L("call.connecting") }
        if (state?.people ?? []).allSatisfy(\.local) { return L("call.waiting") }
        let seconds = Int(Date().timeIntervalSince(at))
        return String(format: "%d:%02d", seconds / 60, seconds % 60)
    }
}
