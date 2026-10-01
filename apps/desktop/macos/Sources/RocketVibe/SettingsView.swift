import AppKit
import RocketVibeCore
import RocketVibeKit
import SwiftUI
import UniformTypeIdentifiers

struct SettingsView: View {
    @Environment(AppModel.self) var app
    @State var language = "auto"

    var body: some View {
        Form {
            Section(L("settings.accounts")) {
                ForEach(app.accounts, id: \.key) { account in
                    HStack {
                        Avatar(path: nil, name: account.username, size: 22)
                        Text(account.username)
                        Text(URL(string: account.baseUrl)?.host() ?? account.baseUrl).foregroundStyle(.secondary)
                        Spacer()
                        if account.key == app.account?.key {
                            Text(L("settings.current")).foregroundStyle(.secondary)
                        } else {
                            Button(L("notify.open")) { Task { await app.resume(account) } }
                        }
                    }
                }
                HStack {
                    Button(L("settings.add_account")) { app.showLogin(error: nil) }
                    Spacer()
                    Button(L("rooms.sign_out"), role: .destructive) { Task { await app.signOut() } }
                        .disabled(!app.signedIn)
                }
            }
            if app.chat != nil {
                MyProfileSection()
            }
            if app.native?.supportedFeatures().contains("device_sessions") == true {
                DevicesSection()
            }
            if app.native?.securitySupported() == true {
                SecuritySection()
            }
            if app.chat != nil {
                Section(L("e2e.status")) {
                    HStack {
                        Text(app.e2eUnlocked ? L("e2e.unlocked") : L("e2e.locked"))
                        Spacer()
                        if app.e2eUnlocked {
                            Button(L("e2e.lock")) { app.lock() }
                        }
                    }
                }
            }
            Section(L("settings.language")) {
                Picker(L("settings.language"), selection: $language) {
                    Text(L("settings.lang_auto")).tag("auto")
                    Text(L("settings.lang_fr")).tag("fr")
                    Text(L("settings.lang_en")).tag("en")
                }
                .onChange(of: language) { _, choice in
                    try? choice.write(toFile: app.client.configDir() + "/language", atomically: true, encoding: .utf8)
                }
                Text(L("settings.language_restart")).font(.caption).foregroundStyle(.secondary)
            }
            Section(L("settings.notifications")) {
                if app.chat != nil { NotificationPreference() }
                Button(L("notify.test")) { Notifier.shared.test() }
                Button(L("notify.system_settings")) {
                    if let url = URL(string: "x-apple.systempreferences:com.apple.Notifications-Settings.extension") {
                        NSWorkspace.shared.open(url)
                    }
                }
            }
            Section(L("settings.about")) {
                LabeledContent(L("settings.version"), value: Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "dev")
            }
        }
        .formStyle(.grouped)
        .frame(width: 480)
        .onAppear {
            language = (try? String(contentsOfFile: app.client.configDir() + "/language", encoding: .utf8))?
                .trimmingCharacters(in: .whitespacesAndNewlines) ?? "auto"
        }
    }
}

struct DevicesSection: View {
    @Environment(AppModel.self) var app
    @State private var model: DevicesModel?
    @State private var selected: NativeDeviceSession?
    @State private var selectedModel: DevicesModel?

    var body: some View {
        Section(L("devices.title")) {
            if let model {
                if model.busy { ProgressView(L("devices.loading")) }
                ForEach(model.rows, id: \.id) { device in
                    DisclosureGroup((device.label.isEmpty ? L("devices.unnamed") : device.label) + (device.current ? " · " + L("devices.current") : "")) {
                        if device.current { Text(L("devices.current")).foregroundStyle(.secondary) }
                        TextField(L("devices.name"), text: Binding(get: { model.labels[device.id] ?? device.label }, set: { model.labels[device.id] = $0 }))
                        Button(L("settings.save")) { Task { await model.rename(device) } }
                            .disabled(model.busy || (model.labels[device.id] ?? device.label) == device.label)
                        LabeledContent(L("devices.created"), value: date(device.createdAt))
                        LabeledContent(L("devices.seen"), value: date(device.lastSeenAt))
                        LabeledContent(L("devices.expires"), value: date(device.expiresAt))
                        if !device.current {
                            Button(L("devices.revoke"), role: .destructive) { selectedModel = model; selected = device }
                                .disabled(model.busy)
                        }
                    }
                }
                if let error = model.error { Text(error).foregroundStyle(.red) }
                Button(L("devices.refresh")) { Task { await model.load() } }.disabled(model.busy)
            }
        }
        .task(id: app.native.map(ObjectIdentifier.init)) {
            selected = nil; selectedModel = nil
            let fresh = DevicesModel(app: app); model = fresh; await fresh.load()
        }
        .alert(L("devices.confirm"), isPresented: Binding(get: { selected != nil }, set: { if !$0 { selected = nil } })) {
            Button(L("devices.revoke"), role: .destructive) {
                if let device = selected, let expected = selectedModel { Task { await expected.revoke(device) } }
                selected = nil
            }
            Button(L("actions.cancel"), role: .cancel) { selected = nil }
        } message: { Text(L("devices.confirm_body")) }
    }
    private func date(_ value: String) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let parsed = formatter.date(from: value)
        formatter.formatOptions = [.withInternetDateTime]
        return (parsed ?? formatter.date(from: value))?.formatted(date: .abbreviated, time: .shortened) ?? value
    }
}

/// Which messages notify me, kept on the server (`desktopNotifications`).
struct NotificationPreference: View {
    @Environment(AppModel.self) var app
    @State var value = "default"
    @State var ready = false

    var body: some View {
        Picker(L("settings.desktop_notifications"), selection: $value) {
            Text(L("settings.notify_default")).tag("default")
            Text(L("settings.notify_all")).tag("all")
            Text(L("settings.notify_mention")).tag("mention")
            Text(L("settings.notify_nothing")).tag("nothing")
        }
        .disabled(!ready)
        .task {
            if let me = try? await app.chat?.me() {
                value = me.desktopNotifications
                ready = true
            }
        }
        .onChange(of: value) { old, new in
            guard ready, old != new else { return }
            Task {
                do { try await app.chat?.setDesktopNotifications(value: new) } catch { app.notice = L("settings.save_failed") }
            }
        }
    }
}

/// My photo, presence and status, name, username, email and bio.
struct MyProfileSection: View {
    @Environment(AppModel.self) var app
    @State var saved: Me?
    @State var edited: Me?
    @State var password = ""
    @State var method: String?
    @State var code = ""
    @State var message: String?

    var body: some View {
        Section(L("settings.edit_profile")) {
            if let saved, edited != nil {
                let me = Binding(get: { edited ?? saved }, set: { edited = $0 })
                HStack(spacing: 12) {
                    Avatar(path: saved.avatar, name: saved.username, size: 48)
                    Button(L("settings.photo_change"), action: changePhoto)
                    Button(L("settings.photo_remove")) {
                        Task { await run { try await app.chat?.resetAvatar() } }
                    }
                }
                Picker(L("settings.presence"), selection: me.status) {
                    ForEach(["online", "away", "busy", "offline"], id: \.self) { Text(L("presence.\($0)")).tag($0) }
                }
                TextField(L("settings.status_text"), text: me.statusText)
                TextField(L("settings.name"), text: me.name)
                TextField(L("settings.username"), text: me.username)
                TextField(L("settings.email"), text: me.email)
                TextField(L("info.bio"), text: me.bio, axis: .vertical).lineLimit(1...4)
                if me.wrappedValue.username != saved.username || me.wrappedValue.email != saved.email {
                    SecureField(L("settings.current_password"), text: $password)
                }
                if method != nil {
                    Text(L("settings.code_needed")).font(.caption)
                    SecureField(L("settings.code"), text: $code)
                }
                HStack {
                    if let message { Text(message).font(.caption).foregroundStyle(.secondary) }
                    Spacer()
                    Button(L("settings.save"), action: save).disabled(edited == saved)
                }
            } else {
                ProgressView()
            }
        }
        .task { await reload() }
    }

    func reload() async {
        guard let me = try? await app.chat?.me() else { return }
        saved = me
        edited = me
    }

    func save() {
        guard let before = saved, let after = edited, let chat = app.chat else { return }
        Task {
            do {
                if after.status != before.status || after.statusText != before.statusText {
                    try await chat.setStatus(status: after.status, message: after.statusText)
                }
                try await chat.updateProfile(
                    before: before, after: after, password: password.isEmpty ? nil : password,
                    method: method, code: method == nil ? nil : code)
                method = nil
                code = ""
                password = ""
                message = L("settings.saved")
                await reload()
            } catch let RvError.Server(_, _, _, twoFactor, _, _) where twoFactor != nil {
                method = twoFactor?.method
            } catch let RvError.Local(text) where text == "password-needed" {
                message = L("settings.current_password")
            } catch {
                message = L("settings.save_failed")
            }
        }
    }

    func changePhoto() {
        let panel = NSOpenPanel()
        panel.allowedContentTypes = [.image]
        guard panel.runModal() == .OK, let url = panel.url else { return }
        let mime = UTType(filenameExtension: url.pathExtension)?.preferredMIMEType ?? "image/png"
        Task { await run { try await app.chat?.setAvatar(path: url.path, mime: mime) } }
    }

    func run(_ action: () async throws -> Void) async {
        do {
            try await action()
            message = L("settings.saved")
            await reload()
        } catch {
            message = L("settings.save_failed")
        }
    }
}
