import Foundation
import Observation
import RocketVibeCore

/// The scheduled messages of one room, or of one thread, on a Vibez
/// server (`scheduled_messages`, brain/features/scheduled-messages.md). The
/// list is the server's: read when the room opens, after each schedule or
/// cancel, and every minute while the room shows, since a sent one leaves
/// silently.
@MainActor @Observable
public final class ScheduledModel {
    public private(set) var items: [ScheduledItem] = []
    public let rid: String
    /// A thread's root: only its replies. None: every one of the room.
    public let root: String?
    @ObservationIgnored let native: NativeChat
    @ObservationIgnored private var reads = 0

    init(native: NativeChat, rid: String, root: String?) {
        self.native = native
        self.rid = rid
        self.root = root
    }

    /// Reads now, then every minute, until the task is cancelled (the room left).
    public func run() async {
        while !Task.isCancelled {
            await refresh()
            try? await Task.sleep(nanoseconds: 60_000_000_000)
        }
    }

    /// Reads the list again; offline or refused, the last one stays.
    public func refresh() async {
        reads += 1
        let read = reads
        guard let list = try? await native.scheduledMessages(room: rid, root: root), read == reads else { return }
        items = list
    }

    /// Cancels a pending one, or removes a failed one; a refusal comes back worded.
    public func cancel(_ id: String) async -> String? {
        var refusal: String?
        do { try await native.cancelScheduled(id: id) }
        catch let RvError.Local(message) { refusal = message }
        catch { refusal = L("native.error") }
        await refresh()
        return refusal
    }
}

extension RoomModel {
    /// "Send later": a Vibez server offering it, in a room that is not
    /// end-to-end encrypted (the server never holds its plaintext).
    public var supportsScheduling: Bool {
        active && !room.encrypted && provider.native?.canSchedule(room: room.rid) == true
    }

    /// The scheduled messages this room (or this thread) shows.
    public func scheduledModel() -> ScheduledModel? {
        guard supportsScheduling, let native = provider.native else { return nil }
        return ScheduledModel(native: native, rid: room.rid, root: threadId)
    }

    /// The menu's instants, from now: in 1 hour, tomorrow at 08:00, and the
    /// window "Pick a time" allows.
    public func scheduleTimes() -> ScheduleTimes? { provider.native?.scheduleTimes() }

    /// Schedules the draft (a reply when this is a thread) for `sendAt` (Unix
    /// seconds). On success the draft clears, unless it was typed over, and the
    /// "Scheduled for …" notice comes back; a refusal comes back worded.
    public func scheduleDraft(at sendAt: Int64) async -> String? {
        guard supportsScheduling, canSend, pendingQuote == nil, let native = provider.native else { return nil }
        let text = draft
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
        do {
            let notice = try await native.scheduleMessage(room: room.rid, root: threadId, text: text, sendAt: sendAt)
            if active, draft == text { draft = "" }
            return notice
        } catch let RvError.Local(message) {
            return message
        } catch {
            return L("native.error")
        }
    }
}
