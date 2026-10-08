import AppKit
import RocketVibeCore
import RocketVibeKit
import SwiftUI

/// A key to revoke, once confirmed.
struct BotKeyTarget {
    let bot: NativeBot
    let key: NativeBotKey
}

/// The Bots category (RFC 0003), as the GTK app's (`settings/native_bots.rs`):
/// my bots, each opening its description, scopes, keys and deletion; "Create a
/// bot" when the server lets me.
struct BotsSection: View {
    @Environment(AppModel.self) var app
    @State private var model: BotsModel?
    @State private var creating = false
    @State private var deleting: NativeBot?
    @State private var revoking: BotKeyTarget?

    var body: some View {
        Section(L("bots.title")) {
            Text(L("bots.intro")).foregroundStyle(.secondary)
            if let model {
                if model.busy && !model.loaded { ProgressView(L("bots.loading")) }
                if model.loaded && model.bots.isEmpty && model.error == nil {
                    Text(L("bots.empty")).foregroundStyle(.secondary)
                }
                ForEach(model.bots, id: \.id) { bot in
                    DisclosureGroup {
                        BotDetail(model: model, bot: bot, deleting: $deleting, revoking: $revoking)
                    } label: {
                        HStack(spacing: 8) {
                            Avatar(path: bot.avatar, name: bot.username, size: 22)
                            Text(bot.displayName)
                            Text("@\(bot.username)").foregroundStyle(.secondary)
                            AdminBadge(text: L("bots.badge"), color: Vibe.sky)
                            if bot.disabled { AdminBadge(text: L("bots.disabled"), color: Vibe.muted) }
                            Spacer()
                            Text(L("bots.keys_count", count: Int(bot.liveKeys))).foregroundStyle(.secondary)
                        }
                    }
                }
                if model.loaded {
                    if model.canCreate {
                        Button(L("bots.create")) { creating = true }.disabled(model.busy)
                    } else {
                        Text(L("bots.closed")).foregroundStyle(.secondary)
                    }
                }
                if let error = model.error { Text(error).foregroundStyle(.red) }
                if let notice = model.notice { Text(notice).foregroundStyle(.secondary) }
                Button(L("security.refresh")) { Task { await model.load() } }.disabled(model.busy)
            }
        }
        .task(id: app.native.map(ObjectIdentifier.init)) {
            creating = false; deleting = nil; revoking = nil
            let fresh = BotsModel(app: app); model = fresh; await fresh.load()
        }
        .modalOverlay(isPresented: $creating, style: .sheet(width: 640, height: 680)) {
            if let model { BotForm(model: model) }
        }
        .modalOverlay(
            isPresented: Binding(get: { model?.created != nil }, set: { if !$0 { model?.created = nil } }),
            style: .sheet(width: 640, height: 440)
        ) {
            if let created = model?.created { BotKeySheet(created: created) }
        }
        .confirmOverlay(
            isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } }),
            title: L("bots.delete_confirm", ["name": "@" + (deleting?.username ?? "")]),
            message: L("bots.delete_body"),
            actions: [ModalAction(title: L("bots.delete"), role: .destructive) {
                if let bot = deleting, let model { Task { _ = await model.delete(bot) } }
                deleting = nil
            }]
        )
        .confirmOverlay(
            isPresented: Binding(get: { revoking != nil }, set: { if !$0 { revoking = nil } }),
            title: L("bots.key_revoke_confirm"),
            message: L("bots.key_revoke_body"),
            actions: [ModalAction(title: L("bots.key_revoke"), role: .destructive) {
                if let target = revoking, let model { Task { await model.revoke(target.bot, target.key) } }
                revoking = nil
            }]
        )
    }
}

/// One bot: its description and scopes, its keys, a new key, its deletion.
struct BotDetail: View {
    @Environment(AppModel.self) var app
    let model: BotsModel
    let bot: NativeBot
    @Binding var deleting: NativeBot?
    @Binding var revoking: BotKeyTarget?
    @State private var displayName = ""
    @State private var description = ""
    @State private var scopes: Set<String> = []
    @State private var label = ""
    @State private var days = ""

    private var expiry: UInt32? {
        let text = days.trimmingCharacters(in: .whitespaces)
        if text.isEmpty { return 0 }
        guard let value = UInt32(text), value <= 3650 else { return nil }
        return value
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 12) {
                Avatar(path: bot.avatar, name: bot.username, size: 48)
                VStack(alignment: .leading) {
                    Text(bot.displayName).font(.title3.bold())
                    Text("@\(bot.username)").foregroundStyle(.secondary)
                }
                Spacer()
                Button(L("settings.photo_change"), action: changePhoto)
                Button(L("settings.photo_remove")) { Task { await model.setPhoto(bot, png: nil) } }
                    .disabled(bot.avatar == nil)
            }
            .disabled(model.busy)
            TextField(L("bots.display_name"), text: $displayName)
            TextField(L("bots.description"), text: $description, axis: .vertical).lineLimit(1 ... 4)
            BotScopes(model: model, selected: $scopes)
            Button(L("settings.save")) {
                let chosen = BotsModel.scopes.filter(scopes.contains)
                Task { _ = await model.update(bot, displayName: displayName, description: description, scopes: chosen) }
            }
            .disabled(model.busy || (
                displayName.trimmingCharacters(in: .whitespacesAndNewlines) == bot.displayName
                    && description == bot.description && scopes == Set(bot.scopes)
            ))

            Text(L("bots.keys")).font(.headline)
            if let keys = model.keys[bot.id] {
                if keys.isEmpty { Text(L("bots.no_keys")).foregroundStyle(.secondary) }
                ForEach(keys, id: \.id) { key in
                    VStack(alignment: .leading, spacing: 2) {
                        HStack {
                            Text(key.label).bold()
                            Text("…\(key.hint)").font(.system(.body, design: .monospaced)).foregroundStyle(.secondary)
                            Spacer()
                            Button(L("bots.key_revoke"), role: .destructive) { revoking = BotKeyTarget(bot: bot, key: key) }
                                .disabled(model.busy)
                        }
                        Text([
                            L("bots.key_created") + " " + botDate(key.createdAt),
                            L("bots.key_expires") + " " + (key.expiresAt.map(botDate) ?? L("bots.key_never")),
                            L("bots.key_used") + " " + (key.lastUsedAt.map(botDate) ?? L("bots.key_unused")),
                        ].joined(separator: " · ")).font(.caption).foregroundStyle(.secondary)
                    }
                }
            }
            Text(L("bots.key_new")).font(.headline)
            TextField(L("bots.key_label"), text: $label)
            TextField(L("bots.key_days"), text: $days)
            HStack {
                Button(L("bots.key_create")) {
                    let (name, expires) = (label, expiry ?? 0)
                    Task {
                        await model.createKey(bot, label: name, days: expires)
                        if model.created != nil { label = ""; days = "" }
                    }
                }
                .disabled(model.busy || label.trimmingCharacters(in: .whitespaces).isEmpty || expiry == nil)
                if app.native?.securitySupported() == true {
                    Button(L("security.verify")) { app.settingsCategory = .security }
                }
            }
            Button(L("bots.delete"), role: .destructive) { deleting = bot }.disabled(model.busy)
        }
        .onAppear { displayName = bot.displayName; description = bot.description; scopes = Set(bot.scopes) }
        .task(id: bot.id) { await model.loadKeys(bot) }
    }

    /// The same picker and conversion as my own photo, aimed at the bot.
    func changePhoto() {
        let panel = NSOpenPanel()
        panel.allowedContentTypes = [.image]
        guard panel.runModal() == .OK, let url = panel.url else { return }
        guard let png = profilePNG(url) else { model.photoRejected(); return }
        Task { await model.setPhoto(bot, png: png) }
    }
}

/// The scopes to tick, each with its API read from the server, then what
/// every key may do and what stays closed.
struct BotScopes: View {
    let model: BotsModel
    @Binding var selected: Set<String>

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(L("bots.scopes")).font(.headline)
            ForEach(BotsModel.scopes, id: \.self) { scope in
                VStack(alignment: .leading, spacing: 2) {
                    Toggle(isOn: Binding(get: { selected.contains(scope) }, set: { on in
                        if on { selected.insert(scope) } else { selected.remove(scope) }
                    })) {
                        VStack(alignment: .leading, spacing: 1) {
                            Text(BotsModel.scopeText(scope))
                            Text(scope).font(.system(.caption, design: .monospaced)).foregroundStyle(.secondary)
                        }
                    }
                    .toggleStyle(.checkbox)
                    BotRoutes(routes: model.routes(scope))
                }
            }
            Label(L("bots.scope.always"), systemImage: "checkmark")
            BotRoutes(routes: model.routes(nil))
            Text(model.closedNote).font(.caption).foregroundStyle(.secondary)
        }
    }
}

/// A scope's API: method and path of each route, as the server's gate admits them.
struct BotRoutes: View {
    let routes: [NativeBotRoute]

    var body: some View {
        if !routes.isEmpty {
            DisclosureGroup(L("bots.api")) {
                VStack(alignment: .leading, spacing: 2) {
                    ForEach(Array(routes.enumerated()), id: \.offset) { _, route in
                        Text("\(route.method) \(route.path)")
                            .font(.system(.caption, design: .monospaced))
                            .textSelection(.enabled)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding(.leading, 22)
        }
    }
}

/// A new bot: username, display name, description, scopes.
struct BotForm: View {
    @Environment(\.closeModal) var dismiss
    let model: BotsModel
    @State private var username = ""
    @State private var displayName = ""
    @State private var description = ""
    @State private var scopes: Set<String> = []

    var body: some View {
        SheetFrame(title: L("bots.create")) {
            Form {
                TextField(L("bots.username"), text: $username).firstModalField()
                TextField(L("bots.display_name"), text: $displayName)
                TextField(L("bots.description"), text: $description, axis: .vertical).lineLimit(1 ... 4)
                BotScopes(model: model, selected: $scopes)
                if let notice = model.notice { Text(notice).foregroundStyle(.red) }
                Button(L("bots.create")) {
                    let chosen = BotsModel.scopes.filter(scopes.contains)
                    Task {
                        if await model.create(username: username, displayName: displayName, description: description, scopes: chosen) != nil {
                            dismiss()
                        }
                    }
                }
                .disabled(model.busy || username.trimmingCharacters(in: .whitespaces).isEmpty)
            }
            .formStyle(.grouped)
        }
    }
}

/// The new key, once: copy it now. It lives only in the model until this closes.
struct BotKeySheet: View {
    let created: NativeBotKeyCreated

    var body: some View {
        SheetFrame(title: L("bots.key_title")) {
            VStack(alignment: .leading, spacing: 12) {
                Text(L("bots.key_once")).bold().foregroundStyle(Vibe.sun)
                copyable(created.key)
                Text(L("bots.example")).font(.headline)
                copyable(created.example)
                Text(L("bots.example_hint")).font(.caption).foregroundStyle(.secondary)
            }
            .padding(18)
        }
    }

    private func copyable(_ text: String) -> some View {
        HStack(alignment: .top) {
            Text(text).font(.system(.body, design: .monospaced)).textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
            Button(L("actions.copy")) {
                NSPasteboard.general.clearContents(); NSPasteboard.general.setString(text, forType: .string)
            }
        }
    }
}

/// An RFC 3339 date as the devices list shows one.
private func botDate(_ value: String) -> String {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    let parsed = formatter.date(from: value)
    formatter.formatOptions = [.withInternetDateTime]
    return (parsed ?? formatter.date(from: value))?.formatted(date: .abbreviated, time: .shortened) ?? value
}
