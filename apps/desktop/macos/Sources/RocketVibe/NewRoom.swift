import RocketVibeKit
import SwiftUI

/// A new room on a RocketVibe server, as GTK's dialog makes one: a name,
/// private or not, and a voice channel where the server offers voice. Opened
/// once the list carries it.
struct NewRoomSheet: View {
    @Environment(AppModel.self) var app
    @Environment(\.dismiss) var dismiss
    @State var name = ""
    @State var secret = true
    @State var voice = false
    @State var busy = false
    @State var error: String?

    /// What the server takes (rv-core checks it again): not blank, 128 bytes at most.
    var valid: Bool {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        return !trimmed.isEmpty && trimmed.utf8.count <= 128
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Form {
                TextField(L("native.room_name"), text: $name)
                    .onSubmit(create)
                Toggle(L("native.private"), isOn: $secret)
                if app.voice != nil {
                    Toggle(isOn: $voice) {
                        Text(L("voice_session.channel"))
                        Text(L("voice_session.channel_hint"))
                    }
                }
                if let error {
                    Text(error).foregroundStyle(Vibe.pink)
                }
            }
            .formStyle(.grouped)
            HStack {
                if busy { ProgressView().controlSize(.small) }
                Spacer()
                Button(L("actions.cancel")) { dismiss() }
                    .keyboardShortcut(.cancelAction)
                Button(L("native.create"), action: create)
                    .keyboardShortcut(.defaultAction)
                    .disabled(!valid || busy)
            }
            .padding([.horizontal, .bottom], 20)
        }
        .frame(width: 420)
        .navigationTitle(L("native.create"))
    }

    func create() {
        guard valid, !busy else { return }
        busy = true
        error = nil
        let (title, hidden, channel) = (name, secret, voice && app.voice != nil)
        Task {
            let failure = await app.createRoom(name: title, private: hidden, voice: channel)
            busy = false
            if let failure { error = failure } else { dismiss() }
        }
    }
}
