import Foundation
import RocketVibeCore

public extension RoomModel {
    var supportsSocial: Bool { active && membershipIsCurrent && !room.encrypted && provider.native?.socialAvailable(room: rid) == true }
    var supportsSocialMedia: Bool { active && membershipIsCurrent && !room.encrypted && (provider.legacy.map { !$0.isMattermost() && !$0.isSlack() } == true || provider.native?.supportedFeatures().contains("sticker_shelf") == true) }
    var supportsGiphy: Bool { supportsSocialMedia && (provider.legacy != nil || provider.native?.supportedFeatures().contains("giphy") == true) }
    var socialUser: String { provider.native?.account().userId ?? provider.legacy?.account().userId ?? "" }
    func socialGuard() throws { guard active, membershipIsCurrent, !room.encrypted, !Task.isCancelled else { throw CancellationError() } }
    func socialMedia(gifs: Bool, query: String) async throws -> [SocialMediaItem] {
        try socialGuard()
        let result: [SocialMediaItem]
        switch provider {
        case let .vibez(chat): result = try await (gifs ? chat.socialGifs(query: query) : chat.socialStickers())
        case let .rocketChat(chat): if gifs { result = try await chat.socialGifs(room: rid, query: query) } else { result = try chat.socialStickers() }
        }
        try socialGuard(); return result
    }
    func socialSave(_ item: SocialMediaItem, operation: String) async throws {
        try socialGuard()
        let title = String((item.title.isEmpty ? "GIF" : item.title).prefix(100))
        switch provider {
        case let .vibez(chat): try await chat.saveSticker(operation: operation, title: title, url: item.url)
        case let .rocketChat(chat): try chat.saveSticker(operation: operation, title: title, url: item.url)
        }
        try socialGuard()
    }
    func socialRemove(_ id: String) async throws {
        try socialGuard()
        switch provider {
        case let .vibez(chat): try await chat.removeSticker(id: id)
        case let .rocketChat(chat): try chat.removeSticker(id: id)
        }
        try socialGuard()
    }
    func socialSend(_ item: SocialMediaItem, operation: String, gif: Bool, query: String) async throws {
        try socialGuard()
        switch provider {
        case let .vibez(chat): try await chat.sendSocialImage(room: rid, root: threadId, operation: operation, title: item.title, url: item.url)
        case let .rocketChat(chat): try await chat.sendSocialImage(room: rid, root: threadId, operation: operation, title: item.title, url: item.url, giphyId: gif ? item.id : nil, query: query)
        }
        try socialGuard()
    }
    func socialPoll(operation: String, question: String, options: [String], multiple: Bool, closesAt: Int64?) async throws {
        try socialGuard(); guard let chat = provider.native else { throw CancellationError() }
        try await chat.createPoll(room: rid, root: threadId, operation: operation, question: question, options: options, multiple: multiple, closesAt: closesAt)
        try socialGuard()
    }
    func socialGame(operation: String, title: String, description: String, startsAt: Int64) async throws {
        try socialGuard(); guard let chat = provider.native else { throw CancellationError() }
        try await chat.createGameNight(room: rid, root: threadId, operation: operation, title: title, description: description, startsAt: startsAt)
        try socialGuard()
    }
    func socialAnswer(id: String, operation: String, choices: [UInt32]) async throws {
        try socialGuard(); guard let chat = provider.native else { throw CancellationError() }
        try await chat.answerSocial(id: id, operation: operation, choices: choices.sorted())
        try socialGuard()
    }
    func socialClose(id: String, operation: String) async throws {
        try socialGuard(); guard let chat = provider.native else { throw CancellationError() }
        try await chat.closePoll(id: id, operation: operation); try socialGuard()
    }
}
