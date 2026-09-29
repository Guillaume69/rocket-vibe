import Foundation
import RocketVibeCore

/// Protected files and photos, fetched through rv-ffi (which holds the
/// token) once each, however many rows ask at the same time.
@MainActor
public final class MediaStore {
    let chat: Chat
    var done: [String: MediaData] = [:]
    var coming: [String: Task<MediaData?, Never>] = [:]

    init(chat: Chat) {
        self.chat = chat
    }

    public func cached(_ path: String) -> MediaData? {
        done[path]
    }

    public func load(_ path: String) async -> MediaData? {
        if let hit = done[path] { return hit }
        if let task = coming[path] { return await task.value }
        let chat = chat
        let task = Task<MediaData?, Never> { try? await chat.media(path: path) }
        coming[path] = task
        let media = await task.value
        coming[path] = nil
        if let media {
            if done.count > 400 { done.removeAll() }
            done[path] = media
        }
        return media
    }

    /// A photo changed somewhere: fetch everything again.
    func forget() {
        done.removeAll()
    }

    public func avatar(user: String) -> String {
        chat.userAvatar(username: user)
    }

    public func customEmoji(_ code: String) -> String? {
        chat.customEmoji(code: code)
    }

    public func download(_ path: String, to destination: String) async throws {
        try await chat.download(path: path, destination: destination)
    }
}
