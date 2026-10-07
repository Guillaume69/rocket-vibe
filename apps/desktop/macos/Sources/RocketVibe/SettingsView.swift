import AppKit
import ImageIO
import RocketVibeCore
import RocketVibeKit
import SwiftUI
import UniformTypeIdentifiers

struct SettingsView: View {
    @Environment(AppModel.self) var app
    @State var language = "auto"
    @State private var profile: MyProfileModel?

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
            if let profile, app.provider?.supportsProfiles == true {
                MyProfileSection(model: profile)
            }
            if app.native?.supportedFeatures().contains("device_sessions") == true {
                DevicesSection()
            }
            if app.native?.securitySupported() == true {
                SecuritySection()
            }
            if app.native?.cryptoSettingsSupported() == true {
                CryptoSection()
            }
            if let voice = app.voice {
                VoiceSettings(voice: voice)
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
                Picker(L("settings.language"), selection: Binding(get: { profile?.native == true ? profile?.language ?? language : language }, set: { choice in
                    if let profile, profile.native { Task { await profile.setLanguage(choice) } }
                    else {
                        language = choice
                        try? choice.write(toFile: app.client.configDir() + "/language", atomically: true, encoding: .utf8)
                    }
                })) {
                    Text(L("settings.lang_auto")).tag("auto")
                    Text(L("settings.lang_fr")).tag("fr")
                    Text(L("settings.lang_en")).tag("en")
                }
                .disabled(profile?.native == true && profile?.preferencesEditable != true)
                Text(L("settings.language_restart")).font(.caption).foregroundStyle(.secondary)
            }
            Section(L("settings.notifications")) {
                if let profile, profile.saved != nil { NotificationPreference(model: profile) }
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
        .task(id: app.sessionId) {
            profile?.close()
            let fresh = MyProfileModel(app: app); profile = fresh
            await fresh.load()
        }
        .onDisappear { profile?.close() }
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
    let model: MyProfileModel

    var body: some View {
        Picker(L("settings.desktop_notifications"), selection: Binding(get: { model.desktopNotifications }, set: { choice in Task { await model.setNotifications(choice) } })) {
            Text(L("settings.notify_default")).tag("default")
            Text(L("settings.notify_all")).tag("all")
            Text(L("settings.notify_mention")).tag("mention")
            Text(L("settings.notify_nothing")).tag("nothing")
        }
        .disabled(model.native ? !model.preferencesEditable : model.busy)
    }
}

/// My photo, presence and status, name, username, email and bio.
struct MyProfileSection: View {
    @Bindable var model: MyProfileModel

    var body: some View {
        Section(L("settings.edit_profile")) {
            if model.isCurrent, let saved = model.saved, model.edited != nil {
                let me = Binding(get: { model.edited ?? saved }, set: { model.edited = $0 })
                HStack(spacing: 12) {
                    Avatar(path: saved.avatar, name: saved.username, size: 48)
                    Button(L("settings.photo_change"), action: changePhoto)
                    Button(L("settings.photo_remove")) {
                        Task { await model.removePhoto() }
                    }
                }
                .disabled(!model.photoEditable)
                Group {
                Picker(L("settings.presence"), selection: me.status) {
                    ForEach(["online", "away", "busy", "offline"], id: \.self) { Text(L("presence.\($0)")).tag($0) }
                }
                TextField(L("settings.status_text"), text: me.statusText)
                TextField(L("settings.name"), text: me.name)
                TextField(L("settings.username"), text: me.username)
                TextField(L("settings.email"), text: me.email)
                    .disabled(model.native)
                if model.native { Text(L("profile.email_verified")).font(.caption).foregroundStyle(.secondary) }
                TextField(L("info.bio"), text: me.bio, axis: .vertical).lineLimit(1...4)
                if !model.native && (me.wrappedValue.username != saved.username || me.wrappedValue.email != saved.email) {
                    SecureField(L("settings.current_password"), text: $model.password)
                }
                if model.method != nil {
                    Text(L("settings.code_needed")).font(.caption)
                    SecureField(L("settings.code"), text: $model.code)
                }
                }.disabled(!model.editable)
                HStack {
                    if let message = model.message { Text(message).font(.caption).foregroundStyle(.secondary) }
                    Spacer()
                    Button(L("settings.save")) { Task { await model.save() } }
                        .disabled(model.busy || model.edited == saved || model.intention("profile") != nil)
                }
                ForEach(model.intentions, id: \.key) { pending in
                    VStack(alignment: .leading) {
                        Text(L("profile.pending_" + pending.slot)).font(.caption)
                        if pending.phase == "proof" { Text(L("security.required")).font(.caption) }
                        HStack {
                            if pending.phase != "failed" { Button(L("profile.resume")) { Task { await model.resume(pending.slot) } } }
                            if pending.phase != "pending" { Button(L("profile.discard"), role: .destructive) { Task { await model.discard(pending) } } }
                        }.disabled(model.busy)
                    }
                }
            } else {
                if model.busy { ProgressView() }
                if let message = model.message { Text(message).foregroundStyle(.secondary) }
                Button(L("devices.refresh")) { Task { await model.load() } }.disabled(model.busy)
            }
        }
    }

    func changePhoto() {
        let panel = NSOpenPanel()
        panel.allowedContentTypes = [.image]
        guard panel.runModal() == .OK, let url = panel.url else { return }
        if model.native {
            guard let png = profilePNG(url) else { model.photoRejected(); return }
            Task { await model.changePhoto(png: png) }
        } else {
            let mime = UTType(filenameExtension: url.pathExtension)?.preferredMIMEType ?? "image/png"
            Task { await model.legacyPhoto(path: url.path, mime: mime) }
        }
    }
}

private func profilePNG(_ url: URL) -> Data? {
    guard let source = CGImageSourceCreateWithURL(url as CFURL, nil),
          let image = CGImageSourceCreateThumbnailAtIndex(source, 0, [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: 512
          ] as CFDictionary) else { return nil }
    let bytes = NSMutableData()
    guard let destination = CGImageDestinationCreateWithData(bytes, UTType.png.identifier as CFString, 1, nil) else { return nil }
    CGImageDestinationAddImage(destination, image, nil)
    guard CGImageDestinationFinalize(destination), bytes.length <= 2 * 1024 * 1024 else { return nil }
    return bytes as Data
}
