// Prints the rooms of an account through rv-ffi: the toolchain's proof.
//   rv-rooms                              offline self-check (catalog, markdown)
//   rv-rooms <server> <user> <password>   signs in and lists the rooms
import Foundation
import RocketVibeCore
import RocketVibeKit

setFrench(french: false)
guard systemMessage(kind: "uj", param: "") == "joined the channel",
      replaceShortcodes(text: ":smile:") == "😄",
      completeEmoji(prefix: "thumbsu", limit: 1).first?.glyph == "👍"
else {
    print("rv-ffi answers wrong")
    exit(1)
}
print("rv-ffi linked: \(L("room.synced"))")

let args = CommandLine.arguments
guard args.count == 4 else { exit(0) }

let home = FileManager.default.temporaryDirectory.appendingPathComponent("rv-rooms-\(getpid())").path
let app = AppModel(home: home)
app.login.server = args[1]
app.login.user = args[2]
app.login.password = args[3]
await app.submitLogin()
guard app.screen == .chat else {
    print("sign-in failed: \(app.login.error ?? "?")")
    exit(1)
}
for _ in 0..<100 where app.rooms.isEmpty {
    try await Task.sleep(nanoseconds: 100_000_000)
}
for group in app.groups {
    print("\(group.section):")
    for room in group.rooms {
        print("  \(room.name) (\(room.kind)) unread \(room.unread)")
    }
}
guard !app.rooms.isEmpty else { exit(1) }
await app.signOut()
try? FileManager.default.removeItem(atPath: home)
