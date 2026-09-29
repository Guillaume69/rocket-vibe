import AppKit
import RocketVibeKit
import SwiftUI

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
                        .disabled(app.chat == nil)
                }
            }
            Section(L("e2e.status")) {
                HStack {
                    Text(app.e2eUnlocked ? L("e2e.unlocked") : L("e2e.locked"))
                    Spacer()
                    if app.e2eUnlocked {
                        Button(L("e2e.lock")) { app.lock() }
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
