import AppKit
import RocketVibeCore
import RocketVibeKit
import SwiftUI

@main
struct RocketVibeApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) var delegate
    @State var app = AppModel(home: NSHomeDirectory())

    var body: some Scene {
        Window("rocket-vibe", id: "main") {
            RootView()
                .environment(app)
                .vibe()
                .frame(minWidth: 420, minHeight: 360)
                .task { await start() }
                .onOpenURL { url in open(url) }
        }
        .defaultSize(width: 1100, height: 720)
        .commands { AppCommands(app: app) }

        Settings {
            SettingsView()
                .environment(app)
                .vibe()
        }
    }

    @MainActor
    func start() async {
        let notifier = Notifier.shared
        notifier.onOpen = { [app] rid, message, scope in
            if let scope {
                NSApp.activate()
                Task { await app.notificationAction(key:scope,message:message) }
                return
            }
            guard app.native == nil else { return }
            NSApp.activate()
            Task { await app.open(rid, message: message) }
        }
        notifier.onReply = { [app] rid, message, scope, text in
            if let scope {
                Task { await app.notificationAction(key:scope,message:message,text:text) }
                return
            }
            guard app.native == nil else { return }
            Task { try? await app.provider?.send(rid: rid, text: text) }
        }
        app.onIncoming = { [app] incoming in
            let watching = NSApp.isActive && app.room?.rid == incoming.rid
            if !watching { notifier.show(incoming, scope: app.native?.notificationKey(rid: incoming.rid)) }
        }
        app.onWithdraw = { key in notifier.withdraw(scope: key) }
        app.onAttention = { count in
            NSApp.dockTile.badgeLabel = count > 0 ? String(count) : nil
        }
        app.onVoiceCue = { VoiceSounds.shared.cue($0) }
        app.onVoiceTone = { tone in
            VoiceSounds.shared.tone(tone)
            // A call ringing while the app is behind: the dock bounces.
            if tone == .ringtone && !NSApp.isActive { NSApp.requestUserAttention(.criticalRequest) }
        }
        notifier.start()
        if app.screen == .starting && !SmokeGallery.requested { await app.start() }
    }

    /// `rocketvibe://room/<rid>?host=<server>`, from the Android app's links;
    /// the core resolves provider, full service URL, instance and account scope.
    @MainActor
    func open(_ url: URL) {
        Task { await app.openLink(url.absoluteString) }
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        true
    }
}

struct RootView: View {
    @Environment(AppModel.self) var app

    var body: some View {
        if SmokeGallery.requested {
            GalleryView()
        } else {
            screen
        }
    }

    @ViewBuilder var screen: some View {
        switch app.screen {
        case .starting:
            VStack(spacing: 18) {
                Wordmark(size: 34, twinkles: true)
                Comet(active: true).frame(width: 180)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        case .login:
            LoginView()
        case .chat:
            ChatView()
        }
    }
}

struct AppCommands: Commands {
    let app: AppModel

    var body: some Commands {
        CommandGroup(after: .toolbar) {
            Button(L("nav.back")) { app.goBack() }
                .keyboardShortcut(.leftArrow, modifiers: .option)
            Button(L("nav.forward")) { app.goForward() }
                .keyboardShortcut(.rightArrow, modifiers: .option)
        }
    }
}

extension View {
    /// The night look everywhere: dark, pink accents, Nunito text.
    func vibe() -> some View {
        preferredColorScheme(.dark)
            .tint(Vibe.pink)
            .font(.vibe(14))
            .foregroundStyle(Vibe.text)
            .containerBackground(Vibe.night, for: .window)
    }
}
