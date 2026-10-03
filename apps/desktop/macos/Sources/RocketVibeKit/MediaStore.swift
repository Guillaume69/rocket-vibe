import Foundation
import RocketVibeCore

/// Protected files and photos, fetched through rv-ffi (which holds the
/// token) once each, however many rows ask at the same time.
@MainActor
public final class MediaStore {
    let chat: Chat?
    let native:NativeChat?
    var generation=0
    var done: [String: MediaData] = [:]
    var coming: [String: Task<MediaData?, Never>] = [:]

    init(chat: Chat) {
        self.chat = chat
        self.native=nil
    }
    init(native:NativeChat){self.chat=nil;self.native=native}

    public func cached(_ path: String) -> MediaData? {
        current(path) ? done[path] : nil
    }
    public func current(_ path:String)->Bool{guard let native else{return true};guard path.hasPrefix("rv-avatar:")else{return false};return native.profileAvatarCurrent(id:String(path.dropFirst("rv-avatar:".count)))}

    public func load(_ path: String) async -> MediaData? {
        guard current(path) else{return nil}
        if let hit = done[path] { return hit }
        if let task = coming[path] {
            let version=generation
            let media=await task.value
            return version==generation && current(path) ? media : nil
        }
        let (chat,native,version) = (chat,self.native,generation)
        let task = Task<MediaData?, Never> {
            if let native {
                guard path.hasPrefix("rv-avatar:") else{return nil}
                return try? await native.profileAvatar(id:String(path.dropFirst("rv-avatar:".count)))
            }
            return try? await chat?.media(path: path)
        }
        coming[path] = task
        let media = await task.value
        coming[path] = nil
        guard version==generation,current(path) else{return nil}
        if let media {
            let byteCount=done.values.reduce(0){$0+$1.bytes.count}
            if done.count > (native == nil ? 400 : 127)||native != nil&&byteCount+media.bytes.count>32*1024*1024 { done.removeAll() }
            done[path] = media
        }
        return media
    }

    /// A photo changed somewhere: fetch everything again.
    func forget() {
        generation+=1
        done.removeAll()
        for task in coming.values{task.cancel()};coming.removeAll()
    }

    public func avatar(user: String) -> String {
        chat?.userAvatar(username: user) ?? native?.userAvatar(username:user) ?? ""
    }

    public func customEmoji(_ code: String) -> String? {
        chat?.customEmoji(code: code)
    }

    public func download(_ path: String, to destination: String) async throws {
        if let chat{try await chat.download(path: path, destination: destination)}
        else{throw RvError.Local(message:"unsupported_feature")}
    }
}
