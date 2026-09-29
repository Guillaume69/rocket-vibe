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
                .frame(minWidth: 420, minHeight: 360)
                .task { await start() }
                .onOpenURL { url in open(url) }
        }
        .defaultSize(width: 1100, height: 720)
        .commands { AppCommands(app: app) }

        Settings {
            SettingsView()
                .environment(app)
        }
    }

    @MainActor
    func start() async {
        let notifier = Notifier.shared
        notifier.onOpen = { [app] rid, message in
            NSApp.activate()
            Task { await app.open(rid, message: message) }
        }
        notifier.onReply = { [app] rid, text in
            Task { await app.chat?.send(rid: rid, text: text, threadId: nil) }
        }
        app.onIncoming = { [app] incoming in
            let watching = NSApp.isActive && app.room?.rid == incoming.rid
            if !watching { notifier.show(incoming) }
        }
        app.onAttention = { count in
            NSApp.dockTile.badgeLabel = count > 0 ? String(count) : nil
        }
        notifier.start()
        if app.screen == .starting && !SmokeGallery.requested { await app.start() }
    }

    /// `rocketvibe://salon/<rid>?host=<server>`, from the Android app's links.
    @MainActor
    func open(_ url: URL) {
        guard url.scheme == "rocketvibe", ["salon", "room"].contains(url.host() ?? "") else { return }
        guard let rid = url.pathComponents.first(where: { $0 != "/" }) else { return }
        let host = URLComponents(url: url, resolvingAgainstBaseURL: false)?
            .queryItems?.first { $0.name == "host" }?.value
        if let host, let base = app.account?.baseUrl, let ours = URL(string: base)?.host(),
           let theirs = (URL(string: host)?.host() ?? URL(string: "https://" + host)?.host()),
           ours.lowercased() != theirs.lowercased() {
            if let other = app.accounts.first(where: { URL(string: $0.baseUrl)?.host()?.lowercased() == theirs.lowercased() }) {
                Task {
                    await app.resume(other)
                    app.open(rid)
                }
            }
            return
        }
        app.open(rid)
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
            ProgressView()
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
