import AppKit
import RocketVibeCore
import RocketVibeKit
import SwiftUI

@main
struct RocketVibeApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) var delegate
    @State var app = AppModel(home: NSHomeDirectory())
    @State var modals = ModalCenter()

    var body: some Scene {
        Window("rocket-vibe", id: "main") {
            RootView()
                .environment(app)
                .environment(modals)
                .frame(minWidth: 420, minHeight: 360)
                .task { await start() }
                .onOpenURL { url in open(url) }
        }
        .defaultSize(width: 1100, height: 720)
        .commands { AppCommands(app: app) }
        // No Settings scene: the settings are an overlay of this window,
        // which the app menu's Settings item (Command-comma) opens.
    }

    @MainActor
    func start() async {
        NSEvent.addLocalMonitorForEvents(matching: .otherMouseDown) { [app] event in
            switch event.buttonNumber {
            case 3: app.goBack()
            case 4: app.goForward()
            default: return event
            }
            return nil
        }
        let wheel = WheelZoom()
        NSEvent.addLocalMonitorForEvents(matching: .scrollWheel) { [app] event in
            guard event.modifierFlags.contains(.command) else { return event }
            if let larger = wheel.notch(event) { app.zoom(in: larger) }
            return nil
        }
        NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [app] event in
            let modifiers = event.modifierFlags.intersection(.deviceIndependentFlagsMask).subtracting([.shift, .numericPad, .capsLock])
            guard modifiers == .command, event.charactersIgnoringModifiers == "+" else { return event }
            app.zoom(in: true)
            return nil
        }
        let notifier = Notifier.shared
        notifier.onOpen = { [app] rid, message, scope in
            if let scope, app.client.backgroundTarget(scope: scope) != nil {
                NSApp.activate()
                Task { await app.openBackgroundNotification(scope: scope, message: message) }
                return
            }
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
            if let scope, app.client.backgroundTarget(scope: scope) != nil {
                Task { try? await app.client.backgroundReply(scope: scope, text: text) }
                return
            }
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
        app.onBackgroundIncoming = { incoming, scope in notifier.show(incoming, scope: scope) }
        app.onBackgroundCall = { [app] call in
            guard let call else {
                VoiceSounds.shared.tone(app.foregroundTone)
                notifier.withdrawCall()
                return
            }
            if !call.quiet { VoiceSounds.shared.tone(.ringtone) }
            guard !NSApp.isActive else { return }
            NSApp.requestUserAttention(.criticalRequest)
            notifier.showCall(rid: call.rid, callId: call.id, caller: "\(call.caller) (\(call.server))")
        }
        notifier.onOpenLink = { [app] link in
            NSApp.activate()
            Task { await app.openLink(link) }
        }
        app.onReminder = { notifier.showReminder($0) }
        app.onAttention = { count in
            NSApp.dockTile.badgeLabel = count > 0 ? String(count) : nil
        }
        app.onVoiceCue = { VoiceSounds.shared.cue($0) }
        app.onVoiceTone = { [app] tone in
            // A muted account's call shows in the window only, silently.
            let muted = tone == .ringtone && app.openMuted
            VoiceSounds.shared.tone(muted ? nil : tone)
            // A call ringing while the app is behind: the dock bounces.
            if tone == .ringtone && !muted && !NSApp.isActive { NSApp.requestUserAttention(.criticalRequest) }
        }
        app.onCallRing = { [app] call in
            // The voice model owns the tone while a Vibez account is shown.
            if app.voice == nil { VoiceSounds.shared.tone(call == nil || app.openMuted ? nil : .ringtone) }
            guard let call, !NSApp.isActive, !app.openMuted else {
                notifier.withdrawCall()
                return
            }
            NSApp.requestUserAttention(.criticalRequest)
            notifier.showCall(rid: call.rid, callId: call.callId, caller: app.callerName(call))
        }
        notifier.onCall = { [app] accept in
            if let call = app.backgroundCall {
                NSApp.activate()
                if accept {
                    let title = L("call.window_title", ["room": call.caller])
                    Task { if let link = await app.answerBackgroundCall(call), let url = URL(string: link) { CallWindow.show(url, title: title) } }
                } else {
                    app.declineBackgroundCall(call)
                }
                return
            }
            guard let call = app.ringingCall else { return }
            NSApp.activate()
            if accept {
                let title = L("call.window_title", ["room": app.callerName(call)])
                Task { if let link = await app.answerCall(call), let url = URL(string: link) { CallWindow.show(url, title: title) } }
            } else {
                app.declineCall(call)
            }
        }
        notifier.start()
        // Missed reminders fire now, the others at their time.
        if !SmokeGallery.requested { app.startReminders() }
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

/// Cmd + wheel as zoom notches, larger when the wheel turns up whatever the
/// scrolling direction setting: one per wheel click, one per 20 points a
/// trackpad gesture scrolls, its momentum left out.
final class WheelZoom {
    var travel = 0.0

    func notch(_ event: NSEvent) -> Bool? {
        guard event.momentumPhase.isEmpty else { return nil }
        if event.phase.contains(.began) { travel = 0 }
        if event.phase.contains(.ended) || event.phase.contains(.cancelled) {
            travel = 0
            return nil
        }
        let up = event.isDirectionInvertedFromDevice ? -event.scrollingDeltaY : event.scrollingDeltaY
        guard event.hasPreciseScrollingDeltas else {
            return up == 0 ? nil : up > 0
        }
        travel += up
        guard abs(travel) >= 20 else { return nil }
        defer { travel = 0 }
        return travel > 0
    }
}

struct RootView: View {
    @Environment(AppModel.self) var app

    var body: some View {
        content.vibe()
    }

    var content: some View {
        Group {
            if SmokeGallery.requested {
                GalleryView()
            } else {
                screen
                    .overlay {
                        if app.settingsShown {
                            SettingsOverlay().transition(.opacity)
                        } else if let admin = app.admin {
                            AdminOverlay(model: admin).transition(.opacity)
                        }
                    }
                    .animation(.easeOut(duration: 0.16), value: app.settingsShown)
                    .animation(.easeOut(duration: 0.16), value: app.admin != nil)
                    .modalOverlay(item: Binding(get: { app.reporting }, set: { if $0 == nil { app.cancelReport() } })) { draft in
                        ReportSheet(draft: draft)
                    }
                    // The account's reminders (account menu): a click outside closes the list.
                    .modalOverlay(isPresented: Binding(get: { app.remindersShown }, set: { app.remindersShown = $0 })) {
                        RemindersList()
                    }
                    // A new bot key, shown once, whether the settings are still open or not.
                    .modalOverlay(
                        isPresented: Binding(get: { app.botKey != nil }, set: { if !$0 { app.dismissBotKey() } }),
                        style: .sheet(width: 640, height: 440)
                    ) {
                        if let created = app.botKey { BotKeySheet(created: created) }
                    }
                    // A workflow's new webhook URL, shown once, the settings still open or not.
                    .modalOverlay(
                        isPresented: Binding(get: { app.workflowWebhook != nil }, set: { if !$0 { app.dismissWorkflowWebhook() } }),
                        style: .sheet(width: 640, height: 340)
                    ) {
                        if let url = app.workflowWebhook { WorkflowWebhookSheet(url: url) }
                    }
            }
        }
        // Over everything, the settings and the administration included.
        .overlay { ModalHost() }
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
        CommandGroup(replacing: .appSettings) {
            Button(L("settings.title") + "…") { app.openSettings() }
                .keyboardShortcut(",", modifiers: .command)
        }
        CommandGroup(after: .toolbar) {
            Button(L("zoom.in")) { app.zoom(in: true) }
                .keyboardShortcut("=", modifiers: .command)
            Button(L("zoom.out")) { app.zoom(in: false) }
                .keyboardShortcut("-", modifiers: .command)
            Button(L("zoom.reset")) { app.zoom(in: nil) }
                .keyboardShortcut("0", modifiers: .command)
            Divider()
            Button(L("nav.back")) { app.goBack() }
                .keyboardShortcut(.leftArrow, modifiers: .option)
            Button(L("nav.forward")) { app.goForward() }
                .keyboardShortcut(.rightArrow, modifiers: .option)
            // Not over the settings or the administration, which cover the rooms.
            Button(L("switcher.title") + "…") { if !app.panelShown && app.account != nil { app.switching = true } }
                .keyboardShortcut("k", modifiers: .command)
            // Cmd + 1 to 9 opens the rail's first nine accounts (GTK: Ctrl),
            // hidden rail included; not over a panel.
            Divider()
            ForEach(Array(app.railAccounts.prefix(9).enumerated()), id: \.element.key) { slot, account in
                if let digit = railShortcutDigit(slot: UInt32(slot)), let key = String(digit).first {
                    Button("\(ServerRail.host(account)) · @\(account.username)") {
                        if !app.panelShown && app.account != nil { Task { await app.openRailSlot(slot) } }
                    }
                    .keyboardShortcut(KeyEquivalent(key), modifiers: .command)
                }
            }
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
